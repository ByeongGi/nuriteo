use std::fmt;
use std::future::Future;
use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, PgConnection, Postgres, Transaction};
use time::OffsetDateTime;
use tokio::time::{self as tokio_time, Instant};

use crate::database::{DatabaseError, DatabasePool};
use crate::object_storage::{
    BoundedPresignedRequest, ObjectKey, ObjectStoreError, PresignExpiry, PresignedPutRequest,
    S3ObjectStore,
};
use crate::project::{EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository};
use crate::quota::{
    QuotaRepository, QuotaService, QuotaServiceError, QuotaServicePolicy, ReservationRequest,
    SaveSessionId, TerminalSaveState,
};

use super::types::{
    CreateSinglePutSession, IdempotencySecret, ReconciliationState, RelaySinglePutSession,
    SinglePutSession, SinglePutUploadCapability,
};

const CONTENT_TYPE: &str = "application/vnd.nuriteo.project-bundle";
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const SQL_TIMEOUT_MARGIN: Duration = Duration::from_millis(25);
const MAX_SINGLE_PUT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_LOGICAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILES: u32 = 2_500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinglePutServicePolicy {
    operation_timeout: Duration,
    presign_minutes: u16,
}

impl SinglePutServicePolicy {
    pub fn new(
        operation_timeout: Duration,
        presign_minutes: u16,
    ) -> Result<Self, SinglePutServiceError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout)
            || PresignExpiry::minutes(presign_minutes).is_err()
        {
            return Err(SinglePutServiceError::InvalidInput);
        }
        Ok(Self {
            operation_timeout,
            presign_minutes,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SinglePutServiceError {
    InvalidInput,
    ScopeNotFound,
    ProjectNotFound,
    ProjectUnavailable,
    StaleProjectVersion,
    IdempotencyConflict,
    IdempotencyConfigurationMismatch,
    ActiveSessionConflict,
    SessionTerminal,
    SessionNearExpiry,
    QuotaExceeded,
    OperationTimeout,
    DatabaseUnavailable,
    ObjectStorageUnavailable,
    PresignTimeoutReconciliationRequired,
    CommitOutcomeUnknown,
    ReconciliationRequired,
    InvariantViolation,
}

impl fmt::Display for SinglePutServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "single-PUT request is invalid",
            Self::ScopeNotFound => "storage scope was not found",
            Self::ProjectNotFound => "project was not found",
            Self::ProjectUnavailable => "project is unavailable",
            Self::StaleProjectVersion => "project version is stale",
            Self::IdempotencyConflict => "idempotency key conflicts with an existing request",
            Self::IdempotencyConfigurationMismatch => {
                "Save idempotency configuration does not match persisted state"
            }
            Self::ActiveSessionConflict => "project already has an active Save session",
            Self::SessionTerminal => "idempotent Save session is terminal",
            Self::SessionNearExpiry => "Save session is too close to expiry for a new capability",
            Self::QuotaExceeded => "workspace storage quota is exceeded",
            Self::OperationTimeout => "single-PUT operation timed out",
            Self::DatabaseUnavailable => "single-PUT persistence is unavailable",
            Self::ObjectStorageUnavailable => "upload capability is unavailable",
            Self::PresignTimeoutReconciliationRequired => {
                "upload capability timed out and the Save session requires reconciliation"
            }
            Self::CommitOutcomeUnknown => "Save session commit outcome is unknown",
            Self::ReconciliationRequired => "Save session requires reconciliation",
            Self::InvariantViolation => "single-PUT persistence state is invalid",
        })
    }
}

impl std::error::Error for SinglePutServiceError {}

pub trait PutPresigner: Clone + Send + Sync + 'static {
    type Error: Send;

    fn presign(
        &self,
        request: PresignedPutRequest,
    ) -> impl Future<Output = Result<BoundedPresignedRequest, Self::Error>> + Send;
}

impl PutPresigner for S3ObjectStore {
    type Error = ObjectStoreError;

    async fn presign(
        &self,
        request: PresignedPutRequest,
    ) -> Result<BoundedPresignedRequest, ObjectStoreError> {
        self.presign_put(request).await
    }
}

#[derive(Clone)]
pub struct SinglePutService<S = S3ObjectStore> {
    pool: DatabasePool,
    store: S,
    quota: QuotaService,
    policy: SinglePutServicePolicy,
    idempotency_secret: IdempotencySecret,
}

