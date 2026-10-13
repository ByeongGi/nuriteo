use std::borrow::Cow;
use std::fmt;
use std::time::Duration;

use sqlx::SqlSafeStr;
use sqlx::migrate::{MigrateError, Migration, MigrationType, Migrator};
use sqlx::pool::PoolConnection;
use sqlx::{PgConnection, Postgres};
use tokio::time::{self, Instant};

use super::{DatabaseError, DatabaseErrorCategory, DatabasePool, classify_error};

const FRAMEWORK_BASELINE_SQL: &str = include_str!("../../migrations/0001_framework_baseline.sql");
const IDENTITY_CORE_SQL: &str = include_str!("../../migrations/0002_identity_core.sql");
const SESSIONS_AND_AUDIT_SQL: &str = include_str!("../../migrations/0003_sessions_and_audit.sql");
const ACTIVATION_INVITATIONS_SQL: &str =
    include_str!("../../migrations/0004_activation_invitations.sql");
const AUTH_LOCKOUT_SQL: &str = include_str!("../../migrations/0005_auth_lockout.sql");
const PERSONAL_STORAGE_SCOPES_SQL: &str =
    include_str!("../../migrations/0006_personal_storage_scopes.sql");
const ORGANIZATIONS_SQL: &str = include_str!("../../migrations/0007_organizations.sql");
const ORGANIZATION_INVITATIONS_SQL: &str =
    include_str!("../../migrations/0008_organization_invitations.sql");
const ORGANIZATION_STORAGE_SCOPES_SQL: &str =
    include_str!("../../migrations/0009_organization_storage_scopes.sql");
const PROJECTS_SQL: &str = include_str!("../../migrations/0010_projects.sql");
const PROJECT_DELETION_INVARIANTS_SQL: &str =
    include_str!("../../migrations/0011_project_deletion_invariants.sql");
const PROJECT_MUTATION_INVARIANTS_SQL: &str =
    include_str!("../../migrations/0012_project_mutation_invariants.sql");
const PROJECT_USER_ROLES_SQL: &str = include_str!("../../migrations/0013_project_user_roles.sql");
const PROJECT_BUNDLES_SQL: &str = include_str!("../../migrations/0014_project_bundles.sql");
const SINGLE_PUT_IDEMPOTENCY_SQL: &str =
    include_str!("../../migrations/0015_single_put_idempotency.sql");
const MULTIPART_LIFECYCLE_SQL: &str = include_str!("../../migrations/0016_multipart_lifecycle.sql");
const SAVE_CLEANUP_SQL: &str = include_str!("../../migrations/0017_save_cleanup.sql");
const EXPLICIT_PROJECT_VERSIONS_SQL: &str =
    include_str!("../../migrations/0018_explicit_project_versions.sql");
const PROJECT_HISTORY_PROMOTIONS_SQL: &str =
    include_str!("../../migrations/0019_project_history_promotions.sql");
const SAVE_UPLOAD_LEASES_SQL: &str = include_str!("../../migrations/0020_save_upload_leases.sql");
const ORGANIZATION_MEMBER_LIMIT_SQL: &str =
    include_str!("../../migrations/0021_organization_member_limit.sql");
const INSTANCE_SETTINGS_SQL: &str = include_str!("../../migrations/0022_instance_settings.sql");
const ADMIN_LIFECYCLE_INVARIANTS_SQL: &str =
    include_str!("../../migrations/0023_admin_lifecycle_invariants.sql");
const TEAM_CORE_SQL: &str = include_str!("../../migrations/0024_team_core.sql");
const NOTIFICATIONS_SQL: &str = include_str!("../../migrations/0025_notifications.sql");
const INTEGRATION_SECRETS_SQL: &str = include_str!("../../migrations/0026_integration_secrets.sql");
const NOTIFICATION_DELIVERY_WORKER_SQL: &str =
    include_str!("../../migrations/0027_notification_delivery_worker.sql");
const OIDC_PROVIDERS_SQL: &str = include_str!("../../migrations/0028_oidc_providers.sql");
const MFA_TOTP_SQL: &str = include_str!("../../migrations/0029_mfa_totp.sql");
const OIDC_PROTOCOL_VALIDATION_SQL: &str =
    include_str!("../../migrations/0030_oidc_protocol_validation.sql");
const MFA_CHALLENGES_SQL: &str = include_str!("../../migrations/0031_mfa_challenges.sql");
const OIDC_AUTHORIZATION_CODE_SQL: &str =
    include_str!("../../migrations/0032_oidc_authorization_code.sql");
