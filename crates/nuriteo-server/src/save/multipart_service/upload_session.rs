#![allow(unused_imports)]
use super::upload_commands::*;
use super::upload_rows::*;
use super::*;
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

use super::super::{
    CreateMultipartSession, IdempotencySecret, MultipartCompleteResult, MultipartPartCapability,
    MultipartPartPlan, MultipartPartReceipt, MultipartSession, MultipartSessionContext,
};
use super::{
    Deadline, ExistingMultipart, LoadedMultipart, LoadedPart, MAX_FILES, MAX_ISSUE_BATCH,
    MAX_LOGICAL_BYTES, MAX_MULTIPART_BYTES, MAX_OPERATION_TIMEOUT, MIN_OPERATION_TIMEOUT,
    MultipartService, MultipartServiceError, MultipartServicePolicy, MultipartStore, PartRow,
    PersistedMultipart, PreparedComplete, SQL_TIMEOUT_MARGIN, SessionRow,
};

impl<S: MultipartStore> super::MultipartService<S> {
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
    pub(crate) fn new_with_quota_source(
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
    pub(crate) async fn persist_plan(
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
    pub(crate) async fn attach_upload(
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
    pub(crate) async fn mark_create_unknown(
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
    pub(crate) async fn compensate_confirmed_attach_failure(
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
    pub(crate) async fn load_active(
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
    pub(crate) async fn prepare_complete(
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
    pub(crate) async fn finalize_complete(
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
    pub(crate) async fn mark_complete_unknown(
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
