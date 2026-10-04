use std::future::Future;
use std::time::Duration;

use sqlx::{Acquire, Postgres, Transaction};
use tokio::io::AsyncRead;
use tokio::time::{self, Instant};

use crate::database::{DatabaseError, DatabasePool};
use crate::object_storage::{
    MultipartLimits, MultipartUpload, ObjectKey, ObjectStoreError, ObjectStoreErrorKind,
    S3ObjectStore, Sha256Checksum, StreamingMultipartPartRequest, StreamingPutRequest, UploadBody,
    UploadDeadlines, upload_abort_pair,
};
use crate::project::SaveProjectContext;
use crate::quota::SaveSessionId;

use super::{
    MultipartPartReceipt, MultipartService, MultipartServiceError, MultipartSessionContext,
};

const CONTENT_TYPE: &str = "application/vnd.nuriteo.project-bundle";
const SQL_TIMEOUT_MARGIN: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RelayUploadError {
    NotFound,
    InvalidInput,
    Conflict,
    SessionExpired,
    OperationTimeout,
    Unavailable,
    ReconciliationRequired,
    Internal,
}

#[derive(Clone)]
pub(crate) struct RelayUploadService {
    pool: DatabasePool,
    store: S3ObjectStore,
    multipart: MultipartService,
    operation_timeout: Duration,
    idle_timeout: Duration,
    total_timeout: Duration,
}

impl RelayUploadService {
    pub(crate) fn new(
        pool: DatabasePool,
        store: S3ObjectStore,
        multipart: MultipartService,
        operation_timeout: Duration,
        idle_timeout: Duration,
        total_timeout: Duration,
    ) -> Result<Self, RelayUploadError> {
        UploadDeadlines::for_put(idle_timeout, total_timeout)
            .map_err(|_| RelayUploadError::InvalidInput)?;
        UploadDeadlines::for_multipart_part(idle_timeout, total_timeout)
            .map_err(|_| RelayUploadError::InvalidInput)?;
        Ok(Self {
            pool,
            store,
            multipart,
            operation_timeout,
            idle_timeout,
            total_timeout,
        })
    }

    pub(crate) async fn upload_single(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        declared_bytes: u64,
        checksum: Sha256Checksum,
        reader: impl AsyncRead + Send + 'static,
    ) -> Result<(), RelayUploadError> {
        let target = self
            .prepare_single(context, session_id, declared_bytes, &checksum)
            .await?;
        let (_, abort) = upload_abort_pair();
        self.store
            .put_stream_once(StreamingPutRequest {
                key: target,
                body: UploadBody::from_reader(reader, declared_bytes, checksum),
                content_type: Some(CONTENT_TYPE.to_owned()),
                deadlines: UploadDeadlines::for_put(self.idle_timeout, self.total_timeout)
                    .map_err(|_| RelayUploadError::Internal)?,
                abort,
            })
            .await
            .map_err(map_object_store)
    }

    pub(crate) async fn upload_part(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        part_number: u16,
        declared_bytes: u64,
        checksum: Sha256Checksum,
        reader: impl AsyncRead + Send + 'static,
    ) -> Result<(), RelayUploadError> {
        let target = self
            .prepare_part(context, session_id, part_number, declared_bytes, &checksum)
            .await?;
        let (_, abort) = upload_abort_pair();
        let uploaded = self
            .store
            .upload_part_stream_once(
                StreamingMultipartPartRequest {
                    upload: target.upload,
                    part_number,
                    body: UploadBody::from_reader(reader, declared_bytes, checksum.clone()),
                    final_part: target.final_part,
                    deadlines: UploadDeadlines::for_multipart_part(
                        self.idle_timeout,
                        self.total_timeout,
                    )
                    .map_err(|_| RelayUploadError::Internal)?,
                    abort,
                },
                &target.limits,
            )
            .await
            .map_err(map_object_store)?;
        let receipt = MultipartPartReceipt::new(
            uploaded.part_number,
            declared_bytes,
            checksum,
            uploaded.e_tag,
        )
        .map_err(map_multipart)?;
        self.multipart
            .record_receipts(multipart_context(context, session_id), vec![receipt])
            .await
            .map_err(map_multipart)
    }