const MFA_POLICY_SQL: &str = include_str!("../../migrations/0033_mfa_policy.sql");
const OIDC_IDENTITY_LINKING_SQL: &str =
    include_str!("../../migrations/0034_oidc_identity_linking.sql");
const NOTIFICATION_INBOX_PREFERENCES_SQL: &str =
    include_str!("../../migrations/0035_notification_inbox_preferences.sql");
const POLICY_MAINTENANCE_WORKERS_SQL: &str =
    include_str!("../../migrations/0036_policy_maintenance_workers.sql");
const ACCESS_TOKENS_SQL: &str = include_str!("../../migrations/0037_access_tokens.sql");
const ACCESS_TOKEN_RUNTIME_SQL: &str =
    include_str!("../../migrations/0038_access_token_runtime.sql");
const GIT_PROVIDERS_SQL: &str = include_str!("../../migrations/0039_git_providers.sql");
const REGISTRY_GATEWAY_SQL: &str = include_str!("../../migrations/0040_registry_gateway.sql");
const GIT_USER_OPERATIONS_SQL: &str = include_str!("../../migrations/0041_git_user_operations.sql");
const PUBLISHED_EXAMPLES_SQL: &str = include_str!("../../migrations/0042_published_examples.sql");
const PUBLISHED_EXAMPLE_FORKS_SQL: &str =
    include_str!("../../migrations/0043_published_example_forks.sql");
const GIT_WORKING_HEAD_MATERIALIZATIONS_SQL: &str =
    include_str!("../../migrations/0044_git_working_head_materializations.sql");
const INVITATION_DELIVERY_TOKENS_SQL: &str =
    include_str!("../../migrations/0045_invitation_delivery_tokens.sql");
const PUBLIC_PREVIEW_RATE_LIMITS_SQL: &str =
    include_str!("../../migrations/0046_public_preview_rate_limits.sql");
const BACKUP_MANIFEST_STATE_SQL: &str =
    include_str!("../../migrations/0047_backup_manifest_state.sql");
const BACKUP_SYNCHRONIZED_SNAPSHOT_SQL: &str =
    include_str!("../../migrations/0048_backup_synchronized_snapshot.sql");
const INSTANCE_RECOVERY_STATE_SQL: &str =
    include_str!("../../migrations/0049_instance_recovery_state.sql");
const BACKUP_OPERATIONS_SQL: &str = include_str!("../../migrations/0050_backup_operations.sql");

// Two-key advisory locks use a namespace distinct from PostgreSQL's one-key
// bigint locks. 0x4e555249 is the ASCII representation of "NURI".
const ADVISORY_LOCK_NAMESPACE: i32 = 0x4e55_5249;
const ADVISORY_LOCK_KEY: i32 = 2;
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(25);
const LOCK_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_LOCK_WAIT_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(300);
const MIN_EXECUTION_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_EXECUTION_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// Bounded runtime policy for one explicit migration invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationOptions {
    lock_wait_timeout: Duration,
    execution_timeout: Duration,
}

impl MigrationOptions {
    pub fn new(
        lock_wait_timeout: Duration,
        execution_timeout: Duration,
    ) -> Result<Self, MigrationError> {
        if !(MIN_LOCK_WAIT_TIMEOUT..=MAX_LOCK_WAIT_TIMEOUT).contains(&lock_wait_timeout) {
            return Err(MigrationError::InvalidLockWaitTimeout);
        }
        if !(MIN_EXECUTION_TIMEOUT..=MAX_EXECUTION_TIMEOUT).contains(&execution_timeout) {
            return Err(MigrationError::InvalidExecutionTimeout);
        }
        Ok(Self {
            lock_wait_timeout,
            execution_timeout,
        })
    }
}

/// Stable result returned by the explicit migration boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationReport {
    pub latest_version: Option<i64>,
    pub known_migrations: usize,
}

/// Applies the migrations embedded in the server binary.
///
/// This function is intentionally not called by the application `serve` path.
/// Deployment orchestration must invoke it through the dedicated migration
/// command before rolling out application replicas.
pub async fn run_embedded_migrations(
    pool: &DatabasePool,
    options: MigrationOptions,
) -> Result<MigrationReport, MigrationError> {
    let migrator = embedded_migrator();
    run_migrator(pool, options, &migrator).await
}

