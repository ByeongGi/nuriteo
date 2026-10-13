use std::fmt;
use std::future::Future;
use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use sqlx::{Acquire, PgConnection, Postgres, Transaction};
use time::OffsetDateTime;
use tokio::time::{self as tokio_time, Instant};

use crate::database::{DatabaseError, DatabasePool};
use crate::identity::UserId;
use crate::object_storage::{
    BoundedPresignedRequest, MAX_MULTIPART_PART_BYTES, MAX_MULTIPART_PARTS,
    MIN_MULTIPART_PART_BYTES, MultipartUpload, ObjectKey, ObjectStoreError, PresignExpiry,
    PresignedMultipartPartRequest, S3ObjectStore, Sha256Checksum, UploadedPart,
};
use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId,
};
use crate::quota::{
    QuotaRepository, QuotaService, QuotaServiceError, QuotaServicePolicy, ReservationRequest,
    SaveSessionId, TerminalSaveState,
};
use crate::workspace::StorageScopeId;

use super::{
    CreateMultipartSession, IdempotencySecret, MultipartCompleteResult, MultipartPartCapability,
    MultipartPartPlan, MultipartPartReceipt, MultipartSession, MultipartSessionContext,
};

const MAX_MULTIPART_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_LOGICAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILES: u32 = 2_500;
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const SQL_TIMEOUT_MARGIN: Duration = Duration::from_millis(25);
const MAX_ISSUE_BATCH: u16 = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MultipartServicePolicy {
    operation_timeout: Duration,
    presign_minutes: u16,
    single_put_threshold_bytes: u64,
    part_size_bytes: u64,
    issue_batch_limit: u16,
}

impl MultipartServicePolicy {
    pub fn new(
        operation_timeout: Duration,
        presign_minutes: u16,
        single_put_threshold_bytes: u64,
        part_size_bytes: u64,
        issue_batch_limit: u16,
    ) -> Result<Self, MultipartServiceError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout)
            || PresignExpiry::minutes(presign_minutes).is_err()
            || single_put_threshold_bytes == 0
            || single_put_threshold_bytes >= MAX_MULTIPART_BYTES
            || !(MIN_MULTIPART_PART_BYTES as u64..=MAX_MULTIPART_PART_BYTES as u64)
                .contains(&part_size_bytes)
            || !(1..=MAX_ISSUE_BATCH).contains(&issue_batch_limit)
        {
            return Err(MultipartServiceError::InvalidInput);
        }
        Ok(Self {
            operation_timeout,
            presign_minutes,
            single_put_threshold_bytes,
            part_size_bytes,
            issue_batch_limit,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum MultipartServiceError {
    InvalidInput,
    ScopeNotFound,
    ProjectNotFound,
    ProjectUnavailable,
    StaleProjectVersion,
    IdempotencyConflict,
    IdempotencyConfigurationMismatch,
    ActiveSessionConflict,
    SessionNotFound,
    SessionExpired,
    SessionTerminal,
    SessionNearExpiry,
    PartConflict,
    PartsIncomplete,
    QuotaExceeded,
    OperationTimeout,
    DatabaseUnavailable,
    ObjectStorageUnavailable,
    CreateReconciliationRequired,
    CompleteReconciliationRequired,
    CommitOutcomeUnknown,
    InvariantViolation,
}

impl fmt::Display for MultipartServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "multipart request is invalid",
            Self::ScopeNotFound => "storage scope was not found",
            Self::ProjectNotFound => "project was not found",
            Self::ProjectUnavailable => "project is unavailable",
            Self::StaleProjectVersion => "project version is stale",
            Self::IdempotencyConflict => "idempotency key conflicts with an existing request",
            Self::IdempotencyConfigurationMismatch => {
                "Save idempotency configuration does not match persisted state"
            }
            Self::ActiveSessionConflict => "project already has an active Save session",
            Self::SessionNotFound => "multipart Save session was not found",
            Self::SessionExpired => "multipart Save session is expired",
            Self::SessionTerminal => "multipart Save session is terminal",
            Self::SessionNearExpiry => "multipart Save session is too close to expiry",
            Self::PartConflict => "multipart part conflicts with the persisted plan",
            Self::PartsIncomplete => "multipart parts are incomplete",
            Self::QuotaExceeded => "workspace storage quota is exceeded",
            Self::OperationTimeout => "multipart operation timed out",
            Self::DatabaseUnavailable => "multipart persistence is unavailable",
            Self::ObjectStorageUnavailable => "multipart object storage is unavailable",
            Self::CreateReconciliationRequired => "multipart create requires reconciliation",
            Self::CompleteReconciliationRequired => "multipart complete requires reconciliation",
            Self::CommitOutcomeUnknown => "multipart transaction commit outcome is unknown",
            Self::InvariantViolation => "multipart persistence state is invalid",
        })
    }
}

impl std::error::Error for MultipartServiceError {}

pub trait MultipartStore: Clone + Send + Sync + 'static {
    type Error: Send;

    fn create(
        &self,
        key: ObjectKey,
    ) -> impl Future<Output = Result<MultipartUpload, Self::Error>> + Send;

    fn presign_part(
        &self,
        request: PresignedMultipartPartRequest,
    ) -> impl Future<Output = Result<BoundedPresignedRequest, Self::Error>> + Send;

    fn complete(
        &self,
        upload: &MultipartUpload,
        parts: Vec<UploadedPart>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;

    fn abort(
        &self,
        upload: &MultipartUpload,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

impl MultipartStore for S3ObjectStore {
    type Error = ObjectStoreError;

    async fn create(&self, key: ObjectKey) -> Result<MultipartUpload, Self::Error> {
        self.create_multipart(key).await
    }

    async fn presign_part(
        &self,
        request: PresignedMultipartPartRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        self.presign_multipart_part(request).await
    }

    async fn complete(
        &self,
        upload: &MultipartUpload,
        parts: Vec<UploadedPart>,
    ) -> Result<(), Self::Error> {
        self.complete_multipart(upload, parts).await
    }

    async fn abort(&self, upload: &MultipartUpload) -> Result<(), Self::Error> {
        self.abort_multipart(upload).await
    }
}

#[derive(Clone)]
pub struct MultipartService<S = S3ObjectStore> {
    pool: DatabasePool,
    store: S,
    quota: QuotaService,
    policy: MultipartServicePolicy,
    idempotency_secret: IdempotencySecret,
}

impl<S> fmt::Debug for MultipartService<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultipartService")
            .field("pool", &self.pool)
            .field("policy", &self.policy)
            .field("idempotency_secret", &self.idempotency_secret)
            .finish_non_exhaustive()
    }
}

