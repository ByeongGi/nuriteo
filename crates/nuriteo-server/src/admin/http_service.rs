use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Acquire, Postgres, Row, Transaction};
use time::OffsetDateTime;
use tokio::time as tokio_time;
use url::Url;
use utoipa::ToSchema;

use crate::VERSION;
use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::config::{
    INSTANCE_SETTING_REGISTRY_VERSION, SettingApplyMode, SettingSensitivity,
    instance_setting_definition,
};
use crate::database::{DatabasePool, SchemaReadiness, check_schema_readiness};
use crate::identity::{
    BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionPolicy,
    SessionService, SessionServiceError, Timestamp, UserId,
};
use crate::instance_settings::{EffectiveInstanceSettings, InstanceSettingsRepository};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdminHttpPolicy {
    pub(super) operation_timeout: Duration,
}

impl AdminHttpPolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, AdminHttpServiceError> {
        if !(Duration::from_millis(100)..=Duration::from_secs(30)).contains(&operation_timeout) {
            return Err(AdminHttpServiceError::Configuration);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for AdminHttpPolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminHttpServiceError {
    AuthenticationFailed,
    Forbidden,
    ReauthenticationRequired,
    InvalidSetting,
    InvalidAuditQuery,
    SettingNotFound,
    AuditEventNotFound,
    PreconditionFailed,
    AuditExportTooLarge,
    AuditUnavailable,
    Unavailable,
    OperationTimeout,
    Configuration,
    Internal,
}

impl fmt::Display for AdminHttpServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "administrator authentication failed",
            Self::Forbidden => "administrator request was forbidden",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::InvalidSetting => "instance setting is invalid",
            Self::InvalidAuditQuery => "audit query is invalid",
            Self::SettingNotFound => "instance setting was not found",
            Self::AuditEventNotFound => "audit event was not found",
            Self::PreconditionFailed => "instance setting version is stale",
            Self::AuditExportTooLarge => "audit export exceeds the response limit",
            Self::AuditUnavailable => "instance setting audit persistence is unavailable",
            Self::Unavailable => "administrator service is unavailable",
            Self::OperationTimeout => "administrator operation timed out",
            Self::Configuration => "administrator service configuration is invalid",
            Self::Internal => "administrator operation failed",
        })
    }
}

impl std::error::Error for AdminHttpServiceError {}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminSettingView {
    pub key: String,
    pub value: Value,
    pub version: u64,
    pub apply_mode: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminSettingListView {
    pub registry_version: u16,
    pub items: Vec<AdminSettingView>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminStatusView {
    pub release_version: String,
    pub schema_version: i64,
    pub setting_registry_version: u16,
    pub setting_count: usize,
    pub restart_required: bool,
}

#[derive(Clone)]
pub struct AdminHttpService {
    runtime: Option<Arc<AdminRuntime>>,
}

pub(super) struct AdminRuntime {
    pub(super) pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    startup_settings: EffectiveInstanceSettings,
    pub(super) policy: AdminHttpPolicy,
}

impl fmt::Debug for AdminHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AdminHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl AdminHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        policy: AdminHttpPolicy,
        session_policy: SessionPolicy,
        startup_settings: EffectiveInstanceSettings,
    ) -> Result<Self, AdminHttpServiceError> {
        let cookies = BrowserCookieBoundary::new(external_url)
            .map_err(|_| AdminHttpServiceError::Configuration)?;
        Ok(Self {
            runtime: Some(Arc::new(AdminRuntime {
                sessions: SessionService::new(pool.clone(), session_policy),
                pool,
                cookies,
                startup_settings,
                policy,
            })),
        })
    }

    pub(crate) async fn list_settings(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdminSettingListView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        runtime.authenticate(request).await?;
        let settings =
            InstanceSettingsRepository::new(runtime.pool.clone(), runtime.policy.operation_timeout)
                .map_err(|_| AdminHttpServiceError::Configuration)?
                .load()
                .await
                .map_err(|_| AdminHttpServiceError::Unavailable)?;
        settings_view(&settings)
    }