    async fn prepare_single(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        declared_bytes: u64,
        checksum: &Sha256Checksum,
    ) -> Result<ObjectKey, RelayUploadError> {
        let deadline = Deadline::new(self.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database)?;
        let mut transaction = deadline.run(connection.begin()).await?.map_err(map_sql)?;
        configure(&mut transaction, deadline).await?;
        type SingleRow = (String, String, i64, Vec<u8>, bool);
        let row: Option<SingleRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT state,staging_object_key,expected_physical_bytes,\
                     expected_bundle_sha256,expires_at<=transaction_timestamp() \
                     FROM save_sessions WHERE id=$1::uuid AND project_id=$2::uuid \
                     AND storage_scope_id=$3::uuid AND actor_user_id=$4::uuid \
                     AND upload_mode='single' FOR UPDATE",
                )
                .bind(session_id.to_string())
                .bind(context.project_id.to_string())
                .bind(context.storage_scope_id.to_string())
                .bind(context.actor_user_id.to_string())
                .fetch_optional(&mut *transaction),
            )
            .await?
            .map_err(map_sql)?;
        let Some((state, key, expected_bytes, expected_checksum, expired)) = row else {
            return Err(RelayUploadError::NotFound);
        };
        validate_session_state(&state, expired, &["created", "uploading"])?;
        if u64::try_from(expected_bytes).ok() != Some(declared_bytes)
            || expected_checksum.as_slice() != checksum.as_bytes()
        {
            return Err(RelayUploadError::InvalidInput);
        }
        if state == "created" {
            let affected = deadline
                .run(
                    sqlx::query(
                        "UPDATE save_sessions SET state='uploading',updated_at=transaction_timestamp() \
                         WHERE id=$1::uuid AND state='created' AND upload_mode='single'",
                    )
                    .bind(session_id.to_string())
                    .execute(&mut *transaction),
                )
                .await?
                .map_err(map_sql)?
                .rows_affected();
            if affected != 1 {
                return Err(RelayUploadError::Conflict);
            }
        }
        commit(transaction, deadline).await?;
        ObjectKey::parse(key).map_err(|_| RelayUploadError::Internal)
    }

    async fn prepare_part(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        part_number: u16,
        declared_bytes: u64,
        checksum: &Sha256Checksum,
    ) -> Result<RelayPartTarget, RelayUploadError> {
        let deadline = Deadline::new(self.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database)?;
        let mut transaction = deadline.run(connection.begin()).await?.map_err(map_sql)?;
        configure(&mut transaction, deadline).await?;
        type PartRow = (
            String,
            String,
            Option<String>,
            bool,
            String,
            String,
            i64,
            i16,
            i64,
            Vec<u8>,
            String,
        );
        let row: Option<PartRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT save.state,save.staging_object_key,save.multipart_upload_id,\
                     save.expires_at<=transaction_timestamp(),lifecycle.create_status,\
                     lifecycle.complete_status,lifecycle.part_size_bytes,lifecycle.part_count,\
                     part.expected_bytes,part.expected_sha256,part.state \
                     FROM save_sessions save JOIN multipart_lifecycles lifecycle \
                       ON lifecycle.save_session_id=save.id \
                     JOIN multipart_parts part ON part.save_session_id=save.id \
                     WHERE save.id=$1::uuid AND save.project_id=$2::uuid \
                       AND save.storage_scope_id=$3::uuid AND save.actor_user_id=$4::uuid \
                       AND save.upload_mode='multipart' AND part.part_number=$5 FOR UPDATE OF save,lifecycle,part",
                )
                .bind(session_id.to_string())
                .bind(context.project_id.to_string())
                .bind(context.storage_scope_id.to_string())
                .bind(context.actor_user_id.to_string())
                .bind(i16::try_from(part_number).map_err(|_| RelayUploadError::InvalidInput)?)
                .fetch_optional(&mut *transaction),
            )
            .await?
            .map_err(map_sql)?;
        let Some(row) = row else {
            return Err(RelayUploadError::NotFound);
        };
        validate_session_state(&row.0, row.3, &["uploading"])?;
        if row.4 != "ready"
            || row.5 != "pending"
            || !matches!(row.10.as_str(), "pending" | "uploaded")
        {
            return Err(RelayUploadError::Conflict);
        }
        let upload_id = row.2.ok_or(RelayUploadError::Internal)?;
        if u64::try_from(row.8).ok() != Some(declared_bytes)
            || row.9.as_slice() != checksum.as_bytes()
        {
            return Err(RelayUploadError::InvalidInput);
        }
        let part_size = usize::try_from(row.6).map_err(|_| RelayUploadError::Internal)?;
        let part_count = u16::try_from(row.7).map_err(|_| RelayUploadError::Internal)?;
        if part_number == 0 || part_number > part_count {
            return Err(RelayUploadError::InvalidInput);
        }
        let target = RelayPartTarget {
            upload: MultipartUpload {
                key: ObjectKey::parse(row.1).map_err(|_| RelayUploadError::Internal)?,
                upload_id,
            },
            limits: MultipartLimits::new(part_size).map_err(|_| RelayUploadError::Internal)?,
            final_part: part_number == part_count,
        };
        commit(transaction, deadline).await?;
        Ok(target)
    }
}

struct RelayPartTarget {
    upload: MultipartUpload,
    limits: MultipartLimits,
    final_part: bool,
}

fn multipart_context(
    context: SaveProjectContext,
    session_id: SaveSessionId,
) -> MultipartSessionContext {
    MultipartSessionContext {
        storage_scope_id: context.storage_scope_id,
        project_id: context.project_id,
        actor_user_id: context.actor_user_id,
        session_id,
    }
}

fn validate_session_state(
    state: &str,
    expired: bool,
    allowed: &[&str],
) -> Result<(), RelayUploadError> {
    if expired {
        return Err(RelayUploadError::SessionExpired);
    }
    if allowed.contains(&state) {
        Ok(())
    } else if matches!(
        state,
        "created" | "uploading" | "verifying" | "committed" | "aborted" | "expired" | "failed"
    ) {
        Err(RelayUploadError::Conflict)
    } else {
        Err(RelayUploadError::Internal)
    }
}

