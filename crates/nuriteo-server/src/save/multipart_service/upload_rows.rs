#![allow(unused_imports)]
use super::upload_commands::*;
use super::upload_session::*;
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

impl super::PersistedMultipart {
    pub(crate) fn is_expired(&self) -> bool {
        self.database_remaining
            .saturating_sub(self.remaining_captured_at.elapsed())
            .is_zero()
    }

    pub(crate) fn context(&self) -> MultipartSessionContext {
        MultipartSessionContext {
            storage_scope_id: self.storage_scope_id,
            project_id: self.project_id,
            actor_user_id: self.actor_user_id,
            session_id: self.session_id,
        }
    }

    pub(crate) fn public(&self) -> MultipartSession {
        MultipartSession::new(
            self.session_id,
            self.expires_at,
            self.part_count,
            self.idempotent_retry,
        )
    }
}

impl ExistingMultipart {
    pub(crate) fn into_persisted(
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

impl SessionRow {
    pub(crate) fn upload(&self) -> Result<MultipartUpload, MultipartServiceError> {
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

impl LoadedMultipart {
    pub(crate) fn upload(&self) -> Result<MultipartUpload, MultipartServiceError> {
        Ok(MultipartUpload {
            key: ObjectKey::parse(self.staging_object_key.clone())
                .map_err(|_| MultipartServiceError::InvariantViolation)?,
            upload_id: self
                .upload_id
                .clone()
                .ok_or(MultipartServiceError::InvariantViolation)?,
        })
    }

    pub(crate) fn presign_expiry(
        &self,
        configured: u16,
    ) -> Result<PresignExpiry, MultipartServiceError> {
        let remaining = self
            .remaining
            .saturating_sub(self.remaining_captured_at.elapsed());
        let minutes = u16::try_from(remaining.as_secs() / 60)
            .unwrap_or(u16::MAX)
            .min(configured);
        PresignExpiry::minutes(minutes).map_err(|_| MultipartServiceError::SessionNearExpiry)
    }
}

impl Deadline {
    pub(crate) fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    pub(crate) fn remaining(self) -> Result<Duration, MultipartServiceError> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(MultipartServiceError::OperationTimeout)
        } else {
            Ok(remaining)
        }
    }

    pub(crate) async fn run<T>(
        self,
        future: impl Future<Output = T>,
    ) -> Result<T, MultipartServiceError> {
        tokio_time::timeout_at(self.0, future)
            .await
            .map_err(|_| MultipartServiceError::OperationTimeout)
    }
}

pub(crate) fn validate_create(
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

pub(crate) fn validate_part_batch(
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

pub(crate) fn validate_receipt_batch(
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

pub(crate) fn idempotency_digest(
    secret: &IdempotencySecret,
    request: &CreateMultipartSession,
) -> [u8; 32] {
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

pub(crate) async fn ensure_idempotency_configuration(
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

pub(crate) async fn lock_scope_and_authorize(
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

pub(crate) async fn load_idempotent(
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

pub(crate) fn validate_existing(
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

pub(crate) async fn validate_existing_parts(
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

pub(crate) async fn load_session_for_update(
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

pub(crate) fn ensure_uploading(session: &SessionRow) -> Result<(), MultipartServiceError> {
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

pub(crate) fn decode_parts(rows: Vec<PartRow>) -> Result<Vec<LoadedPart>, MultipartServiceError> {
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

pub(crate) async fn marker_update(
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

pub(crate) async fn configure_transaction(
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

pub(crate) async fn commit(
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

pub(crate) fn duration_from_seconds(seconds: i64) -> Result<Duration, MultipartServiceError> {
    u64::try_from(seconds)
        .map(Duration::from_secs)
        .map_err(|_| MultipartServiceError::InvariantViolation)
}

pub(crate) fn parse_session_id(value: &str) -> Result<SaveSessionId, MultipartServiceError> {
    let uuid =
        uuid::Uuid::parse_str(value).map_err(|_| MultipartServiceError::InvariantViolation)?;
    SaveSessionId::from_uuid(uuid).map_err(|_| MultipartServiceError::InvariantViolation)
}

pub(crate) fn map_database_error(error: DatabaseError) -> MultipartServiceError {
    match error {
        DatabaseError::AcquireTimeout => MultipartServiceError::OperationTimeout,
        _ => MultipartServiceError::DatabaseUnavailable,
    }
}

pub(crate) fn map_sql_error(error: sqlx::Error) -> MultipartServiceError {
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

pub(crate) fn map_quota_error(error: QuotaServiceError) -> MultipartServiceError {
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

pub(crate) fn map_project_access_error(error: ProjectAccessError) -> MultipartServiceError {
    match error {
        ProjectAccessError::OperationTimeout => MultipartServiceError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => MultipartServiceError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => MultipartServiceError::InvariantViolation,
        _ => MultipartServiceError::ProjectNotFound,
    }
}
