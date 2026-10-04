use std::fmt;
use std::time::Duration;

use sqlx::{Acquire, Postgres, Transaction};
use subtle::ConstantTimeEq;
use tokio::time::{self, Instant};
use uuid::Uuid;

use crate::database::{DatabaseError, DatabasePool};
use crate::object_storage::{ObjectKey, ObjectStoreErrorKind, S3ObjectStore};
use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectVersion,
};
use crate::quota::QuotaRepository;

use super::VerifiedStagingBundle;

const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(600);
const SQL_MARGIN: Duration = Duration::from_millis(25);
const MAX_RECOVERY_CHECKPOINTS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkingHeadCommitPolicy {
    operation_timeout: Duration,
}

impl WorkingHeadCommitPolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, WorkingHeadCommitError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&operation_timeout) {
            return Err(WorkingHeadCommitError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommitWorkingHeadOutcome {
    bundle_id: Uuid,
    project_version: ProjectVersion,
}

impl CommitWorkingHeadOutcome {
    #[must_use]
    pub const fn bundle_id(self) -> Uuid {
        self.bundle_id
    }

    #[must_use]
    pub const fn project_version(self) -> ProjectVersion {
        self.project_version
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkingHeadCommitReconciliation {
    Committed(CommitWorkingHeadOutcome),
    NotCommitted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum WorkingHeadCommitError {
    InvalidInput,
    SessionNotFound,
    SessionUnavailable,
    SessionExpired,
    Unauthorized,
    StaleProjectVersion,
    ObjectMismatch,
    OperationTimeout,
    DatabaseUnavailable,
    StorageUnavailable,
    CommitOutcomeUnknown,
    InvariantViolation,
}

impl fmt::Display for WorkingHeadCommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Working Head commit input is invalid",
            Self::SessionNotFound => "Save session was not found",
            Self::SessionUnavailable => "Save session cannot be committed",
            Self::SessionExpired => "Save session has expired",
            Self::Unauthorized => "Save session is unavailable",
            Self::StaleProjectVersion => "project version is stale",
            Self::ObjectMismatch => "staging object no longer matches the verified Bundle",
            Self::OperationTimeout => "Working Head commit timed out",
            Self::DatabaseUnavailable => "Working Head persistence is unavailable",
            Self::StorageUnavailable => "staging object storage is unavailable",
            Self::CommitOutcomeUnknown => "Working Head commit outcome is unknown",
            Self::InvariantViolation => "Working Head persistence state is invalid",
        })
    }
}

impl std::error::Error for WorkingHeadCommitError {}

#[derive(Clone)]
pub struct WorkingHeadCommitService {
    pool: DatabasePool,
    store: S3ObjectStore,
    policy: WorkingHeadCommitPolicy,
}

impl fmt::Debug for WorkingHeadCommitService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkingHeadCommitService")
            .field("pool", &self.pool)
            .field("store", &self.store)
            .field("policy", &self.policy)
            .finish()
    }
}

impl WorkingHeadCommitService {
    #[must_use]
    pub fn new(pool: DatabasePool, store: S3ObjectStore, policy: WorkingHeadCommitPolicy) -> Self {
        Self {
            pool,
            store,
            policy,
        }
    }

    pub async fn commit(
        &self,
        capability: &VerifiedStagingBundle,
    ) -> Result<CommitWorkingHeadOutcome, WorkingHeadCommitError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure(&mut tx, deadline).await?;

        if !deadline
            .run(QuotaRepository::lock_storage_scope(
                &mut tx,
                capability.storage_scope_id(),
            ))
            .await?
            .map_err(map_sql_error)?
        {
            return Err(WorkingHeadCommitError::SessionNotFound);
        }

