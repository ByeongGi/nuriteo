use std::future::Future;
use std::time::Duration;

use ::time::OffsetDateTime;
use sqlx::{Acquire, Postgres, Transaction};
use tokio::io::AsyncRead;
use tokio::time::{self, Instant};
use uuid::Uuid;

use crate::database::{DatabaseError, DatabasePool};
use crate::object_storage::{
    MultipartLimits, MultipartUpload, ObjectKey, ObjectStoreError, ObjectStoreErrorKind,
    S3ObjectStore, Sha256Checksum, StreamingMultipartPartRequest, StreamingPutRequest, UploadBody,
    UploadDeadlines, upload_abort_pair,
};
use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, SaveProjectContext,
};
use crate::quota::{QuotaRepository, SaveSessionId};

const CONTENT_TYPE: &str = "application/vnd.nuriteo.project-bundle";
const SQL_TIMEOUT_MARGIN: Duration = Duration::from_millis(25);
const LEASE_GRACE: Duration = Duration::from_secs(5);

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
    operation_timeout: Duration,
    idle_timeout: Duration,
    total_timeout: Duration,
    lease_duration: Duration,
}

impl RelayUploadService {
    pub(crate) fn new(
        pool: DatabasePool,
        store: S3ObjectStore,
        operation_timeout: Duration,
        idle_timeout: Duration,
        total_timeout: Duration,
    ) -> Result<Self, RelayUploadError> {
        UploadDeadlines::for_put(idle_timeout, total_timeout)
            .map_err(|_| RelayUploadError::InvalidInput)?;
        UploadDeadlines::for_multipart_part(idle_timeout, total_timeout)
            .map_err(|_| RelayUploadError::InvalidInput)?;
        let lease_duration = total_timeout
            .checked_add(operation_timeout)
            .and_then(|duration| duration.checked_add(LEASE_GRACE))
            .ok_or(RelayUploadError::InvalidInput)?;
        Ok(Self {
            pool,
            store,
            operation_timeout,
            idle_timeout,
            total_timeout,
            lease_duration,
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
        let result = self
            .store
            .put_stream_once(StreamingPutRequest {
                key: target.object_key,
                body: UploadBody::from_reader(reader, declared_bytes, checksum),
                content_type: Some(CONTENT_TYPE.to_owned()),
                deadlines: UploadDeadlines::for_put(self.idle_timeout, self.total_timeout)
                    .map_err(|_| RelayUploadError::Internal)?,
                abort: upload_abort_pair().1,
            })
            .await;
        if let Err(error) = result {
            self.release_lease(context, session_id, target.lease)
                .await
                .map_err(|_| RelayUploadError::ReconciliationRequired)?;
            return Err(map_object_store(error));
        }
        self.finalize_single(context, session_id, target.lease)
            .await
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
        let target = match self
            .prepare_part(context, session_id, part_number, declared_bytes, &checksum)
            .await?
        {
            PreparePart::AlreadyUploaded => return Ok(()),
            PreparePart::Ready(target) => target,
        };
        let uploaded = self
            .store
            .upload_part_stream_once(
                StreamingMultipartPartRequest {
                    upload: target.upload,
                    part_number,
                    body: UploadBody::from_reader(reader, declared_bytes, checksum),
                    final_part: target.final_part,
                    deadlines: UploadDeadlines::for_multipart_part(
                        self.idle_timeout,
                        self.total_timeout,
                    )
                    .map_err(|_| RelayUploadError::Internal)?,
                    abort: upload_abort_pair().1,
                },
                &target.limits,
            )
            .await;
        let uploaded = match uploaded {
            Ok(uploaded) => uploaded,
            Err(error) => {
                self.release_lease(context, session_id, target.lease)
                    .await
                    .map_err(|_| RelayUploadError::ReconciliationRequired)?;
                return Err(map_object_store(error));
            }
        };
        self.finalize_part(
            context,
            session_id,
            target.lease,
            declared_bytes,
            uploaded.e_tag,
        )
        .await
    }

    async fn prepare_single(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        declared_bytes: u64,
        checksum: &Sha256Checksum,
    ) -> Result<RelaySingleTarget, RelayUploadError> {
        let deadline = Deadline::new(self.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database)?;
        let mut transaction = deadline.run(connection.begin()).await?.map_err(map_sql)?;
        configure(&mut transaction, deadline).await?;
        require_write(&mut transaction, context, deadline).await?;
        type SingleRow = (String, String, i64, Vec<u8>, bool, OffsetDateTime);
        let row: Option<SingleRow> = deadline
            .run(
                sqlx::query_as(
                    "SELECT state,staging_object_key,expected_physical_bytes,\
                     expected_bundle_sha256,expires_at<=transaction_timestamp(),expires_at \
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
        let Some((state, key, expected_bytes, expected_checksum, expired, expires_at)) = row else {
            return Err(RelayUploadError::NotFound);
        };
        validate_session_state(&state, expired, &["created", "uploading"])?;
        validate_expected_payload(expected_bytes, &expected_checksum, declared_bytes, checksum)?;
        ensure_lease_fits(expires_at, self.lease_duration)?;
        if state == "created" {
            update_single_to_uploading(&mut transaction, session_id, deadline).await?;
        }
        let lease = acquire_lease(
            &mut transaction,
            session_id,
            0,
            self.lease_duration,
            deadline,
        )
        .await?;
        ensure_relay_cleanup_guard(&mut transaction, session_id, deadline).await?;
        commit(transaction, deadline).await?;
        Ok(RelaySingleTarget {
            object_key: ObjectKey::parse(key).map_err(|_| RelayUploadError::Internal)?,
            lease,
        })
    }

    async fn prepare_part(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        part_number: u16,
        declared_bytes: u64,
        checksum: &Sha256Checksum,
    ) -> Result<PreparePart, RelayUploadError> {
        let deadline = Deadline::new(self.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database)?;
        let mut transaction = deadline.run(connection.begin()).await?.map_err(map_sql)?;
        configure(&mut transaction, deadline).await?;
        require_write(&mut transaction, context, deadline).await?;
        type PartRow = (
            String,
            String,
            Option<String>,
            bool,
            OffsetDateTime,
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
                     save.expires_at<=transaction_timestamp(),save.expires_at,lifecycle.create_status,\
                     lifecycle.complete_status,lifecycle.part_size_bytes,lifecycle.part_count,\
                     part.expected_bytes,part.expected_sha256,part.state \
                     FROM save_sessions save JOIN multipart_lifecycles lifecycle \
                       ON lifecycle.save_session_id=save.id \
                     JOIN multipart_parts part ON part.save_session_id=save.id \
                     WHERE save.id=$1::uuid AND save.project_id=$2::uuid \
                       AND save.storage_scope_id=$3::uuid AND save.actor_user_id=$4::uuid \
                       AND save.upload_mode='multipart' AND part.part_number=$5 \
                     FOR UPDATE OF save,lifecycle,part",
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
        if row.5 != "ready" || row.6 != "pending" {
            return Err(RelayUploadError::Conflict);
        }
        validate_expected_payload(row.9, &row.10, declared_bytes, checksum)?;
        if row.11 == "uploaded" {
            commit(transaction, deadline).await?;
            return Ok(PreparePart::AlreadyUploaded);
        }
        if row.11 != "pending" {
            return Err(RelayUploadError::Internal);
        }
        ensure_lease_fits(row.4, self.lease_duration)?;
        let part_count = u16::try_from(row.8).map_err(|_| RelayUploadError::Internal)?;
        if part_number == 0 || part_number > part_count {
            return Err(RelayUploadError::InvalidInput);
        }
        let lease = acquire_lease(
            &mut transaction,
            session_id,
            i16::try_from(part_number).map_err(|_| RelayUploadError::InvalidInput)?,
            self.lease_duration,
            deadline,
        )
        .await?;
        ensure_relay_cleanup_guard(&mut transaction, session_id, deadline).await?;
        let target = RelayPartTarget {
            upload: MultipartUpload {
                key: ObjectKey::parse(row.1).map_err(|_| RelayUploadError::Internal)?,
                upload_id: row.2.ok_or(RelayUploadError::Internal)?,
            },
            limits: MultipartLimits::new(
                usize::try_from(row.7).map_err(|_| RelayUploadError::Internal)?,
            )
            .map_err(|_| RelayUploadError::Internal)?,
            final_part: part_number == part_count,
            lease,
        };
        commit(transaction, deadline).await?;
        Ok(PreparePart::Ready(target))
    }

    async fn finalize_single(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        lease: RelayLease,
    ) -> Result<(), RelayUploadError> {
        self.finalize(context, session_id, lease, None).await
    }

    async fn finalize_part(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        lease: RelayLease,
        declared_bytes: u64,
        e_tag: String,
    ) -> Result<(), RelayUploadError> {
        self.finalize(context, session_id, lease, Some((declared_bytes, e_tag)))
            .await
    }

    async fn finalize(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        lease: RelayLease,
        part_receipt: Option<(u64, String)>,
    ) -> Result<(), RelayUploadError> {
        let deadline = Deadline::new(self.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database)?;
        let mut transaction = deadline.run(connection.begin()).await?.map_err(map_sql)?;
        configure(&mut transaction, deadline).await?;
        let authorization = read_write_authorization(&mut transaction, context, deadline).await?;
        let session = lock_session(&mut transaction, context, session_id, deadline).await?;
        require_matching_lease(&mut transaction, session_id, lease, deadline).await?;
        let expected_state = if part_receipt.is_some() {
            session.state == "uploading"
        } else {
            matches!(session.state.as_str(), "created" | "uploading")
        };
        if authorization != WriteAuthorization::Authorized || session.expired || !expected_state {
            release_lease_row(&mut transaction, session_id, lease, deadline).await?;
            let sibling_active = lock_active_sibling_leases(
                &mut transaction,
                session_id,
                lease.part_number,
                deadline,
            )
            .await?;
            let error = invalidated_session_error(&session, authorization);
            if sibling_active {
                commit(transaction, deadline).await?;
                return Err(error);
            }
            let error = fail_invalidated_session(
                &mut transaction,
                session_id,
                &session,
                authorization,
                deadline,
            )
            .await?;
            commit(transaction, deadline).await?;
            return Err(error);
        }
        if let Some((declared_bytes, e_tag)) = part_receipt {
            let affected = deadline
                .run(
                    sqlx::query(
                        "UPDATE multipart_parts SET state='uploaded',object_etag=$3,\
                         uploaded_at=transaction_timestamp(),updated_at=transaction_timestamp() \
                         WHERE save_session_id=$1::uuid AND part_number=$2 \
                           AND expected_bytes=$4 AND state='pending'",
                    )
                    .bind(session_id.to_string())
                    .bind(lease.part_number)
                    .bind(e_tag)
                    .bind(i64::try_from(declared_bytes).map_err(|_| RelayUploadError::Internal)?)
                    .execute(&mut *transaction),
                )
                .await?
                .map_err(map_sql)?
                .rows_affected();
            if affected != 1 {
                return Err(RelayUploadError::ReconciliationRequired);
            }
        }
        release_lease_row(&mut transaction, session_id, lease, deadline).await?;
        remove_resolved_relay_cleanup_guard(&mut transaction, session_id, deadline).await?;
        commit(transaction, deadline).await
    }

    async fn release_lease(
        &self,
        context: SaveProjectContext,
        session_id: SaveSessionId,
        lease: RelayLease,
    ) -> Result<(), RelayUploadError> {
        let deadline = Deadline::new(self.operation_timeout);
        let mut connection = deadline
            .run(self.pool.acquire())
            .await?
            .map_err(map_database)?;
        let mut transaction = deadline.run(connection.begin()).await?.map_err(map_sql)?;
        configure(&mut transaction, deadline).await?;
        let _ = read_write_authorization(&mut transaction, context, deadline).await?;
        let _ = lock_session(&mut transaction, context, session_id, deadline).await?;
        release_lease_row(&mut transaction, session_id, lease, deadline).await?;
        remove_resolved_relay_cleanup_guard(&mut transaction, session_id, deadline).await?;
        commit(transaction, deadline).await
    }
}

#[derive(Clone, Copy)]
struct RelayLease {
    token: Uuid,
    generation: i64,
    part_number: i16,
}

struct RelaySingleTarget {
    object_key: ObjectKey,
    lease: RelayLease,
}

enum PreparePart {
    AlreadyUploaded,
    Ready(RelayPartTarget),
}

struct RelayPartTarget {
    upload: MultipartUpload,
    limits: MultipartLimits,
    final_part: bool,
    lease: RelayLease,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteAuthorization {
    Authorized,
    Denied,
    ProjectUnavailable,
}

struct LockedSession {
    state: String,
    expired: bool,
}

async fn read_write_authorization(
    transaction: &mut Transaction<'_, Postgres>,
    context: SaveProjectContext,
    deadline: Deadline,
) -> Result<WriteAuthorization, RelayUploadError> {
    let scope = deadline
        .run(QuotaRepository::lock_storage_scope(
            transaction,
            context.storage_scope_id,
        ))
        .await?
        .map_err(map_sql)?;
    if !scope {
        return Ok(WriteAuthorization::Denied);
    }
    let role = match deadline
        .run(ProjectAccessRepository::resolve_effective_role_for_update(
            transaction,
            context.project_id,
            context.actor_user_id,
        ))
        .await?
    {
        Ok(role) => role,
        Err(
            ProjectAccessError::ProjectUnavailable
            | ProjectAccessError::ProjectNotOrganizationOwned
            | ProjectAccessError::MemberUnavailable,
        ) => return Ok(WriteAuthorization::Denied),
        Err(ProjectAccessError::OperationTimeout) => {
            return Err(RelayUploadError::OperationTimeout);
        }
        Err(ProjectAccessError::PersistenceUnavailable) => {
            return Err(RelayUploadError::Unavailable);
        }
        Err(ProjectAccessError::InvalidPersistedState | ProjectAccessError::AlreadyGranted) => {
            return Err(RelayUploadError::Internal);
        }
    };
    let project: Option<(String, String)> = deadline
        .run(
            sqlx::query_as("SELECT state,storage_scope_id::text FROM projects WHERE id=$1::uuid")
                .bind(context.project_id.to_string())
                .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?;
    let Some((state, scope_id)) = project else {
        return Ok(WriteAuthorization::Denied);
    };
    if scope_id != context.storage_scope_id.to_string() || role < EffectiveProjectRole::Write {
        Ok(WriteAuthorization::Denied)
    } else if state != "active" {
        Ok(WriteAuthorization::ProjectUnavailable)
    } else {
        Ok(WriteAuthorization::Authorized)
    }
}

async fn require_write(
    transaction: &mut Transaction<'_, Postgres>,
    context: SaveProjectContext,
    deadline: Deadline,
) -> Result<(), RelayUploadError> {
    match read_write_authorization(transaction, context, deadline).await? {
        WriteAuthorization::Authorized => Ok(()),
        WriteAuthorization::Denied => Err(RelayUploadError::NotFound),
        WriteAuthorization::ProjectUnavailable => Err(RelayUploadError::Conflict),
    }
}

async fn lock_session(
    transaction: &mut Transaction<'_, Postgres>,
    context: SaveProjectContext,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<LockedSession, RelayUploadError> {
    let row: Option<(String, bool)> = deadline
        .run(
            sqlx::query_as(
                "SELECT state,expires_at<=transaction_timestamp() FROM save_sessions \
                 WHERE id=$1::uuid AND project_id=$2::uuid AND storage_scope_id=$3::uuid \
                   AND actor_user_id=$4::uuid FOR UPDATE",
            )
            .bind(session_id.to_string())
            .bind(context.project_id.to_string())
            .bind(context.storage_scope_id.to_string())
            .bind(context.actor_user_id.to_string())
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?;
    row.map(|(state, expired)| LockedSession { state, expired })
        .ok_or(RelayUploadError::NotFound)
}

async fn acquire_lease(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    part_number: i16,
    duration: Duration,
    deadline: Deadline,
) -> Result<RelayLease, RelayUploadError> {
    let token = Uuid::now_v7();
    let seconds = i64::try_from(duration.as_secs()).map_err(|_| RelayUploadError::Internal)?;
    let generation: Option<i64> = deadline
        .run(
            sqlx::query_scalar(
                "INSERT INTO save_upload_leases \
                 (save_session_id,part_number,generation,lease_token,lease_expires_at) \
                 VALUES ($1::uuid,$2,1,$3::uuid,clock_timestamp()+make_interval(secs=>$4)) \
                 ON CONFLICT (save_session_id,part_number) DO UPDATE SET \
                   generation=save_upload_leases.generation+1,lease_token=EXCLUDED.lease_token,\
                   lease_expires_at=EXCLUDED.lease_expires_at,released_at=NULL \
                 WHERE save_upload_leases.released_at IS NOT NULL \
                    OR save_upload_leases.lease_expires_at<=clock_timestamp() \
                 RETURNING generation",
            )
            .bind(session_id.to_string())
            .bind(part_number)
            .bind(token.to_string())
            .bind(seconds)
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?;
    generation
        .map(|generation| RelayLease {
            token,
            generation,
            part_number,
        })
        .ok_or(RelayUploadError::Conflict)
}

async fn require_matching_lease(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    lease: RelayLease,
    deadline: Deadline,
) -> Result<(), RelayUploadError> {
    let row: Option<(i64, String)> = deadline
        .run(
            sqlx::query_as(
                "SELECT generation,lease_token::text FROM save_upload_leases \
                 WHERE save_session_id=$1::uuid AND part_number=$2 \
                   AND released_at IS NULL AND lease_expires_at>clock_timestamp() FOR UPDATE",
            )
            .bind(session_id.to_string())
            .bind(lease.part_number)
            .fetch_optional(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?;
    if row.as_ref().is_some_and(|(generation, token)| {
        *generation == lease.generation && token == &lease.token.to_string()
    }) {
        Ok(())
    } else {
        Err(RelayUploadError::Conflict)
    }
}

async fn ensure_relay_cleanup_guard(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<(), RelayUploadError> {
    let affected = deadline
        .run(
            sqlx::query(
                "INSERT INTO save_cleanup_jobs \
                 (save_session_id,cleanup_kind,object_key,multipart_upload_id,eligible_at) \
                 SELECT id,CASE WHEN upload_mode='single' THEN 'object_delete' \
                                ELSE 'multipart_abort' END,staging_object_key,\
                        CASE WHEN upload_mode='single' THEN NULL ELSE multipart_upload_id END,\
                        expires_at \
                 FROM save_sessions WHERE id=$1::uuid \
                 ON CONFLICT (save_session_id) DO NOTHING",
            )
            .bind(session_id.to_string())
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?
        .rows_affected();
    if affected <= 1 {
        Ok(())
    } else {
        Err(RelayUploadError::Internal)
    }
}

async fn remove_resolved_relay_cleanup_guard(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<(), RelayUploadError> {
    deadline
        .run(
            sqlx::query(
                "DELETE FROM save_cleanup_jobs job USING save_sessions session \
                 WHERE job.save_session_id=$1::uuid AND session.id=job.save_session_id \
                   AND job.status='queued' AND session.state IN ('created','uploading') \
                   AND ((session.upload_mode='single' AND job.cleanup_kind='object_delete') \
                     OR (session.upload_mode='multipart' AND job.cleanup_kind='multipart_abort')) \
                   AND NOT EXISTS (SELECT 1 FROM save_upload_leases lease \
                                   WHERE lease.save_session_id=session.id \
                                     AND lease.released_at IS NULL)",
            )
            .bind(session_id.to_string())
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?;
    Ok(())
}

async fn release_lease_row(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    lease: RelayLease,
    deadline: Deadline,
) -> Result<(), RelayUploadError> {
    let affected = deadline
        .run(
            sqlx::query(
                "UPDATE save_upload_leases SET released_at=transaction_timestamp(),\
                 updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid \
                 AND part_number=$2 AND generation=$3 AND lease_token=$4::uuid \
                 AND released_at IS NULL",
            )
            .bind(session_id.to_string())
            .bind(lease.part_number)
            .bind(lease.generation)
            .bind(lease.token.to_string())
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?
        .rows_affected();
    if affected == 1 {
        Ok(())
    } else {
        Err(RelayUploadError::Conflict)
    }
}

async fn lock_active_sibling_leases(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    released_part_number: i16,
    deadline: Deadline,
) -> Result<bool, RelayUploadError> {
    let siblings: Vec<i16> = deadline
        .run(
            sqlx::query_scalar(
                "SELECT part_number FROM save_upload_leases \
                 WHERE save_session_id=$1::uuid AND part_number<>$2 \
                   AND released_at IS NULL AND lease_expires_at>clock_timestamp() \
                 ORDER BY part_number FOR UPDATE",
            )
            .bind(session_id.to_string())
            .bind(released_part_number)
            .fetch_all(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?;
    Ok(!siblings.is_empty())
}

fn invalidated_session_error(
    session: &LockedSession,
    authorization: WriteAuthorization,
) -> RelayUploadError {
    if session.expired {
        RelayUploadError::SessionExpired
    } else if authorization == WriteAuthorization::Denied {
        RelayUploadError::NotFound
    } else {
        RelayUploadError::Conflict
    }
}

async fn fail_invalidated_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    session: &LockedSession,
    authorization: WriteAuthorization,
    deadline: Deadline,
) -> Result<RelayUploadError, RelayUploadError> {
    if matches!(
        session.state.as_str(),
        "created" | "uploading" | "verifying"
    ) {
        let terminal = if session.expired { "expired" } else { "failed" };
        let affected = deadline
            .run(
                sqlx::query(
                    "UPDATE save_sessions SET state=$2,terminal_at=transaction_timestamp(),\
                     updated_at=transaction_timestamp() WHERE id=$1::uuid \
                     AND state IN ('created','uploading','verifying')",
                )
                .bind(session_id.to_string())
                .bind(terminal)
                .execute(&mut **transaction),
            )
            .await?
            .map_err(map_sql)?
            .rows_affected();
        if affected != 1 {
            return Err(RelayUploadError::ReconciliationRequired);
        }
    }
    Ok(invalidated_session_error(session, authorization))
}

async fn update_single_to_uploading(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: SaveSessionId,
    deadline: Deadline,
) -> Result<(), RelayUploadError> {
    let affected = deadline
        .run(
            sqlx::query(
                "UPDATE save_sessions SET state='uploading',updated_at=transaction_timestamp() \
                 WHERE id=$1::uuid AND state='created' AND upload_mode='single'",
            )
            .bind(session_id.to_string())
            .execute(&mut **transaction),
        )
        .await?
        .map_err(map_sql)?
        .rows_affected();
    if affected == 1 {
        Ok(())
    } else {
        Err(RelayUploadError::Conflict)
    }
}

fn validate_expected_payload(
    expected_bytes: i64,
    expected_checksum: &[u8],
    declared_bytes: u64,
    checksum: &Sha256Checksum,
) -> Result<(), RelayUploadError> {
    if u64::try_from(expected_bytes).ok() == Some(declared_bytes)
        && expected_checksum == checksum.as_bytes()
    {
        Ok(())
    } else {
        Err(RelayUploadError::InvalidInput)
    }
}

fn ensure_lease_fits(
    expires_at: OffsetDateTime,
    lease_duration: Duration,
) -> Result<(), RelayUploadError> {
    if expires_at > OffsetDateTime::now_utc() + lease_duration {
        Ok(())
    } else {
        Err(RelayUploadError::SessionExpired)
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
    match error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
    {
        Some("57014" | "55P03") => RelayUploadError::OperationTimeout,
        Some("23503" | "23505" | "23514") => RelayUploadError::Conflict,
        _ => RelayUploadError::Unavailable,
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