    pub(crate) async fn status(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdminStatusView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        runtime.authenticate(request).await?;
        runtime
            .within_timeout(async {
                let schema_version = match check_schema_readiness(&runtime.pool).await {
                    Ok(SchemaReadiness::Ready { version }) => version,
                    _ => return Err(AdminHttpServiceError::Unavailable),
                };
                let current = InstanceSettingsRepository::new(
                    runtime.pool.clone(),
                    runtime.policy.operation_timeout,
                )
                .map_err(|_| AdminHttpServiceError::Configuration)?
                .load()
                .await
                .map_err(|_| AdminHttpServiceError::Unavailable)?;
                Ok(AdminStatusView {
                    release_version: VERSION.into(),
                    schema_version,
                    setting_registry_version: current.registry_version(),
                    setting_count: current.len(),
                    restart_required: restart_required(&runtime.startup_settings, &current),
                })
            })
            .await
    }

    pub(crate) async fn update_setting(
        &self,
        request: BrowserRequestHeaders<'_>,
        key: &str,
        value: Value,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<AdminSettingView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        let definition =
            instance_setting_definition(key).ok_or(AdminHttpServiceError::SettingNotFound)?;
        if definition.sensitivity != SettingSensitivity::Public
            || definition.validate(&value).is_err()
        {
            return Err(AdminHttpServiceError::InvalidSetting);
        }
        runtime
            .within_timeout(runtime.update_setting(
                session,
                definition,
                value,
                expected_version,
                correlation_id,
            ))
            .await
    }

    pub(super) fn runtime(&self) -> Result<&AdminRuntime, AdminHttpServiceError> {
        self.runtime
            .as_deref()
            .ok_or(AdminHttpServiceError::Unavailable)
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct AdminSession {
    pub(super) user_id: UserId,
    pub(super) session_id: crate::identity::SessionId,
}

impl AdminRuntime {
    pub(super) async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdminSession, AdminHttpServiceError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(map_browser_error)?
            .into_session_token();
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_session_error)?;
        let identity = AdminSession {
            user_id: session.user_id(),
            session_id: session.id(),
        };
        self.within_timeout(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| AdminHttpServiceError::Unavailable)?;
            let authorized: Option<bool> = sqlx::query_scalar(
                "SELECT status = 'active' AND is_instance_admin FROM users WHERE id = $1::uuid",
            )
            .bind(identity.user_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| AdminHttpServiceError::Unavailable)?;
            match authorized {
                Some(true) => Ok(()),
                Some(false) => Err(AdminHttpServiceError::Forbidden),
                None => Err(AdminHttpServiceError::AuthenticationFailed),
            }
        })
        .await?;
        Ok(identity)
    }

    async fn update_setting(
        &self,
        session: AdminSession,
        definition: &'static crate::config::InstanceSettingDefinition,
        value: Value,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<AdminSettingView, AdminHttpServiceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| AdminHttpServiceError::Unavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| AdminHttpServiceError::Unavailable)?;
        let actor = authorize_recent_admin(&mut transaction, session).await?;
        let row: Option<(i16, String, i64)> = sqlx::query_as(
            "SELECT registry_version, value::text, lock_version FROM instance_settings \
             WHERE key = $1 FOR UPDATE",
        )
        .bind(definition.key)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
        let (registry_version, current_json, lock_version) =
            row.ok_or(AdminHttpServiceError::SettingNotFound)?;
        if registry_version != i16::try_from(INSTANCE_SETTING_REGISTRY_VERSION).unwrap_or(-1) {
            return Err(AdminHttpServiceError::Internal);
        }
        let expected = i64::try_from(expected_version)
            .map_err(|_| AdminHttpServiceError::PreconditionFailed)?;
        if lock_version != expected {
            return Err(AdminHttpServiceError::PreconditionFailed);
        }
        let current: Value =
            serde_json::from_str(&current_json).map_err(|_| AdminHttpServiceError::Internal)?;
        if current == value {
            transaction
                .commit()
                .await
                .map_err(|_| AdminHttpServiceError::Unavailable)?;
            return setting_view(definition, value, expected_version);
        }
        let row: (String, i64) = sqlx::query_as(
            "UPDATE instance_settings SET value = $2::jsonb, lock_version = lock_version + 1, \
             updated_at = transaction_timestamp() WHERE key = $1 AND lock_version = $3 \
             RETURNING value::text, lock_version",
        )
        .bind(definition.key)
        .bind(value.to_string())
        .bind(expected)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?
        .ok_or(AdminHttpServiceError::PreconditionFailed)?;
        let updated_value: Value =
            serde_json::from_str(&row.0).map_err(|_| AdminHttpServiceError::Internal)?;
        append_setting_audit(&mut transaction, &actor, definition.key, correlation_id).await?;
        transaction
            .commit()
            .await
            .map_err(|_| AdminHttpServiceError::Unavailable)?;
        setting_view(
            definition,
            updated_value,
            u64::try_from(row.1).map_err(|_| AdminHttpServiceError::Internal)?,
        )
    }

    pub(super) async fn within_timeout<T>(
        &self,
        operation: impl Future<Output = Result<T, AdminHttpServiceError>>,
    ) -> Result<T, AdminHttpServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| AdminHttpServiceError::OperationTimeout)?
    }
}

