mod audit_service;
mod backup_service;
mod http_routes;
mod http_service;
mod maintenance;
mod operations_service;
mod support_bundle;
mod update;

use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::time::Duration;

use serde_json::json;
use sqlx::{Acquire, Postgres, Row, Transaction};
use time::OffsetDateTime;
use tokio::time as tokio_time;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::database::DatabasePool;
use crate::identity::{
    SessionId, Timestamp, UserId, UserStatus, acquire_mfa_population_lock,
    has_required_active_local_enrolled_admin,
};

pub use audit_service::{
    AdminAuditEventCollectionView, AdminAuditEventView, AdminAuditExportFormat,
    AdminAuditExportInput, AdminAuditExportView, AdminAuditListInput, AdminAuditRetentionPreview,
    AdminAuditRetentionPruneView,
};
pub use backup_service::{
    AdminBackupAlertView, AdminBackupConsoleView, AdminBackupOperationRequest,
    AdminBackupOperationView, AdminBackupPolicyUpdate, AdminBackupPolicyView,
    AdminBackupRestorePointView,
};
pub(crate) use http_routes::openapi_router;
pub use http_service::{
    AdminHttpPolicy, AdminHttpService, AdminHttpServiceError, AdminSettingConstraintView,
    AdminSettingListView, AdminSettingView, AdminStatusView,
};
pub use maintenance::AdminMaintenanceView;
pub use operations_service::{
    AdminCleanupQueueView, AdminDependencyStatusView, AdminOperationsState, AdminOperationsView,
    AdminSupportBundlePreviewView, AdminUsageView,
};
pub use support_bundle::{
    AdminSupportBundleConfigurationView, AdminSupportBundleDiagnosticView,
    AdminSupportBundleIntegrationView, AdminSupportBundleReleaseView, AdminSupportBundleView,
};
pub use update::{
    AdminUpdateApprovalView, AdminUpdateCompatibilityView, AdminUpdateHistoryView,
    AdminUpdatePreflightView, AdminUpdateReadinessView,
};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_REAUTHENTICATION_MAX_AGE: Duration = Duration::from_secs(30 * 60);
const MIN_REAUTHENTICATION_MAX_AGE: Duration = Duration::from_secs(15 * 60);
const MAX_REAUTHENTICATION_MAX_AGE: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdminLifecyclePolicy {
    operation_timeout: Duration,
    reauthentication_max_age: Duration,
}

impl AdminLifecyclePolicy {
    pub fn new(
        operation_timeout: Duration,
        reauthentication_max_age: Duration,
    ) -> Result<Self, AdminLifecycleError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout)
            || !(MIN_REAUTHENTICATION_MAX_AGE..=MAX_REAUTHENTICATION_MAX_AGE)
                .contains(&reauthentication_max_age)
        {
            return Err(AdminLifecycleError::InvalidInput);
        }
        Ok(Self {
            operation_timeout,
            reauthentication_max_age,
        })
    }
}

impl Default for AdminLifecyclePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
            reauthentication_max_age: DEFAULT_REAUTHENTICATION_MAX_AGE,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdminLifecycleActor {
    user_id: UserId,
    session_id: SessionId,
}

impl AdminLifecycleActor {
    #[must_use]
    pub const fn new(user_id: UserId, session_id: SessionId) -> Self {
        Self {
            user_id,
            session_id,
        }
    }

    #[must_use]
    pub const fn user_id(self) -> UserId {
        self.user_id
    }
}

#[derive(Clone)]
pub struct AdminLifecycleAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    correlation_id: String,
    source_ip: Option<IpAddr>,
}

impl AdminLifecycleAuditContext {
    #[must_use]
    pub fn new(
        event_id: AuditEventId,
        actor_user_id: UserId,
        correlation_id: String,
        source_ip: Option<IpAddr>,
    ) -> Self {
        Self {
            event_id,
            actor_user_id,
            correlation_id,
            source_ip,
        }
    }
}

