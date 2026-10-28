#![allow(unused_imports)]
use super::*;
use super::upload_session::*;
use super::upload_rows::*;
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
use super::{MAX_MULTIPART_BYTES, MAX_LOGICAL_BYTES, MAX_FILES, MIN_OPERATION_TIMEOUT, MAX_OPERATION_TIMEOUT, SQL_TIMEOUT_MARGIN, MAX_ISSUE_BATCH, MultipartServicePolicy, MultipartServiceError, MultipartStore, MultipartService, PersistedMultipart, ExistingMultipart, SessionRow, LoadedPart, PartRow, LoadedMultipart, PreparedComplete, Deadline};



impl super::MultipartServicePolicy {
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


impl fmt::Display for MultipartServiceError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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


impl<S> fmt::Debug for MultipartService<S> { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultipartService")
            .field("pool", &self.pool)
            .field("policy", &self.policy)
            .field("idempotency_secret", &self.idempotency_secret)
            .finish_non_exhaustive()
    }
}