impl<S> fmt::Debug for SinglePutService<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SinglePutService")
            .field("pool", &self.pool)
            .field("policy", &self.policy)
            .field("idempotency_secret", &self.idempotency_secret)
            .finish_non_exhaustive()
    }
}

impl<S: PutPresigner> SinglePutService<S> {
    pub fn new(
        pool: DatabasePool,
        store: S,
        policy: SinglePutServicePolicy,
        idempotency_secret: IdempotencySecret,
    ) -> Result<Self, SinglePutServiceError> {
        Self::new_with_quota_source(pool, store, policy, idempotency_secret, false)
    }

    pub(crate) fn new_live(
        pool: DatabasePool,
        store: S,
        policy: SinglePutServicePolicy,
        idempotency_secret: IdempotencySecret,
    ) -> Result<Self, SinglePutServiceError> {
        Self::new_with_quota_source(pool, store, policy, idempotency_secret, true)
    }

    fn new_with_quota_source(
        pool: DatabasePool,
        store: S,
        policy: SinglePutServicePolicy,
        idempotency_secret: IdempotencySecret,
        live_instance_defaults: bool,
    ) -> Result<Self, SinglePutServiceError> {
        let quota_policy = QuotaServicePolicy::new(policy.operation_timeout)
            .map_err(|_| SinglePutServiceError::InvalidInput)?;
        let quota = if live_instance_defaults {
            QuotaService::new_live(pool.clone(), quota_policy)
        } else {
            QuotaService::new(pool.clone(), quota_policy)
        };
        Ok(Self {
            quota,
            pool,
            store,
            policy,
            idempotency_secret,
        })
    }

    pub async fn create(
        &self,
        request: CreateSinglePutSession,
    ) -> Result<SinglePutSession, SinglePutServiceError> {
        validate_request(&request)?;
        let deadline = Deadline::new(self.policy.operation_timeout);
        let digest = idempotency_digest(&self.idempotency_secret, &request);
        let persisted = self.persist_session(&request, &digest, deadline).await?;
        let presign_expiry = persisted.presign_expiry(self.policy.presign_minutes)?;
        let capability = match deadline
            .run(
                self.store.presign(PresignedPutRequest {
                    key: ObjectKey::parse(persisted.staging_object_key.clone())
                        .map_err(|_| SinglePutServiceError::InvariantViolation)?,
                    content_length: request.expected_physical_bytes,
                    content_type: CONTENT_TYPE.to_owned(),
                    checksum: request.expected_sha256.clone(),
                    expiry: presign_expiry,
                }),
            )
            .await
        {
            Ok(result) => result.map_err(|_| SinglePutServiceError::ObjectStorageUnavailable),
            Err(error) => Err(error),
        };
        match capability {
            Ok(capability) => Ok(SinglePutSession::new(
                persisted.session_id,
                persisted.expires_at,
                persisted.idempotent_retry,
                SinglePutUploadCapability::new(capability),
            )),
            Err(failure) => {
                if !persisted.idempotent_retry
                    && self.compensate(persisted, deadline).await.is_err()
                {
                    return if failure == SinglePutServiceError::OperationTimeout {
                        Err(SinglePutServiceError::PresignTimeoutReconciliationRequired)
                    } else {
                        Err(SinglePutServiceError::ReconciliationRequired)
                    };
                }
                Err(failure)
            }
        }
    }

    /// Persists the same Save session contract without minting a bearer URL.
    /// The authenticated HTTP relay validates and streams the body later.
    pub async fn create_relay(
        &self,
        request: CreateSinglePutSession,
    ) -> Result<RelaySinglePutSession, SinglePutServiceError> {
        validate_request(&request)?;
        let deadline = Deadline::new(self.policy.operation_timeout);
        let digest = idempotency_digest(&self.idempotency_secret, &request);
        let persisted = self.persist_session(&request, &digest, deadline).await?;
        // Preserve direct mode's near-expiry capability boundary on idempotent
        // replay even though relay mode does not mint a presigned URL.
        let _ = persisted.presign_expiry(self.policy.presign_minutes)?;
        Ok(RelaySinglePutSession::new(
            persisted.session_id,
            persisted.expires_at,
            persisted.idempotent_retry,
        ))
    }

