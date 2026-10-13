use std::fmt;
use std::time::Duration;

use sqlx::{Acquire, Postgres, Transaction};
use subtle::ConstantTimeEq;
use tokio::time::{self, Instant};

use crate::database::{DatabaseError, DatabasePool};
use crate::identity::UserId;
use crate::object_storage::{ObjectKey, S3ObjectStore, Sha256Checksum};
use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId,
};
use crate::quota::SaveSessionId;
use crate::workspace::StorageScopeId;

use super::admission::AdmissionContract;
use super::archive::{VerifiedArchive, verify_archive};

const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(600);
const SQL_MARGIN: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Debug)]
pub struct VerifyStagingBundle {
    pub storage_scope_id: StorageScopeId,
    pub project_id: ProjectId,
    pub actor_user_id: UserId,
    pub session_id: SaveSessionId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StagingVerifierPolicy {
    operation_timeout: Duration,
}

impl StagingVerifierPolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, VerificationError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&operation_timeout) {
            return Err(VerificationError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedStagingBundle {
    session_id: SaveSessionId,
    project_id: ProjectId,
    storage_scope_id: StorageScopeId,
    archive_sha256: Sha256Checksum,
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
}

impl VerifiedStagingBundle {
    pub const fn session_id(&self) -> SaveSessionId {
        self.session_id
    }
    pub const fn project_id(&self) -> ProjectId {
        self.project_id
    }
    pub const fn storage_scope_id(&self) -> StorageScopeId {
        self.storage_scope_id
    }
    pub const fn archive_sha256(&self) -> &Sha256Checksum {
        &self.archive_sha256
    }
    pub const fn physical_bytes(&self) -> u64 {
        self.physical_bytes
    }
    pub const fn logical_bytes(&self) -> u64 {
        self.logical_bytes
    }
    pub const fn file_count(&self) -> u32 {
        self.file_count
    }
}

impl fmt::Debug for VerifiedStagingBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedStagingBundle")
            .field("session_id", &self.session_id)
            .field("project_id", &self.project_id)
            .field("storage_scope_id", &self.storage_scope_id)
            .field("archive_sha256", &self.archive_sha256)
            .field("physical_bytes", &self.physical_bytes)
            .field("logical_bytes", &self.logical_bytes)
            .field("file_count", &self.file_count)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum VerificationError {
    InvalidInput,
    SessionNotFound,
    SessionUnavailable,
    SessionExpired,
    Unauthorized,
    ObjectMismatch,
    InvalidArchive,
    OperationTimeout,
    DatabaseUnavailable,
    StorageUnavailable,
    CommitOutcomeUnknown,
    InvariantViolation,
}

impl fmt::Display for VerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "staging verification input is invalid",
            Self::SessionNotFound => "Save session was not found",
            Self::SessionUnavailable => "Save session cannot be verified",
            Self::SessionExpired => "Save session has expired",
            Self::Unauthorized => "Save session is unavailable",
            Self::ObjectMismatch => "staging object does not match the Save session",
            Self::InvalidArchive => "staging object is not a canonical Project Bundle",
            Self::OperationTimeout => "staging verification timed out",
            Self::DatabaseUnavailable => "staging verification persistence is unavailable",
            Self::StorageUnavailable => "staging object storage is unavailable",
            Self::CommitOutcomeUnknown => "staging verification commit outcome is unknown",
            Self::InvariantViolation => "staging verification state is invalid",
        })
    }
}

impl std::error::Error for VerificationError {}

#[derive(Clone)]
pub struct StagingVerifier {
    pool: DatabasePool,
    store: S3ObjectStore,
    policy: StagingVerifierPolicy,
}

impl fmt::Debug for StagingVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StagingVerifier")
            .field("pool", &self.pool)
            .field("store", &self.store)
            .field("policy", &self.policy)
            .finish()
    }
}

impl StagingVerifier {
    pub fn new(pool: DatabasePool, store: S3ObjectStore, policy: StagingVerifierPolicy) -> Self {
        Self {
            pool,
            store,
            policy,
        }
    }

