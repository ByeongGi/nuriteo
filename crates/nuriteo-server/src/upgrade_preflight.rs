use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::INSTANCE_SETTING_REGISTRY_VERSION;
use crate::database::{DatabasePool, SchemaReadiness, check_schema_readiness};
use crate::instance_settings::InstanceSettingsRepository;

const COMPATIBILITY_MANIFEST: &str =
    include_str!("../../../compat/self-hosted-upgrade-compatibility-v1.json");
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityManifest {
    schema_version: u8,
    task_id: String,
    release_lineage: String,
    support: SupportContract,
    schema: SchemaContract,
    configuration: ConfigurationContract,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupportContract {
    upgrade_to: String,
    direction: String,
    downgrade: String,
    failure_policy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaContract {
    engine: String,
    source_migration: i64,
    history_policy: String,
    candidate_policy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationContract {
    registry_version: u16,
    persisted_authority: String,
    unknown_key_policy: String,
    future_registry_policy: String,
    compatibility: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpgradeSchemaState {
    UpgradeRequired,
    PartiallyApplied,
    AlreadyCurrent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradePreflightReport {
    status: &'static str,
    release_lineage: &'static str,
    source_migration: i64,
    current_migration: i64,
    target_migration: i64,
    schema_state: UpgradeSchemaState,
    configuration_registry_version: u16,
}

impl UpgradePreflightReport {
    #[must_use]
    pub const fn current_migration(&self) -> i64 {
        self.current_migration
    }

    #[must_use]
    pub const fn target_migration(&self) -> i64 {
        self.target_migration
    }

    #[must_use]
    pub const fn schema_state(&self) -> UpgradeSchemaState {
        self.schema_state
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeCompatibilityContract {
    pub release_lineage: String,
    pub target_release: String,
    pub source_migration: i64,
    pub configuration_registry_version: u16,
}

pub fn compatibility_contract() -> Result<UpgradeCompatibilityContract, UpgradePreflightError> {
    let manifest = parse_manifest()?;
    Ok(UpgradeCompatibilityContract {
        release_lineage: manifest.release_lineage,
        target_release: manifest.support.upgrade_to,
        source_migration: manifest.schema.source_migration,
        configuration_registry_version: manifest.configuration.registry_version,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpgradePreflightError {
    Manifest,
    Database,
    FreshDatabase,
    SchemaDirty,
    SchemaChecksumMismatch,
    SchemaUnsupported,
    SchemaSourceUnsupported,
    ConfigurationRegistry,
}

impl UpgradePreflightError {
    #[must_use]
    pub const fn category(self) -> &'static str {
        match self {
            Self::Manifest => "manifest",
            Self::Database => "database-operation",
            Self::FreshDatabase => "fresh-database",
            Self::SchemaDirty => "schema-dirty",
            Self::SchemaChecksumMismatch => "schema-checksum-mismatch",
            Self::SchemaUnsupported => "schema-unsupported",
            Self::SchemaSourceUnsupported => "schema-source-unsupported",
            Self::ConfigurationRegistry => "configuration-registry",
        }
    }
}

impl fmt::Display for UpgradePreflightError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "upgrade preflight stopped ({})", self.category())
    }
}

impl std::error::Error for UpgradePreflightError {}

pub async fn execute(pool: &DatabasePool) -> Result<UpgradePreflightReport, UpgradePreflightError> {
    let manifest = parse_manifest()?;
    let readiness = check_schema_readiness(pool)
        .await
        .map_err(|_| UpgradePreflightError::Database)?;
    let (current_migration, target_migration, schema_state) =
        evaluate_schema(readiness, manifest.schema.source_migration)?;

    // `load` is deliberately read-only. Registry upgrades remain owned by the
    // later migration/serve lifecycle after this command has succeeded.
    let settings = InstanceSettingsRepository::new(pool.clone(), SETTINGS_TIMEOUT)
        .map_err(|_| UpgradePreflightError::ConfigurationRegistry)?
        .load()
        .await
        .map_err(|_| UpgradePreflightError::ConfigurationRegistry)?;
    if settings.registry_version() != manifest.configuration.registry_version {
        return Err(UpgradePreflightError::ConfigurationRegistry);
    }

    Ok(UpgradePreflightReport {
        status: "compatible",
        release_lineage: "nuriteo-self-hosted-v1",
        source_migration: manifest.schema.source_migration,
        current_migration,
        target_migration,
        schema_state,
        configuration_registry_version: settings.registry_version(),
    })
}

fn parse_manifest() -> Result<CompatibilityManifest, UpgradePreflightError> {
    let manifest: CompatibilityManifest = serde_json::from_str(COMPATIBILITY_MANIFEST)
        .map_err(|_| UpgradePreflightError::Manifest)?;
    let valid = manifest.schema_version == 1
        && manifest.task_id == "UPG-001"
        && manifest.release_lineage == "nuriteo-self-hosted-v1"
        && manifest.support.upgrade_to == "self-hosted-v1-rc-lineage"
        && manifest.support.direction == "forward-only"
        && manifest.support.downgrade == "not-supported"
        && manifest.support.failure_policy == "stop-before-mutation"
        && manifest.schema.engine == "postgresql"
        && manifest.schema.source_migration > 0
        && manifest.schema.history_policy == "exact-prefix-checksum"
        && manifest.schema.candidate_policy == "append-only"
        && manifest.configuration.registry_version == INSTANCE_SETTING_REGISTRY_VERSION
        && manifest.configuration.persisted_authority == "postgresql-after-bootstrap"
        && manifest.configuration.unknown_key_policy == "fail-closed"
        && manifest.configuration.future_registry_policy == "fail-closed"
        && manifest.configuration.compatibility == "exact-registry-version";
    if valid {
        Ok(manifest)
    } else {
        Err(UpgradePreflightError::Manifest)
    }
}

fn evaluate_schema(
    readiness: SchemaReadiness,
    source_migration: i64,
) -> Result<(i64, i64, UpgradeSchemaState), UpgradePreflightError> {
    match readiness {
        SchemaReadiness::Pending {
            current: Some(current),
            target,
        } if current == source_migration && target > current => {
            Ok((current, target, UpgradeSchemaState::UpgradeRequired))
        }
        SchemaReadiness::Pending {
            current: Some(current),
            target,
        } if current > source_migration && current < target => {
            Ok((current, target, UpgradeSchemaState::PartiallyApplied))
        }
        SchemaReadiness::Ready { version } if version >= source_migration => {
            Ok((version, version, UpgradeSchemaState::AlreadyCurrent))
        }
        SchemaReadiness::Pending { current: None, .. } => Err(UpgradePreflightError::FreshDatabase),
        SchemaReadiness::Dirty { .. } => Err(UpgradePreflightError::SchemaDirty),
        SchemaReadiness::ChecksumMismatch { .. } => {
            Err(UpgradePreflightError::SchemaChecksumMismatch)
        }
        SchemaReadiness::Unsupported { .. } => Err(UpgradePreflightError::SchemaUnsupported),
        SchemaReadiness::Pending { .. } | SchemaReadiness::Ready { .. } => {
            Err(UpgradePreflightError::SchemaSourceUnsupported)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_matches_compiled_configuration_contract() {
        let manifest = parse_manifest().unwrap();
        assert_eq!(manifest.schema.source_migration, 46);
        assert_eq!(manifest.configuration.registry_version, 4);
        let contract = compatibility_contract().unwrap();
        assert_eq!(contract.release_lineage, "nuriteo-self-hosted-v1");
        assert_eq!(contract.target_release, "self-hosted-v1-rc-lineage");
    }

    #[test]
    fn schema_preflight_accepts_direct_retry_and_completed_upgrade_states() {
        assert_eq!(
            evaluate_schema(
                SchemaReadiness::Pending {
                    current: Some(46),
                    target: 47,
                },
                46,
            ),
            Ok((46, 47, UpgradeSchemaState::UpgradeRequired))
        );
        assert_eq!(
            evaluate_schema(
                SchemaReadiness::Pending {
                    current: Some(47),
                    target: 48,
                },
                46,
            ),
            Ok((47, 48, UpgradeSchemaState::PartiallyApplied))
        );
        assert_eq!(
            evaluate_schema(SchemaReadiness::Ready { version: 47 }, 46),
            Ok((47, 47, UpgradeSchemaState::AlreadyCurrent))
        );
    }

    #[test]
    fn schema_preflight_stops_before_fresh_or_incompatible_histories() {
        let cases = [
            (
                SchemaReadiness::Pending {
                    current: None,
                    target: 47,
                },
                UpgradePreflightError::FreshDatabase,
            ),
            (
                SchemaReadiness::Pending {
                    current: Some(45),
                    target: 47,
                },
                UpgradePreflightError::SchemaSourceUnsupported,
            ),
            (
                SchemaReadiness::Dirty { version: 46 },
                UpgradePreflightError::SchemaDirty,
            ),
            (
                SchemaReadiness::ChecksumMismatch { version: 46 },
                UpgradePreflightError::SchemaChecksumMismatch,
            ),
            (
                SchemaReadiness::Unsupported { version: 99 },
                UpgradePreflightError::SchemaUnsupported,
            ),
        ];
        for (readiness, expected) in cases {
            assert_eq!(evaluate_schema(readiness, 46), Err(expected));
        }
    }
}