    /// Establishes or verifies the persisted fingerprint for the configured
    /// idempotency secret before the service accepts HTTP traffic.
    pub async fn validate_idempotency_configuration(&self) -> Result<(), SinglePutServiceError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        ensure_idempotency_configuration(&mut connection, &self.idempotency_secret, deadline).await
    }

    pub async fn reconcile(
        &self,
        request: &CreateSinglePutSession,
    ) -> Result<ReconciliationState, SinglePutServiceError> {
        validate_request(request)?;
        let deadline = Deadline::new(self.policy.operation_timeout);
        let digest = idempotency_digest(&self.idempotency_secret, request);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        ensure_idempotency_configuration(&mut connection, &self.idempotency_secret, deadline)
            .await?;
        let row: Option<(String, String)> = deadline
            .run(
                sqlx::query_as(
                    "SELECT id::text,state FROM save_sessions WHERE project_id=$1::uuid \
                     AND actor_user_id=$2::uuid AND idempotency_digest=$3",
                )
                .bind(request.project_id.to_string())
                .bind(request.actor_user_id.to_string())
                .bind(digest.as_slice())
                .fetch_optional(&mut *connection),
            )
            .await?
            .map_err(map_sql_error)?;
        match row {
            None => Ok(ReconciliationState::Missing),
            Some((id, state)) => {
                let session_id = parse_session_id(&id)?;
                if is_active(&state) {
                    Ok(ReconciliationState::Active(session_id))
                } else {
                    Ok(ReconciliationState::Terminal(session_id))
                }
            }
        }
    }

    async fn persist_session(
        &self,
        request: &CreateSinglePutSession,
        digest: &[u8; 32],
        deadline: Deadline,
    ) -> Result<PersistedSession, SinglePutServiceError> {
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut transaction, deadline).await?;
        ensure_idempotency_configuration(&mut transaction, &self.idempotency_secret, deadline)
            .await?;
        let current_project_version =
            lock_scope_and_authorize(&mut transaction, request, deadline).await?;

        if let Some(existing) = load_idempotent(&mut transaction, request, digest, deadline).await?
        {
            validate_existing(&existing, request)?;
            if !is_active(&existing.state) {
                return Err(SinglePutServiceError::SessionTerminal);
            }
            let session_id = parse_session_id(&existing.id)?;
            let admission = self
                .quota
                .reserve_before_commit(
                    &mut transaction,
                    reservation(request, session_id),
                    deadline.0,
                )
                .await
                .map_err(map_quota_error)?;
            commit(transaction, deadline).await?;
            if admission.is_expired() {
                return Err(SinglePutServiceError::SessionTerminal);
            }
            return Ok(PersistedSession {
                session_id,
                expires_at: existing.expires_at,
                staging_object_key: existing.staging_object_key,
                idempotent_retry: true,
                storage_scope_id: request.storage_scope_id,
                project_id: request.project_id,
                database_remaining: existing.remaining,
                remaining_captured_at: Instant::now(),
            });
        }

        if current_project_version != request.expected_project_version.get() {
            return Err(SinglePutServiceError::StaleProjectVersion);
        }

        let active: bool = deadline
            .run(
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM save_sessions WHERE project_id=$1::uuid \
                     AND state IN ('created','uploading','verifying'))",
                )
                .bind(request.project_id.to_string())
                .fetch_one(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        if active {
            return Err(SinglePutServiceError::ActiveSessionConflict);
        }

        let session_id = SaveSessionId::new();
        let staging_object_key = format!(
            "staging/{}/{}/{}.bundle",
            request.storage_scope_id, request.project_id, session_id
        );
        let session_minutes = self
            .policy
            .presign_minutes
            .checked_add(1)
            .ok_or(SinglePutServiceError::InvalidInput)?;
        let (expires_at, remaining_seconds): (OffsetDateTime, i64) = deadline
            .run(
                sqlx::query_as(
                    "INSERT INTO save_sessions \
                     (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
                      expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
                      expected_file_count,staging_object_key,upload_mode,expires_at,idempotency_digest) \
                     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,'single', \
                             transaction_timestamp()+make_interval(mins=>$11),$12) \
                     RETURNING expires_at,EXTRACT(EPOCH FROM (expires_at-transaction_timestamp()))::bigint",
                )
                .bind(session_id.to_string())
                .bind(request.project_id.to_string())
                .bind(request.storage_scope_id.to_string())
                .bind(request.actor_user_id.to_string())
                .bind(request.expected_project_version.get())
                .bind(request.expected_sha256.as_bytes().as_slice())
                .bind(i64::try_from(request.expected_physical_bytes).map_err(|_| SinglePutServiceError::InvalidInput)?)
                .bind(i64::try_from(request.expected_logical_bytes).map_err(|_| SinglePutServiceError::InvalidInput)?)
                .bind(i32::try_from(request.expected_file_count).map_err(|_| SinglePutServiceError::InvalidInput)?)
                .bind(&staging_object_key)
                .bind(i32::from(session_minutes))
                .bind(digest.as_slice())
                .fetch_one(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        self.quota
            .reserve_before_commit(
                &mut transaction,
                reservation(request, session_id),
                deadline.0,
            )
            .await
            .map_err(map_quota_error)?;
        commit(transaction, deadline).await?;
        Ok(PersistedSession {
            session_id,
            expires_at,
            staging_object_key,
            idempotent_retry: false,
            storage_scope_id: request.storage_scope_id,
            project_id: request.project_id,
            database_remaining: duration_from_seconds(remaining_seconds)?,
            remaining_captured_at: Instant::now(),
        })
    }

    async fn compensate(
        &self,
        persisted: PersistedSession,
        deadline: Deadline,
    ) -> Result<(), SinglePutServiceError> {
        self.quota
            .transition_terminal_before(
                persisted.storage_scope_id,
                persisted.project_id,
                persisted.session_id,
                TerminalSaveState::Failed,
                deadline.0,
            )
            .await
            .map_err(|_| SinglePutServiceError::ReconciliationRequired)
    }
}

