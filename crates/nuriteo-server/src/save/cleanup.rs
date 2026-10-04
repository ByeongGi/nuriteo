use std::fmt;
use std::future::Future;
use std::time::Duration;

use sqlx::{Acquire, Postgres, Transaction};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{self, Instant};
use uuid::Uuid;

use crate::database::{DatabaseError, DatabasePool};
use crate::identity::UserId;
use crate::object_storage::{
    MultipartUpload, ObjectKey, ObjectStoreError, ObjectStoreErrorKind, S3ObjectStore,
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
            || !(1..=MAX_ATTEMPTS).contains(&max_attempts)
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
        let minimum_lease = item_timeout
            .checked_add(operation_timeout)
            .and_then(|per_wave| per_wave.checked_mul(processing_waves))
            .and_then(|batch| batch.checked_add(SQL_TIMEOUT_MARGIN))
            .ok_or(CleanupError::InvalidPolicy)?;
        if lease_duration <= minimum_lease || lease_duration > Duration::from_secs(10 * 60) {
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
            lease_duration: Duration::from_secs(5 * 60),
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
    SingleDelete,
    MultipartAbort,
    MultipartReconcile,
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
            CleanupKind::SingleDelete => self.delete(&target.object_key).await,
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
                self.reconcile_multipart_for_exact_key(&target.object_key)
                    .await
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
            CleanupBackendOutcome::Completed | CleanupBackendOutcome::Missing => {
                self.finish_job(owner, job.session_id).await
            }
            CleanupBackendOutcome::Timeout => self.retry_job(owner, job, "timeout").await,
            CleanupBackendOutcome::Retryable => self.retry_job(owner, job, "retryable").await,
            CleanupBackendOutcome::Unknown => self.retry_job(owner, job, "unknown").await,
            CleanupBackendOutcome::Permanent => {
                self.fail_job(owner, job.session_id, "permanent").await
            }
        }
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
                    "UPDATE save_cleanup_jobs SET status='failed',retry_at=NULL,\
                         lease_owner=NULL,lease_expires_at=NULL,last_failure_category='unknown',\
                         updated_at=transaction_timestamp() \
                     WHERE status='running' AND lease_expires_at <= transaction_timestamp() \
                       AND attempts >= $1",
                )
                .bind(max_attempts)
                .execute(&mut *connection),
            )
            .await?
            .map_err(map_sql_error)?;
        type JobRow = (String, String, String, Option<String>, i16);
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
                               job.multipart_upload_id,job.attempts",
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

    async fn finish_job(&self, owner: Uuid, session_id: SaveSessionId) -> Result<(), CleanupError> {
        self.update_claim(
            owner,
            session_id,
            "status='completed',completed_at=transaction_timestamp(),last_failure_category=NULL",
            None,
            None,
        )
        .await
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
                       AND lease_owner=$2::uuid",
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
             AND status='running' AND lease_owner=$2::uuid"
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
}

fn decode_job(
    row: (String, String, String, Option<String>, i16),
) -> Result<ClaimedJob, CleanupError> {
    let session_id = parse_session_id(&row.0)?;
    let kind = match row.1.as_str() {
        "single_delete" if row.3.is_none() => CleanupKind::SingleDelete,
        "multipart_abort" if row.3.is_some() => CleanupKind::MultipartAbort,
        "multipart_reconcile" if row.3.is_none() => CleanupKind::MultipartReconcile,
        _ => return Err(CleanupError::InvariantViolation),
    };
    let object_key = ObjectKey::parse(row.2).map_err(|_| CleanupError::InvariantViolation)?;
    if !(1..=i16::try_from(MAX_ATTEMPTS).map_err(|_| CleanupError::InvariantViolation)?)
        .contains(&row.4)
    {
        return Err(CleanupError::InvariantViolation);
    }
    Ok(ClaimedJob {
        session_id,
        target: CleanupTarget {
            kind,
            object_key,
            multipart_upload_id: row.3,
        },
        attempts: row.4,
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
        };
        let rendered = format!("{target:?}");
        assert!(!rendered.contains("staging/private/key"));
        assert!(!rendered.contains("private-upload-identity"));
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
}
