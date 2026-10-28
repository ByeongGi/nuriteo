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


const MAX_BATCH_SIZE: u16 = 100;

const MAX_CONCURRENCY: u16 = 16;

const MAX_ATTEMPTS: u16 = 16;

const SQL_TIMEOUT_MARGIN: Duration = Duration::from_millis(25);


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupWorkerPolicy {
    batch_size: u16,
    concurrency: u16,
    max_attempts: u16,
    operation_timeout: Duration,
    item_timeout: Duration,
    lease_duration: Duration,
    poll_interval: Duration,
    base_backoff: Duration,
    max_backoff: Duration,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CleanupError {
    InvalidPolicy,
    ScopeNotFound,
    ProjectNotFound,
    ProjectUnavailable,
    SessionNotFound,
    SessionTerminal,
    UploadInProgress,
    OperationTimeout,
    CommitOutcomeUnknown,
    DatabaseUnavailable,
    InvariantViolation,
}


#[derive(Debug, Clone, Copy)]
pub struct AbortSaveSession {
    pub storage_scope_id: StorageScopeId,
    pub project_id: ProjectId,
    pub session_id: SaveSessionId,
    pub actor_user_id: UserId,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbortSaveSessionResult {
    Aborted,
    AlreadyAborted,
    Expired,
}


#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExpirySweepReport {
    pub expired: u16,
    pub failed: u16,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerShutdown {
    Drained,
    DeadlineExceeded,
    WorkerFailed,
}


#[derive(Clone)]
pub struct CleanupService<B = S3ObjectStore> {
    pool: DatabasePool,
    backend: B,
    policy: CleanupWorkerPolicy,
}


pub trait CleanupBackend: Clone + Send + Sync + 'static {
    fn cleanup(&self, target: CleanupTarget) -> impl Future<Output = CleanupBackendOutcome> + Send;
}


#[derive(Clone, PartialEq, Eq)]
pub struct CleanupTarget {
    kind: CleanupKind,
    object_key: ObjectKey,
    multipart_upload_id: Option<String>,
    prior_absence: bool,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CleanupKind {
    ObjectDelete,
    MultipartAbort,
    MultipartReconcile,
    MultipartCompleteReconcile,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupBackendOutcome {
    Completed,
    Missing,
    Timeout,
    Retryable,
    Permanent,
    Unknown,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CanonicalMaterializationDisposition {
    Finalize,
    EnqueueObject,
    AbortMultipartAndEnqueue,
}


const fn canonical_materialization_disposition(
    referenced: bool,
    multipart_upload_id: Option<&str>,
) -> CanonicalMaterializationDisposition {
    if referenced {
        CanonicalMaterializationDisposition::Finalize
    } else if multipart_upload_id.is_some() {
        CanonicalMaterializationDisposition::AbortMultipartAndEnqueue
    } else {
        CanonicalMaterializationDisposition::EnqueueObject
    }
}


pub struct CleanupWorker {
    cancel: watch::Sender<bool>,
    join: JoinHandle<Result<(), CleanupError>>,
}


#[derive(Clone)]
struct ClaimedJob {
    session_id: SaveSessionId,
    target: CleanupTarget,
    attempts: i16,
    absence_count: i16,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReconcilePreparation {
    Proceed,
    StaleReady,
}


#[derive(Clone, Copy)]
struct Deadline(Instant);


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_bounds_and_backoff_are_hard_bounded() {
        assert_eq!(
            CleanupWorkerPolicy::new(
                101,
                1,
                1,
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_secs(2)
            ),
            Err(CleanupError::InvalidPolicy)
        );
        assert_eq!(
            CleanupWorkerPolicy::new(
                4,
                1,
                1,
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_secs(8),
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_secs(2)
            ),
            Err(CleanupError::InvalidPolicy)
        );
        assert_eq!(
            CleanupWorkerPolicy::new(
                32,
                4,
                8,
                Duration::from_secs(5),
                Duration::from_secs(30),
                Duration::from_secs(5 * 60),
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_secs(2)
            ),
            Err(CleanupError::InvalidPolicy)
        );
        assert!(
            CleanupWorkerPolicy::new(
                32,
                4,
                8,
                Duration::from_secs(5),
                Duration::from_secs(30),
                Duration::from_millis(325_025),
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_secs(2)
            )
            .is_ok()
        );
        assert_eq!(
            CleanupWorkerPolicy::new(
                32,
                4,
                8,
                Duration::from_secs(5),
                Duration::from_secs(30),
                Duration::from_millis(325_024),
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_secs(2)
            ),
            Err(CleanupError::InvalidPolicy)
        );
        let policy = CleanupWorkerPolicy::default();
        for attempts in [1, 2, 8, i16::MAX] {
            let delay = retry_delay(policy, SaveSessionId::new(), attempts).unwrap();
            assert!(delay <= policy.max_backoff);
            assert!(delay >= policy.base_backoff);
        }
    }

    #[test]
    fn sensitive_cleanup_identity_is_redacted() {
        let target = CleanupTarget {
            kind: CleanupKind::MultipartAbort,
            object_key: ObjectKey::parse("staging/private/key").unwrap(),
            multipart_upload_id: Some("private-upload-identity".to_owned()),
            prior_absence: false,
        };
        let rendered = format!("{target:?}");
        assert!(!rendered.contains("staging/private/key"));
        assert!(!rendered.contains("private-upload-identity"));
    }

    #[test]
    fn stale_canonical_materialization_routes_reference_and_multipart_cleanup() {
        assert_eq!(
            canonical_materialization_disposition(true, Some("unfinished-upload")),
            CanonicalMaterializationDisposition::Finalize
        );
        assert_eq!(
            canonical_materialization_disposition(false, None),
            CanonicalMaterializationDisposition::EnqueueObject
        );
        assert_eq!(
            canonical_materialization_disposition(false, Some("unfinished-upload")),
            CanonicalMaterializationDisposition::AbortMultipartAndEnqueue
        );
    }

    #[test]
    fn backend_categories_and_commit_response_loss_are_stable() {
        for (kind, retryable, expected) in [
            (
                ObjectStoreErrorKind::NotFound,
                false,
                CleanupBackendOutcome::Missing,
            ),
            (
                ObjectStoreErrorKind::Timeout,
                true,
                CleanupBackendOutcome::Timeout,
            ),
            (
                ObjectStoreErrorKind::ResponseUnknown,
                true,
                CleanupBackendOutcome::Unknown,
            ),
            (
                ObjectStoreErrorKind::Authorization,
                false,
                CleanupBackendOutcome::Permanent,
            ),
            (
                ObjectStoreErrorKind::Unavailable,
                true,
                CleanupBackendOutcome::Retryable,
            ),
        ] {
            assert_eq!(
                classify_backend_result(Err(ObjectStoreError::new(
                    crate::object_storage::ObjectOperation::Delete,
                    kind,
                    retryable,
                ))),
                expected
            );
        }
        let lost = sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "sensitive backend response detail",
        ));
        assert_eq!(map_commit_error(lost), CleanupError::CommitOutcomeUnknown);
    }

    #[tokio::test]
    async fn supervised_worker_forces_a_bounded_shutdown_and_joins() {
        let (cancel, _) = watch::channel(false);
        let worker = CleanupWorker {
            cancel,
            join: tokio::spawn(std::future::pending()),
        };
        assert_eq!(
            worker.run_until(async {}, Duration::from_millis(10)).await,
            WorkerShutdown::DeadlineExceeded
        );
    }
}


mod backend;
pub(crate) use backend::*;
mod worker;
pub(crate) use worker::*;
mod jobs;
pub(crate) use jobs::*;