#[derive(Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    fn remaining(self) -> Result<Duration, SinglePutServiceError> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(SinglePutServiceError::OperationTimeout)
        } else {
            Ok(remaining)
        }
    }

    async fn run<T>(self, future: impl Future<Output = T>) -> Result<T, SinglePutServiceError> {
        tokio_time::timeout_at(self.0, future)
            .await
            .map_err(|_| SinglePutServiceError::OperationTimeout)
    }
}

struct PersistedSession {
    session_id: SaveSessionId,
    expires_at: OffsetDateTime,
    staging_object_key: String,
    idempotent_retry: bool,
    storage_scope_id: crate::workspace::StorageScopeId,
    project_id: crate::project::ProjectId,
    database_remaining: Duration,
    remaining_captured_at: Instant,
}

impl PersistedSession {
    fn presign_expiry(
        &self,
        configured_minutes: u16,
    ) -> Result<PresignExpiry, SinglePutServiceError> {
        let remaining = self
            .database_remaining
            .saturating_sub(self.remaining_captured_at.elapsed());
        let remaining_whole_minutes = remaining.as_secs() / 60;
        let minutes = u16::try_from(remaining_whole_minutes)
            .unwrap_or(u16::MAX)
            .min(configured_minutes);
        PresignExpiry::minutes(minutes).map_err(|_| SinglePutServiceError::SessionNearExpiry)
    }
}

struct ExistingSession {
    id: String,
    state: String,
    expected_project_version: i64,
    expected_physical_bytes: i64,
    expected_logical_bytes: i64,
    expected_file_count: i32,
    expected_sha256: Vec<u8>,
    expires_at: OffsetDateTime,
    staging_object_key: String,
    remaining: Duration,
}

fn validate_request(request: &CreateSinglePutSession) -> Result<(), SinglePutServiceError> {
    if !(1..=MAX_SINGLE_PUT_BYTES).contains(&request.expected_physical_bytes)
        || request.expected_logical_bytes > MAX_LOGICAL_BYTES
        || request.expected_file_count > MAX_FILES
    {
        return Err(SinglePutServiceError::InvalidInput);
    }
    Ok(())
}

fn idempotency_digest(secret: &IdempotencySecret, request: &CreateSinglePutSession) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.expose_for_hmac())
        .unwrap_or_else(|_| unreachable!("HMAC-SHA-256 accepts a 32-byte key"));
    mac.update(b"nuriteo-save-single-put-v1\0");
    mac.update(request.actor_user_id.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(request.project_id.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(request.idempotency_key.expose_for_hmac());
    mac.finalize().into_bytes().into()
}

fn idempotency_key_fingerprint(secret: &IdempotencySecret) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"nuriteo-save-idempotency-key-v1\0");
    digest.update(secret.expose_for_hmac());
    digest.finalize().into()
}