impl fmt::Debug for AdminLifecycleAuditContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AdminLifecycleAuditContext")
            .field("event_id", &self.event_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminLifecycleChange {
    Changed { revoked_sessions: u64 },
    Unchanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AdminLifecycleError {
    InvalidInput,
    Unauthorized,
    ReauthenticationRequired,
    TargetUnavailable,
    LastAdministrator,
    LastOrganizationOwner,
    AuditUnavailable,
    DatabaseUnavailable,
    OperationTimeout,
    InvariantViolation,
}

impl fmt::Display for AdminLifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "administrator lifecycle input is invalid",
            Self::Unauthorized => "administrator lifecycle operation is not authorized",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::TargetUnavailable => "administrator lifecycle target is unavailable",
            Self::LastAdministrator => "instance must retain an active administrator",
            Self::LastOrganizationOwner => "organization must retain an active owner",
            Self::AuditUnavailable => "administrator lifecycle audit persistence is unavailable",
            Self::DatabaseUnavailable => "administrator lifecycle persistence is unavailable",
            Self::OperationTimeout => "administrator lifecycle operation timed out",
            Self::InvariantViolation => "administrator lifecycle state is invalid",
        })
    }
}

impl std::error::Error for AdminLifecycleError {}

#[derive(Clone)]
pub struct AdminLifecycleService {
    pool: DatabasePool,
    policy: AdminLifecyclePolicy,
}

