#![allow(unused_imports)]
use super::*;
use super::backend::*;
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



impl<B: CleanupBackend> super::CleanupService<B> {    #[must_use]
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
    pub(crate) async fn worker_loop(&self, mut cancel: watch::Receiver<bool>) -> Result<(), CleanupError> {
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
    pub(crate) async fn process_batch(
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
    pub(crate) async fn process_job(&self, owner: Uuid, job: ClaimedJob) -> Result<(), CleanupError> {
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
    pub(crate) async fn prepare_reconcile(
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
    pub(crate) async fn claim(&self, owner: Uuid) -> Result<Vec<ClaimedJob>, CleanupError> {
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
    pub(crate) async fn finish_job(
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
    pub(crate) async fn finish_ambiguous_multipart(
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
}