async fn ensure_idempotency_configuration(
    connection: &mut PgConnection,
    secret: &IdempotencySecret,
    deadline: Deadline,
) -> Result<(), SinglePutServiceError> {
    let fingerprint = idempotency_key_fingerprint(secret);
    deadline
        .run(
            sqlx::query(
                "INSERT INTO save_idempotency_config (singleton,key_fingerprint) VALUES (TRUE,$1) \
                 ON CONFLICT (singleton) DO NOTHING",
            )
            .bind(fingerprint.as_slice())
            .execute(&mut *connection),
        )
        .await?
        .map_err(map_sql_error)?;
    let matches: bool = deadline
        .run(
            sqlx::query_scalar(
                "SELECT key_fingerprint=$1 FROM save_idempotency_config WHERE singleton=TRUE",
            )
            .bind(fingerprint.as_slice())
            .fetch_one(&mut *connection),
        )
        .await?
        .map_err(map_sql_error)?;
    if matches {
        Ok(())
    } else {
        Err(SinglePutServiceError::IdempotencyConfigurationMismatch)
    }
}

fn reservation(request: &CreateSinglePutSession, session_id: SaveSessionId) -> ReservationRequest {
    ReservationRequest {
        storage_scope_id: request.storage_scope_id,
        project_id: request.project_id,
        save_session_id: session_id,
        requested_bytes: request.expected_physical_bytes,
        effective_quota: request.effective_quota,
    }
}

