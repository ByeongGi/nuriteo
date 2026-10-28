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

#[derive(Clone)]
pub struct MultipartService<S = S3ObjectStore> {
    pool: DatabasePool,
    store: S,
    quota: QuotaService,
    policy: MultipartServicePolicy,
    idempotency_secret: IdempotencySecret,
}

pub(crate) struct PersistedMultipart {
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

pub(crate) struct ExistingMultipart {
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

pub(crate) struct SessionRow {
    state: String,
    staging_object_key: String,
    multipart_upload_id: Option<String>,
    expected_physical_bytes: i64,
    remaining: Duration,
}

pub(crate) struct LoadedPart {
    part_number: u16,
    expected_bytes: u64,
    expected_sha256: Sha256Checksum,
    state: String,
    e_tag: Option<String>,
}

type PartRow = (i16, i64, Vec<u8>, String, Option<String>);

pub(crate) struct LoadedMultipart {
    staging_object_key: String,
    upload_id: Option<String>,
    remaining: Duration,
    remaining_captured_at: Instant,
    parts: Vec<LoadedPart>,
}

pub(crate) struct PreparedComplete {
    upload: MultipartUpload,
    parts: Vec<UploadedPart>,
    idempotent_retry: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct Deadline(Instant);

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

mod upload_commands;
pub(crate) use upload_commands::*;
mod upload_session;
pub(crate) use upload_session::*;
mod upload_rows;
pub(crate) use upload_rows::*;
