#![allow(unused_imports)]
use super::*;
use super::worker::*;
use super::jobs::*;
use std::fmt;

use std::future::Future;

use std::str::FromStr;

use std::time::Duration;


use sqlx::{Acquire, Postgres, Transaction};

use tokio::sync::watch;

use tokio::task::{JoinHandle, JoinSet};

use tokio::time::{self, Instant};

use uuid::Uuid;


use crate::database::{DatabaseError, DatabasePool};

use crate::identity::UserId;

use crate::object_storage::{
    MultipartReconcileOutcome, MultipartUpload, ObjectKey, ObjectStoreError, ObjectStoreErrorKind,
    S3ObjectStore,
};

use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId,
};

use crate::quota::{QuotaRepository, SaveSessionId};

use crate::workspace::StorageScopeId;
use super::{MAX_BATCH_SIZE, MAX_CONCURRENCY, MAX_ATTEMPTS, SQL_TIMEOUT_MARGIN, CleanupWorkerPolicy, CleanupError, AbortSaveSession, AbortSaveSessionResult, ExpirySweepReport, WorkerShutdown, CleanupService, CleanupBackend, CleanupTarget, CleanupKind, CleanupBackendOutcome, CanonicalMaterializationDisposition, canonical_materialization_disposition, CleanupWorker, ClaimedJob, ReconcilePreparation, Deadline};



impl super::CleanupWorkerPolicy {
    #[allow(
        clippy::too_many_arguments,
        reason = "all cleanup resource bounds are explicit"
    )]
    pub fn new(
        batch_size: u16,
        concurrency: u16,
        max_attempts: u16,
        operation_timeout: Duration,
        item_timeout: Duration,
        lease_duration: Duration,
        poll_interval: Duration,
        base_backoff: Duration,
        max_backoff: Duration,
    ) -> Result<Self, CleanupError> {
        if !(1..=MAX_BATCH_SIZE).contains(&batch_size)
            || !(1..=MAX_CONCURRENCY).contains(&concurrency)
            || !(2..=MAX_ATTEMPTS).contains(&max_attempts)
            || !(Duration::from_millis(100)..=Duration::from_secs(30)).contains(&operation_timeout)
            || !(Duration::from_millis(100)..=Duration::from_secs(120)).contains(&item_timeout)
            || !(Duration::from_millis(10)..=Duration::from_secs(60)).contains(&poll_interval)
            || !(Duration::from_millis(100)..=Duration::from_secs(60 * 60)).contains(&base_backoff)
            || base_backoff > max_backoff
            || max_backoff > Duration::from_secs(24 * 60 * 60)
        {
            return Err(CleanupError::InvalidPolicy);
        }
        let processing_waves = u32::from(batch_size)
            .checked_add(u32::from(concurrency) - 1)
            .and_then(|rounded| rounded.checked_div(u32::from(concurrency)))
            .ok_or(CleanupError::InvalidPolicy)?;
        let minimum_lease = operation_timeout
            .checked_mul(2)
            .and_then(|database_time| item_timeout.checked_add(database_time))
            .and_then(|per_wave| per_wave.checked_mul(processing_waves))
            .and_then(|processing| processing.checked_add(operation_timeout))
            .and_then(|batch| batch.checked_add(SQL_TIMEOUT_MARGIN))
            .ok_or(CleanupError::InvalidPolicy)?;
        if lease_duration < minimum_lease || lease_duration > Duration::from_secs(10 * 60) {
            return Err(CleanupError::InvalidPolicy);
        }
        Ok(Self {
            batch_size,
            concurrency,
            max_attempts,
            operation_timeout,
            item_timeout,
            lease_duration,
            poll_interval,
            base_backoff,
            max_backoff,
        })
    }
}


impl Default for CleanupWorkerPolicy { fn default() -> Self {
        Self {
            batch_size: 32,
            concurrency: 4,
            max_attempts: 8,
            operation_timeout: Duration::from_secs(5),
            item_timeout: Duration::from_secs(30),
            lease_duration: Duration::from_secs(6 * 60),
            poll_interval: Duration::from_secs(2),
            base_backoff: Duration::from_secs(2),
            max_backoff: Duration::from_secs(15 * 60),
        }
    }
}