async fn configure_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), SinglePutServiceError> {
    let timeout = deadline
        .remaining()?
        .saturating_sub(SQL_TIMEOUT_MARGIN)
        .max(Duration::from_millis(1));
    let millis = timeout.as_millis().min(i64::MAX as u128);
    deadline
        .run(
            sqlx::query(
                "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
            )
            .bind(format!("{millis}ms"))
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(())
}

async fn lock_scope_and_authorize(
    transaction: &mut Transaction<'_, Postgres>,
    request: &CreateSinglePutSession,
    deadline: Deadline,
) -> Result<i64, SinglePutServiceError> {
    let scope = deadline
        .run(QuotaRepository::lock_storage_scope(
            transaction,
            request.storage_scope_id,
        ))
        .await?
        .map_err(map_sql_error)?;
    if !scope {
        return Err(SinglePutServiceError::ScopeNotFound);
    }
    let role = deadline
        .run(ProjectAccessRepository::resolve_effective_role_for_update(
            transaction,
            request.project_id,
            request.actor_user_id,
        ))
        .await?
        .map_err(map_project_access_error)?;
    if role < EffectiveProjectRole::Write {
        return Err(SinglePutServiceError::ProjectNotFound);
    }
    let row: (String, i64, String) = deadline
        .run(
            sqlx::query_as(
                "SELECT state,lock_version,storage_scope_id::text FROM projects WHERE id=$1::uuid",
            )
            .bind(request.project_id.to_string())
            .fetch_one(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    if row.0 != "active" {
        return Err(SinglePutServiceError::ProjectUnavailable);
    }
    if row.2 != request.storage_scope_id.to_string() {
        return Err(SinglePutServiceError::ProjectNotFound);
    }
    Ok(row.1)
}

async fn load_idempotent(
    transaction: &mut Transaction<'_, Postgres>,
    request: &CreateSinglePutSession,
    digest: &[u8; 32],
    deadline: Deadline,
) -> Result<Option<ExistingSession>, SinglePutServiceError> {
    type ExistingSessionRow = (
        String,
        String,
        i64,
        i64,
        i64,
        i32,
        Vec<u8>,
        OffsetDateTime,
        String,
        i64,
    );
    let row: Option<ExistingSessionRow> = deadline
        .run(
            sqlx::query_as(
                "SELECT id::text,state,expected_project_version,expected_physical_bytes, \
                 expected_logical_bytes,expected_file_count,expected_bundle_sha256,expires_at,staging_object_key, \
                 GREATEST(0,EXTRACT(EPOCH FROM (expires_at-transaction_timestamp()))::bigint) \
                 FROM save_sessions \
                 WHERE project_id=$1::uuid AND actor_user_id=$2::uuid AND idempotency_digest=$3 \
                 FOR UPDATE",
            )
            .bind(request.project_id.to_string())
            .bind(request.actor_user_id.to_string())
            .bind(digest.as_slice())
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(row.map(|row| ExistingSession {
        id: row.0,
        state: row.1,
        expected_project_version: row.2,
        expected_physical_bytes: row.3,
        expected_logical_bytes: row.4,
        expected_file_count: row.5,
        expected_sha256: row.6,
        expires_at: row.7,
        staging_object_key: row.8,
        remaining: Duration::from_secs(u64::try_from(row.9).unwrap_or(0)),
    }))
}

fn duration_from_seconds(seconds: i64) -> Result<Duration, SinglePutServiceError> {
    u64::try_from(seconds)
        .map(Duration::from_secs)
        .map_err(|_| SinglePutServiceError::InvariantViolation)
}

fn validate_existing(
    existing: &ExistingSession,
    request: &CreateSinglePutSession,
) -> Result<(), SinglePutServiceError> {
    if existing.expected_project_version != request.expected_project_version.get()
        || u64::try_from(existing.expected_physical_bytes).ok()
            != Some(request.expected_physical_bytes)
        || u64::try_from(existing.expected_logical_bytes).ok()
            != Some(request.expected_logical_bytes)
        || u32::try_from(existing.expected_file_count).ok() != Some(request.expected_file_count)
        || existing.expected_sha256.as_slice() != request.expected_sha256.as_bytes()
    {
        return Err(SinglePutServiceError::IdempotencyConflict);
    }
    Ok(())
}

async fn commit(
    transaction: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), SinglePutServiceError> {
    match tokio_time::timeout_at(deadline.0, transaction.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(map_commit_error(error)),
        Err(_) => Err(SinglePutServiceError::CommitOutcomeUnknown),
    }
}

fn parse_session_id(value: &str) -> Result<SaveSessionId, SinglePutServiceError> {
    let uuid =
        uuid::Uuid::parse_str(value).map_err(|_| SinglePutServiceError::InvariantViolation)?;
    SaveSessionId::from_uuid(uuid).map_err(|_| SinglePutServiceError::InvariantViolation)
}

fn is_active(state: &str) -> bool {
    matches!(state, "created" | "uploading" | "verifying")
}

fn map_database_error(error: DatabaseError) -> SinglePutServiceError {
    match error {
        DatabaseError::AcquireTimeout => SinglePutServiceError::OperationTimeout,
        _ => SinglePutServiceError::DatabaseUnavailable,
    }
}

fn map_sql_error(error: sqlx::Error) -> SinglePutServiceError {
    match error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
    {
        Some("57014" | "55P03") => SinglePutServiceError::OperationTimeout,
        Some("23505") => SinglePutServiceError::IdempotencyConflict,
        Some("23503" | "23514") => SinglePutServiceError::InvariantViolation,
        _ => SinglePutServiceError::DatabaseUnavailable,
    }
}

pub(super) fn map_commit_error(error: sqlx::Error) -> SinglePutServiceError {
    if error.as_database_error().is_none() {
        SinglePutServiceError::CommitOutcomeUnknown
    } else {
        map_sql_error(error)
    }
}

fn map_quota_error(error: QuotaServiceError) -> SinglePutServiceError {
    match error {
        QuotaServiceError::QuotaExceeded => SinglePutServiceError::QuotaExceeded,
        QuotaServiceError::OperationTimeout => SinglePutServiceError::OperationTimeout,
        QuotaServiceError::CommitOutcomeUnknown => SinglePutServiceError::CommitOutcomeUnknown,
        QuotaServiceError::ScopeNotFound => SinglePutServiceError::ScopeNotFound,
        QuotaServiceError::ProjectNotFound | QuotaServiceError::WrongScope => {
            SinglePutServiceError::ProjectNotFound
        }
        QuotaServiceError::SessionTerminal | QuotaServiceError::SessionExpired => {
            SinglePutServiceError::SessionTerminal
        }
        QuotaServiceError::DatabaseUnavailable => SinglePutServiceError::DatabaseUnavailable,
        QuotaServiceError::InvalidInput => SinglePutServiceError::InvalidInput,
        QuotaServiceError::ReservationConflict
        | QuotaServiceError::ArithmeticOverflow
        | QuotaServiceError::SessionNotFound
        | QuotaServiceError::InvariantViolation => SinglePutServiceError::InvariantViolation,
    }
}

fn map_project_access_error(error: ProjectAccessError) -> SinglePutServiceError {
    match error {
        ProjectAccessError::OperationTimeout => SinglePutServiceError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => SinglePutServiceError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => SinglePutServiceError::InvariantViolation,
        ProjectAccessError::ProjectUnavailable
        | ProjectAccessError::ProjectNotOrganizationOwned
        | ProjectAccessError::MemberUnavailable
        | ProjectAccessError::AlreadyGranted => SinglePutServiceError::ProjectNotFound,
    }
}
