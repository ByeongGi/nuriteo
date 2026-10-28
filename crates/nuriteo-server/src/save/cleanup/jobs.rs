#![allow(unused_imports)]
use super::*;
use super::backend::*;
use super::worker::*;
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



impl<B: CleanupBackend> super::CleanupService<B> { pub(crate) async fn finish_known_multipart(
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
    pub(crate) async fn finish_complete_reconcile(
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
    pub(crate) async fn retry_job(
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
    pub(crate) async fn observe_absence(&self, owner: Uuid, job: ClaimedJob) -> Result<(), CleanupError> {
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
    pub(crate) async fn fail_job(
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
    pub(crate) async fn release_claims(
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
    pub(crate) async fn update_claim(
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


impl fmt::Debug for CleanupWorker { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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


impl Drop for CleanupWorker { fn drop(&mut self) {
        let _ = self.cancel.send(true);
        self.join.abort();
    }
}


pub(crate) fn decode_job(    row: (String, String, String, Option<String>, i16, i16),
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


pub(crate) fn retry_delay(    policy: CleanupWorkerPolicy,
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


impl Deadline {
    pub(crate) fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    pub(crate) fn remaining(self) -> Result<Duration, CleanupError> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(CleanupError::OperationTimeout)
        } else {
            Ok(remaining)
        }
    }

    pub(crate) async fn run<T>(self, future: impl Future<Output = T>) -> Result<T, CleanupError> {
        time::timeout_at(self.0, future)
            .await
            .map_err(|_| CleanupError::OperationTimeout)
    }
}


pub(crate) async fn configure_transaction(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn lock_scope(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn transition_session(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn active_relay_upload_exists(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn complete_claim(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn assert_active_claim(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn delete_claim(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn commit(    transaction: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), CleanupError> {
    match time::timeout_at(deadline.0, transaction.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(map_commit_error(error)),
        Err(_) => Err(CleanupError::CommitOutcomeUnknown),
    }
}


pub(crate) fn map_commit_error(error: sqlx::Error) -> CleanupError {    if error.as_database_error().is_none() {
        CleanupError::CommitOutcomeUnknown
    } else {
        map_sql_error(error)
    }
}


pub(crate) fn parse_session_id(value: &str) -> Result<SaveSessionId, CleanupError> {    let uuid = Uuid::parse_str(value).map_err(|_| CleanupError::InvariantViolation)?;
    SaveSessionId::from_uuid(uuid).map_err(|_| CleanupError::InvariantViolation)
}


pub(crate) fn map_database_error(error: DatabaseError) -> CleanupError {    match error {
        DatabaseError::AcquireTimeout => CleanupError::OperationTimeout,
        _ => CleanupError::DatabaseUnavailable,
    }
}


pub(crate) fn map_sql_error(error: sqlx::Error) -> CleanupError {    match error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
    {
        Some("57014" | "55P03") => CleanupError::OperationTimeout,
        Some("23503" | "23505" | "23514") => CleanupError::InvariantViolation,
        _ => CleanupError::DatabaseUnavailable,
    }
}


pub(crate) fn map_project_access_error(error: ProjectAccessError) -> CleanupError {    match error {
        ProjectAccessError::OperationTimeout => CleanupError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => CleanupError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => CleanupError::InvariantViolation,
        _ => CleanupError::ProjectNotFound,
    }
}