        type ProjectRow = (String, i64, Option<String>, Option<String>);
        let project: Option<ProjectRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT state,lock_version,project.working_head_bundle_id::text,head.object_key \
                     FROM projects project \
                     LEFT JOIN bundles head ON head.id=project.working_head_bundle_id \
                     WHERE project.id=$1::uuid AND project.storage_scope_id=$2::uuid \
                     FOR UPDATE OF project",
                )
                .bind(capability.project_id().to_string())
                .bind(capability.storage_scope_id().to_string())
                .fetch_optional(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        let Some((project_state, project_version, old_bundle_id, old_object_key)) = project else {
            return Err(WorkingHeadCommitError::SessionNotFound);
        };
        if project_state != "active" {
            return Err(WorkingHeadCommitError::SessionUnavailable);
        }

        type SessionRow = (
            String,
            String,
            Vec<u8>,
            i64,
            i64,
            i32,
            i64,
            String,
            bool,
            Option<String>,
        );
        let session: Option<SessionRow> = deadline.run(sqlx::query_as(
            "SELECT state,staging_object_key,expected_bundle_sha256,expected_physical_bytes,\
                    expected_logical_bytes,expected_file_count,expected_project_version,\
                    actor_user_id::text,expires_at<=transaction_timestamp(),committed_bundle_id::text \
             FROM save_sessions WHERE id=$1::uuid AND project_id=$2::uuid \
               AND storage_scope_id=$3::uuid FOR UPDATE"
        ).bind(capability.session_id().to_string())
            .bind(capability.project_id().to_string())
            .bind(capability.storage_scope_id().to_string())
            .fetch_optional(&mut *tx)).await?.map_err(map_sql_error)?;
        let Some(session) = session else {
            return Err(WorkingHeadCommitError::SessionNotFound);
        };
        validate_capability(capability, &session)?;

        let actor = session
            .7
            .parse()
            .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
        let role = deadline
            .run(ProjectAccessRepository::resolve_effective_role_for_update(
                &mut tx,
                capability.project_id(),
                actor,
            ))
            .await?
            .map_err(map_access_error)?;
        if role < EffectiveProjectRole::Write {
            return Err(WorkingHeadCommitError::Unauthorized);
        }

        if session.0 == "committed" {
            let outcome = committed_outcome(&mut tx, capability, &session, deadline).await?;
            commit_transaction(tx, deadline).await?;
            return Ok(outcome);
        }
        if session.0 != "verifying" {
            return Err(WorkingHeadCommitError::SessionUnavailable);
        }
        if session.8 {
            let affected = deadline
                .run(
                    sqlx::query(
                        "UPDATE save_sessions SET state='expired',terminal_at=transaction_timestamp(),\
                         updated_at=transaction_timestamp() WHERE id=$1::uuid AND state='verifying'",
                    )
                    .bind(capability.session_id().to_string())
                    .execute(&mut *tx),
                )
                .await?
                .map_err(map_sql_error)?
                .rows_affected();
            if affected != 1 {
                return Err(WorkingHeadCommitError::SessionUnavailable);
            }
            commit_transaction(tx, deadline).await?;
            return Err(WorkingHeadCommitError::SessionExpired);
        }
        if project_version != session.6 {
            let affected = deadline
                .run(
                    sqlx::query(
                        "UPDATE save_sessions SET state='failed',terminal_at=transaction_timestamp(),\
                         updated_at=transaction_timestamp() WHERE id=$1::uuid AND state='verifying'",
                    )
                    .bind(capability.session_id().to_string())
                    .execute(&mut *tx),
                )
                .await?
                .map_err(map_sql_error)?
                .rows_affected();
            if affected != 1 {
                return Err(WorkingHeadCommitError::SessionUnavailable);
            }
            commit_transaction(tx, deadline).await?;
            return Err(WorkingHeadCommitError::StaleProjectVersion);
        }

        // Serialize checksum deduplication before discovering the canonical
        // object key, then lock every participating object in one global
        // integer order. The namespace differs from object lifecycle locks.
        deadline
            .run(
                sqlx::query(
                    "SELECT pg_advisory_xact_lock(1347566130,hashtext(encode($1::bytea,'hex')))",
                )
                .bind(capability.archive_sha256().as_bytes().as_slice())
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        let deduplicated_object_key: Option<String> = deadline
            .run(
                sqlx::query_scalar("SELECT object_key FROM bundles WHERE sha256=$1")
                    .bind(capability.archive_sha256().as_bytes().as_slice())
                    .fetch_optional(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        let mut object_lock_keys: Vec<i32> = deadline
            .run(
                sqlx::query_scalar(
                    "SELECT DISTINCT hashtext('bundle-object:'||object_key) FROM \
                     unnest(ARRAY[$1,$2,$3]::text[]) object_key WHERE object_key IS NOT NULL",
                )
                .bind(old_object_key.as_deref())
                .bind(&session.1)
                .bind(deduplicated_object_key.as_deref())
                .fetch_all(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        object_lock_keys.sort_unstable();
        for lock_key in object_lock_keys {
            deadline
                .run(
                    sqlx::query("SELECT pg_advisory_xact_lock(1347566129,$1)")
                        .bind(lock_key)
                        .execute(&mut *tx),
                )
                .await?
                .map_err(map_sql_error)?;
        }

        let cleanup_exists: bool = deadline
            .run(
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM save_cleanup_jobs \
                     WHERE save_session_id=$1::uuid FOR UPDATE)",
                )
                .bind(capability.session_id().to_string())
                .fetch_one(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        if cleanup_exists {
            return Err(WorkingHeadCommitError::SessionUnavailable);
        }

        if let Err(error) = verify_object_head(&self.store, &session.1, capability, deadline).await
        {
            if error != WorkingHeadCommitError::ObjectMismatch {
                return Err(error);
            }
            let affected = deadline
                .run(
                    sqlx::query(
                        "UPDATE save_sessions SET state='failed',terminal_at=transaction_timestamp(),\
                         updated_at=transaction_timestamp() WHERE id=$1::uuid AND state='verifying'",
                    )
                    .bind(capability.session_id().to_string())
                    .execute(&mut *tx),
                )
                .await?
                .map_err(map_sql_error)?
                .rows_affected();
            if affected != 1 {
                return Err(WorkingHeadCommitError::SessionUnavailable);
            }
            commit_transaction(tx, deadline).await?;
            return Err(WorkingHeadCommitError::ObjectMismatch);
        }

        let candidate_bundle_id = Uuid::now_v7();
        let inserted = deadline
            .run(
                sqlx::query(
                    "INSERT INTO bundles \
             (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,\
              verification_state,verified_at,created_at) \
             VALUES ($1::uuid,$2,$3,$4,$5,$6,'project-bundle-v1','verified',\
                     transaction_timestamp(),transaction_timestamp()) \
             ON CONFLICT (sha256) DO NOTHING",
                )
                .bind(candidate_bundle_id.to_string())
                .bind(capability.archive_sha256().as_bytes().as_slice())
                .bind(&session.1)
                .bind(to_i64(capability.physical_bytes())?)
                .bind(to_i64(capability.logical_bytes())?)
                .bind(
                    i32::try_from(capability.file_count())
                        .map_err(|_| WorkingHeadCommitError::InvariantViolation)?,
                )
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();

        type BundleRow = (String, String, i64, i64, i32);
        let bundle: BundleRow = deadline
            .run(
                sqlx::query_as(
                    "SELECT id::text,object_key,physical_bytes,logical_bytes,file_count FROM bundles \
             WHERE sha256=$1",
                )
                .bind(capability.archive_sha256().as_bytes().as_slice())
                .fetch_one(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        if bundle.2 != to_i64(capability.physical_bytes())?
            || bundle.3 != to_i64(capability.logical_bytes())?
            || bundle.4
                != i32::try_from(capability.file_count())
                    .map_err(|_| WorkingHeadCommitError::InvariantViolation)?
        {
            return Err(WorkingHeadCommitError::InvariantViolation);
        }

        let bundle_id = bundle
            .0
            .parse()
            .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
        let affected = deadline
            .run(
                sqlx::query(
                    "UPDATE save_sessions SET state='committed',committed_bundle_id=$2::uuid,\
                    terminal_at=transaction_timestamp(),updated_at=transaction_timestamp() \
             WHERE id=$1::uuid AND state='verifying'",
                )
                .bind(capability.session_id().to_string())
                .bind(&bundle.0)
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if affected != 1 {
            return Err(WorkingHeadCommitError::SessionUnavailable);
        }

        deadline.run(sqlx::query(
            "INSERT INTO project_bundle_admissions \
             (project_id,storage_scope_id,bundle_id,save_session_id,source_save_session_id,created_at) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$4::uuid,transaction_timestamp()) \
             ON CONFLICT (project_id,bundle_id) DO NOTHING"
        ).bind(capability.project_id().to_string()).bind(capability.storage_scope_id().to_string())
            .bind(&bundle.0).bind(capability.session_id().to_string()).execute(&mut *tx))
            .await?.map_err(map_sql_error)?;

        let rotates_recovery = old_bundle_id
            .as_deref()
            .is_some_and(|old_bundle_id| old_bundle_id != bundle.0.as_str());
        if rotates_recovery {
            rotate_recovery_checkpoints(
                &mut tx,
                capability,
                &session.7,
                old_bundle_id
                    .as_deref()
                    .ok_or(WorkingHeadCommitError::InvariantViolation)?,
                deadline,
            )
            .await?;
        }

        let affected = deadline
            .run(
                sqlx::query(
                    "UPDATE projects SET working_head_bundle_id=$2::uuid,lock_version=lock_version+1,\
                    updated_at=transaction_timestamp() \
             WHERE id=$1::uuid AND lock_version=$3",
                )
                .bind(capability.project_id().to_string())
                .bind(&bundle.0)
                .bind(session.6)
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if affected != 1 {
            return Err(WorkingHeadCommitError::StaleProjectVersion);
        }

        if rotates_recovery {
            clear_live_reference_gc_candidates(&mut tx, capability, &bundle.0, deadline).await?;
        }

        if inserted == 0 && bundle.1 != session.1 {
            deadline
                .run(
                    sqlx::query(
                        "INSERT INTO save_cleanup_jobs \
                 (save_session_id,cleanup_kind,object_key,eligible_at) \
                 SELECT id,'object_delete',staging_object_key,\
                        GREATEST(expires_at,transaction_timestamp()) \
                 FROM save_sessions WHERE id=$1::uuid \
                 ON CONFLICT (save_session_id) DO NOTHING",
                    )
                    .bind(capability.session_id().to_string())
                    .execute(&mut *tx),
                )
                .await?
                .map_err(map_sql_error)?;
        }

        let next_version = ProjectVersion::new(
            session
                .6
                .checked_add(1)
                .ok_or(WorkingHeadCommitError::InvariantViolation)?,
        )
        .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
        let outcome = CommitWorkingHeadOutcome {
            bundle_id,
            project_version: next_version,
        };
        commit_transaction(tx, deadline).await?;
        Ok(outcome)
    }

    pub async fn reconcile(
        &self,
        capability: &VerifiedStagingBundle,
    ) -> Result<WorkingHeadCommitReconciliation, WorkingHeadCommitError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure(&mut tx, deadline).await?;
        if !deadline
            .run(QuotaRepository::lock_storage_scope(
                &mut tx,
                capability.storage_scope_id(),
            ))
            .await?
            .map_err(map_sql_error)?
        {
            return Err(WorkingHeadCommitError::SessionNotFound);
        }
        let project_locked: bool = deadline
            .run(
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1::uuid \
                     AND storage_scope_id=$2::uuid FOR UPDATE)",
                )
                .bind(capability.project_id().to_string())
                .bind(capability.storage_scope_id().to_string())
                .fetch_one(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        if !project_locked {
            return Err(WorkingHeadCommitError::SessionNotFound);
        }
        type Row = (
            String,
            String,
            Vec<u8>,
            i64,
            i64,
            i32,
            i64,
            String,
            bool,
            Option<String>,
        );
        let row: Option<Row> = deadline.run(sqlx::query_as(
            "SELECT state,staging_object_key,expected_bundle_sha256,expected_physical_bytes,\
                    expected_logical_bytes,expected_file_count,expected_project_version,\
                    actor_user_id::text,expires_at<=transaction_timestamp(),committed_bundle_id::text \
             FROM save_sessions WHERE id=$1::uuid AND project_id=$2::uuid \
               AND storage_scope_id=$3::uuid FOR UPDATE"
        ).bind(capability.session_id().to_string()).bind(capability.project_id().to_string())
            .bind(capability.storage_scope_id().to_string()).fetch_optional(&mut *tx))
            .await?.map_err(map_sql_error)?;
        let Some(row) = row else {
            return Err(WorkingHeadCommitError::SessionNotFound);
        };
        validate_capability(capability, &row)?;
        let actor = row
            .7
            .parse()
            .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
        let role = deadline
            .run(ProjectAccessRepository::resolve_effective_role_for_update(
                &mut tx,
                capability.project_id(),
                actor,
            ))
            .await?
            .map_err(map_access_error)?;
        if role < EffectiveProjectRole::Write {
            return Err(WorkingHeadCommitError::Unauthorized);
        }
        if row.0 != "committed" {
            commit_transaction(tx, deadline).await?;
            return Ok(WorkingHeadCommitReconciliation::NotCommitted);
        }
        let bundle_id: Uuid = row
            .9
            .as_deref()
            .ok_or(WorkingHeadCommitError::InvariantViolation)?
            .parse()
            .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
        let valid: bool = deadline
            .run(
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM project_bundle_admissions \
             WHERE project_id=$1::uuid AND storage_scope_id=$2::uuid AND bundle_id=$3::uuid)",
                )
                .bind(capability.project_id().to_string())
                .bind(capability.storage_scope_id().to_string())
                .bind(bundle_id.to_string())
                .fetch_one(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        if !valid {
            return Err(WorkingHeadCommitError::InvariantViolation);
        }
        let project_version = ProjectVersion::new(
            row.6
                .checked_add(1)
                .ok_or(WorkingHeadCommitError::InvariantViolation)?,
        )
        .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
        let result = WorkingHeadCommitReconciliation::Committed(CommitWorkingHeadOutcome {
            bundle_id,
            project_version,
        });
        commit_transaction(tx, deadline).await?;
        Ok(result)
    }
}

async fn rotate_recovery_checkpoints(
    tx: &mut Transaction<'_, Postgres>,
    capability: &VerifiedStagingBundle,
    actor_user_id: &str,
    previous_head_bundle_id: &str,
    deadline: Deadline,
) -> Result<(), WorkingHeadCommitError> {
    type RecoveryRow = (String, i16);
    let recovery_rows: Vec<RecoveryRow> = deadline
        .run(
            sqlx::query_as(
                "SELECT id::text,recovery_position FROM project_bundle_refs \
                 WHERE project_id=$1::uuid AND kind='recovery' \
                 ORDER BY created_at,id FOR UPDATE",
            )
            .bind(capability.project_id().to_string())
            .fetch_all(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    if recovery_rows.len() > MAX_RECOVERY_CHECKPOINTS {
        return Err(WorkingHeadCommitError::InvariantViolation);
    }

    let mut occupied = [false; MAX_RECOVERY_CHECKPOINTS];
    for (_, position) in &recovery_rows {
        let index = position
            .checked_sub(1)
            .and_then(|position| usize::try_from(position).ok())
            .filter(|index| *index < occupied.len())
            .ok_or(WorkingHeadCommitError::InvariantViolation)?;
        if occupied[index] {
            return Err(WorkingHeadCommitError::InvariantViolation);
        }
        occupied[index] = true;
    }

    let recovery_position = if recovery_rows.len() == occupied.len() {
        let (oldest_id, oldest_position) = recovery_rows
            .first()
            .ok_or(WorkingHeadCommitError::InvariantViolation)?;
        let deleted = deadline
            .run(
                sqlx::query(
                    "DELETE FROM project_bundle_refs \
                     WHERE id=$1::uuid AND project_id=$2::uuid AND kind='recovery'",
                )
                .bind(oldest_id)
                .bind(capability.project_id().to_string())
                .execute(&mut **tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if deleted != 1 {
            return Err(WorkingHeadCommitError::InvariantViolation);
        }
        *oldest_position
    } else {
        occupied
            .iter()
            .position(|occupied| !occupied)
            .and_then(|index| i16::try_from(index + 1).ok())
            .ok_or(WorkingHeadCommitError::InvariantViolation)?
    };

    deadline
        .run(
            sqlx::query(
                "INSERT INTO project_bundle_refs \
                 (id,project_id,storage_scope_id,bundle_id,kind,recovery_position,actor_user_id) \
                 VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'recovery',$5,$6::uuid)",
            )
            .bind(Uuid::now_v7().to_string())
            .bind(capability.project_id().to_string())
            .bind(capability.storage_scope_id().to_string())
            .bind(previous_head_bundle_id)
            .bind(recovery_position)
            .bind(actor_user_id)
            .execute(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(())
}

async fn clear_live_reference_gc_candidates(
    tx: &mut Transaction<'_, Postgres>,
    capability: &VerifiedStagingBundle,
    incoming_bundle_id: &str,
    deadline: Deadline,
) -> Result<(), WorkingHeadCommitError> {
    deadline
        .run(
            sqlx::query(
                "DELETE FROM gc_candidates candidate USING bundles bundle \
                 WHERE candidate.object_key=bundle.object_key \
                   AND candidate.status IN ('queued','retry_wait','failed') \
                   AND (bundle.id=$2::uuid OR EXISTS ( \
                       SELECT 1 FROM project_bundle_refs reference \
                       WHERE reference.project_id=$1::uuid AND reference.bundle_id=bundle.id))",
            )
            .bind(capability.project_id().to_string())
            .bind(incoming_bundle_id)
            .execute(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;

    let protected_candidate_exists: bool = deadline
        .run(
            sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM gc_candidates candidate \
                 JOIN bundles bundle ON bundle.object_key=candidate.object_key \
                 WHERE candidate.status IN ('running','completed') \
                   AND (bundle.id=$2::uuid OR EXISTS ( \
                       SELECT 1 FROM project_bundle_refs reference \
                       WHERE reference.project_id=$1::uuid AND reference.bundle_id=bundle.id)))",
            )
            .bind(capability.project_id().to_string())
            .bind(incoming_bundle_id)
            .fetch_one(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    if protected_candidate_exists {
        return Err(WorkingHeadCommitError::InvariantViolation);
    }
    Ok(())
}

type PersistedSession = (
    String,
    String,
    Vec<u8>,
    i64,
    i64,
    i32,
    i64,
    String,
    bool,
    Option<String>,
);

fn validate_capability(
    capability: &VerifiedStagingBundle,
    session: &PersistedSession,
) -> Result<(), WorkingHeadCommitError> {
    if session.2.len() != 32
        || session
            .2
            .as_slice()
            .ct_eq(capability.archive_sha256().as_bytes())
            .unwrap_u8()
            != 1
        || session.3 != to_i64(capability.physical_bytes())?
        || session.4 != to_i64(capability.logical_bytes())?
        || session.5
            != i32::try_from(capability.file_count())
                .map_err(|_| WorkingHeadCommitError::InvariantViolation)?
    {
        return Err(WorkingHeadCommitError::ObjectMismatch);
    }
    Ok(())
}

async fn committed_outcome(
    tx: &mut Transaction<'_, Postgres>,
    capability: &VerifiedStagingBundle,
    session: &PersistedSession,
    deadline: Deadline,
) -> Result<CommitWorkingHeadOutcome, WorkingHeadCommitError> {
    let bundle_id: Uuid = session
        .9
        .as_deref()
        .ok_or(WorkingHeadCommitError::InvariantViolation)?
        .parse()
        .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
    let valid: bool = deadline
        .run(
            sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM bundles bundle \
         JOIN project_bundle_admissions admission ON admission.bundle_id=bundle.id \
         WHERE bundle.id=$1::uuid AND bundle.sha256=$2 AND admission.project_id=$3::uuid \
           AND admission.storage_scope_id=$4::uuid)",
            )
            .bind(bundle_id.to_string())
            .bind(capability.archive_sha256().as_bytes().as_slice())
            .bind(capability.project_id().to_string())
            .bind(capability.storage_scope_id().to_string())
            .fetch_one(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    if !valid {
        return Err(WorkingHeadCommitError::InvariantViolation);
    }
    let project_version = ProjectVersion::new(
        session
            .6
            .checked_add(1)
            .ok_or(WorkingHeadCommitError::InvariantViolation)?,
    )
    .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
    Ok(CommitWorkingHeadOutcome {
        bundle_id,
        project_version,
    })
}

async fn verify_object_head(
    store: &S3ObjectStore,
    raw_key: &str,
    capability: &VerifiedStagingBundle,
    deadline: Deadline,
) -> Result<(), WorkingHeadCommitError> {
    let key = ObjectKey::parse(raw_key.to_owned())
        .map_err(|_| WorkingHeadCommitError::InvariantViolation)?;
    let metadata = deadline
        .run(store.head(&key))
        .await?
        .map_err(map_storage_error)?;
    if metadata.content_length != capability.physical_bytes() {
        return Err(WorkingHeadCommitError::ObjectMismatch);
    }
    Ok(())
}

async fn configure(
    tx: &mut Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), WorkingHeadCommitError> {
    let millis = deadline
        .remaining()?
        .saturating_sub(SQL_MARGIN)
        .as_millis()
        .max(1);
    deadline
        .run(
            sqlx::query(
                "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
            )
            .bind(format!("{millis}ms"))
            .execute(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(())
}

async fn commit_transaction(
    tx: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), WorkingHeadCommitError> {
    match deadline.run_raw(tx.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(map_commit_error(error)),
        Err(_) => Err(WorkingHeadCommitError::CommitOutcomeUnknown),
    }
}

fn map_commit_error(error: sqlx::Error) -> WorkingHeadCommitError {
    if error.as_database_error().is_some() {
        map_sql_error(error)
    } else {
        WorkingHeadCommitError::CommitOutcomeUnknown
    }
}

fn to_i64(value: u64) -> Result<i64, WorkingHeadCommitError> {
    i64::try_from(value).map_err(|_| WorkingHeadCommitError::InvariantViolation)
}

fn map_database_error(_: DatabaseError) -> WorkingHeadCommitError {
    WorkingHeadCommitError::DatabaseUnavailable
}

fn map_sql_error(error: sqlx::Error) -> WorkingHeadCommitError {
    if error
        .as_database_error()
        .and_then(|value| value.code())
        .is_some_and(|code| matches!(code.as_ref(), "55P03" | "57014" | "40P01"))
    {
        WorkingHeadCommitError::OperationTimeout
    } else {
        WorkingHeadCommitError::DatabaseUnavailable
    }
}

fn map_storage_error(error: crate::object_storage::ObjectStoreError) -> WorkingHeadCommitError {
    match error.kind() {
        ObjectStoreErrorKind::NotFound | ObjectStoreErrorKind::Integrity => {
            WorkingHeadCommitError::ObjectMismatch
        }
        ObjectStoreErrorKind::Timeout => WorkingHeadCommitError::OperationTimeout,
        _ => WorkingHeadCommitError::StorageUnavailable,
    }
}

fn map_access_error(error: ProjectAccessError) -> WorkingHeadCommitError {
    match error {
        ProjectAccessError::OperationTimeout => WorkingHeadCommitError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => WorkingHeadCommitError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => WorkingHeadCommitError::InvariantViolation,
        ProjectAccessError::ProjectUnavailable
        | ProjectAccessError::ProjectNotOrganizationOwned
        | ProjectAccessError::MemberUnavailable
        | ProjectAccessError::AlreadyGranted => WorkingHeadCommitError::Unauthorized,
    }
}

#[derive(Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn new(duration: Duration) -> Self {
        Self(Instant::now() + duration)
    }

    fn remaining(self) -> Result<Duration, WorkingHeadCommitError> {
        self.0
            .checked_duration_since(Instant::now())
            .filter(|value| !value.is_zero())
            .ok_or(WorkingHeadCommitError::OperationTimeout)
    }

    async fn run<F, T>(self, future: F) -> Result<T, WorkingHeadCommitError>
    where
        F: std::future::Future<Output = T>,
    {
        time::timeout_at(self.0, future)
            .await
            .map_err(|_| WorkingHeadCommitError::OperationTimeout)
    }

    async fn run_raw<F, T>(self, future: F) -> Result<T, time::error::Elapsed>
    where
        F: std::future::Future<Output = T>,
    {
        time::timeout_at(self.0, future).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_bounds_are_fail_closed() {
        assert_eq!(
            WorkingHeadCommitPolicy::new(Duration::from_millis(99)),
            Err(WorkingHeadCommitError::InvalidInput)
        );
        assert!(WorkingHeadCommitPolicy::new(Duration::from_secs(5)).is_ok());
        assert_eq!(
            WorkingHeadCommitPolicy::new(Duration::from_secs(601)),
            Err(WorkingHeadCommitError::InvalidInput)
        );
    }

    #[test]
    fn connection_loss_during_commit_is_never_reported_as_definite_failure() {
        let lost = sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "response lost",
        ));
        assert_eq!(
            map_commit_error(lost),
            WorkingHeadCommitError::CommitOutcomeUnknown
        );
    }
}