impl<S: MultipartStore> MultipartService<S> {
    pub fn new(
        pool: DatabasePool,
        store: S,
        policy: MultipartServicePolicy,
        idempotency_secret: IdempotencySecret,
    ) -> Result<Self, MultipartServiceError> {
        Self::new_with_quota_source(pool, store, policy, idempotency_secret, false)
    }

    pub(crate) fn new_live(
        pool: DatabasePool,
        store: S,
        policy: MultipartServicePolicy,
        idempotency_secret: IdempotencySecret,
    ) -> Result<Self, MultipartServiceError> {
        Self::new_with_quota_source(pool, store, policy, idempotency_secret, true)
    }

    fn new_with_quota_source(
        pool: DatabasePool,
        store: S,
        policy: MultipartServicePolicy,
        idempotency_secret: IdempotencySecret,
        live_instance_defaults: bool,
    ) -> Result<Self, MultipartServiceError> {
        let quota_policy = QuotaServicePolicy::new(policy.operation_timeout)
            .map_err(|_| MultipartServiceError::InvalidInput)?;
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
        request: CreateMultipartSession,
    ) -> Result<MultipartSession, MultipartServiceError> {
        validate_create(&request, self.policy)?;
        let deadline = Deadline::new(self.policy.operation_timeout);
        let digest = idempotency_digest(&self.idempotency_secret, &request);
        let persisted = self.persist_plan(&request, &digest, deadline).await?;
        if persisted.idempotent_retry {
            if persisted.is_expired() {
                return Err(MultipartServiceError::SessionExpired);
            }
            return match (persisted.state.as_str(), persisted.create_status.as_str()) {
                ("uploading", "ready") => Ok(persisted.public()),
                ("created", "creating" | "unknown") => {
                    Err(MultipartServiceError::CreateReconciliationRequired)
                }
                ("verifying", _) | ("committed", _) => Err(MultipartServiceError::SessionTerminal),
                _ => Err(MultipartServiceError::InvariantViolation),
            };
        }

        let key = ObjectKey::parse(persisted.staging_object_key.clone())
            .map_err(|_| MultipartServiceError::InvariantViolation)?;
        let upload = match deadline.run(self.store.create(key)).await {
            Ok(Ok(upload)) => upload,
            Ok(Err(_)) | Err(_) => {
                let _ = self.mark_create_unknown(&persisted, deadline).await;
                return Err(MultipartServiceError::CreateReconciliationRequired);
            }
        };
        match self.attach_upload(&persisted, &upload, deadline).await {
            Ok(()) => Ok(persisted.public()),
            Err(MultipartServiceError::CommitOutcomeUnknown) => {
                // A fresh connection observes either the committed `ready`
                // attach or the rolled-back `creating` marker. Only the
                // latter may become `unknown` and enqueue reconciliation.
                let _ = self.mark_create_unknown(&persisted, deadline).await;
                Err(MultipartServiceError::CommitOutcomeUnknown)
            }
            Err(_) => {
                self.compensate_confirmed_attach_failure(&persisted, &upload, deadline)
                    .await
            }
        }
    }

    pub async fn issue_parts(
        &self,
        context: MultipartSessionContext,
        requested: Vec<MultipartPartPlan>,
    ) -> Result<Vec<MultipartPartCapability>, MultipartServiceError> {
        validate_part_batch(&requested, self.policy.issue_batch_limit)?;
        let deadline = Deadline::new(self.policy.operation_timeout);
        let loaded = self
            .load_active(context, &requested, false, deadline)
            .await?;
        let expiry = loaded.presign_expiry(self.policy.presign_minutes)?;
        let upload = loaded.upload()?;
        let mut result = Vec::with_capacity(loaded.parts.len());
        for part in loaded.parts {
            let request = PresignedMultipartPartRequest::new(
                upload.clone(),
                part.part_number,
                part.expected_bytes,
                part.expected_sha256,
                expiry,
            )
            .map_err(|_| MultipartServiceError::InvariantViolation)?;
            let signed = deadline
                .run(self.store.presign_part(request))
                .await?
                .map_err(|_| MultipartServiceError::ObjectStorageUnavailable)?;
            result.push(MultipartPartCapability::new(part.part_number, signed));
        }
        Ok(result)
    }

    /// Validates a relay capability batch against the persisted multipart
    /// plan without creating or exposing an object-store bearer capability.
    pub async fn validate_relay_parts(
        &self,
        context: MultipartSessionContext,
        requested: Vec<MultipartPartPlan>,
    ) -> Result<(), MultipartServiceError> {
        validate_part_batch(&requested, self.policy.issue_batch_limit)?;
        let deadline = Deadline::new(self.policy.operation_timeout);
        self.load_active(context, &requested, false, deadline)
            .await
            .map(|_| ())
    }

