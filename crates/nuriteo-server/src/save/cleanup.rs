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

impl CleanupWorkerPolicy {
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

impl Default for CleanupWorkerPolicy {
    fn default() -> Self {
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

impl fmt::Display for CleanupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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

impl<B> fmt::Debug for CleanupService<B> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CleanupService")
            .field("pool", &self.pool)
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
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

impl fmt::Debug for CleanupTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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

impl CleanupBackend for S3ObjectStore {
    async fn cleanup(&self, target: CleanupTarget) -> CleanupBackendOutcome {
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

fn classify_backend_result(result: Result<(), ObjectStoreError>) -> CleanupBackendOutcome {
    match result {
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

impl<B: CleanupBackend> CleanupService<B> {
    #[must_use]
    pub const fn new(pool: DatabasePool, backend: B, policy: CleanupWorkerPolicy) -> Self {
        Self {
            pool,
            backend,
            policy,
        }
    }

    pub async fn abort(
        &self,
        request: AbortSaveSession,
    ) -> Result<AbortSaveSessionResult, CleanupError> {
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
        lock_scope(&mut transaction, request.storage_scope_id, deadline).await?;
        let role = deadline
            .run(ProjectAccessRepository::resolve_effective_role_for_update(
                &mut transaction,
                request.project_id,
                request.actor_user_id,
            ))
            .await?
            .map_err(map_project_access_error)?;
        if role < EffectiveProjectRole::Write {
            return Err(CleanupError::ProjectNotFound);
        }
        let row: Option<(String, String, String, bool)> = deadline
            .run(
                sqlx::query_as(
                    "SELECT state,storage_scope_id::text,project_id::text,\
                            expires_at <= transaction_timestamp() \
                     FROM save_sessions WHERE id=$1::uuid FOR UPDATE",
                )
                .bind(request.session_id.to_string())
                .fetch_optional(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let Some((state, scope, project, expired)) = row else {
            return Err(CleanupError::SessionNotFound);
        };
        if scope != request.storage_scope_id.to_string()
            || project != request.project_id.to_string()
        {
            return Err(CleanupError::SessionNotFound);
        }
        if active_relay_upload_exists(&mut transaction, request.session_id, deadline).await? {
            return Err(CleanupError::UploadInProgress);
        }
        let result = match state.as_str() {
            "aborted" => {
                deadline
                    .run(transaction.rollback())
                    .await?
                    .map_err(map_sql_error)?;
                return Ok(AbortSaveSessionResult::AlreadyAborted);
            }
            "created" | "uploading" | "verifying" if expired => {
                transition_session(&mut transaction, request.session_id, "expired", deadline)
                    .await?;
                AbortSaveSessionResult::Expired
            }
            "created" | "uploading" | "verifying" => {
                transition_session(&mut transaction, request.session_id, "aborted", deadline)
                    .await?;
                AbortSaveSessionResult::Aborted
            }
            _ => return Err(CleanupError::SessionTerminal),
        };
        commit(transaction, deadline).await?;
        Ok(result)
    }

    /// Expires at most 100 sessions selected by the PostgreSQL clock. Project
    /// rows are locked before Save rows; nested savepoints isolate one corrupt
    /// row so it cannot roll back successful siblings in the batch.
    pub async fn expire_scope(
        &self,
        storage_scope_id: StorageScopeId,
    ) -> Result<ExpirySweepReport, CleanupError> {
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
        lock_scope(&mut transaction, storage_scope_id, deadline).await?;
        deadline
            .run(
                sqlx::query(
                    "SELECT project.id FROM projects project WHERE project.id IN (\
                        SELECT candidate.project_id FROM (\
                            SELECT session.project_id FROM save_sessions session \
                            WHERE session.storage_scope_id=$1::uuid \
                              AND session.state IN ('created','uploading','verifying') \
                              AND session.expires_at <= transaction_timestamp() \
                              AND NOT EXISTS (SELECT 1 FROM save_upload_leases lease \
                                  WHERE lease.save_session_id=session.id \
                                    AND lease.released_at IS NULL \
                                    AND lease.lease_expires_at>clock_timestamp()) \
                            ORDER BY session.expires_at,session.id LIMIT $2\
                        ) candidate\
                     ) ORDER BY project.id FOR UPDATE",
                )
                .bind(storage_scope_id.to_string())
                .bind(i64::from(self.policy.batch_size))
                .fetch_all(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let ids: Vec<String> = deadline
            .run(
                sqlx::query_scalar(
                    "SELECT session.id::text FROM save_sessions session \
                     WHERE session.storage_scope_id=$1::uuid \
                       AND session.state IN ('created','uploading','verifying') \
                       AND session.expires_at <= transaction_timestamp() \
                       AND NOT EXISTS (SELECT 1 FROM save_upload_leases lease \
                           WHERE lease.save_session_id=session.id \
                             AND lease.released_at IS NULL \
                             AND lease.lease_expires_at>clock_timestamp()) \
                     ORDER BY session.expires_at,session.id LIMIT $2 \
                     FOR UPDATE SKIP LOCKED",
                )
                .bind(storage_scope_id.to_string())
                .bind(i64::from(self.policy.batch_size))
                .fetch_all(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let mut report = ExpirySweepReport::default();
        for id in ids {
            let session_id = match parse_session_id(&id) {
                Ok(id) => id,
                Err(_) => {
                    report.failed = report
                        .failed
                        .checked_add(1)
                        .ok_or(CleanupError::InvariantViolation)?;
                    continue;
                }
            };
            let mut savepoint = deadline
                .run(transaction.begin())
                .await?
                .map_err(map_sql_error)?;
            match transition_session(&mut savepoint, session_id, "expired", deadline).await {
                Ok(()) => {
                    deadline
                        .run(savepoint.commit())
                        .await?
                        .map_err(map_sql_error)?;
                    report.expired = report
                        .expired
                        .checked_add(1)
                        .ok_or(CleanupError::InvariantViolation)?;
                }
                Err(_) => {
                    deadline
                        .run(savepoint.rollback())
                        .await?
                        .map_err(map_sql_error)?;
                    report.failed = report
                        .failed
                        .checked_add(1)
                        .ok_or(CleanupError::InvariantViolation)?;
                }
            }
        }
        commit(transaction, deadline).await?;
        Ok(report)
    }

    pub fn start_worker(&self) -> CleanupWorker {
        let (cancel, receiver) = watch::channel(false);
        let service = self.clone();
        let join = tokio::spawn(async move { service.worker_loop(receiver).await });
        CleanupWorker { cancel, join }
    }

    async fn worker_loop(&self, mut cancel: watch::Receiver<bool>) -> Result<(), CleanupError> {
        let owner = Uuid::now_v7();
        loop {
            if *cancel.borrow() {
                return Ok(());
            }
            self.reconcile_canonical_materializations_once().await?;
            let jobs = self.claim(owner).await?;
            if jobs.is_empty() {
                tokio::select! {
                    changed = cancel.changed() => {
                        if changed.is_err() || *cancel.borrow() { return Ok(()); }
                    }
                    () = time::sleep(self.policy.poll_interval) => {}
                }
                continue;
            }
            self.process_batch(owner, jobs, &cancel).await?;
        }
    }

    /// Converts abandoned canonical materializations into the existing,
    /// lifecycle-fenced GC queue. The grace period is longer than every
    /// materializer request deadline, so an active upload is never collected.
    /// Reconciles one bounded batch of abandoned canonical materializations.
    /// Exposed for supervised maintenance entry points and actual-backend
    /// qualification; normal production use is through `start_worker`.
    pub async fn reconcile_canonical_materializations_once(&self) -> Result<(), CleanupError> {
        type Row = (String, String, Vec<u8>, i64, Option<String>);
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
        deadline
            .run(
                sqlx::query(
                    "DELETE FROM canonical_bundle_materializations materialization \
                     USING gc_candidates candidate WHERE materialization.object_key=candidate.object_key \
                     AND materialization.state='cleanup_pending' AND candidate.status='completed' \
                     AND NOT EXISTS(SELECT 1 FROM bundles bundle \
                                    WHERE bundle.object_key=materialization.object_key)",
                )
                .execute(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let rows: Vec<Row> = deadline
            .run(
                sqlx::query_as(
                    "SELECT id::text,object_key,sha256,physical_bytes,multipart_upload_id \
                     FROM canonical_bundle_materializations \
                     WHERE state IN ('pending','uploaded','cleanup_pending') \
                       AND updated_at <= transaction_timestamp() - INTERVAL '10 minutes' \
                     ORDER BY updated_at,id LIMIT $1 FOR UPDATE SKIP LOCKED",
                )
                .bind(i64::from(self.policy.batch_size))
                .fetch_all(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let mut multipart_targets = Vec::new();
        for (id, object_key, sha256, physical_bytes, multipart_upload_id) in rows {
            deadline
                .run(
                    sqlx::query("SELECT lock_bundle_object_lifecycle($1)")
                        .bind(&object_key)
                        .execute(&mut *transaction),
                )
                .await?
                .map_err(map_sql_error)?;
            let referenced: bool = deadline
                .run(
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM bundles WHERE object_key=$1)")
                        .bind(&object_key)
                        .fetch_one(&mut *transaction),
                )
                .await?
                .map_err(map_sql_error)?;
            let disposition =
                canonical_materialization_disposition(referenced, multipart_upload_id.as_deref());
            if disposition == CanonicalMaterializationDisposition::Finalize {
                deadline
                    .run(
                        sqlx::query(
                            "UPDATE canonical_bundle_materializations SET state='finalized',\
                             updated_at=transaction_timestamp() WHERE id=$1::uuid",
                        )
                        .bind(&id)
                        .execute(&mut *transaction),
                    )
                    .await?
                    .map_err(map_sql_error)?;
                continue;
            }
            if sha256.len() != 32 || physical_bytes <= 0 {
                return Err(CleanupError::InvariantViolation);
            }
            if disposition == CanonicalMaterializationDisposition::AbortMultipartAndEnqueue {
                let upload_id = multipart_upload_id.ok_or(CleanupError::InvariantViolation)?;
                multipart_targets.push((id.clone(), object_key.clone(), upload_id));
            }
            deadline
                .run(
                    sqlx::query(
                        "INSERT INTO gc_candidates \
                         (object_key,expected_sha256,expected_bytes,reason,status,eligible_at) \
                         VALUES($1,$2,$3,'verification_failed','queued',transaction_timestamp()) \
                         ON CONFLICT (object_key) DO NOTHING",
                    )
                    .bind(&object_key)
                    .bind(&sha256)
                    .bind(physical_bytes)
                    .execute(&mut *transaction),
                )
                .await?
                .map_err(map_sql_error)?;
            deadline
                .run(
                    sqlx::query(
                        "UPDATE canonical_bundle_materializations SET state='cleanup_pending',\
                         updated_at=transaction_timestamp() WHERE id=$1::uuid",
                    )
                    .bind(&id)
                    .execute(&mut *transaction),
                )
                .await?
                .map_err(map_sql_error)?;
        }
        commit(transaction, deadline).await?;
        for (id, object_key, upload_id) in multipart_targets {
            let target = CleanupTarget {
                kind: CleanupKind::MultipartAbort,
                object_key: ObjectKey::parse(object_key)
                    .map_err(|_| CleanupError::InvariantViolation)?,
                multipart_upload_id: Some(upload_id),
                prior_absence: false,
            };
            let outcome = time::timeout(self.policy.item_timeout, self.backend.cleanup(target))
                .await
                .unwrap_or(CleanupBackendOutcome::Timeout);
            if matches!(
                outcome,
                CleanupBackendOutcome::Completed | CleanupBackendOutcome::Missing
            ) {
                let mut connection = deadline
                    .run(self.pool.acquire())
                    .await?
                    .map_err(map_database_error)?;
                deadline
                    .run(
                        sqlx::query(
                            "UPDATE canonical_bundle_materializations \
                             SET multipart_upload_id=NULL,updated_at=transaction_timestamp() \
                             WHERE id=$1::uuid AND state='cleanup_pending'",
                        )
                        .bind(id)
                        .execute(&mut *connection),
                    )
                    .await?
                    .map_err(map_sql_error)?;
            }
        }
        Ok(())
    }

    async fn process_batch(
        &self,
        owner: Uuid,
        jobs: Vec<ClaimedJob>,
        cancel: &watch::Receiver<bool>,
    ) -> Result<(), CleanupError> {
        let mut pending = jobs.into_iter();
        let mut running = JoinSet::new();
        loop {
            while running.len() < usize::from(self.policy.concurrency) && !*cancel.borrow() {
                let Some(job) = pending.next() else { break };
                let service = self.clone();
                running.spawn(async move { service.process_job(owner, job).await });
            }
            if running.is_empty() {
                break;
            }
            match running.join_next().await {
                Some(Ok(result)) => result?,
                Some(Err(_)) => return Err(CleanupError::InvariantViolation),
                None => break,
            }
        }
        if *cancel.borrow() {
            self.release_claims(owner, pending.map(|job| job.session_id).collect())
                .await?;
        }
        Ok(())
    }

    async fn process_job(&self, owner: Uuid, job: ClaimedJob) -> Result<(), CleanupError> {
        if job.target.kind == CleanupKind::MultipartReconcile
            && self.prepare_reconcile(owner, &job).await? == ReconcilePreparation::StaleReady
        {
            return Ok(());
        }
        let outcome = match time::timeout(
            self.policy.item_timeout,
            self.backend.cleanup(job.target.clone()),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(_) => CleanupBackendOutcome::Timeout,
        };
        match outcome {
            CleanupBackendOutcome::Completed => self.finish_job(owner, job, outcome).await,
            CleanupBackendOutcome::Missing if job.absence_count == 0 => {
                self.observe_absence(owner, job).await
            }
            CleanupBackendOutcome::Missing => self.finish_job(owner, job, outcome).await,
            CleanupBackendOutcome::Timeout => self.retry_job(owner, job, "timeout").await,
            CleanupBackendOutcome::Retryable => self.retry_job(owner, job, "retryable").await,
            CleanupBackendOutcome::Unknown => self.retry_job(owner, job, "unknown").await,
            CleanupBackendOutcome::Permanent => {
                self.fail_job(owner, job.session_id, "permanent").await
            }
        }
    }

    async fn prepare_reconcile(
        &self,
        owner: Uuid,
        job: &ClaimedJob,
    ) -> Result<ReconcilePreparation, CleanupError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let identity: Option<(String, String)> = deadline
            .run(
                sqlx::query_as(
                    "SELECT storage_scope_id::text,project_id::text FROM save_sessions \
                     WHERE id=$1::uuid",
                )
                .bind(job.session_id.to_string())
                .fetch_optional(&mut *connection),
            )
            .await?
            .map_err(map_sql_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut transaction, deadline).await?;
        let Some((scope_id, project_id)) = identity else {
            assert_active_claim(&mut transaction, owner, job.session_id, deadline).await?;
            commit(transaction, deadline).await?;
            return Ok(ReconcilePreparation::Proceed);
        };
        let scope =
            StorageScopeId::from_str(&scope_id).map_err(|_| CleanupError::InvariantViolation)?;
        let scope_locked = deadline
            .run(QuotaRepository::lock_storage_scope(&mut transaction, scope))
            .await?
            .map_err(map_sql_error)?;
        if !scope_locked {
            assert_active_claim(&mut transaction, owner, job.session_id, deadline).await?;
            commit(transaction, deadline).await?;
            return Ok(ReconcilePreparation::Proceed);
        }
        let project_locked = deadline
            .run(
                sqlx::query("SELECT 1 FROM projects WHERE id=$1::uuid FOR UPDATE")
                    .bind(project_id)
                    .execute(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?
            .rows_affected()
            == 1;
        if !project_locked {
            assert_active_claim(&mut transaction, owner, job.session_id, deadline).await?;
            commit(transaction, deadline).await?;
            return Ok(ReconcilePreparation::Proceed);
        }
        type SessionRow = (String, String, Option<String>, String, Option<String>);
        let row: Option<SessionRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT session.state,session.upload_mode,session.multipart_upload_id,\
                            session.staging_object_key,lifecycle.create_status \
                     FROM save_sessions session \
                     LEFT JOIN multipart_lifecycles lifecycle \
                       ON lifecycle.save_session_id=session.id \
                     WHERE session.id=$1::uuid FOR UPDATE OF session",
                )
                .bind(job.session_id.to_string())
                .fetch_optional(&mut *transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let Some((state, mode, upload_id, object_key, create_status)) = row else {
            commit(transaction, deadline).await?;
            return Ok(ReconcilePreparation::Proceed);
        };
        if mode != "multipart" || object_key != job.target.object_key.expose() {
            return Err(CleanupError::InvariantViolation);
        }
        if state == "uploading" && upload_id.is_some() && create_status.as_deref() == Some("ready")
        {
            delete_claim(&mut transaction, owner, job.session_id, deadline).await?;
            commit(transaction, deadline).await?;
            return Ok(ReconcilePreparation::StaleReady);
        }
        if state == "created" && upload_id.is_none() {
            match create_status.as_deref() {
                Some("creating") => {
                    let affected = deadline
                        .run(
                            sqlx::query(
                                "UPDATE multipart_lifecycles SET create_status='unknown',\
                                     updated_at=transaction_timestamp() \
                                 WHERE save_session_id=$1::uuid AND create_status='creating' \
                                   AND complete_status='pending'",
                            )
                            .bind(job.session_id.to_string())
                            .execute(&mut *transaction),
                        )
                        .await?
                        .map_err(map_sql_error)?
                        .rows_affected();
                    if affected != 1 {
                        return Err(CleanupError::InvariantViolation);
                    }
                }
                Some("unknown" | "cleaned") => {}
                _ => return Err(CleanupError::InvariantViolation),
            }
        } else if !(state == "uploading"
            && upload_id.is_some()
            && create_status.as_deref() == Some("cleaned"))
            && !matches!(state.as_str(), "aborted" | "expired" | "failed")
        {
            return Err(CleanupError::InvariantViolation);
        }
        assert_active_claim(&mut transaction, owner, job.session_id, deadline).await?;
        commit(transaction, deadline).await?;
        Ok(ReconcilePreparation::Proceed)
    }

    async fn claim(&self, owner: Uuid) -> Result<Vec<ClaimedJob>, CleanupError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let lease_millis = i64::try_from(self.policy.lease_duration.as_millis())
            .map_err(|_| CleanupError::InvalidPolicy)?;
        let max_attempts =
            i16::try_from(self.policy.max_attempts).map_err(|_| CleanupError::InvalidPolicy)?;
        // A process may die after claiming its final allowed attempt. Reap the
        // expired lease into an explicit terminal state before claiming more;
        // otherwise `attempts < max` would make it invisible forever.
        deadline
            .run(
                sqlx::query(
                    "WITH expired AS (\
                        SELECT save_session_id FROM save_cleanup_jobs \
                        WHERE status='running' \
                          AND lease_expires_at <= transaction_timestamp() \
                          AND attempts >= $1 \
                        ORDER BY lease_expires_at,save_session_id LIMIT $2 \
                        FOR UPDATE SKIP LOCKED\
                     ) UPDATE save_cleanup_jobs job SET status='failed',retry_at=NULL,\
                         lease_owner=NULL,lease_expires_at=NULL,last_failure_category='unknown',\
                         updated_at=transaction_timestamp() \
                     FROM expired WHERE job.save_session_id=expired.save_session_id",
                )
                .bind(max_attempts)
                .bind(i64::from(self.policy.batch_size))
                .execute(&mut *connection),
            )
            .await?
            .map_err(map_sql_error)?;
        type JobRow = (String, String, String, Option<String>, i16, i16);
        let rows: Vec<JobRow> = deadline
            .run(
                sqlx::query_as(
                    "WITH selected AS (\
                        SELECT save_session_id FROM save_cleanup_jobs \
                        WHERE attempts < $1 AND (\
                            (status='queued' AND eligible_at <= transaction_timestamp()) OR\
                            (status='retry_wait' AND retry_at <= transaction_timestamp()) OR\
                            (status='running' AND lease_expires_at <= transaction_timestamp())\
                        ) ORDER BY COALESCE(retry_at,eligible_at),save_session_id \
                        LIMIT $2 FOR UPDATE SKIP LOCKED\
                     ) UPDATE save_cleanup_jobs job SET status='running',attempts=attempts+1,\
                         retry_at=NULL,lease_owner=$3::uuid,\
                         lease_expires_at=transaction_timestamp()+($4 * interval '1 millisecond'),\
                         started_at=COALESCE(started_at,transaction_timestamp()),\
                         updated_at=transaction_timestamp() \
                     FROM selected WHERE job.save_session_id=selected.save_session_id \
                     RETURNING job.save_session_id::text,job.cleanup_kind,job.object_key,\
                               job.multipart_upload_id,job.attempts,job.absence_count",
                )
                .bind(max_attempts)
                .bind(i64::from(self.policy.batch_size))
                .bind(owner.to_string())
                .bind(lease_millis)
                .fetch_all(&mut *connection),
            )
            .await?
            .map_err(map_sql_error)?;
        rows.into_iter().map(decode_job).collect()
    }

    async fn finish_job(
        &self,
        owner: Uuid,
        job: ClaimedJob,
        outcome: CleanupBackendOutcome,
    ) -> Result<(), CleanupError> {
        if job.target.kind == CleanupKind::ObjectDelete {
            return self
                .update_claim(
                    owner,
                    job.session_id,
                    "status='completed',completed_at=transaction_timestamp(),last_failure_category=NULL",
                    None,
                    None,
                )
                .await;
        }

        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let identity: Option<(String, String)> = deadline
            .run(
                sqlx::query_as(
                    "SELECT storage_scope_id::text,project_id::text FROM save_sessions \
                     WHERE id=$1::uuid",
                )
                .bind(job.session_id.to_string())
                .fetch_optional(&mut *connection),
            )
            .await?
            .map_err(map_sql_error)?;
        let mut transaction = deadline
            .run(connection.begin())
            .await?
            .map_err(map_sql_error)?;
        configure_transaction(&mut transaction, deadline).await?;

        if let Some((scope_id, project_id)) = identity {
            let scope = StorageScopeId::from_str(&scope_id)
                .map_err(|_| CleanupError::InvariantViolation)?;
            if deadline
                .run(QuotaRepository::lock_storage_scope(&mut transaction, scope))
                .await?
                .map_err(map_sql_error)?
            {
                let project_locked = deadline
                    .run(
                        sqlx::query("SELECT 1 FROM projects WHERE id=$1::uuid FOR UPDATE")
                            .bind(project_id)
                            .execute(&mut *transaction),
                    )
                    .await?
                    .map_err(map_sql_error)?
                    .rows_affected()
                    == 1;
                if project_locked {
                    match job.target.kind {
                        CleanupKind::MultipartReconcile => {
                            self.finish_ambiguous_multipart(&mut transaction, &job, deadline)
                                .await?;
                        }
                        CleanupKind::MultipartAbort => {
                            self.finish_known_multipart(&mut transaction, &job, deadline)
                                .await?;
                        }
                        CleanupKind::MultipartCompleteReconcile => {
                            self.finish_complete_reconcile(
                                &mut transaction,
                                &job,
                                outcome,
                                deadline,
                            )
                            .await?;
                        }
                        CleanupKind::ObjectDelete => {
                            return Err(CleanupError::InvariantViolation);
                        }
                    }
                }
            }
        }

        if job.target.kind == CleanupKind::MultipartCompleteReconcile
            && outcome == CleanupBackendOutcome::Completed
        {
            delete_claim(&mut transaction, owner, job.session_id, deadline).await?;
        } else {
            complete_claim(&mut transaction, owner, job.session_id, deadline).await?;
        }
        commit(transaction, deadline).await
    }

    async fn finish_ambiguous_multipart(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        job: &ClaimedJob,
        deadline: Deadline,
    ) -> Result<(), CleanupError> {
        type SessionRow = (String, String, Option<String>, String, Option<String>, bool);
        let row: Option<SessionRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT session.state,session.upload_mode,session.multipart_upload_id,\
                            session.staging_object_key,lifecycle.create_status,\
                            session.expires_at <= transaction_timestamp() \
                     FROM save_sessions session \
                     LEFT JOIN multipart_lifecycles lifecycle \
                       ON lifecycle.save_session_id=session.id \
                     WHERE session.id=$1::uuid FOR UPDATE OF session",
                )
                .bind(job.session_id.to_string())
                .fetch_optional(&mut **transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let Some((state, mode, upload_id, object_key, create_status, expired)) = row else {
            return Ok(());
        };
        if mode != "multipart" || object_key != job.target.object_key.expose() {
            return Err(CleanupError::InvariantViolation);
        }
        if !matches!(
            create_status.as_deref(),
            Some("creating" | "unknown" | "cleaned")
        ) {
            return Err(CleanupError::InvariantViolation);
        }
        if matches!(state.as_str(), "aborted" | "expired" | "failed")
            && create_status.as_deref() == Some("cleaned")
        {
            return Ok(());
        }
        let ambiguous_create = state == "created"
            && upload_id.is_none()
            && matches!(
                create_status.as_deref(),
                Some("creating" | "unknown" | "cleaned")
            );
        let confirmed_abort = state == "uploading"
            && upload_id.is_some()
            && create_status.as_deref() == Some("cleaned");
        if !ambiguous_create && !confirmed_abort {
            return Err(CleanupError::InvariantViolation);
        }
        if create_status.as_deref() != Some("cleaned") {
            let affected = deadline
                .run(
                    sqlx::query(
                        "UPDATE multipart_lifecycles SET create_status='cleaned',\
                             updated_at=transaction_timestamp() \
                         WHERE save_session_id=$1::uuid \
                           AND create_status IN ('creating','unknown') \
                           AND complete_status='pending'",
                    )
                    .bind(job.session_id.to_string())
                    .execute(&mut **transaction),
                )
                .await?
                .map_err(map_sql_error)?
                .rows_affected();
            if affected != 1 {
                return Err(CleanupError::InvariantViolation);
            }
        }
        let terminal_state = if expired { "expired" } else { "failed" };
        transition_session(transaction, job.session_id, terminal_state, deadline).await
    }

    async fn finish_known_multipart(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        job: &ClaimedJob,
        deadline: Deadline,
    ) -> Result<(), CleanupError> {
        type SessionRow = (
            String,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
        );
        let row: Option<SessionRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT session.state,session.upload_mode,session.multipart_upload_id,\
                            session.staging_object_key,lifecycle.create_status,\
                            lifecycle.complete_status \
                     FROM save_sessions session \
                     LEFT JOIN multipart_lifecycles lifecycle \
                       ON lifecycle.save_session_id=session.id \
                     WHERE session.id=$1::uuid FOR UPDATE OF session",
                )
                .bind(job.session_id.to_string())
                .fetch_optional(&mut **transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let Some((state, mode, upload_id, object_key, create_status, complete_status)) = row else {
            return Ok(());
        };
        if !matches!(state.as_str(), "aborted" | "expired" | "failed")
            || mode != "multipart"
            || upload_id.as_deref() != job.target.multipart_upload_id.as_deref()
            || object_key != job.target.object_key.expose()
        {
            return Err(CleanupError::InvariantViolation);
        }
        // Sessions created before the lifecycle migration have no marker.
        if create_status.is_none() && complete_status.is_none() {
            return Ok(());
        }
        if complete_status.as_deref() != Some("pending") {
            return Err(CleanupError::InvariantViolation);
        }
        match create_status.as_deref() {
            Some("cleaned") => Ok(()),
            Some("ready") => {
                let affected = deadline
                    .run(
                        sqlx::query(
                            "UPDATE multipart_lifecycles SET create_status='cleaned',\
                                 updated_at=transaction_timestamp() \
                             WHERE save_session_id=$1::uuid AND create_status='ready' \
                               AND complete_status='pending'",
                        )
                        .bind(job.session_id.to_string())
                        .execute(&mut **transaction),
                    )
                    .await?
                    .map_err(map_sql_error)?
                    .rows_affected();
                if affected == 1 {
                    Ok(())
                } else {
                    Err(CleanupError::InvariantViolation)
                }
            }
            _ => Err(CleanupError::InvariantViolation),
        }
    }

    async fn finish_complete_reconcile(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        job: &ClaimedJob,
        outcome: CleanupBackendOutcome,
        deadline: Deadline,
    ) -> Result<(), CleanupError> {
        type SessionRow = (String, Option<String>, String, String, String, bool);
        let row: Option<SessionRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT session.state,session.multipart_upload_id,session.staging_object_key,\
                            lifecycle.create_status,lifecycle.complete_status,\
                            session.expires_at <= transaction_timestamp() \
                     FROM save_sessions session JOIN multipart_lifecycles lifecycle \
                       ON lifecycle.save_session_id=session.id \
                     WHERE session.id=$1::uuid FOR UPDATE OF session",
                )
                .bind(job.session_id.to_string())
                .fetch_optional(&mut **transaction),
            )
            .await?
            .map_err(map_sql_error)?;
        let Some((state, upload_id, object_key, create_status, complete_status, expired)) = row
        else {
            return Ok(());
        };
        if !matches!(state.as_str(), "uploading" | "verifying")
            || upload_id.as_deref() != job.target.multipart_upload_id.as_deref()
            || object_key != job.target.object_key.expose()
            || create_status != "ready"
            || !matches!(complete_status.as_str(), "completing" | "unknown")
        {
            return Err(CleanupError::InvariantViolation);
        }
        match outcome {
            CleanupBackendOutcome::Completed => {
                if state == "uploading" {
                    let affected = deadline
                        .run(
                            sqlx::query(
                                "UPDATE save_sessions SET state='verifying',\
                                     updated_at=transaction_timestamp() \
                                 WHERE id=$1::uuid AND state='uploading'",
                            )
                            .bind(job.session_id.to_string())
                            .execute(&mut **transaction),
                        )
                        .await?
                        .map_err(map_sql_error)?
                        .rows_affected();
                    if affected != 1 {
                        return Err(CleanupError::InvariantViolation);
                    }
                }
                let affected = deadline
                    .run(
                        sqlx::query(
                            "UPDATE multipart_lifecycles SET complete_status='completed',\
                                 updated_at=transaction_timestamp() \
                             WHERE save_session_id=$1::uuid AND create_status='ready' \
                               AND complete_status IN ('completing','unknown')",
                        )
                        .bind(job.session_id.to_string())
                        .execute(&mut **transaction),
                    )
                    .await?
                    .map_err(map_sql_error)?
                    .rows_affected();
                if affected != 1 {
                    return Err(CleanupError::InvariantViolation);
                }
                Ok(())
            }
            CleanupBackendOutcome::Missing => {
                let affected = deadline
                    .run(
                        sqlx::query(
                            "UPDATE multipart_lifecycles SET create_status='cleaned',\
                                 updated_at=transaction_timestamp() \
                             WHERE save_session_id=$1::uuid AND create_status='ready' \
                               AND complete_status IN ('completing','unknown')",
                        )
                        .bind(job.session_id.to_string())
                        .execute(&mut **transaction),
                    )
                    .await?
                    .map_err(map_sql_error)?
                    .rows_affected();
                if affected != 1 {
                    return Err(CleanupError::InvariantViolation);
                }
                let terminal_state = if expired { "expired" } else { "failed" };
                transition_session(transaction, job.session_id, terminal_state, deadline).await
            }
            _ => Err(CleanupError::InvariantViolation),
        }
    }

    async fn retry_job(
        &self,
        owner: Uuid,
        job: ClaimedJob,
        category: &'static str,
    ) -> Result<(), CleanupError> {
        let attempts = u16::try_from(job.attempts).map_err(|_| CleanupError::InvariantViolation)?;
        if attempts >= self.policy.max_attempts {
            return self.fail_job(owner, job.session_id, category).await;
        }
        let delay = retry_delay(self.policy, job.session_id, job.attempts)?;
        let delay_millis =
            i64::try_from(delay.as_millis()).map_err(|_| CleanupError::InvalidPolicy)?;
        self.update_claim(
            owner,
            job.session_id,
            "status='retry_wait',retry_at=transaction_timestamp()+($4 * interval '1 millisecond'),last_failure_category=$3",
            Some(category),
            Some(delay_millis),
        )
        .await
    }

    async fn observe_absence(&self, owner: Uuid, job: ClaimedJob) -> Result<(), CleanupError> {
        let attempts = u16::try_from(job.attempts).map_err(|_| CleanupError::InvariantViolation)?;
        if attempts >= self.policy.max_attempts {
            return self.fail_job(owner, job.session_id, "absent").await;
        }
        let delay = retry_delay(self.policy, job.session_id, job.attempts)?;
        let delay_millis =
            i64::try_from(delay.as_millis()).map_err(|_| CleanupError::InvalidPolicy)?;
        self.update_claim(
            owner,
            job.session_id,
            "status='retry_wait',retry_at=transaction_timestamp()+($4 * interval '1 millisecond'),last_failure_category=$3,absence_count=1,absence_observed_at=transaction_timestamp()",
            Some("absent"),
            Some(delay_millis),
        )
        .await
    }

    async fn fail_job(
        &self,
        owner: Uuid,
        session_id: SaveSessionId,
        category: &'static str,
    ) -> Result<(), CleanupError> {
        self.update_claim(
            owner,
            session_id,
            "status='failed',last_failure_category=$3",
            Some(category),
            None,
        )
        .await
    }

    async fn release_claims(
        &self,
        owner: Uuid,
        session_ids: Vec<SaveSessionId>,
    ) -> Result<(), CleanupError> {
        if session_ids.is_empty() {
            return Ok(());
        }
        let expected = u64::try_from(session_ids.len()).map_err(|_| CleanupError::InvalidPolicy)?;
        let session_ids: Vec<String> = session_ids
            .into_iter()
            .map(|session_id| session_id.to_string())
            .collect();
        let deadline = Deadline::new(self.policy.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let result = deadline
            .run(
                sqlx::query(
                    "UPDATE save_cleanup_jobs SET status='retry_wait',\
                         retry_at=transaction_timestamp(),last_failure_category='unknown',\
                         lease_owner=NULL,lease_expires_at=NULL,updated_at=transaction_timestamp() \
                     WHERE save_session_id = ANY($1::text[]::uuid[]) AND status='running' \
                       AND lease_owner=$2::uuid AND lease_expires_at > clock_timestamp()",
                )
                .bind(session_ids)
                .bind(owner.to_string())
                .execute(&mut *connection),
            )
            .await?
            .map_err(map_sql_error)?;
        if result.rows_affected() == expected {
            Ok(())
        } else {
            Err(CleanupError::InvariantViolation)
        }
    }

    async fn update_claim(
        &self,
        owner: Uuid,
        session_id: SaveSessionId,
        assignment: &'static str,
        category: Option<&'static str>,
        delay_millis: Option<i64>,
    ) -> Result<(), CleanupError> {
        let deadline = Deadline::new(self.policy.operation_timeout);
        let sql = format!(
            "UPDATE save_cleanup_jobs SET {assignment},lease_owner=NULL,lease_expires_at=NULL,\
             updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid \
             AND status='running' AND lease_owner=$2::uuid \
             AND lease_expires_at > clock_timestamp()"
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(session_id.to_string())
            .bind(owner.to_string());
        if let Some(category) = category {
            query = query.bind(category);
        }
        if let Some(delay) = delay_millis {
            query = query.bind(delay);
        }
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database_error)?;
        let result = deadline
            .run(query.execute(&mut *connection))
            .await?
            .map_err(map_sql_error)?;
        if result.rows_affected() == 1 {
            Ok(())
        } else {
            Err(CleanupError::InvariantViolation)
        }
    }
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

impl fmt::Debug for CleanupWorker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CleanupWorker")
            .finish_non_exhaustive()
    }
}

impl CleanupWorker {
    pub async fn run_until<F>(mut self, shutdown: F, deadline: Duration) -> WorkerShutdown
    where
        F: Future<Output = ()>,
    {
        tokio::pin!(shutdown);
        tokio::select! {
            result = &mut self.join => match result {
                Ok(Ok(())) => WorkerShutdown::Drained,
                _ => WorkerShutdown::WorkerFailed,
            },
            () = &mut shutdown => {
                let _ = self.cancel.send(true);
                match time::timeout(deadline, &mut self.join).await {
                    Ok(Ok(Ok(()))) => WorkerShutdown::Drained,
                    Ok(_) => WorkerShutdown::WorkerFailed,
                    Err(_) => {
                        self.join.abort();
                        let _ = (&mut self.join).await;
                        WorkerShutdown::DeadlineExceeded
                    }
                }
            }
        }
    }

    pub async fn shutdown(mut self, deadline: Duration) -> WorkerShutdown {
        let _ = self.cancel.send(true);
        match time::timeout(deadline, &mut self.join).await {
            Ok(Ok(Ok(()))) => WorkerShutdown::Drained,
            Ok(_) => WorkerShutdown::WorkerFailed,
            Err(_) => {
                self.join.abort();
                let _ = (&mut self.join).await;
                WorkerShutdown::DeadlineExceeded
            }
        }
    }
}

impl Drop for CleanupWorker {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
        self.join.abort();
    }
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

fn decode_job(
    row: (String, String, String, Option<String>, i16, i16),
) -> Result<ClaimedJob, CleanupError> {
    let session_id = parse_session_id(&row.0)?;
    let kind = match row.1.as_str() {
        "object_delete" if row.3.is_none() => CleanupKind::ObjectDelete,
        "multipart_abort" if row.3.is_some() => CleanupKind::MultipartAbort,
        "multipart_reconcile" if row.3.is_none() => CleanupKind::MultipartReconcile,
        "multipart_complete_reconcile" if row.3.is_some() => {
            CleanupKind::MultipartCompleteReconcile
        }
        _ => return Err(CleanupError::InvariantViolation),
    };
    let object_key = ObjectKey::parse(row.2).map_err(|_| CleanupError::InvariantViolation)?;
    if !(1..=i16::try_from(MAX_ATTEMPTS).map_err(|_| CleanupError::InvariantViolation)?)
        .contains(&row.4)
        || !(0..=1).contains(&row.5)
    {
        return Err(CleanupError::InvariantViolation);
    }
    Ok(ClaimedJob {
        session_id,
        target: CleanupTarget {
            kind,
            object_key,
            multipart_upload_id: row.3,
            prior_absence: row.5 == 1,
        },
        attempts: row.4,
        absence_count: row.5,
    })
}

fn retry_delay(
    policy: CleanupWorkerPolicy,
    session_id: SaveSessionId,
    attempts: i16,
) -> Result<Duration, CleanupError> {
    let prior_attempts = attempts
        .checked_sub(1)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(CleanupError::InvariantViolation)?;
    let factor = 1_u32
        .checked_shl(prior_attempts.min(20))
        .ok_or(CleanupError::InvariantViolation)?;
    let exponential = policy
        .base_backoff
        .checked_mul(factor)
        .map_or(policy.max_backoff, |value| value.min(policy.max_backoff));
    let jitter_window = exponential.as_millis() / 4;
    if jitter_window == 0 {
        return Ok(exponential);
    }
    let session_uuid = session_id.into_uuid();
    let bytes = session_uuid.as_bytes();
    let seed = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as u128;
    let jitter = seed % jitter_window;
    let jitter =
        Duration::from_millis(u64::try_from(jitter).map_err(|_| CleanupError::InvariantViolation)?);
    Ok(exponential
        .checked_add(jitter)
        .map_or(policy.max_backoff, |value| value.min(policy.max_backoff)))
}

#[derive(Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    fn remaining(self) -> Result<Duration, CleanupError> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(CleanupError::OperationTimeout)
        } else {
            Ok(remaining)
        }
    }

    async fn run<T>(self, future: impl Future<Output = T>) -> Result<T, CleanupError> {
        time::timeout_at(self.0, future)
            .await
            .map_err(|_| CleanupError::OperationTimeout)
    }
}

async fn configure_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), CleanupError> {
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

async fn lock_scope(
    transaction: &mut Transaction<'_, Postgres>,
    storage_scope_id: StorageScopeId,
    deadline: Deadline,
) -> Result<(), CleanupError> {
    let found = deadline
        .run(QuotaRepository::lock_storage_scope(
            transaction,
            storage_scope_id,
        ))
        .await?
        .map_err(map_sql_error)?;
    if found {
        Ok(())
    } else {
        Err(CleanupError::ScopeNotFound)
    }
}

async fn transition_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    state: &'static str,
    deadline: Deadline,
) -> Result<(), CleanupError> {
    let result = deadline.run(sqlx::query("UPDATE save_sessions SET state=$2,terminal_at=transaction_timestamp(),updated_at=transaction_timestamp() WHERE id=$1::uuid")
        .bind(session_id.to_string()).bind(state).execute(&mut **transaction)).await?.map_err(map_sql_error)?;
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(CleanupError::InvariantViolation)
    }
}

async fn active_relay_upload_exists(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<bool, CleanupError> {
    deadline
        .run(
            sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM save_upload_leases \
                 WHERE save_session_id=$1::uuid AND released_at IS NULL \
                   AND lease_expires_at>clock_timestamp())",
            )
            .bind(session_id.to_string())
            .fetch_one(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)
}

async fn complete_claim(
    transaction: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<(), CleanupError> {
    let affected = deadline
        .run(
            sqlx::query(
                "UPDATE save_cleanup_jobs SET status='completed',\
                     completed_at=transaction_timestamp(),last_failure_category=NULL,\
                     lease_owner=NULL,lease_expires_at=NULL,updated_at=transaction_timestamp() \
                 WHERE save_session_id=$1::uuid AND status='running' AND lease_owner=$2::uuid \
                   AND lease_expires_at > clock_timestamp()",
            )
            .bind(session_id.to_string())
            .bind(owner.to_string())
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?
        .rows_affected();
    if affected == 1 {
        Ok(())
    } else {
        Err(CleanupError::InvariantViolation)
    }
}

async fn assert_active_claim(
    transaction: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<(), CleanupError> {
    let active = deadline
        .run(
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM save_cleanup_jobs \
                 WHERE save_session_id=$1::uuid AND status='running' \
                   AND lease_owner=$2::uuid AND lease_expires_at > clock_timestamp())",
            )
            .bind(session_id.to_string())
            .bind(owner.to_string())
            .fetch_one(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?;
    if active {
        Ok(())
    } else {
        Err(CleanupError::InvariantViolation)
    }
}

async fn delete_claim(
    transaction: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<(), CleanupError> {
    let affected = deadline
        .run(
            sqlx::query(
                "DELETE FROM save_cleanup_jobs WHERE save_session_id=$1::uuid \
                 AND status='running' AND lease_owner=$2::uuid \
                   AND lease_expires_at > clock_timestamp()",
            )
            .bind(session_id.to_string())
            .bind(owner.to_string())
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql_error)?
        .rows_affected();
    if affected == 1 {
        Ok(())
    } else {
        Err(CleanupError::InvariantViolation)
    }
}

async fn commit(
    transaction: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), CleanupError> {
    match time::timeout_at(deadline.0, transaction.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(map_commit_error(error)),
        Err(_) => Err(CleanupError::CommitOutcomeUnknown),
    }
}

fn map_commit_error(error: sqlx::Error) -> CleanupError {
    if error.as_database_error().is_none() {
        CleanupError::CommitOutcomeUnknown
    } else {
        map_sql_error(error)
    }
}

fn parse_session_id(value: &str) -> Result<SaveSessionId, CleanupError> {
    let uuid = Uuid::parse_str(value).map_err(|_| CleanupError::InvariantViolation)?;
    SaveSessionId::from_uuid(uuid).map_err(|_| CleanupError::InvariantViolation)
}

fn map_database_error(error: DatabaseError) -> CleanupError {
    match error {
        DatabaseError::AcquireTimeout => CleanupError::OperationTimeout,
        _ => CleanupError::DatabaseUnavailable,
    }
}

fn map_sql_error(error: sqlx::Error) -> CleanupError {
    match error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
    {
        Some("57014" | "55P03") => CleanupError::OperationTimeout,
        Some("23503" | "23505" | "23514") => CleanupError::InvariantViolation,
        _ => CleanupError::DatabaseUnavailable,
    }
}

fn map_project_access_error(error: ProjectAccessError) -> CleanupError {
    match error {
        ProjectAccessError::OperationTimeout => CleanupError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => CleanupError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => CleanupError::InvariantViolation,
        _ => CleanupError::ProjectNotFound,
    }
}

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