impl AdminLifecycleService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: AdminLifecyclePolicy) -> Self {
        Self { pool, policy }
    }

    pub async fn promote(
        &self,
        actor: AdminLifecycleActor,
        target_user_id: UserId,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<AdminLifecycleChange, AdminLifecycleError> {
        self.change_admin(actor, target_user_id, true, audit).await
    }

    pub async fn demote(
        &self,
        actor: AdminLifecycleActor,
        target_user_id: UserId,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<AdminLifecycleChange, AdminLifecycleError> {
        self.change_admin(actor, target_user_id, false, audit).await
    }

    pub async fn disable(
        &self,
        actor: AdminLifecycleActor,
        target_user_id: UserId,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<AdminLifecycleChange, AdminLifecycleError> {
        self.change_status(actor, target_user_id, UserStatus::Disabled, audit)
            .await
    }

    pub async fn reactivate(
        &self,
        actor: AdminLifecycleActor,
        target_user_id: UserId,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<AdminLifecycleChange, AdminLifecycleError> {
        self.change_status(actor, target_user_id, UserStatus::Active, audit)
            .await
    }

    async fn change_admin(
        &self,
        actor: AdminLifecycleActor,
        target_user_id: UserId,
        enabled: bool,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<AdminLifecycleChange, AdminLifecycleError> {
        self.ensure_audit_actor(actor, audit)?;
        self.within_deadline(self.change_admin_inner(actor, target_user_id, enabled, audit))
            .await
    }

    async fn change_status(
        &self,
        actor: AdminLifecycleActor,
        target_user_id: UserId,
        status: UserStatus,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<AdminLifecycleChange, AdminLifecycleError> {
        self.ensure_audit_actor(actor, audit)?;
        self.within_deadline(self.change_status_inner(actor, target_user_id, status, audit))
            .await
    }

    async fn change_admin_inner(
        &self,
        actor: AdminLifecycleActor,
        target_user_id: UserId,
        enabled: bool,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<AdminLifecycleChange, AdminLifecycleError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
        acquire_mfa_population_lock(&mut transaction)
            .await
            .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
        let actor_display_name = authorize_actor(
            &mut transaction,
            actor,
            self.policy.reauthentication_max_age,
        )
        .await?;
        let (target_status, target_is_admin) =
            lock_target(&mut transaction, target_user_id).await?;
        if enabled && target_status != "active" {
            return Err(AdminLifecycleError::TargetUnavailable);
        }
        if target_is_admin == enabled {
            return Ok(AdminLifecycleChange::Unchanged);
        }
        if !enabled && target_status == "active" {
            ensure_another_active_administrator(&mut transaction, target_user_id).await?;
        }
        let result = sqlx::query(
            "UPDATE users SET is_instance_admin = $2, updated_at = transaction_timestamp() \
             WHERE id = $1::uuid",
        )
        .bind(target_user_id.to_string())
        .bind(enabled)
        .execute(&mut *transaction)
        .await
        .map_err(lifecycle_write_error)?;
        if result.rows_affected() != 1 {
            return Err(AdminLifecycleError::InvariantViolation);
        }
        ensure_mfa_admin_safety(&mut transaction).await?;
        let action = if enabled {
            "instance.administrator_promoted"
        } else {
            "instance.administrator_demoted"
        };
        append_audit(
            &mut transaction,
            audit,
            actor_display_name,
            target_user_id,
            action,
            vec!["is_instance_admin".into()],
            0,
        )
        .await?;
        commit(transaction).await?;
        Ok(AdminLifecycleChange::Changed {
            revoked_sessions: 0,
        })
    }

    async fn change_status_inner(
        &self,
        actor: AdminLifecycleActor,
        target_user_id: UserId,
        status: UserStatus,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<AdminLifecycleChange, AdminLifecycleError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
        acquire_mfa_population_lock(&mut transaction)
            .await
            .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
        let actor_display_name = authorize_actor(
            &mut transaction,
            actor,
            self.policy.reauthentication_max_age,
        )
        .await?;
        let (target_status, target_is_admin) =
            lock_target(&mut transaction, target_user_id).await?;
        let requested = match status {
            UserStatus::Active => "active",
            UserStatus::Disabled => "disabled",
        };
        if target_status == requested {
            return Ok(AdminLifecycleChange::Unchanged);
        }
        if status == UserStatus::Disabled {
            if target_is_admin {
                ensure_another_active_administrator(&mut transaction, target_user_id).await?;
            }
            ensure_not_last_active_owner(&mut transaction, target_user_id).await?;
        }
        let result =
            match status {
                UserStatus::Active => {
                    sqlx::query(
                        "UPDATE users SET status = 'active', disabled_at = NULL, \
                     updated_at = transaction_timestamp() WHERE id = $1::uuid",
                    )
                    .bind(target_user_id.to_string())
                    .execute(&mut *transaction)
                    .await
                }
                UserStatus::Disabled => sqlx::query(
                    "UPDATE users SET status = 'disabled', disabled_at = transaction_timestamp(), \
                     updated_at = transaction_timestamp() WHERE id = $1::uuid",
                )
                .bind(target_user_id.to_string())
                .execute(&mut *transaction)
                .await,
            }
            .map_err(lifecycle_write_error)?;
        if result.rows_affected() != 1 {
            return Err(AdminLifecycleError::InvariantViolation);
        }
        let revoked_sessions = if status == UserStatus::Disabled {
            sqlx::query(
                "UPDATE sessions SET revoked_at = transaction_timestamp(), \
                 revocation_reason = 'user_disabled' \
                 WHERE user_id = $1::uuid AND revoked_at IS NULL",
            )
            .bind(target_user_id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?
            .rows_affected()
        } else {
            0
        };
        ensure_mfa_admin_safety(&mut transaction).await?;
        let action = match status {
            UserStatus::Active => "instance.user_reactivated",
            UserStatus::Disabled => "instance.user_disabled",
        };
        let mut changed_fields = vec!["status".into()];
        if status == UserStatus::Disabled {
            changed_fields.push("sessions".into());
        }
        append_audit(
            &mut transaction,
            audit,
            actor_display_name,
            target_user_id,
            action,
            changed_fields,
            revoked_sessions,
        )
        .await?;
        commit(transaction).await?;
        Ok(AdminLifecycleChange::Changed { revoked_sessions })
    }

    async fn within_deadline<T>(
        &self,
        operation: impl Future<Output = Result<T, AdminLifecycleError>>,
    ) -> Result<T, AdminLifecycleError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| AdminLifecycleError::OperationTimeout)?
    }

    fn ensure_audit_actor(
        &self,
        actor: AdminLifecycleActor,
        audit: &AdminLifecycleAuditContext,
    ) -> Result<(), AdminLifecycleError> {
        if audit.actor_user_id != actor.user_id {
            return Err(AdminLifecycleError::InvalidInput);
        }
        Ok(())
    }
}

async fn ensure_mfa_admin_safety(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<(), AdminLifecycleError> {
    let safe = has_required_active_local_enrolled_admin(transaction)
        .await
        .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
    if safe {
        Ok(())
    } else {
        Err(AdminLifecycleError::LastAdministrator)
    }
}

async fn authorize_actor(
    transaction: &mut Transaction<'_, Postgres>,
    actor: AdminLifecycleActor,
    reauthentication_max_age: Duration,
) -> Result<String, AdminLifecycleError> {
    let row = sqlx::query(
        "SELECT actor.display_name, session.last_reauthenticated_at, transaction_timestamp() AS now \
         FROM users actor \
         JOIN sessions session ON session.user_id = actor.id AND session.id = $2::uuid \
         WHERE actor.id = $1::uuid AND actor.status = 'active' AND actor.is_instance_admin \
           AND session.revoked_at IS NULL \
           AND session.idle_expires_at > transaction_timestamp() \
           AND session.absolute_expires_at > transaction_timestamp() \
         FOR UPDATE OF actor, session",
    )
    .bind(actor.user_id.to_string())
    .bind(actor.session_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?
    .ok_or(AdminLifecycleError::Unauthorized)?;
    let display_name: String = row
        .try_get("display_name")
        .map_err(|_| AdminLifecycleError::InvariantViolation)?;
    let reauthenticated_at: Option<OffsetDateTime> = row
        .try_get("last_reauthenticated_at")
        .map_err(|_| AdminLifecycleError::InvariantViolation)?;
    let now: OffsetDateTime = row
        .try_get("now")
        .map_err(|_| AdminLifecycleError::InvariantViolation)?;
    let seconds = i64::try_from(reauthentication_max_age.as_secs())
        .map_err(|_| AdminLifecycleError::InvalidInput)?;
    let cutoff = now - time::Duration::seconds(seconds);
    if !reauthenticated_at.is_some_and(|at| at >= cutoff && at <= now) {
        return Err(AdminLifecycleError::ReauthenticationRequired);
    }
    Ok(display_name)
}

async fn lock_target(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(String, bool), AdminLifecycleError> {
    sqlx::query_as("SELECT status, is_instance_admin FROM users WHERE id = $1::uuid FOR UPDATE")
        .bind(user_id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?
        .ok_or(AdminLifecycleError::TargetUnavailable)
}

async fn ensure_another_active_administrator(
    transaction: &mut Transaction<'_, Postgres>,
    target_user_id: UserId,
) -> Result<(), AdminLifecycleError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users \
         WHERE id <> $1::uuid AND status = 'active' AND is_instance_admin)",
    )
    .bind(target_user_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
    if !exists {
        return Err(AdminLifecycleError::LastAdministrator);
    }
    Ok(())
}

async fn ensure_not_last_active_owner(
    transaction: &mut Transaction<'_, Postgres>,
    target_user_id: UserId,
) -> Result<(), AdminLifecycleError> {
    let is_last: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM organization_memberships target \
           WHERE target.user_id = $1::uuid AND target.role = 'owner' \
             AND NOT EXISTS( \
               SELECT 1 FROM organization_memberships other \
               JOIN users other_user ON other_user.id = other.user_id \
               WHERE other.organization_id = target.organization_id \
                 AND other.user_id <> target.user_id \
                 AND other.role = 'owner' AND other_user.status = 'active' \
             ) \
         )",
    )
    .bind(target_user_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
    if is_last {
        return Err(AdminLifecycleError::LastOrganizationOwner);
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "audit fields are explicit security context"
)]
async fn append_audit(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &AdminLifecycleAuditContext,
    actor_display_name: String,
    target_user_id: UserId,
    action: &str,
    changed_fields: Vec<String>,
    revoked_sessions: u64,
) -> Result<(), AdminLifecycleError> {
    let occurred_at: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| AdminLifecycleError::DatabaseUnavailable)?;
    let event = AuditEvent::new(AuditEventFields {
        id: audit.event_id,
        occurred_at: Timestamp::from_datetime(occurred_at)
            .map_err(|_| AdminLifecycleError::InvariantViolation)?,
        actor: AuditActor {
            kind: ActorType::User,
            id: audit.actor_user_id.to_string(),
            user_id: Some(audit.actor_user_id),
            display_name: Some(actor_display_name),
        },
        action_code: action.into(),
        target: AuditTarget {
            kind: "user".into(),
            id: target_user_id.to_string(),
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: "instance".into(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: audit.correlation_id.clone(),
        source_ip: audit.source_ip,
        schema_version: 1,
        changed_fields,
        metadata: AuditMetadata::new(json!({
            "source": "admin-lifecycle-service",
            "revoked_sessions": revoked_sessions
        }))
        .map_err(|_| AdminLifecycleError::InvalidInput)?,
    })
    .map_err(|_| AdminLifecycleError::InvalidInput)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| AdminLifecycleError::AuditUnavailable)
}

async fn commit(transaction: Transaction<'_, Postgres>) -> Result<(), AdminLifecycleError> {
    transaction.commit().await.map_err(lifecycle_write_error)
}

fn lifecycle_write_error(error: sqlx::Error) -> AdminLifecycleError {
    let constraint = error
        .as_database_error()
        .and_then(|database| database.constraint());
    match constraint {
        Some("users_last_active_instance_admin") => AdminLifecycleError::LastAdministrator,
        Some("users_last_active_organization_owner")
        | Some("organization_memberships_last_active_owner") => {
            AdminLifecycleError::LastOrganizationOwner
        }
        _ => AdminLifecycleError::DatabaseUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_bounds_operation_and_reauthentication_windows() {
        assert_eq!(
            AdminLifecyclePolicy::new(Duration::from_millis(99), Duration::from_secs(1800)),
            Err(AdminLifecycleError::InvalidInput)
        );
        assert_eq!(
            AdminLifecyclePolicy::new(Duration::from_secs(5), Duration::from_secs(899)),
            Err(AdminLifecycleError::InvalidInput)
        );
        assert_eq!(
            AdminLifecyclePolicy::new(Duration::from_secs(5), Duration::from_secs(7201)),
            Err(AdminLifecycleError::InvalidInput)
        );
        assert!(
            AdminLifecyclePolicy::new(Duration::from_secs(5), Duration::from_secs(1800)).is_ok()
        );
    }

    #[test]
    fn errors_and_audit_debug_are_context_free() {
        let user_id = UserId::new();
        let audit = AdminLifecycleAuditContext::new(
            AuditEventId::new(),
            user_id,
            "request-secret-free".into(),
            None,
        );
        assert!(!format!("{audit:?}").contains("request-secret-free"));
        for error in [
            AdminLifecycleError::Unauthorized,
            AdminLifecycleError::ReauthenticationRequired,
            AdminLifecycleError::LastAdministrator,
            AdminLifecycleError::LastOrganizationOwner,
            AdminLifecycleError::DatabaseUnavailable,
        ] {
            assert!(!error.to_string().contains(&user_id.to_string()));
        }
    }
}