#[derive(Clone, Copy)]
struct Deadline(Instant);

impl Deadline {
    fn new(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    fn remaining(self) -> Result<Duration, RelayUploadError> {
        let remaining = self.0.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(RelayUploadError::OperationTimeout)
        } else {
            Ok(remaining)
        }
    }

    async fn run<T>(self, future: impl Future<Output = T>) -> Result<T, RelayUploadError> {
        time::timeout_at(self.0, future)
            .await
            .map_err(|_| RelayUploadError::OperationTimeout)
    }
}

async fn configure(
    transaction: &mut Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), RelayUploadError> {
    let millis = deadline
        .remaining()?
        .saturating_sub(SQL_TIMEOUT_MARGIN)
        .max(Duration::from_millis(1))
        .as_millis()
        .min(i64::MAX as u128);
    deadline
        .run(
            sqlx::query(
                "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
            )
            .bind(format!("{millis}ms"))
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?;
    Ok(())
}

async fn commit(
    transaction: Transaction<'_, Postgres>,
    deadline: Deadline,
) -> Result<(), RelayUploadError> {
    match time::timeout_at(deadline.0, transaction.commit()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) | Err(_) => Err(RelayUploadError::ReconciliationRequired),
    }
}

fn map_database(error: DatabaseError) -> RelayUploadError {
    match error {
        DatabaseError::AcquireTimeout => RelayUploadError::OperationTimeout,
        _ => RelayUploadError::Unavailable,
    }
}

fn map_sql(error: sqlx::Error) -> RelayUploadError {
    if error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| matches!(code.as_ref(), "57014" | "55P03"))
    {
        RelayUploadError::OperationTimeout
    } else {
        RelayUploadError::Unavailable
    }
}

fn map_object_store(error: ObjectStoreError) -> RelayUploadError {
    match error.kind() {
        ObjectStoreErrorKind::InvalidRequest | ObjectStoreErrorKind::Integrity => {
            RelayUploadError::InvalidInput
        }
        ObjectStoreErrorKind::NotFound | ObjectStoreErrorKind::Conflict => {
            RelayUploadError::Conflict
        }
        ObjectStoreErrorKind::Timeout => RelayUploadError::OperationTimeout,
        ObjectStoreErrorKind::Authentication
        | ObjectStoreErrorKind::Authorization
        | ObjectStoreErrorKind::Throttled
        | ObjectStoreErrorKind::Unavailable => RelayUploadError::Unavailable,
        ObjectStoreErrorKind::ResponseUnknown => RelayUploadError::ReconciliationRequired,
        ObjectStoreErrorKind::ResponseTooLarge
        | ObjectStoreErrorKind::Unsupported
        | ObjectStoreErrorKind::Internal => RelayUploadError::Internal,
    }
}

fn map_multipart(error: MultipartServiceError) -> RelayUploadError {
    match error {
        MultipartServiceError::InvalidInput
        | MultipartServiceError::PartConflict
        | MultipartServiceError::PartsIncomplete => RelayUploadError::InvalidInput,
        MultipartServiceError::ScopeNotFound
        | MultipartServiceError::ProjectNotFound
        | MultipartServiceError::SessionNotFound => RelayUploadError::NotFound,
        MultipartServiceError::ProjectUnavailable
        | MultipartServiceError::ActiveSessionConflict
        | MultipartServiceError::SessionTerminal
        | MultipartServiceError::SessionNearExpiry
        | MultipartServiceError::StaleProjectVersion
        | MultipartServiceError::IdempotencyConflict => RelayUploadError::Conflict,
        MultipartServiceError::SessionExpired => RelayUploadError::SessionExpired,
        MultipartServiceError::OperationTimeout => RelayUploadError::OperationTimeout,
        MultipartServiceError::DatabaseUnavailable
        | MultipartServiceError::ObjectStorageUnavailable => RelayUploadError::Unavailable,
        MultipartServiceError::CreateReconciliationRequired
        | MultipartServiceError::CompleteReconciliationRequired
        | MultipartServiceError::CommitOutcomeUnknown => RelayUploadError::ReconciliationRequired,
        MultipartServiceError::IdempotencyConfigurationMismatch
        | MultipartServiceError::InvariantViolation
        | MultipartServiceError::QuotaExceeded => RelayUploadError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_validation_is_explicit_and_fail_closed() {
        assert_eq!(
            validate_session_state("uploading", false, &["uploading"]),
            Ok(())
        );
        assert_eq!(
            validate_session_state("committed", false, &["uploading"]),
            Err(RelayUploadError::Conflict)
        );
        assert_eq!(
            validate_session_state("uploading", true, &["uploading"]),
            Err(RelayUploadError::SessionExpired)
        );
        assert_eq!(
            validate_session_state("future-state", false, &["uploading"]),
            Err(RelayUploadError::Internal)
        );
    }
}
