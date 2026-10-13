use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::Duration;

use serde_json::Value;
use sqlx::{Connection, Executor, Postgres, Transaction};
use tokio::time;

use crate::config::{
    BootstrapSettingOrigin, INSTANCE_SETTING_DEFINITIONS, INSTANCE_SETTING_REGISTRY_VERSION,
    InstanceSettingBootstrap, SettingApplyMode, SettingSensitivity, instance_setting_definition,
};
use crate::database::DatabasePool;
use crate::policy::validate_policy_values;

const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

type SettingRow = (String, i16, String, String, i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceSettingsError {
    InvalidOperationTimeout,
    OperationTimeout,
    PersistenceUnavailable,
    UnknownPersistedKey,
    IncompletePersistedSet,
    UnsupportedRegistryVersion,
    InvalidPersistedValue,
    SecretPersistenceForbidden,
}

impl fmt::Display for InstanceSettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidOperationTimeout => "Instance setting operation timeout is invalid",
            Self::OperationTimeout => "Instance setting operation timed out",
            Self::PersistenceUnavailable => "Instance setting persistence is unavailable",
            Self::UnknownPersistedKey => "persisted Instance setting key is unknown",
            Self::IncompletePersistedSet => "persisted Instance setting set is incomplete",
            Self::UnsupportedRegistryVersion => {
                "persisted Instance setting registry version is unsupported"
            }
            Self::InvalidPersistedValue => "persisted Instance setting value is invalid",
            Self::SecretPersistenceForbidden => {
                "secret values are forbidden in the Instance setting table"
            }
        })
    }
}

impl std::error::Error for InstanceSettingsError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistedBootstrapOrigin {
    Default,
    File,
    Environment,
}

impl PersistedBootstrapOrigin {
    fn parse(value: &str) -> Result<Self, InstanceSettingsError> {
        match value {
            "default" => Ok(Self::Default),
            "file" => Ok(Self::File),
            "environment" => Ok(Self::Environment),
            _ => Err(InstanceSettingsError::InvalidPersistedValue),
        }
    }
}