impl fmt::Display for CleanupError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPolicy => "Save cleanup policy is invalid",
            Self::ScopeNotFound => "storage scope was not found",
            Self::ProjectNotFound => "project was not found",
            Self::ProjectUnavailable => "project is unavailable",
            Self::SessionNotFound => "Save session was not found",
            Self::SessionTerminal => "Save session is already terminal",
            Self::UploadInProgress => "Save session upload is in progress",
            Self::OperationTimeout => "Save cleanup operation timed out",
            Self::CommitOutcomeUnknown => "Save cleanup commit outcome is unknown",
            Self::DatabaseUnavailable => "Save cleanup persistence is unavailable",
            Self::InvariantViolation => "Save cleanup persistence state is invalid",
        })
    }
}


impl std::error::Error for CleanupError {}


impl<B> fmt::Debug for CleanupService<B> { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CleanupService")
            .field("pool", &self.pool)
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}


impl fmt::Debug for CleanupTarget { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CleanupTarget")
            .field("kind", &self.kind)
            .field("object_key", &"[REDACTED]")
            .field(
                "multipart_upload_id",
                &self.multipart_upload_id.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}


impl CleanupBackend for S3ObjectStore { async fn cleanup(&self, target: CleanupTarget) -> CleanupBackendOutcome {
        let result = match target.kind {
            CleanupKind::ObjectDelete => self.delete(&target.object_key).await,
            CleanupKind::MultipartAbort => {
                let Some(upload_id) = target.multipart_upload_id else {
                    return CleanupBackendOutcome::Permanent;
                };
                self.abort_multipart(&MultipartUpload {
                    key: target.object_key,
                    upload_id,
                })
                .await
            }
            CleanupKind::MultipartReconcile => {
                return match self
                    .reconcile_multipart_for_exact_key(&target.object_key)
                    .await
                {
                    Ok(MultipartReconcileOutcome::Aborted) => CleanupBackendOutcome::Completed,
                    Ok(MultipartReconcileOutcome::Missing) => CleanupBackendOutcome::Missing,
                    Err(error) => classify_backend_result(Err(error)),
                };
            }
            CleanupKind::MultipartCompleteReconcile => {
                return match self.head(&target.object_key).await {
                    Ok(_) => CleanupBackendOutcome::Completed,
                    Err(error) if error.kind() == ObjectStoreErrorKind::NotFound => {
                        if !target.prior_absence {
                            return CleanupBackendOutcome::Missing;
                        }
                        let Some(upload_id) = target.multipart_upload_id else {
                            return CleanupBackendOutcome::Permanent;
                        };
                        match classify_backend_result(
                            self.abort_multipart(&MultipartUpload {
                                key: target.object_key.clone(),
                                upload_id,
                            })
                            .await,
                        ) {
                            CleanupBackendOutcome::Completed | CleanupBackendOutcome::Missing => {
                                match self.head(&target.object_key).await {
                                    Ok(_) => CleanupBackendOutcome::Completed,
                                    Err(error)
                                        if error.kind() == ObjectStoreErrorKind::NotFound =>
                                    {
                                        CleanupBackendOutcome::Missing
                                    }
                                    Err(error) => classify_backend_result(Err(error)),
                                }
                            }
                            outcome => outcome,
                        }
                    }
                    Err(error) => classify_backend_result(Err(error)),
                };
            }
        };
        classify_backend_result(result)
    }
}


pub(crate) fn classify_backend_result(result: Result<(), ObjectStoreError>) -> CleanupBackendOutcome {    match result {
        Ok(()) => CleanupBackendOutcome::Completed,
        Err(error) if error.kind() == ObjectStoreErrorKind::NotFound => {
            CleanupBackendOutcome::Missing
        }
        Err(error) if error.kind() == ObjectStoreErrorKind::Timeout => {
            CleanupBackendOutcome::Timeout
        }
        Err(error) if error.kind() == ObjectStoreErrorKind::ResponseUnknown => {
            CleanupBackendOutcome::Unknown
        }
        Err(error) if error.is_retryable() => CleanupBackendOutcome::Retryable,
        Err(error)
            if matches!(
                error.kind(),
                ObjectStoreErrorKind::Authentication
                    | ObjectStoreErrorKind::Authorization
                    | ObjectStoreErrorKind::InvalidRequest
                    | ObjectStoreErrorKind::Unsupported
            ) =>
        {
            CleanupBackendOutcome::Permanent
        }
        Err(_) => CleanupBackendOutcome::Unknown,
    }
}