pub(super) struct AuditActorIdentity {
    pub(super) user_id: UserId,
    pub(super) display_name: String,
    pub(super) occurred_at: Timestamp,
}

pub(super) async fn authorize_recent_admin(
    transaction: &mut Transaction<'_, Postgres>,
    session: AdminSession,
) -> Result<AuditActorIdentity, AdminHttpServiceError> {
    let row = sqlx::query(
        "SELECT actor.display_name, active.last_reauthenticated_at, transaction_timestamp() AS now \
         FROM users actor JOIN sessions active ON active.user_id = actor.id \
         WHERE actor.id = $1::uuid AND active.id = $2::uuid \
           AND actor.status = 'active' AND actor.is_instance_admin \
           AND active.revoked_at IS NULL \
           AND active.idle_expires_at > transaction_timestamp() \
           AND active.absolute_expires_at > transaction_timestamp() \
         FOR UPDATE OF actor, active",
    )
    .bind(session.user_id.to_string())
    .bind(session.session_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?
    .ok_or(AdminHttpServiceError::Forbidden)?;
    let now: OffsetDateTime = row
        .try_get("now")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let last: Option<OffsetDateTime> = row
        .try_get("last_reauthenticated_at")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let policy_json: Option<String> = sqlx::query_scalar(
        "SELECT value::text FROM instance_settings \
         WHERE key = 'security.reauthentication_window_minutes' FOR SHARE",
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let policy_value: Value = serde_json::from_str(
        policy_json
            .as_deref()
            .ok_or(AdminHttpServiceError::Internal)?,
    )
    .map_err(|_| AdminHttpServiceError::Internal)?;
    let definition = instance_setting_definition("security.reauthentication_window_minutes")
        .ok_or(AdminHttpServiceError::Internal)?;
    definition
        .validate(&policy_value)
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let minutes = policy_value
        .as_u64()
        .ok_or(AdminHttpServiceError::Internal)?;
    let seconds = minutes
        .checked_mul(60)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or(AdminHttpServiceError::Internal)?;
    if !last.is_some_and(|value| value >= now - time::Duration::seconds(seconds) && value <= now) {
        return Err(AdminHttpServiceError::ReauthenticationRequired);
    }
    Ok(AuditActorIdentity {
        user_id: session.user_id,
        display_name: row
            .try_get("display_name")
            .map_err(|_| AdminHttpServiceError::Internal)?,
        occurred_at: Timestamp::from_datetime(now).map_err(|_| AdminHttpServiceError::Internal)?,
    })
}

async fn append_setting_audit(
    transaction: &mut Transaction<'_, Postgres>,
    actor: &AuditActorIdentity,
    key: &str,
    correlation_id: &str,
) -> Result<(), AdminHttpServiceError> {
    let event = AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at: actor.occurred_at,
        actor: AuditActor {
            kind: ActorType::User,
            id: actor.user_id.to_string(),
            user_id: Some(actor.user_id),
            display_name: Some(actor.display_name.clone()),
        },
        action_code: "instance.setting_updated".into(),
        target: AuditTarget {
            kind: "instance_setting".into(),
            id: key.into(),
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: "instance".into(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec![key.into()],
        metadata: AuditMetadata::new(json!({"source": "admin-settings-api"}))
            .map_err(|_| AdminHttpServiceError::Internal)?,
    })
    .map_err(|_| AdminHttpServiceError::InvalidSetting)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| AdminHttpServiceError::AuditUnavailable)
}

fn settings_view(
    settings: &EffectiveInstanceSettings,
) -> Result<AdminSettingListView, AdminHttpServiceError> {
    let items = settings
        .iter()
        .map(|setting| {
            let definition = instance_setting_definition(setting.key())
                .ok_or(AdminHttpServiceError::Internal)?;
            setting_view(definition, setting.value().clone(), setting.lock_version())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(AdminSettingListView {
        registry_version: settings.registry_version(),
        items,
    })
}

fn setting_view(
    definition: &'static crate::config::InstanceSettingDefinition,
    value: Value,
    version: u64,
) -> Result<AdminSettingView, AdminHttpServiceError> {
    if definition.sensitivity != SettingSensitivity::Public {
        return Err(AdminHttpServiceError::Internal);
    }
    Ok(AdminSettingView {
        key: definition.key.into(),
        value,
        version,
        apply_mode: apply_mode_name(definition.apply_mode).into(),
    })
}

fn apply_mode_name(mode: SettingApplyMode) -> &'static str {
    match mode {
        SettingApplyMode::Live => "live",
        SettingApplyMode::NewRuntime => "new_runtime",
        SettingApplyMode::ServerRestart => "server_restart",
    }
}

fn restart_required(
    startup: &EffectiveInstanceSettings,
    current: &EffectiveInstanceSettings,
) -> bool {
    current.iter().any(|setting| {
        setting.apply_mode() == SettingApplyMode::ServerRestart
            && startup
                .get(setting.key())
                .is_none_or(|original| original.value() != setting.value())
    })
}

fn map_browser_error(error: BrowserCookieError) -> AdminHttpServiceError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            AdminHttpServiceError::AuthenticationFailed
        }
        _ => AdminHttpServiceError::Forbidden,
    }
}

fn map_session_error(error: SessionServiceError) -> AdminHttpServiceError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            AdminHttpServiceError::AuthenticationFailed
        }
        SessionServiceError::OperationTimeout => AdminHttpServiceError::OperationTimeout,
        SessionServiceError::DatabaseUnavailable => AdminHttpServiceError::Unavailable,
        _ => AdminHttpServiceError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_is_bounded_and_errors_are_context_free() {
        assert!(AdminHttpPolicy::default().operation_timeout <= Duration::from_secs(30));
        assert_eq!(
            AdminHttpPolicy::new(Duration::from_millis(99)),
            Err(AdminHttpServiceError::Configuration)
        );
        assert!(
            !AdminHttpServiceError::InvalidSetting
                .to_string()
                .contains("value")
        );
    }

    #[test]
    fn bootstrap_type_remains_value_free_in_debug() {
        let bootstrap = crate::config::InstanceSettingBootstrap::empty();
        assert!(!format!("{bootstrap:?}").contains("password"));
    }
}