    pub async fn record_receipts(
        &self,
        context: MultipartSessionContext,
        receipts: Vec<MultipartPartReceipt>,
    ) -> Result<(), MultipartServiceError> {
        validate_receipt_batch(&receipts, self.policy.issue_batch_limit)?;
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut transaction, deadline).await?;
        lock_scope_and_authorize(&mut transaction, context, deadline).await?;
        let session = load_session_for_update(&mut transaction, context, deadline).await?;
        ensure_uploading(&session)?;
        for receipt in receipts {
            let row: (i64, Vec<u8>, String, Option<String>) = deadline
                .run(
                    sqlx::query_as(
                        "SELECT expected_bytes,expected_sha256,state,object_etag \
                         FROM multipart_parts WHERE save_session_id=$1::uuid AND part_number=$2 \
                         FOR UPDATE",
                    )
                    .bind(context.session_id.to_string())
                    .bind(
                        i16::try_from(receipt.part_number())
                            .map_err(|_| MultipartServiceError::InvalidInput)?,
                    )
                    .fetch_one(&mut *transaction),
                )
                .await?
                .map_err(map_sql_error)?;
            if u64::try_from(row.0).ok() != Some(receipt.expected_bytes())
                || row.1.as_slice() != receipt.expected_sha256().as_bytes()
            {
                return Err(MultipartServiceError::PartConflict);
            }
            if row.2 == "uploaded" {
                if row.3.as_deref() != Some(receipt.expose_etag_for_storage()) {
                    return Err(MultipartServiceError::PartConflict);
                }
                continue;
            }
            deadline
                .run(
                    sqlx::query(
                        "UPDATE multipart_parts SET state='uploaded',object_etag=$3, \
                         uploaded_at=transaction_timestamp(),updated_at=transaction_timestamp() \
                         WHERE save_session_id=$1::uuid AND part_number=$2",
                    )
                    .bind(context.session_id.to_string())
                    .bind(
                        i16::try_from(receipt.part_number())
                            .map_err(|_| MultipartServiceError::InvalidInput)?,
                    )
                    .bind(receipt.expose_etag_for_storage())
                    .execute(&mut *transaction),
                )
                .await?
                .map_err(map_sql_error)?;
        }
        commit(transaction, deadline).await
    }

    pub async fn complete(
        &self,
        context: MultipartSessionContext,
    ) -> Result<MultipartCompleteResult, MultipartServiceError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let prepared = self.prepare_complete(context, deadline).await?;
        if prepared.idempotent_retry {
            return Ok(MultipartCompleteResult::new(true));
        }
        match deadline
            .run(self.store.complete(&prepared.upload, prepared.parts))
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => {
                let _ = self.mark_complete_unknown(context, deadline).await;
                return Err(MultipartServiceError::CompleteReconciliationRequired);
            }
        }
        match self.finalize_complete(context, deadline).await {
            Ok(()) => Ok(MultipartCompleteResult::new(false)),
            Err(MultipartServiceError::CommitOutcomeUnknown) => {
                Err(MultipartServiceError::CommitOutcomeUnknown)
            }
            Err(_) => {
                let _ = self.mark_complete_unknown(context, deadline).await;
                Err(MultipartServiceError::CompleteReconciliationRequired)
            }
        }
    }

    pub async fn abort(
        &self,
        context: MultipartSessionContext,
    ) -> Result<(), MultipartServiceError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let loaded = self.load_active(context, &[], true, deadline).await?;
        let upload = loaded.upload()?;
        match deadline.run(self.store.abort(&upload)).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => return Err(MultipartServiceError::CreateReconciliationRequired),
        }
        marker_update(
            &self.pool,
            context,
            "UPDATE multipart_lifecycles SET create_status='cleaned',updated_at=transaction_timestamp() \
             WHERE save_session_id=$1::uuid AND create_status='ready' AND complete_status='pending'",
            deadline,
        )
        .await
        .map_err(|_| MultipartServiceError::CreateReconciliationRequired)?;
        self.quota
            .transition_terminal_before(
                context.storage_scope_id,
                context.project_id,
                context.session_id,
                TerminalSaveState::Aborted,
                deadline.0,
            )
            .await
            .map_err(|_| MultipartServiceError::CommitOutcomeUnknown)
    }

    async fn persist_plan(
        &self,
        request: &CreateMultipartSession,
        digest: &[u8; 32],
        deadline: Deadline,
    ) -> Result<PersistedMultipart, MultipartServiceError> {
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
        let context = MultipartSessionContext {
            storage_scope_id: request.storage_scope_id,
            project_id: request.project_id,
            actor_user_id: request.actor_user_id,
            session_id: SaveSessionId::new(),
        };
        let project_version = lock_scope_and_authorize(&mut transaction, context, deadline).await?;
        if let Some(existing) = load_idempotent(&mut transaction, request, digest, deadline).await?
        {
            validate_existing(&existing, request, self.policy)?;
            validate_existing_parts(&mut transaction, &existing.id, &request.parts, deadline)
                .await?;
            commit(transaction, deadline).await?;
            return existing.into_persisted(request, true);
        }
        if project_version != request.expected_project_version.get() {
            return Err(MultipartServiceError::StaleProjectVersion);
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
            return Err(MultipartServiceError::ActiveSessionConflict);
        }
        let session_id = context.session_id;
        let staging_object_key = format!(
            "staging/{}/{}/{}.bundle",
            request.storage_scope_id, request.project_id, session_id
        );
        let session_minutes = self
            .policy
            .presign_minutes
            .checked_add(1)
            .ok_or(MultipartServiceError::InvalidInput)?;
        let (expires_at, remaining_seconds): (OffsetDateTime, i64) = deadline
            .run(
                sqlx::query_as(
                    "INSERT INTO save_sessions \
                     (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
                      expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
                      expected_file_count,staging_object_key,upload_mode,expires_at,idempotency_digest) \
                     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,'multipart', \
                             transaction_timestamp()+make_interval(mins=>$11),$12) \
                     RETURNING expires_at,EXTRACT(EPOCH FROM (expires_at-transaction_timestamp()))::bigint",
                )
                .bind(session_id.to_string())
                .bind(request.project_id.to_string())
                .bind(request.storage_scope_id.to_string())
                .bind(request.actor_user_id.to_string())
                .bind(request.expected_project_version.get())
                .bind(request.expected_sha256.as_bytes().as_slice())
                .bind(i64::try_from(request.expected_physical_bytes).map_err(|_| MultipartServiceError::InvalidInput)?)
                .bind(i64::try_from(request.expected_logical_bytes).map_err(|_| MultipartServiceError::InvalidInput)?)
                .bind(i32::try_from(request.expected_file_count).map_err(|_| MultipartServiceError::InvalidInput)?)
                .bind(&staging_object_key)
                .bind(i32::from(session_minutes))
                .bind(digest.as_slice())
                .fetch_one(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let lifecycle_affected = deadline
            .run(
                sqlx::query(
                    "INSERT INTO multipart_lifecycles \
                     (save_session_id,part_size_bytes,part_count,create_status,complete_status) \
                     VALUES ($1::uuid,$2,$3,'creating','pending')",
                )
                .bind(session_id.to_string())
                .bind(
                    i64::try_from(self.policy.part_size_bytes)
                        .map_err(|_| MultipartServiceError::InvalidInput)?,
                )
                .bind(
                    i16::try_from(request.parts.len())
                        .map_err(|_| MultipartServiceError::InvalidInput)?,
                )
                .execute(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if lifecycle_affected != 1 {
            return Err(MultipartServiceError::CreateReconciliationRequired);
        }
        for part in &request.parts {
            deadline
                .run(
                    sqlx::query(
                        "INSERT INTO multipart_parts \
                         (save_session_id,part_number,expected_bytes,expected_sha256) \
                         VALUES ($1::uuid,$2,$3,$4)",
                    )
                    .bind(session_id.to_string())
                    .bind(
                        i16::try_from(part.part_number())
                            .map_err(|_| MultipartServiceError::InvalidInput)?,
                    )
                    .bind(
                        i64::try_from(part.expected_bytes())
                            .map_err(|_| MultipartServiceError::InvalidInput)?,
                    )
                    .bind(part.expected_sha256().as_bytes().as_slice())
                    .execute(&mut *transaction),
                )
                .await?
                .map_err(map_sql_error)?;
        }
        self.quota
            .reserve_before_commit(
                &mut transaction,
                ReservationRequest {
                    storage_scope_id: request.storage_scope_id,
                    project_id: request.project_id,
                    save_session_id: session_id,
                    requested_bytes: request.expected_physical_bytes,
                    effective_quota: request.effective_quota,
                },
                deadline.0,
            )
            .await
            .map_err(map_quota_error)?;
        commit(transaction, deadline).await?;
        Ok(PersistedMultipart {
            session_id,
            expires_at,
            staging_object_key,
            state: "created".to_owned(),
            create_status: "creating".to_owned(),
            part_count: u16::try_from(request.parts.len())
                .map_err(|_| MultipartServiceError::InvalidInput)?,
            idempotent_retry: false,
            storage_scope_id: request.storage_scope_id,
            project_id: request.project_id,
            actor_user_id: request.actor_user_id,
            database_remaining: duration_from_seconds(remaining_seconds)?,
            remaining_captured_at: Instant::now(),
        })
    }

    async fn attach_upload(
        &self,
        persisted: &PersistedMultipart,
        upload: &MultipartUpload,
        deadline: Deadline,
    ) -> Result<(), MultipartServiceError> {
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut tx, deadline).await?;
        lock_scope_and_authorize(&mut tx, persisted.context(), deadline).await?;
        let affected = deadline
            .run(
                sqlx::query(
                    "UPDATE save_sessions SET multipart_upload_id=$2,state='uploading', \
                     updated_at=transaction_timestamp() WHERE id=$1::uuid AND state='created' \
                     AND multipart_upload_id IS NULL \
                     AND expires_at > transaction_timestamp()",
                )
                .bind(persisted.session_id.to_string())
                .bind(&upload.upload_id)
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if affected != 1 {
            return Err(MultipartServiceError::CreateReconciliationRequired);
        }
        let marker_affected = deadline
            .run(
                sqlx::query(
                    "UPDATE multipart_lifecycles SET create_status='ready', \
                     updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid \
                     AND create_status='creating' AND complete_status='pending'",
                )
                .bind(persisted.session_id.to_string())
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if marker_affected != 1 {
            return Err(MultipartServiceError::CreateReconciliationRequired);
        }
        commit(tx, deadline).await
    }

    async fn mark_create_unknown(
        &self,
        persisted: &PersistedMultipart,
        deadline: Deadline,
    ) -> Result<(), MultipartServiceError> {
        marker_update(
            &self.pool,
            persisted.context(),
            "UPDATE multipart_lifecycles SET create_status='unknown',updated_at=transaction_timestamp() \
             WHERE save_session_id=$1::uuid AND create_status='creating' AND complete_status='pending'",
            deadline,
        )
        .await
    }

    async fn compensate_confirmed_attach_failure(
        &self,
        persisted: &PersistedMultipart,
        upload: &MultipartUpload,
        deadline: Deadline,
    ) -> Result<MultipartSession, MultipartServiceError> {
        match deadline.run(self.store.abort(upload)).await {
            Ok(Ok(())) => {
                marker_update(
                    &self.pool,
                    persisted.context(),
                    "UPDATE multipart_lifecycles SET create_status='cleaned',updated_at=transaction_timestamp() \
                     WHERE save_session_id=$1::uuid AND create_status='creating' AND complete_status='pending'",
                    deadline,
                )
                .await
                .map_err(|_| MultipartServiceError::CreateReconciliationRequired)?;
                self.quota
                    .transition_terminal_before(
                        persisted.storage_scope_id,
                        persisted.project_id,
                        persisted.session_id,
                        TerminalSaveState::Failed,
                        deadline.0,
                    )
                    .await
                    .map_err(|_| MultipartServiceError::CreateReconciliationRequired)?;
            }
            Ok(Err(_)) | Err(_) => {
                let _ = self.mark_create_unknown(persisted, deadline).await;
            }
        }
        Err(MultipartServiceError::CreateReconciliationRequired)
    }

    async fn load_active(
        &self,
        context: MultipartSessionContext,
        requested: &[MultipartPartPlan],
        require_all: bool,
        deadline: Deadline,
    ) -> Result<LoadedMultipart, MultipartServiceError> {
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut tx, deadline).await?;
        lock_scope_and_authorize(&mut tx, context, deadline).await?;
        let session = load_session_for_update(&mut tx, context, deadline).await?;
        ensure_uploading(&session)?;
        let rows: Vec<PartRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT part_number,expected_bytes,expected_sha256,state,object_etag \
                     FROM multipart_parts WHERE save_session_id=$1::uuid ORDER BY part_number",
                )
                .bind(context.session_id.to_string())
                .fetch_all(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        let selected = if require_all {
            rows
        } else {
            rows.into_iter()
                .filter(|row| {
                    requested
                        .iter()
                        .any(|part| i32::from(row.0) == i32::from(part.part_number()))
                })
                .collect()
        };
        let parts = decode_parts(selected)?;
        if !require_all {
            if parts.len() != requested.len() {
                return Err(MultipartServiceError::PartConflict);
            }
            for (actual, expected) in parts.iter().zip(requested) {
                if actual.part_number != expected.part_number()
                    || actual.expected_bytes != expected.expected_bytes()
                    || actual.expected_sha256 != *expected.expected_sha256()
                {
                    return Err(MultipartServiceError::PartConflict);
                }
            }
        }
        commit(tx, deadline).await?;
        Ok(LoadedMultipart {
            staging_object_key: session.staging_object_key,
            upload_id: session.multipart_upload_id,
            remaining: session.remaining,
            remaining_captured_at: Instant::now(),
            parts,
        })
    }

    async fn prepare_complete(
        &self,
        context: MultipartSessionContext,
        deadline: Deadline,
    ) -> Result<PreparedComplete, MultipartServiceError> {
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut tx, deadline).await?;
        lock_scope_and_authorize(&mut tx, context, deadline).await?;
        let session = load_session_for_update(&mut tx, context, deadline).await?;
        let relay_upload_active: bool = deadline
            .run(
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM save_upload_leases \
                     WHERE save_session_id=$1::uuid AND released_at IS NULL \
                       AND lease_expires_at>clock_timestamp())",
                )
                .bind(context.session_id.to_string())
                .fetch_one(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        if relay_upload_active {
            return Err(MultipartServiceError::ActiveSessionConflict);
        }
        let lifecycle: (String, String, i16) = deadline
            .run(
                sqlx::query_as(
                    "SELECT create_status,complete_status,part_count FROM multipart_lifecycles \
                     WHERE save_session_id=$1::uuid FOR UPDATE",
                )
                .bind(context.session_id.to_string())
                .fetch_one(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        if session.state == "verifying" && lifecycle.1 == "completed" {
            commit(tx, deadline).await?;
            return Ok(PreparedComplete {
                upload: session.upload()?,
                parts: Vec::new(),
                idempotent_retry: true,
            });
        }
        ensure_uploading(&session)?;
        if lifecycle.0 != "ready" {
            return Err(MultipartServiceError::CreateReconciliationRequired);
        }
        if lifecycle.1 != "pending" {
            return Err(MultipartServiceError::CompleteReconciliationRequired);
        }
        let rows: Vec<PartRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT part_number,expected_bytes,expected_sha256,state,object_etag \
                     FROM multipart_parts WHERE save_session_id=$1::uuid ORDER BY part_number FOR UPDATE",
                )
                .bind(context.session_id.to_string())
                .fetch_all(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?;
        let parts = decode_parts(rows)?;
        if parts.len()
            != usize::try_from(lifecycle.2)
                .map_err(|_| MultipartServiceError::InvariantViolation)?
            || parts
                .iter()
                .any(|part| part.state != "uploaded" || part.e_tag.is_none())
            || parts
                .iter()
                .try_fold(0_u64, |sum, part| sum.checked_add(part.expected_bytes))
                != Some(
                    u64::try_from(session.expected_physical_bytes)
                        .map_err(|_| MultipartServiceError::InvariantViolation)?,
                )
        {
            return Err(MultipartServiceError::PartsIncomplete);
        }
        let completed = parts
            .into_iter()
            .map(|part| {
                Ok(UploadedPart {
                    part_number: part.part_number,
                    e_tag: part.e_tag.ok_or(MultipartServiceError::PartsIncomplete)?,
                    checksum: part.expected_sha256,
                })
            })
            .collect::<Result<Vec<_>, MultipartServiceError>>()?;
        let marker_affected = deadline
            .run(
                sqlx::query(
                    "UPDATE multipart_lifecycles SET complete_status='completing', \
                     updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid",
                )
                .bind(context.session_id.to_string())
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if marker_affected != 1 {
            return Err(MultipartServiceError::CompleteReconciliationRequired);
        }
        let upload = session.upload()?;
        commit(tx, deadline).await?;
        Ok(PreparedComplete {
            upload,
            parts: completed,
            idempotent_retry: false,
        })
    }

    async fn finalize_complete(
        &self,
        context: MultipartSessionContext,
        deadline: Deadline,
    ) -> Result<(), MultipartServiceError> {
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let mut tx = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut tx, deadline).await?;
        lock_scope_and_authorize(&mut tx, context, deadline).await?;
        let session_affected = deadline
            .run(
                sqlx::query(
                    "UPDATE save_sessions SET state='verifying',updated_at=transaction_timestamp() \
                     WHERE id=$1::uuid AND state='uploading'",
                )
                .bind(context.session_id.to_string())
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if session_affected != 1 {
            return Err(MultipartServiceError::CompleteReconciliationRequired);
        }
        let lifecycle_affected = deadline
            .run(
                sqlx::query(
                    "UPDATE multipart_lifecycles SET complete_status='completed', \
                     updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid \
                     AND create_status='ready' AND complete_status='completing'",
                )
                .bind(context.session_id.to_string())
                .execute(&mut *tx),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected();
        if lifecycle_affected != 1 {
            return Err(MultipartServiceError::CompleteReconciliationRequired);
        }
        commit(tx, deadline).await
    }

    async fn mark_complete_unknown(
        &self,
        context: MultipartSessionContext,
        deadline: Deadline,
    ) -> Result<(), MultipartServiceError> {
        marker_update(
            &self.pool,
            context,
            "UPDATE multipart_lifecycles SET complete_status='unknown',updated_at=transaction_timestamp() \
             WHERE save_session_id=$1::uuid AND create_status='ready' AND complete_status='completing'",
            deadline,
        )
        .await
    }
}

struct PersistedMultipart {
    session_id: SaveSessionId,
    expires_at: OffsetDateTime,
    staging_object_key: String,
    state: String,
    create_status: String,
    part_count: u16,
    idempotent_retry: bool,
    storage_scope_id: StorageScopeId,
    project_id: ProjectId,
    actor_user_id: UserId,
    database_remaining: Duration,
    remaining_captured_at: Instant,
}

impl PersistedMultipart {
    fn is_expired(&self) -> bool {
        self.database_remaining
            .saturating_sub(self.remaining_captured_at.elapsed())
            .is_zero()
    }

    fn context(&self) -> MultipartSessionContext {
        MultipartSessionContext {
            storage_scope_id: self.storage_scope_id,
            project_id: self.project_id,
            actor_user_id: self.actor_user_id,
            session_id: self.session_id,
        }
    }

    fn public(&self) -> MultipartSession {
        MultipartSession::new(
            self.session_id,
            self.expires_at,
            self.part_count,
            self.idempotent_retry,
        )
    }
}

struct ExistingMultipart {
    id: String,
    state: String,
    expected_project_version: i64,
    expected_physical_bytes: i64,
    expected_logical_bytes: i64,
    expected_file_count: i32,
    expected_sha256: Vec<u8>,
    expires_at: OffsetDateTime,
    staging_object_key: String,
    remaining_seconds: i64,
    part_size_bytes: i64,
    part_count: i16,
    create_status: String,
}

impl ExistingMultipart {
    fn into_persisted(
        self,
        request: &CreateMultipartSession,
        idempotent_retry: bool,
    ) -> Result<PersistedMultipart, MultipartServiceError> {
        Ok(PersistedMultipart {
            session_id: parse_session_id(&self.id)?,
            expires_at: self.expires_at,
            staging_object_key: self.staging_object_key,
            state: self.state,
            create_status: self.create_status,
            part_count: u16::try_from(self.part_count)
                .map_err(|_| MultipartServiceError::InvariantViolation)?,
            idempotent_retry,
            storage_scope_id: request.storage_scope_id,
            project_id: request.project_id,
            actor_user_id: request.actor_user_id,
            database_remaining: duration_from_seconds(self.remaining_seconds)?,
            remaining_captured_at: Instant::now(),
        })
    }
}

struct SessionRow {
    state: String,
    staging_object_key: String,
    multipart_upload_id: Option<String>,
    expected_physical_bytes: i64,
    remaining: Duration,
}

impl SessionRow {
    fn upload(&self) -> Result<MultipartUpload, MultipartServiceError> {
        Ok(MultipartUpload {
            key: ObjectKey::parse(self.staging_object_key.clone())
                .map_err(|_| MultipartServiceError::InvariantViolation)?,
            upload_id: self
                .multipart_upload_id
                .clone()
                .ok_or(MultipartServiceError::InvariantViolation)?,
        })
    }
}

struct LoadedPart {
    part_number: u16,
    expected_bytes: u64,
    expected_sha256: Sha256Checksum,
    state: String,
    e_tag: Option<String>,
}

type PartRow = (i16, i64, Vec<u8>, String, Option<String>);

struct LoadedMultipart {
    staging_object_key: String,
    upload_id: Option<String>,
    remaining: Duration,
    remaining_captured_at: Instant,
    parts: Vec<LoadedPart>,
}

impl LoadedMultipart {
    fn upload(&self) -> Result<MultipartUpload, MultipartServiceError> {
        Ok(MultipartUpload {
            key: ObjectKey::parse(self.staging_object_key.clone())
                .map_err(|_| MultipartServiceError::InvariantViolation)?,
            upload_id: self
                .upload_id
                .clone()
                .ok_or(MultipartServiceError::InvariantViolation)?,
        })
    }

    fn presign_expiry(&self, configured: u16) -> Result<PresignExpiry, MultipartServiceError> {
        let remaining = self
            .remaining
            .saturating_sub(self.remaining_captured_at.elapsed());
        let minutes = u16::try_from(remaining.as_secs() / 60)
            .unwrap_or(u16::MAX)
            .min(configured);
        PresignExpiry::minutes(minutes).map_err(|_| MultipartServiceError::SessionNearExpiry)
    }
}

struct PreparedComplete {
    upload: MultipartUpload,
    parts: Vec<UploadedPart>,
    idempotent_retry: bool,
}

#[derive(Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    fn remaining(self) -> Result<Duration, MultipartServiceError> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(MultipartServiceError::OperationTimeout)
        } else {
            Ok(remaining)
        }
    }

    async fn run<T>(self, future: impl Future<Output = T>) -> Result<T, MultipartServiceError> {
        tokio_time::timeout_at(self.0, future)
            .await
            .map_err(|_| MultipartServiceError::OperationTimeout)
    }
}

fn validate_create(
    request: &CreateMultipartSession,
    policy: MultipartServicePolicy,
) -> Result<(), MultipartServiceError> {
    if request.expected_physical_bytes <= policy.single_put_threshold_bytes
        || request.expected_physical_bytes > MAX_MULTIPART_BYTES
        || request.expected_logical_bytes > MAX_LOGICAL_BYTES
        || request.expected_file_count > MAX_FILES
        || request.parts.is_empty()
        || request.parts.len() > usize::from(MAX_MULTIPART_PARTS)
    {
        return Err(MultipartServiceError::InvalidInput);
    }
    let expected_count = request
        .expected_physical_bytes
        .checked_add(policy.part_size_bytes - 1)
        .ok_or(MultipartServiceError::InvalidInput)?
        / policy.part_size_bytes;
    if usize::try_from(expected_count).ok() != Some(request.parts.len()) {
        return Err(MultipartServiceError::InvalidInput);
    }
    let mut sum = 0_u64;
    for (index, part) in request.parts.iter().enumerate() {
        let number = u16::try_from(index + 1).map_err(|_| MultipartServiceError::InvalidInput)?;
        let expected_bytes = if index + 1 == request.parts.len() {
            request
                .expected_physical_bytes
                .checked_sub(
                    policy.part_size_bytes
                        * u64::try_from(index).map_err(|_| MultipartServiceError::InvalidInput)?,
                )
                .ok_or(MultipartServiceError::InvalidInput)?
        } else {
            policy.part_size_bytes
        };
        if part.part_number() != number || part.expected_bytes() != expected_bytes {
            return Err(MultipartServiceError::InvalidInput);
        }
        sum = sum
            .checked_add(part.expected_bytes())
            .ok_or(MultipartServiceError::InvalidInput)?;
    }
    if sum != request.expected_physical_bytes {
        return Err(MultipartServiceError::InvalidInput);
    }
    Ok(())
}

fn validate_part_batch(
    parts: &[MultipartPartPlan],
    limit: u16,
) -> Result<(), MultipartServiceError> {
    if parts.is_empty() || parts.len() > usize::from(limit) {
        return Err(MultipartServiceError::InvalidInput);
    }
    for window in parts.windows(2) {
        if window[0].part_number().checked_add(1) != Some(window[1].part_number()) {
            return Err(MultipartServiceError::InvalidInput);
        }
    }
    Ok(())
}

fn validate_receipt_batch(
    receipts: &[MultipartPartReceipt],
    limit: u16,
) -> Result<(), MultipartServiceError> {
    if receipts.is_empty() || receipts.len() > usize::from(limit) {
        return Err(MultipartServiceError::InvalidInput);
    }
    for window in receipts.windows(2) {
        if window[0].part_number().checked_add(1) != Some(window[1].part_number()) {
            return Err(MultipartServiceError::InvalidInput);
        }
    }
    Ok(())
}

fn idempotency_digest(secret: &IdempotencySecret, request: &CreateMultipartSession) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.expose_for_hmac())
        .unwrap_or_else(|_| unreachable!("HMAC-SHA-256 accepts a 32-byte key"));
    mac.update(b"nuriteo-save-multipart-v1\0");
    mac.update(request.actor_user_id.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(request.project_id.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(request.idempotency_key.expose_for_hmac());
    mac.finalize().into_bytes().into()
}

async fn ensure_idempotency_configuration(
    connection: &mut PgConnection,
    secret: &IdempotencySecret,
    deadline: Deadline,
) -> Result<(), MultipartServiceError> {
    use sha2::Digest as _;
    let mut hash = Sha256::new();
    hash.update(b"nuriteo-save-idempotency-key-v1\0");
    hash.update(secret.expose_for_hmac());
    let fingerprint: [u8; 32] = hash.finalize().into();
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
        Err(MultipartServiceError::IdempotencyConfigurationMismatch)
    }
}