pub(super) fn embedded_migrator() -> Migrator {
    migrator_without_driver_lock(vec![
        Migration::new(
            1,
            Cow::Borrowed("framework baseline"),
            MigrationType::Simple,
            FRAMEWORK_BASELINE_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            2,
            Cow::Borrowed("identity core"),
            MigrationType::Simple,
            IDENTITY_CORE_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            3,
            Cow::Borrowed("sessions and audit"),
            MigrationType::Simple,
            SESSIONS_AND_AUDIT_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            4,
            Cow::Borrowed("activation invitations"),
            MigrationType::Simple,
            ACTIVATION_INVITATIONS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            5,
            Cow::Borrowed("authentication lockout"),
            MigrationType::Simple,
            AUTH_LOCKOUT_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            6,
            Cow::Borrowed("personal storage scopes"),
            MigrationType::Simple,
            PERSONAL_STORAGE_SCOPES_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            7,
            Cow::Borrowed("organizations"),
            MigrationType::Simple,
            ORGANIZATIONS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            8,
            Cow::Borrowed("organization invitations"),
            MigrationType::Simple,
            ORGANIZATION_INVITATIONS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            9,
            Cow::Borrowed("organization storage scopes"),
            MigrationType::Simple,
            ORGANIZATION_STORAGE_SCOPES_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            10,
            Cow::Borrowed("projects"),
            MigrationType::Simple,
            PROJECTS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            11,
            Cow::Borrowed("project deletion invariants"),
            MigrationType::Simple,
            PROJECT_DELETION_INVARIANTS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            12,
            Cow::Borrowed("project mutation invariants"),
            MigrationType::Simple,
            PROJECT_MUTATION_INVARIANTS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            13,
            Cow::Borrowed("project user roles"),
            MigrationType::Simple,
            PROJECT_USER_ROLES_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            14,
            Cow::Borrowed("project bundles"),
            MigrationType::Simple,
            PROJECT_BUNDLES_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            15,
            Cow::Borrowed("single PUT idempotency"),
            MigrationType::Simple,
            SINGLE_PUT_IDEMPOTENCY_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            16,
            Cow::Borrowed("multipart lifecycle"),
            MigrationType::Simple,
            MULTIPART_LIFECYCLE_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            17,
            Cow::Borrowed("save cleanup"),
            MigrationType::Simple,
            SAVE_CLEANUP_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            18,
            Cow::Borrowed("explicit project versions"),
            MigrationType::Simple,
            EXPLICIT_PROJECT_VERSIONS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            19,
            Cow::Borrowed("project history promotions"),
            MigrationType::Simple,
            PROJECT_HISTORY_PROMOTIONS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            20,
            Cow::Borrowed("save upload leases"),
            MigrationType::Simple,
            SAVE_UPLOAD_LEASES_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            21,
            Cow::Borrowed("organization member limit"),
            MigrationType::Simple,
            ORGANIZATION_MEMBER_LIMIT_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            22,
            Cow::Borrowed("instance settings"),
            MigrationType::Simple,
            INSTANCE_SETTINGS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            23,
            Cow::Borrowed("admin lifecycle invariants"),
            MigrationType::Simple,
            ADMIN_LIFECYCLE_INVARIANTS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            24,
            Cow::Borrowed("team core"),
            MigrationType::Simple,
            TEAM_CORE_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            25,
            Cow::Borrowed("notifications and email outbox"),
            MigrationType::Simple,
            NOTIFICATIONS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            26,
            Cow::Borrowed("integration credentials and CA bundles"),
            MigrationType::Simple,
            INTEGRATION_SECRETS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            27,
            Cow::Borrowed("notification delivery worker invariants"),
            MigrationType::Simple,
            NOTIFICATION_DELIVERY_WORKER_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            28,
            Cow::Borrowed("global OIDC providers"),
            MigrationType::Simple,
            OIDC_PROVIDERS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            29,
            Cow::Borrowed("MFA TOTP credentials and recovery codes"),
            MigrationType::Simple,
            MFA_TOTP_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            30,
            Cow::Borrowed("OIDC protocol validation proof"),
            MigrationType::Simple,
            OIDC_PROTOCOL_VALIDATION_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            31,
            Cow::Borrowed("MFA challenge replay and lockout state"),
            MigrationType::Simple,
            MFA_CHALLENGES_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            32,
            Cow::Borrowed("OIDC authorization code and PKCE attempts"),
            MigrationType::Simple,
            OIDC_AUTHORIZATION_CODE_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            33,
            Cow::Borrowed("MFA enforcement policy and enrollment deadlines"),
            MigrationType::Simple,
            MFA_POLICY_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            34,
            Cow::Borrowed("OIDC identity linking"),
            MigrationType::Simple,
            OIDC_IDENTITY_LINKING_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            35,
            Cow::Borrowed("notification inbox preferences and administrator receipts"),
            MigrationType::Simple,
            NOTIFICATION_INBOX_PREFERENCES_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            36,
            Cow::Borrowed("policy maintenance worker leases"),
            MigrationType::Simple,
            POLICY_MAINTENANCE_WORKERS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            37,
            Cow::Borrowed("hash-only access tokens"),
            MigrationType::Simple,
            ACCESS_TOKENS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            38,
            Cow::Borrowed("access token runtime controls"),
            MigrationType::Simple,
            ACCESS_TOKEN_RUNTIME_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            39,
            Cow::Borrowed("Git provider host bindings"),
            MigrationType::Simple,
            GIT_PROVIDERS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            40,
            Cow::Borrowed("multi-registry gateway"),
            MigrationType::Simple,
            REGISTRY_GATEWAY_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            41,
            Cow::Borrowed("user Git credentials and operations"),
            MigrationType::Simple,
            GIT_USER_OPERATIONS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            42,
            Cow::Borrowed("immutable Published Examples"),
            MigrationType::Simple,
            PUBLISHED_EXAMPLES_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            43,
            Cow::Borrowed("atomic Published Example forks"),
            MigrationType::Simple,
            PUBLISHED_EXAMPLE_FORKS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            44,
            Cow::Borrowed("Git Working Head materializations"),
            MigrationType::Simple,
            GIT_WORKING_HEAD_MATERIALIZATIONS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            45,
            Cow::Borrowed("one-attempt invitation delivery credentials"),
            MigrationType::Simple,
            INVITATION_DELIVERY_TOKENS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            46,
            Cow::Borrowed("shared Public Preview rate limits"),
            MigrationType::Simple,
            PUBLIC_PREVIEW_RATE_LIMITS_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            47,
            Cow::Borrowed("backup manifest state and retention"),
            MigrationType::Simple,
            BACKUP_MANIFEST_STATE_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            48,
            Cow::Borrowed("backup synchronized PostgreSQL snapshot"),
            MigrationType::Simple,
            BACKUP_SYNCHRONIZED_SNAPSHOT_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            49,
            Cow::Borrowed("instance recovery state"),
            MigrationType::Simple,
            INSTANCE_RECOVERY_STATE_SQL.into_sql_str(),
            false,
        ),
        Migration::new(
            50,
            Cow::Borrowed("backup schedule and operation queue"),
            MigrationType::Simple,
            BACKUP_OPERATIONS_SQL.into_sql_str(),
            false,
        ),
    ])
}