    pub async fn verify(
        &self,
        request: VerifyStagingBundle,
    ) -> Result<VerifiedStagingBundle, VerificationError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let session = self.claim(request, deadline).await?;
        let key = ObjectKey::parse(session.object_key.clone())
            .map_err(|_| VerificationError::InvariantViolation)?;
        let metadata = deadline
            .run(self.store.head(&key))
            .await?
            .map_err(|_| VerificationError::StorageUnavailable)?;
        if metadata.content_length != session.expected_physical_bytes {
            self.reject(request, deadline).await?;
            return Err(VerificationError::ObjectMismatch);
        }
        let stream = deadline
            .run(self.store.get_stream(&key, session.expected_physical_bytes))
            .await?
            .map_err(|_| VerificationError::StorageUnavailable)?;
        if stream.metadata.content_length != session.expected_physical_bytes {
            self.reject(request, deadline).await?;
            return Err(VerificationError::ObjectMismatch);
        }
        let admission = AdmissionContract::load()?;
        let result = deadline
            .run(verify_archive(
                stream.reader,
                session.expected_physical_bytes,
                &request.project_id.to_string(),
                &request.storage_scope_id.to_string(),
                &admission,
            ))
            .await;
        let archive = match result {
            Ok(Ok(archive)) => archive,
            Ok(Err(
                error @ (VerificationError::InvalidArchive | VerificationError::ObjectMismatch),
            )) => {
                self.reject(request, deadline).await?;
                return Err(error);
            }
            Ok(Err(error)) | Err(error) => return Err(error),
        };
        if archive
            .archive_sha256
            .ct_eq(session.expected_sha256.as_slice())
            .unwrap_u8()
            != 1
            || archive.logical_bytes != session.expected_logical_bytes
            || u64::from(archive.file_count) != session.expected_file_count
        {
            self.reject(request, deadline).await?;
            return Err(VerificationError::ObjectMismatch);
        }
        self.confirm(request, deadline).await?;
        Ok(capability(request, archive))
    }

    async fn claim(
        &self,
        request: VerifyStagingBundle,
        deadline: Deadline,
    ) -> Result<Session, VerificationError> {
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure(&mut tx, deadline).await?;
        authorize(&mut tx, request, deadline).await?;
        type SessionRow = (String, String, Vec<u8>, i64, i64, i32, String, bool, bool);
        let row: Option<SessionRow> = deadline.run(
            sqlx::query_as(
                "SELECT state,staging_object_key,expected_bundle_sha256,expected_physical_bytes,\
                 expected_logical_bytes,expected_file_count,upload_mode,expires_at<=transaction_timestamp(),\
                 EXISTS(SELECT 1 FROM save_upload_leases lease WHERE lease.save_session_id=save_sessions.id \
                   AND lease.released_at IS NULL AND lease.lease_expires_at>clock_timestamp()) \
                 FROM save_sessions WHERE id=$1::uuid AND project_id=$2::uuid \
                 AND storage_scope_id=$3::uuid AND actor_user_id=$4::uuid FOR UPDATE"
            ).bind(request.session_id.to_string()).bind(request.project_id.to_string())
                .bind(request.storage_scope_id.to_string()).bind(request.actor_user_id.to_string())
                .fetch_optional(&mut *tx)
        ).await?.map_err(map_sql_error)?;
        let Some(row) = row else {
            return Err(VerificationError::SessionNotFound);
        };
        if row.8 {
            return Err(VerificationError::SessionUnavailable);
        }
        if row.7 {
            transition(&mut tx, request.session_id, "expired", deadline).await?;
            commit(tx, deadline).await?;
            return Err(VerificationError::SessionExpired);
        }
        match (row.0.as_str(), row.6.as_str()) {
            ("created", "single") => {
                let affected = deadline.run(sqlx::query(
                    "UPDATE save_sessions SET state='uploading',updated_at=transaction_timestamp() \
                     WHERE id=$1::uuid AND state='created'"
                ).bind(request.session_id.to_string()).execute(&mut *tx)).await?.map_err(map_sql_error)?.rows_affected();
                if affected != 1 {
                    return Err(VerificationError::SessionUnavailable);
                }
                move_single_to_verifying(&mut tx, request.session_id, deadline).await?;
            }
            ("uploading", "single") => {
                move_single_to_verifying(&mut tx, request.session_id, deadline).await?;
            }
            ("verifying", "single") => {}
            ("verifying", "multipart") => {
                let completed: bool = deadline.run(sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM multipart_lifecycles WHERE save_session_id=$1::uuid \
                     AND create_status='ready' AND complete_status='completed')"
                ).bind(request.session_id.to_string()).fetch_one(&mut *tx)).await?.map_err(map_sql_error)?;
                if !completed {
                    return Err(VerificationError::SessionUnavailable);
                }
            }
            _ => return Err(VerificationError::SessionUnavailable),
        }
        let expected_sha256: [u8; 32] = row
            .2
            .try_into()
            .map_err(|_| VerificationError::InvariantViolation)?;
        let session = Session {
            object_key: row.1,
            expected_sha256,
            expected_physical_bytes: u64::try_from(row.3)
                .map_err(|_| VerificationError::InvariantViolation)?,
            expected_logical_bytes: u64::try_from(row.4)
                .map_err(|_| VerificationError::InvariantViolation)?,
            expected_file_count: u64::try_from(row.5)
                .map_err(|_| VerificationError::InvariantViolation)?,
        };
        commit(tx, deadline).await?;
        Ok(session)
    }

    async fn confirm(
        &self,
        request: VerifyStagingBundle,
        deadline: Deadline,
    ) -> Result<(), VerificationError> {
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure(&mut tx, deadline).await?;
        authorize(&mut tx, request, deadline).await?;
        let row: Option<bool> = deadline.run(sqlx::query_scalar(
            "SELECT expires_at<=transaction_timestamp() FROM save_sessions WHERE id=$1::uuid \
             AND project_id=$2::uuid AND storage_scope_id=$3::uuid AND actor_user_id=$4::uuid \
             AND state='verifying' FOR UPDATE"
        ).bind(request.session_id.to_string()).bind(request.project_id.to_string())
            .bind(request.storage_scope_id.to_string()).bind(request.actor_user_id.to_string())
            .fetch_optional(&mut *tx)).await?.map_err(map_sql_error)?;
        match row {
            None => Err(VerificationError::SessionUnavailable),
            Some(true) => {
                transition(&mut tx, request.session_id, "expired", deadline).await?;
                commit(tx, deadline).await?;
                Err(VerificationError::SessionExpired)
            }
            Some(false) => {
                commit(tx, deadline).await?;
                Ok(())
            }
        }
    }

    async fn reject(
        &self,
        request: VerifyStagingBundle,
        deadline: Deadline,
    ) -> Result<(), VerificationError> {
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure(&mut tx, deadline).await?;
        lock_scope_project(&mut tx, request, deadline).await?;
        let affected = deadline
            .run(
                sqlx::query(
                    "UPDATE save_sessions SET state='failed',terminal_at=transaction_timestamp(),\
             updated_at=transaction_timestamp() WHERE id=$1::uuid AND project_id=$2::uuid \
             AND storage_scope_id=$3::uuid AND actor_user_id=$4::uuid AND state='verifying'",
                )
                .bind(request.session_id.to_string())
                .bind(request.project_id.to_string())
                .bind(request.storage_scope_id.to_string())
                .bind(request.actor_user_id.to_string())
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if affected != 1 {
            return Err(VerificationError::SessionUnavailable);
        }
        commit(tx, deadline).await
    }
}