async fn lock_scope_and_authorize(
    transaction: &mut Transaction<'_, Postgres>,
    context: MultipartSessionContext,
    deadline: Deadline,
) -> Result<i64, MultipartServiceError> {
    let scope = deadline
        .run(QuotaRepository::lock_storage_scope(
            transaction,
            context.storage_scope_id,
        ))
        .await?
        .map_err(map_sql_error)?;
    if !scope {
        return Err(MultipartServiceError::ScopeNotFound);
    }
    let role = deadline
        .run(ProjectAccessRepository::resolve_effective_role_for_update(
            transaction,
            context.project_id,
            context.actor_user_id,
        ))
        .await?
        .map_err(map_project_access_error)?;
    if role < EffectiveProjectRole::Write {
        return Err(MultipartServiceError::ProjectNotFound);
    }
    let row: (String, i64, String) = deadline
        .run(
            sqlx::query_as(
                "SELECT state,lock_version,storage_scope_id::text FROM projects WHERE id=$1::uuid",
            )
            .bind(context.project_id.to_string())
            .fetch_one(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    if row.0 != "active" {
        return Err(MultipartServiceError::ProjectUnavailable);
    }
    if row.2 != context.storage_scope_id.to_string() {
        return Err(MultipartServiceError::ProjectNotFound);
    }
    Ok(row.1)
}

async fn load_idempotent(
    tx: &mut Transaction<'_, Postgres>,
    request: &CreateMultipartSession,
    digest: &[u8; 32],
    deadline: Deadline,
) -> Result<Option<ExistingMultipart>, MultipartServiceError> {
    type Row = (
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
        i64,
        i16,
        String,
    );
    let row: Option<Row> = deadline
        .run(
            sqlx::query_as(
                "SELECT session.id::text,session.state,session.expected_project_version, \
                 session.expected_physical_bytes,session.expected_logical_bytes,session.expected_file_count,\
                 session.expected_bundle_sha256,session.expires_at, \
                 session.staging_object_key, \
                 GREATEST(0,EXTRACT(EPOCH FROM (session.expires_at-transaction_timestamp()))::bigint), \
                 lifecycle.part_size_bytes,lifecycle.part_count,lifecycle.create_status \
                 FROM save_sessions session JOIN multipart_lifecycles lifecycle \
                   ON lifecycle.save_session_id=session.id \
                 WHERE session.project_id=$1::uuid AND session.actor_user_id=$2::uuid \
                   AND session.idempotency_digest=$3 AND session.upload_mode='multipart' FOR UPDATE",
            )
            .bind(request.project_id.to_string())
            .bind(request.actor_user_id.to_string())
            .bind(digest.as_slice())
            .fetch_optional(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(row.map(|row| ExistingMultipart {
        id: row.0,
        state: row.1,
        expected_project_version: row.2,
        expected_physical_bytes: row.3,
        expected_logical_bytes: row.4,
        expected_file_count: row.5,
        expected_sha256: row.6,
        expires_at: row.7,
        staging_object_key: row.8,
        remaining_seconds: row.9,
        part_size_bytes: row.10,
        part_count: row.11,
        create_status: row.12,
    }))
}

fn validate_existing(
    existing: &ExistingMultipart,
    request: &CreateMultipartSession,
    policy: MultipartServicePolicy,
) -> Result<(), MultipartServiceError> {
    if existing.expected_project_version != request.expected_project_version.get()
        || u64::try_from(existing.expected_physical_bytes).ok()
            != Some(request.expected_physical_bytes)
        || u64::try_from(existing.expected_logical_bytes).ok()
            != Some(request.expected_logical_bytes)
        || u32::try_from(existing.expected_file_count).ok() != Some(request.expected_file_count)
        || existing.expected_sha256.as_slice() != request.expected_sha256.as_bytes()
        || u64::try_from(existing.part_size_bytes).ok() != Some(policy.part_size_bytes)
        || usize::try_from(existing.part_count).ok() != Some(request.parts.len())
    {
        return Err(MultipartServiceError::IdempotencyConflict);
    }
    Ok(())
}

async fn validate_existing_parts(
    tx: &mut Transaction<'_, Postgres>,
    session_id: &str,
    requested: &[MultipartPartPlan],
    deadline: Deadline,
) -> Result<(), MultipartServiceError> {
    let rows: Vec<(i16, i64, Vec<u8>)> = deadline
        .run(
            sqlx::query_as(
                "SELECT part_number,expected_bytes,expected_sha256 FROM multipart_parts \
                 WHERE save_session_id=$1::uuid ORDER BY part_number",
            )
            .bind(session_id)
            .fetch_all(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    if rows.len() != requested.len() {
        return Err(MultipartServiceError::IdempotencyConflict);
    }
    for (row, part) in rows.iter().zip(requested) {
        if u16::try_from(row.0).ok() != Some(part.part_number())
            || u64::try_from(row.1).ok() != Some(part.expected_bytes())
            || row.2.as_slice() != part.expected_sha256().as_bytes()
        {
            return Err(MultipartServiceError::IdempotencyConflict);
        }
    }
    Ok(())
}

async fn load_session_for_update(
    tx: &mut Transaction<'_, Postgres>,
    context: MultipartSessionContext,
    deadline: Deadline,
) -> Result<SessionRow, MultipartServiceError> {
    let row: Option<(String, String, Option<String>, i64, i64)> = deadline
        .run(
            sqlx::query_as(
                "SELECT state,staging_object_key,multipart_upload_id,expected_physical_bytes, \
                 GREATEST(0,EXTRACT(EPOCH FROM (expires_at-transaction_timestamp()))::bigint) \
                 FROM save_sessions WHERE id=$1::uuid AND project_id=$2::uuid \
                   AND storage_scope_id=$3::uuid AND upload_mode='multipart' FOR UPDATE",
            )
            .bind(context.session_id.to_string())
            .bind(context.project_id.to_string())
            .bind(context.storage_scope_id.to_string())
            .fetch_optional(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    row.map(|row| SessionRow {
        state: row.0,
        staging_object_key: row.1,
        multipart_upload_id: row.2,
        expected_physical_bytes: row.3,
        remaining: Duration::from_secs(u64::try_from(row.4).unwrap_or(0)),
    })
    .ok_or(MultipartServiceError::SessionNotFound)
}

fn ensure_uploading(session: &SessionRow) -> Result<(), MultipartServiceError> {
    if session.remaining.is_zero() {
        return Err(MultipartServiceError::SessionExpired);
    }
    match session.state.as_str() {
        "uploading" if session.multipart_upload_id.is_some() => Ok(()),
        "created" => Err(MultipartServiceError::CreateReconciliationRequired),
        "verifying" | "committed" | "aborted" | "expired" | "failed" => {
            Err(MultipartServiceError::SessionTerminal)
        }
        _ => Err(MultipartServiceError::InvariantViolation),
    }
}

fn decode_parts(rows: Vec<PartRow>) -> Result<Vec<LoadedPart>, MultipartServiceError> {
    rows.into_iter()
        .map(|row| {
            let digest: [u8; 32] = row
                .2
                .try_into()
                .map_err(|_| MultipartServiceError::InvariantViolation)?;
            Ok(LoadedPart {
                part_number: u16::try_from(row.0)
                    .map_err(|_| MultipartServiceError::InvariantViolation)?,
                expected_bytes: u64::try_from(row.1)
                    .map_err(|_| MultipartServiceError::InvariantViolation)?,
                expected_sha256: Sha256Checksum::from_bytes(digest),
                state: row.3,
                e_tag: row.4,
            })
        })
        .collect()
}

async fn marker_update(
    pool: &DatabasePool,
    context: MultipartSessionContext,
    sql: &'static str,
    deadline: Deadline,
) -> Result<(), MultipartServiceError> {
    let mut connection = deadline
        .run(pool.acquire())
        .await?
        .map_err(map_database_error)?;
    let mut tx = deadline
        .run(connection.begin())
        .await?
        .map_err(map_sql_error)?;
    configure_transaction(&mut tx, deadline).await?;
    let scope = deadline
        .run(QuotaRepository::lock_storage_scope(
            &mut tx,
            context.storage_scope_id,
        ))
        .await?
        .map_err(map_sql_error)?;
    if !scope {
        return Err(MultipartServiceError::ScopeNotFound);
    }
    let affected = deadline
        .run(
            sqlx::query("SELECT 1 FROM projects WHERE id=$1::uuid FOR UPDATE")
                .bind(context.project_id.to_string())
                .execute(&mut *tx),
        )
        .await?
        .map_err(map_sql_error)?
        .rows_affected();
    if affected != 1 {
        return Err(MultipartServiceError::InvariantViolation);
    }
    let affected = deadline
        .run(
            sqlx::query(sql)
                .bind(context.session_id.to_string())
                .execute(&mut *tx),
        )
        .await?
        .map_err(map_sql_error)?
        .rows_affected();
    if affected != 1 {
        return Err(MultipartServiceError::InvariantViolation);
    }
    commit(tx, deadline).await
}

async fn configure_transaction(
    tx: &mut Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), MultipartServiceError> {
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
            .execute(&mut **tx),
        )
        .await?
        .map_err(map_sql_error)?;
    Ok(())
}

async fn commit(
    tx: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), MultipartServiceError> {
    match tokio_time::timeout_at(deadline.0, tx.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) if error.as_database_error().is_none() => {
            Err(MultipartServiceError::CommitOutcomeUnknown)
        }
        Ok(Err(error)) => Err(map_sql_error(error)),
        Err(_) => Err(MultipartServiceError::CommitOutcomeUnknown),
    }
}

fn duration_from_seconds(seconds: i64) -> Result<Duration, MultipartServiceError> {
    u64::try_from(seconds)
        .map(Duration::from_secs)
        .map_err(|_| MultipartServiceError::InvariantViolation)
}

fn parse_session_id(value: &str) -> Result<SaveSessionId, MultipartServiceError> {
    let uuid =
        uuid::Uuid::parse_str(value).map_err(|_| MultipartServiceError::InvariantViolation)?;
    SaveSessionId::from_uuid(uuid).map_err(|_| MultipartServiceError::InvariantViolation)
}

fn map_database_error(error: DatabaseError) -> MultipartServiceError {
    match error {
        DatabaseError::AcquireTimeout => MultipartServiceError::OperationTimeout,
        _ => MultipartServiceError::DatabaseUnavailable,
    }
}

fn map_sql_error(error: sqlx::Error) -> MultipartServiceError {
    match error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
    {
        Some("57014" | "55P03") => MultipartServiceError::OperationTimeout,
        Some("23505") => MultipartServiceError::IdempotencyConflict,
        Some("23503" | "23514") => MultipartServiceError::InvariantViolation,
        _ => MultipartServiceError::DatabaseUnavailable,
    }
}

fn map_quota_error(error: QuotaServiceError) -> MultipartServiceError {
    match error {
        QuotaServiceError::QuotaExceeded => MultipartServiceError::QuotaExceeded,
        QuotaServiceError::OperationTimeout => MultipartServiceError::OperationTimeout,
        QuotaServiceError::CommitOutcomeUnknown => MultipartServiceError::CommitOutcomeUnknown,
        QuotaServiceError::ScopeNotFound => MultipartServiceError::ScopeNotFound,
        QuotaServiceError::ProjectNotFound | QuotaServiceError::WrongScope => {
            MultipartServiceError::ProjectNotFound
        }
        QuotaServiceError::SessionTerminal | QuotaServiceError::SessionExpired => {
            MultipartServiceError::SessionTerminal
        }
        QuotaServiceError::DatabaseUnavailable => MultipartServiceError::DatabaseUnavailable,
        _ => MultipartServiceError::InvariantViolation,
    }
}

fn map_project_access_error(error: ProjectAccessError) -> MultipartServiceError {
    match error {
        ProjectAccessError::OperationTimeout => MultipartServiceError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => MultipartServiceError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => MultipartServiceError::InvariantViolation,
        _ => MultipartServiceError::ProjectNotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::ProjectVersion;
    use crate::quota::EffectiveQuota;
    use crate::save::IdempotencyKey;

    fn policy(part_size: u64) -> MultipartServicePolicy {
        MultipartServicePolicy::new(Duration::from_secs(5), 5, 64 * 1024 * 1024, part_size, 8)
            .unwrap()
    }

    fn request(total: u64, part_size: u64) -> CreateMultipartSession {
        let count = total.div_ceil(part_size);
        let parts = (1..=count)
            .map(|number| {
                let expected = if number == count {
                    total - part_size * (number - 1)
                } else {
                    part_size
                };
                MultipartPartPlan::new(
                    u16::try_from(number).unwrap(),
                    expected,
                    Sha256Checksum::from_bytes([u8::try_from(number).unwrap_or(1); 32]),
                )
            })
            .collect();
        CreateMultipartSession {
            storage_scope_id: StorageScopeId::new(),
            project_id: ProjectId::new(),
            actor_user_id: UserId::new(),
            expected_project_version: ProjectVersion::new(1).unwrap(),
            expected_physical_bytes: total,
            expected_logical_bytes: 0,
            expected_file_count: 0,
            expected_sha256: Sha256Checksum::from_bytes([7; 32]),
            effective_quota: EffectiveQuota::unlimited(),
            idempotency_key: IdempotencyKey::new("multipart-unit-key-0001".to_owned()).unwrap(),
            parts,
        }
    }

    #[test]
    fn exact_plan_accepts_two_gibibytes_at_128_parts() {
        let part_size = 16 * 1024 * 1024;
        let request = request(MAX_MULTIPART_BYTES, part_size);
        assert_eq!(request.parts.len(), 128);
        assert!(validate_create(&request, policy(part_size)).is_ok());
    }

    #[test]
    fn plan_rejects_too_many_parts_and_non_final_short_part() {
        let too_many = request(MAX_MULTIPART_BYTES, 8 * 1024 * 1024);
        assert_eq!(
            validate_create(&too_many, policy(8 * 1024 * 1024)),
            Err(MultipartServiceError::InvalidInput)
        );
        let mut malformed = request(80 * 1024 * 1024, 16 * 1024 * 1024);
        malformed.parts[0] = MultipartPartPlan::new(
            1,
            malformed.parts[0].expected_bytes() - 1,
            malformed.parts[0].expected_sha256().clone(),
        );
        assert_eq!(
            validate_create(&malformed, policy(16 * 1024 * 1024)),
            Err(MultipartServiceError::InvalidInput)
        );
    }

    #[test]
    fn batches_are_bounded_consecutive_and_receipts_are_redacted() {
        let parts = request(80 * 1024 * 1024, 16 * 1024 * 1024).parts;
        assert!(validate_part_batch(&parts[..2], 8).is_ok());
        assert_eq!(
            validate_part_batch(&[parts[0].clone(), parts[2].clone()], 8),
            Err(MultipartServiceError::InvalidInput)
        );
        let receipt = MultipartPartReceipt::new(
            1,
            parts[0].expected_bytes(),
            parts[0].expected_sha256().clone(),
            "private-etag-value".to_owned(),
        )
        .unwrap();
        assert!(!format!("{receipt:?}").contains("private-etag-value"));
    }
}