fn migrator_without_driver_lock(migrations: Vec<sqlx::migrate::Migration>) -> Migrator {
    let mut migrator = Migrator::with_migrations(migrations);
    // NURITEO owns locking below so the namespace, deadline, cancellation and
    // connection ownership contract remain stable across SQLx releases.
    migrator.set_locking(false);
    migrator
}

async fn run_migrator(
    pool: &DatabasePool,
    options: MigrationOptions,
    migrator: &Migrator,
) -> Result<MigrationReport, MigrationError> {
    let connection = pool.acquire().await.map_err(MigrationError::Database)?;
    let mut lock = AdvisoryLock::new(connection);
    lock.acquire(options.lock_wait_timeout).await?;

    let migration_result = time::timeout(
        options.execution_timeout,
        migrator.run_direct(None, lock.connection(), false),
    )
    .await;

    let migration_result = match migration_result {
        Ok(result) => result.map_err(map_migration_error),
        Err(_) => return Err(MigrationError::ExecutionTimeout),
    };

    lock.release().await?;
    migration_result?;

    Ok(MigrationReport {
        latest_version: migrator.iter().map(|migration| migration.version).max(),
        known_migrations: migrator.iter().count(),
    })
}

struct AdvisoryLock {
    connection: PoolConnection<Postgres>,
    possibly_owns_lock: bool,
}

impl AdvisoryLock {
    const fn new(connection: PoolConnection<Postgres>) -> Self {
        Self {
            connection,
            possibly_owns_lock: false,
        }
    }

    fn connection(&mut self) -> &mut PgConnection {
        &mut self.connection
    }

    async fn acquire(&mut self, wait_timeout: Duration) -> Result<(), MigrationError> {
        let deadline = Instant::now() + wait_timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(MigrationError::LockWaitTimeout);
            }

            // If this future is cancelled after PostgreSQL grants the lock but
            // before the response is observed, the connection must be closed.
            self.possibly_owns_lock = true;
            let acquired = time::timeout(
                remaining,
                sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_lock($1, $2)")
                    .bind(ADVISORY_LOCK_NAMESPACE)
                    .bind(ADVISORY_LOCK_KEY)
                    .fetch_one(&mut *self.connection),
            )
            .await
            .map_err(|_| MigrationError::LockOperationTimeout)?
            .map_err(|error| MigrationError::LockFailed(classify_error(&error)))?;