async fn move_single_to_verifying(
    tx: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<(), VerificationError> {
    let affected = deadline
        .run(
            sqlx::query(
                "UPDATE save_sessions SET state='verifying',updated_at=transaction_timestamp() \
                 WHERE id=$1::uuid AND state='uploading' AND upload_mode='single'",
            )
            .bind(session_id.to_string())
            .execute(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?
        .rows_affected();
    if affected != 1 {
        return Err(VerificationError::SessionUnavailable);
    }
    Ok(())
}

struct Session {
    object_key: String,
    expected_sha256: [u8; 32],
    expected_physical_bytes: u64,
    expected_logical_bytes: u64,
    expected_file_count: u64,
}

fn capability(request: VerifyStagingBundle, archive: VerifiedArchive) -> VerifiedStagingBundle {
    VerifiedStagingBundle {
        session_id: request.session_id,
        project_id: request.project_id,
        storage_scope_id: request.storage_scope_id,
        archive_sha256: Sha256Checksum::from_bytes(archive.archive_sha256),
        physical_bytes: archive.physical_bytes,
        logical_bytes: archive.logical_bytes,
        file_count: archive.file_count,
    }
}

async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    request: VerifyStagingBundle,
    deadline: Deadline,
) -> Result<(), VerificationError> {
    lock_scope_project(tx, request, deadline).await?;
    let role = deadline
        .run(ProjectAccessRepository::resolve_effective_role_for_update(
            tx,
            request.project_id,
            request.actor_user_id,
        ))
        .await?
        .map_err(map_access_error)?;
    if role < EffectiveProjectRole::Write {
        return Err(VerificationError::Unauthorized);
    }
    Ok(())
}

async fn lock_scope_project(
    tx: &mut Transaction<'_, Postgres>,
    request: VerifyStagingBundle,
    deadline: Deadline,
) -> Result<(), VerificationError> {
    let scope: bool = deadline
        .run(
            sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM storage_scopes WHERE id=$1::uuid FOR UPDATE)",
            )
            .bind(request.storage_scope_id.to_string())
            .fetch_one(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    if !scope {
        return Err(VerificationError::SessionNotFound);
    }
    let project: bool = deadline.run(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1::uuid AND storage_scope_id=$2::uuid AND state='active' FOR UPDATE)"
    ).bind(request.project_id.to_string()).bind(request.storage_scope_id.to_string()).fetch_one(&mut **tx)).await?.map_err(map_sql_error)?;
    if !project {
        return Err(VerificationError::SessionNotFound);
    }
    Ok(())
}