impl From<BootstrapSettingOrigin> for PersistedBootstrapOrigin {
    fn from(value: BootstrapSettingOrigin) -> Self {
        match value {
            BootstrapSettingOrigin::Default => Self::Default,
            BootstrapSettingOrigin::File => Self::File,
            BootstrapSettingOrigin::Environment => Self::Environment,
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct EffectiveInstanceSetting {
    key: &'static str,
    value: Value,
    lock_version: u64,
    bootstrap_origin: PersistedBootstrapOrigin,
    apply_mode: SettingApplyMode,
}

impl EffectiveInstanceSetting {
    #[must_use]
    pub const fn key(&self) -> &'static str {
        self.key
    }

    #[must_use]
    pub const fn lock_version(&self) -> u64 {
        self.lock_version
    }

    #[must_use]
    pub const fn bootstrap_origin(&self) -> PersistedBootstrapOrigin {
        self.bootstrap_origin
    }

    #[must_use]
    pub const fn apply_mode(&self) -> SettingApplyMode {
        self.apply_mode
    }

    /// Returns a public policy value. Secret definitions can never reach persistence.
    #[must_use]
    pub fn value(&self) -> &Value {
        &self.value
    }
}

impl fmt::Debug for EffectiveInstanceSetting {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectiveInstanceSetting")
            .field("key", &self.key)
            .field("value", &"[REDACTED]")
            .field("lock_version", &self.lock_version)
            .field("bootstrap_origin", &self.bootstrap_origin)
            .field("apply_mode", &self.apply_mode)
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub struct EffectiveInstanceSettings {
    registry_version: u16,
    settings: BTreeMap<&'static str, EffectiveInstanceSetting>,
}

impl EffectiveInstanceSettings {
    #[must_use]
    pub const fn registry_version(&self) -> u16 {
        self.registry_version
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&EffectiveInstanceSetting> {
        self.settings.get(key)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.settings.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.settings.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &EffectiveInstanceSetting> {
        self.settings.values()
    }
}

impl fmt::Debug for EffectiveInstanceSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectiveInstanceSettings")
            .field("registry_version", &self.registry_version)
            .field("keys", &self.settings.keys().collect::<Vec<_>>())
            .finish()
    }
}

#[derive(Clone)]
pub struct InstanceSettingsRepository {
    pool: DatabasePool,
    operation_timeout: Duration,
}

impl InstanceSettingsRepository {
    pub fn new(
        pool: DatabasePool,
        operation_timeout: Duration,
    ) -> Result<Self, InstanceSettingsError> {
        validate_operation_timeout(operation_timeout)?;
        Ok(Self {
            pool,
            operation_timeout,
        })
    }

    /// Atomically materializes every registry key on an empty Instance.
    /// Once any complete set exists, PostgreSQL wins and bootstrap inputs are ignored.
    pub async fn materialize(
        &self,
        bootstrap: &InstanceSettingBootstrap,
    ) -> Result<EffectiveInstanceSettings, InstanceSettingsError> {
        time::timeout(self.operation_timeout, self.materialize_inner(bootstrap))
            .await
            .map_err(|_| InstanceSettingsError::OperationTimeout)?
    }

    pub async fn load(&self) -> Result<EffectiveInstanceSettings, InstanceSettingsError> {
        time::timeout(self.operation_timeout, self.load_inner())
            .await
            .map_err(|_| InstanceSettingsError::OperationTimeout)?
    }

    async fn materialize_inner(
        &self,
        bootstrap: &InstanceSettingBootstrap,
    ) -> Result<EffectiveInstanceSettings, InstanceSettingsError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;
        transaction
            .execute("LOCK TABLE instance_settings IN SHARE ROW EXCLUSIVE MODE")
            .await
            .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;

        let rows = fetch_rows(&mut transaction).await?;
        let effective = if rows.is_empty() {
            insert_complete_set(&mut transaction, bootstrap).await?
        } else if let Some(version) = homogeneous_previous_version(&rows) {
            upgrade_registry(&mut transaction, rows, version).await?
        } else {
            decode_complete_set(rows)?
        };
        transaction
            .commit()
            .await
            .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;
        Ok(effective)
    }

    async fn load_inner(&self) -> Result<EffectiveInstanceSettings, InstanceSettingsError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;
        let rows = sqlx::query_as::<_, SettingRow>(
            "SELECT key, registry_version, value::text, bootstrap_origin, lock_version \
             FROM instance_settings ORDER BY key",
        )
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;
        decode_complete_set(rows)
    }
}

fn homogeneous_previous_version(rows: &[SettingRow]) -> Option<u16> {
    let version = u16::try_from(rows.first()?.1).ok()?;
    (version > 0
        && version < INSTANCE_SETTING_REGISTRY_VERSION
        && rows
            .iter()
            .all(|row| u16::try_from(row.1).ok() == Some(version)))
    .then_some(version)
}

async fn upgrade_registry(
    transaction: &mut Transaction<'_, Postgres>,
    rows: Vec<SettingRow>,
    previous_version: u16,
) -> Result<EffectiveInstanceSettings, InstanceSettingsError> {
    decode_set_for_version(rows, previous_version)?;
    for definition in INSTANCE_SETTING_DEFINITIONS
        .iter()
        .filter(|definition| definition.introduced_in > previous_version)
    {
        if definition.sensitivity == SettingSensitivity::Secret {
            return Err(InstanceSettingsError::SecretPersistenceForbidden);
        }
        let value = definition
            .validated_default()
            .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?
            .ok_or(InstanceSettingsError::InvalidPersistedValue)?;
        sqlx::query(
            "INSERT INTO instance_settings \
             (key, registry_version, value, bootstrap_origin) \
             VALUES ($1, $2, $3::jsonb, 'default')",
        )
        .bind(definition.key)
        .bind(
            i16::try_from(INSTANCE_SETTING_REGISTRY_VERSION)
                .map_err(|_| InstanceSettingsError::UnsupportedRegistryVersion)?,
        )
        .bind(value.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;
    }
    sqlx::query(
        "UPDATE instance_settings SET registry_version = $1, updated_at = transaction_timestamp()",
    )
    .bind(
        i16::try_from(INSTANCE_SETTING_REGISTRY_VERSION)
            .map_err(|_| InstanceSettingsError::UnsupportedRegistryVersion)?,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;
    decode_complete_set(fetch_rows(transaction).await?)
}

fn validate_operation_timeout(timeout: Duration) -> Result<(), InstanceSettingsError> {
    if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&timeout) {
        return Err(InstanceSettingsError::InvalidOperationTimeout);
    }
    Ok(())
}

async fn fetch_rows(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Vec<SettingRow>, InstanceSettingsError> {
    sqlx::query_as::<_, SettingRow>(
        "SELECT key, registry_version, value::text, bootstrap_origin, lock_version \
         FROM instance_settings ORDER BY key",
    )
    .fetch_all(&mut **transaction)
    .await
    .map_err(|_| InstanceSettingsError::PersistenceUnavailable)
}

async fn insert_complete_set(
    transaction: &mut Transaction<'_, Postgres>,
    bootstrap: &InstanceSettingBootstrap,
) -> Result<EffectiveInstanceSettings, InstanceSettingsError> {
    bootstrap
        .validate()
        .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?;
    let mut resolved = BTreeMap::new();
    for definition in INSTANCE_SETTING_DEFINITIONS {
        if definition.sensitivity == SettingSensitivity::Secret {
            return Err(InstanceSettingsError::SecretPersistenceForbidden);
        }
        let (value, origin) = bootstrap
            .resolve(definition)
            .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?;
        resolved.insert(definition.key, (value, origin));
    }
    validate_policy_values(resolved.iter().map(|(key, (value, _origin))| (*key, value)))
        .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?;

    let mut settings = BTreeMap::new();
    for definition in INSTANCE_SETTING_DEFINITIONS {
        let (value, origin) = resolved
            .remove(definition.key)
            .ok_or(InstanceSettingsError::InvalidPersistedValue)?;
        sqlx::query(
            "INSERT INTO instance_settings \
             (key, registry_version, value, bootstrap_origin) \
             VALUES ($1, $2, $3::jsonb, $4)",
        )
        .bind(definition.key)
        .bind(
            i16::try_from(INSTANCE_SETTING_REGISTRY_VERSION)
                .map_err(|_| InstanceSettingsError::UnsupportedRegistryVersion)?,
        )
        .bind(value.to_string())
        .bind(origin.as_str())
        .execute(&mut **transaction)
        .await
        .map_err(|_| InstanceSettingsError::PersistenceUnavailable)?;
        settings.insert(
            definition.key,
            EffectiveInstanceSetting {
                key: definition.key,
                value,
                lock_version: 1,
                bootstrap_origin: origin.into(),
                apply_mode: definition.apply_mode,
            },
        );
    }
    Ok(EffectiveInstanceSettings {
        registry_version: INSTANCE_SETTING_REGISTRY_VERSION,
        settings,
    })
}

pub(crate) fn decode_complete_set(
    rows: Vec<SettingRow>,
) -> Result<EffectiveInstanceSettings, InstanceSettingsError> {
    decode_set_for_version(rows, INSTANCE_SETTING_REGISTRY_VERSION)
}

pub(crate) fn validate_complete_values(
    values: &BTreeMap<String, Value>,
) -> Result<(), InstanceSettingsError> {
    if values.len() != INSTANCE_SETTING_DEFINITIONS.len() {
        return Err(InstanceSettingsError::IncompletePersistedSet);
    }
    for (key, value) in values {
        let definition =
            instance_setting_definition(key).ok_or(InstanceSettingsError::UnknownPersistedKey)?;
        if definition.sensitivity == SettingSensitivity::Secret {
            return Err(InstanceSettingsError::SecretPersistenceForbidden);
        }
        definition
            .validate(value)
            .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?;
    }
    validate_policy_values(values.iter().map(|(key, value)| (key.as_str(), value)))
        .map_err(|_| InstanceSettingsError::InvalidPersistedValue)
}

fn decode_set_for_version(
    rows: Vec<SettingRow>,
    registry_version: u16,
) -> Result<EffectiveInstanceSettings, InstanceSettingsError> {
    let expected_count = INSTANCE_SETTING_DEFINITIONS
        .iter()
        .filter(|definition| definition.introduced_in <= registry_version)
        .count();
    if rows.len() != expected_count {
        return Err(InstanceSettingsError::IncompletePersistedSet);
    }
    let mut seen = BTreeSet::new();
    let mut settings = BTreeMap::new();
    for (key, row_registry_version, value, origin, lock_version) in rows {
        let definition =
            instance_setting_definition(&key).ok_or(InstanceSettingsError::UnknownPersistedKey)?;
        if definition.introduced_in > registry_version {
            return Err(InstanceSettingsError::UnsupportedRegistryVersion);
        }
        if definition.sensitivity == SettingSensitivity::Secret {
            return Err(InstanceSettingsError::SecretPersistenceForbidden);
        }
        if row_registry_version != i16::try_from(registry_version).unwrap_or(-1) {
            return Err(InstanceSettingsError::UnsupportedRegistryVersion);
        }
        if lock_version < 1 || !seen.insert(definition.key) {
            return Err(InstanceSettingsError::InvalidPersistedValue);
        }
        let value: Value = serde_json::from_str(&value)
            .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?;
        definition
            .validate(&value)
            .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?;
        settings.insert(
            definition.key,
            EffectiveInstanceSetting {
                key: definition.key,
                value,
                lock_version: u64::try_from(lock_version)
                    .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?,
                bootstrap_origin: PersistedBootstrapOrigin::parse(&origin)?,
                apply_mode: definition.apply_mode,
            },
        );
    }
    if registry_version == INSTANCE_SETTING_REGISTRY_VERSION {
        validate_policy_values(
            settings
                .iter()
                .map(|(key, setting)| (*key, setting.value())),
        )
        .map_err(|_| InstanceSettingsError::InvalidPersistedValue)?;
    }
    Ok(EffectiveInstanceSettings {
        registry_version,
        settings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_timeout_is_bounded() {
        assert_eq!(
            validate_operation_timeout(Duration::from_millis(99)),
            Err(InstanceSettingsError::InvalidOperationTimeout)
        );
        assert!(validate_operation_timeout(Duration::from_millis(100)).is_ok());
        assert!(validate_operation_timeout(Duration::from_secs(30)).is_ok());
        assert_eq!(
            validate_operation_timeout(Duration::from_secs(31)),
            Err(InstanceSettingsError::InvalidOperationTimeout)
        );
    }

    #[test]
    fn effective_debug_omits_values() {
        let setting = EffectiveInstanceSetting {
            key: "security.mfa_enforcement",
            value: Value::String("must-not-appear".to_owned()),
            lock_version: 1,
            bootstrap_origin: PersistedBootstrapOrigin::Default,
            apply_mode: SettingApplyMode::Live,
        };
        let debug = format!("{setting:?}");
        assert!(!debug.contains("must-not-appear"));
        assert!(debug.contains("[REDACTED]"));
    }
}