            if acquired {
                return Ok(());
            }
            self.possibly_owns_lock = false;

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(MigrationError::LockWaitTimeout);
            }
            time::sleep(LOCK_POLL_INTERVAL.min(remaining)).await;
        }
    }

    async fn release(mut self) -> Result<(), MigrationError> {
        let released = time::timeout(
            LOCK_RELEASE_TIMEOUT,
            sqlx::query_scalar::<_, bool>("SELECT pg_advisory_unlock($1, $2)")
                .bind(ADVISORY_LOCK_NAMESPACE)
                .bind(ADVISORY_LOCK_KEY)
                .fetch_one(&mut *self.connection),
        )
        .await
        .map_err(|_| MigrationError::LockReleaseFailed)?
        .map_err(|_| MigrationError::LockReleaseFailed)?;

        if !released {
            return Err(MigrationError::LockOwnershipLost);
        }
        self.possibly_owns_lock = false;
        Ok(())
    }
}

impl Drop for AdvisoryLock {
    fn drop(&mut self) {
        if self.possibly_owns_lock {
            // A session-level advisory lock survives transaction rollback. A
            // possibly owning connection must never return to the pool.
            self.connection.close_on_drop();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationError {
    InvalidLockWaitTimeout,
    InvalidExecutionTimeout,
    Database(DatabaseError),
    LockWaitTimeout,
    LockOperationTimeout,
    LockFailed(DatabaseErrorCategory),
    LockReleaseFailed,
    LockOwnershipLost,
    ExecutionTimeout,
    ExecutionFailed {
        version: Option<i64>,
        category: DatabaseErrorCategory,
    },
    ChecksumMismatch {
        version: i64,
    },
    AppliedVersionMissing {
        version: i64,
    },
    DirtyVersion {
        version: i64,
    },
    InvalidHistory {
        version: i64,
    },
    Internal,
}

impl fmt::Display for MigrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLockWaitTimeout => {
                formatter.write_str("migration lock wait timeout is invalid")
            }
            Self::InvalidExecutionTimeout => {
                formatter.write_str("migration execution timeout is invalid")
            }
            Self::Database(error) => write!(formatter, "migration database access failed: {error}"),
            Self::LockWaitTimeout => formatter.write_str("migration advisory lock wait timed out"),
            Self::LockOperationTimeout => {
                formatter.write_str("migration advisory lock operation timed out")
            }
            Self::LockFailed(category) => {
                write!(formatter, "migration advisory lock failed ({category})")
            }
            Self::LockReleaseFailed => {
                formatter.write_str("migration advisory lock release failed")
            }
            Self::LockOwnershipLost => {
                formatter.write_str("migration advisory lock ownership was lost")
            }
            Self::ExecutionTimeout => formatter.write_str("migration execution timed out"),
            Self::ExecutionFailed { version, category } => match version {
                Some(version) => write!(
                    formatter,
                    "migration {version} execution failed ({category})"
                ),
                None => write!(formatter, "migration execution failed ({category})"),
            },
            Self::ChecksumMismatch { version } => {
                write!(formatter, "migration {version} checksum does not match")
            }
            Self::AppliedVersionMissing { version } => write!(
                formatter,
                "applied migration {version} is missing from this binary"
            ),
            Self::DirtyVersion { version } => {
                write!(formatter, "migration {version} is marked incomplete")
            }
            Self::InvalidHistory { version } => write!(
                formatter,
                "migration history is invalid at version {version}"
            ),
            Self::Internal => formatter.write_str("migration failed due to an internal error"),
        }
    }
}

impl std::error::Error for MigrationError {}

fn map_migration_error(error: MigrateError) -> MigrationError {
    match error {
        MigrateError::Execute(source) => MigrationError::ExecutionFailed {
            version: None,
            category: classify_error(&source),
        },
        MigrateError::ExecuteMigration(source, version) => MigrationError::ExecutionFailed {
            version: Some(version),
            category: classify_error(&source),
        },
        MigrateError::VersionMismatch(version) => MigrationError::ChecksumMismatch { version },
        MigrateError::VersionMissing(version) => MigrationError::AppliedVersionMissing { version },
        MigrateError::Dirty(version) => MigrationError::DirtyVersion { version },
        MigrateError::VersionNotPresent(version)
        | MigrateError::VersionTooOld(version, _)
        | MigrateError::VersionTooNew(version, _) => MigrationError::InvalidHistory { version },
        _ => MigrationError::Internal,
    }
}

#[cfg(test)]
mod tests;