async fn transition(
    tx: &mut Transaction<'_, Postgres>,
    id: SaveSessionId,
    state: &str,
    deadline: Deadline,
) -> Result<(), VerificationError> {
    let affected = deadline.run(sqlx::query(
        "UPDATE save_sessions SET state=$2,terminal_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE id=$1::uuid AND state IN ('created','uploading','verifying')"
    ).bind(id.to_string()).bind(state).execute(&mut **tx)).await?.map_err(map_sql_error)?.rows_affected();
    if affected != 1 {
        return Err(VerificationError::SessionUnavailable);
    }
    Ok(())
}

async fn configure(
    tx: &mut Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), VerificationError> {
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

async fn commit(
    tx: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), VerificationError> {
    match deadline.run_raw(tx.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) if error.as_database_error().is_some() => Err(map_sql_error(error)),
        Ok(Err(_)) | Err(_) => Err(VerificationError::CommitOutcomeUnknown),
    }
}

fn map_database_error(_: DatabaseError) -> VerificationError {
    VerificationError::DatabaseUnavailable
}
fn map_sql_error(error: sqlx::Error) -> VerificationError {
    if error
        .as_database_error()
        .and_then(|value| value.code())
        .is_some_and(|code| matches!(code.as_ref(), "55P03" | "57014"))
    {
        VerificationError::OperationTimeout
    } else {
        VerificationError::DatabaseUnavailable
    }
}
fn map_access_error(error: ProjectAccessError) -> VerificationError {
    match error {
        ProjectAccessError::OperationTimeout => VerificationError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => VerificationError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => VerificationError::InvariantViolation,
        ProjectAccessError::ProjectUnavailable
        | ProjectAccessError::ProjectNotOrganizationOwned
        | ProjectAccessError::MemberUnavailable
        | ProjectAccessError::AlreadyGranted => VerificationError::Unauthorized,
    }
}

#[derive(Clone, Copy)]
struct Deadline(Instant);
impl Deadline {
    fn new(duration: Duration) -> Self {
        Self(Instant::now() + duration)
    }
    fn remaining(self) -> Result<Duration, VerificationError> {
        self.0
            .checked_duration_since(Instant::now())
            .filter(|value| !value.is_zero())
            .ok_or(VerificationError::OperationTimeout)
    }
    async fn run<F, T>(self, future: F) -> Result<T, VerificationError>
    where
        F: std::future::Future<Output = T>,
    {
        time::timeout_at(self.0, future)
            .await
            .map_err(|_| VerificationError::OperationTimeout)
    }
    async fn run_raw<F, T>(self, future: F) -> Result<T, time::error::Elapsed>
    where
        F: std::future::Future<Output = T>,
    {
        time::timeout_at(self.0, future).await
    }
}
