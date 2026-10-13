//! Canonical Bundle-backed Git Working Head persistence.

use sqlx::{PgConnection, Row};
use std::str::FromStr;
use uuid::Uuid;

use crate::database::DatabasePool;
use crate::object_storage::S3ObjectStore;
use crate::quota::EffectiveQuota;
use crate::save::{CanonicalBundleMaterializer, MaterializationError, PersistedCanonicalBundle};
use crate::workspace::StorageScopeId;

use super::embedded::GitTreeSnapshot;
use super::{
    GitExecutorError, GitWorkingHeadFuture, GitWorkingHeadPreparation, GitWorkingHeadPrepare,
    GitWorkingHeadStore,
};

const MAX_RECOVERY_CHECKPOINTS: usize = 3;

#[derive(Clone)]
pub struct S3GitWorkingHeadStore {
    materializer: CanonicalBundleMaterializer,
    effective_quota: EffectiveQuota,
}

struct PreparedS3WorkingHead {
    project_id: crate::project::ProjectId,
    storage_scope_id: StorageScopeId,
    actor_user_id: crate::identity::UserId,
    remote_head_sha: String,
    persisted: PersistedCanonicalBundle,
}

impl std::fmt::Debug for S3GitWorkingHeadStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("S3GitWorkingHeadStore")
            .field("materializer", &self.materializer)
            .field("effective_quota", &self.effective_quota)
            .finish()
    }
}

impl S3GitWorkingHeadStore {
    #[must_use]
    pub fn new(pool: DatabasePool, store: S3ObjectStore, effective_quota: EffectiveQuota) -> Self {
        Self {
            materializer: CanonicalBundleMaterializer::new(pool, store),
            effective_quota,
        }
    }
}

impl GitWorkingHeadStore for S3GitWorkingHeadStore {
    fn prepare<'a>(
        &'a self,
        input: GitWorkingHeadPrepare<'a>,
    ) -> GitWorkingHeadFuture<'a, GitWorkingHeadPreparation> {
        Box::pin(async move { self.prepare_inner(input).await })
    }

    fn finalize<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        prepared: GitWorkingHeadPreparation,
    ) -> GitWorkingHeadFuture<'a, ()> {
        Box::pin(async move { self.finalize_inner(connection, prepared).await })
    }

    fn load<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        project_id: crate::project::ProjectId,
        _actor_user_id: crate::identity::UserId,
    ) -> GitWorkingHeadFuture<'a, GitTreeSnapshot> {
        Box::pin(async move { self.load_inner(connection, project_id).await })
    }
}

impl S3GitWorkingHeadStore {
    async fn prepare_inner(
        &self,
        input: GitWorkingHeadPrepare<'_>,
    ) -> Result<GitWorkingHeadPreparation, GitExecutorError> {
        let prepared = self
            .materializer
            .prepare(input.project_id, input.storage_scope_id, input.tree)
            .await
            .map_err(map_materialization_error)?;
        let persisted = self
            .materializer
            .persist(prepared)
            .await
            .map_err(map_materialization_error)?;
        Ok(GitWorkingHeadPreparation::new(PreparedS3WorkingHead {
            project_id: input.project_id,
            storage_scope_id: input.storage_scope_id,
            actor_user_id: input.actor_user_id,
            remote_head_sha: input.remote_head_sha.to_owned(),
            persisted,
        }))
    }

    async fn finalize_inner(
        &self,
        connection: &mut PgConnection,
        prepared: GitWorkingHeadPreparation,
    ) -> Result<(), GitExecutorError> {
        let input = prepared.into_inner::<PreparedS3WorkingHead>()?;
        let project: (String, Option<String>) = sqlx::query_as(
            "SELECT storage_scope_id::text,working_head_bundle_id::text FROM projects \
             WHERE id=$1::uuid AND state='active' FOR UPDATE",
        )
        .bind(input.project_id.to_string())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| GitExecutorError::Unavailable)?
        .ok_or(GitExecutorError::Unavailable)?;
        let storage_scope_id =
            StorageScopeId::from_str(&project.0).map_err(|_| GitExecutorError::Unavailable)?;
        if storage_scope_id != input.storage_scope_id {
            return Err(GitExecutorError::Unavailable);
        }
        let bundle = self
            .materializer
            .ensure_verified_bundle(connection, &input.persisted)
            .await
            .map_err(map_materialization_error)?;

        lock_scope_and_enforce_quota(
            connection,
            storage_scope_id,
            input.project_id,
            &bundle.id,
            self.effective_quota,
        )
        .await?;

        let materialization_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO git_working_head_materializations \
             (id,project_id,storage_scope_id,bundle_id,canonical_materialization_id,\
              actor_user_id,remote_head_sha) \
             VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7)",
        )
        .bind(materialization_id.to_string())
        .bind(input.project_id.to_string())
        .bind(storage_scope_id.to_string())
        .bind(&bundle.id)
        .bind(input.persisted.ledger_id().to_string())
        .bind(input.actor_user_id.to_string())
        .bind(input.remote_head_sha)
        .execute(&mut *connection)
        .await
        .map_err(|_| GitExecutorError::Unavailable)?;
        sqlx::query(
            "INSERT INTO project_bundle_admissions \
             (project_id,storage_scope_id,bundle_id,source_git_materialization_id,created_at) \
             VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,transaction_timestamp()) \
             ON CONFLICT (project_id,bundle_id) DO NOTHING",
        )
        .bind(input.project_id.to_string())
        .bind(storage_scope_id.to_string())
        .bind(&bundle.id)
        .bind(materialization_id.to_string())
        .execute(&mut *connection)
        .await
        .map_err(|_| GitExecutorError::Unavailable)?;
        if project
            .1
            .as_deref()
            .is_some_and(|current| current != bundle.id)
        {
            rotate_recovery_checkpoints(
                connection,
                input.project_id,
                storage_scope_id,
                input.actor_user_id,
                project.1.as_deref().ok_or(GitExecutorError::Unavailable)?,
            )
            .await?;
        }
        let affected = sqlx::query(
            "UPDATE projects SET working_head_bundle_id=$2::uuid,\
             lock_version=lock_version+1,updated_at=transaction_timestamp() \
             WHERE id=$1::uuid AND state='active'",
        )
        .bind(input.project_id.to_string())
        .bind(&bundle.id)
        .execute(&mut *connection)
        .await
        .map_err(|_| GitExecutorError::Unavailable)?
        .rows_affected();
        if affected != 1 {
            return Err(GitExecutorError::Unavailable);
        }
        self.materializer
            .finalize_ledger(connection, &input.persisted)
            .await
            .map_err(map_materialization_error)?;
        Ok(())
    }

    async fn load_inner(
        &self,
        connection: &mut PgConnection,
        project_id: crate::project::ProjectId,
    ) -> Result<GitTreeSnapshot, GitExecutorError> {
        let row = sqlx::query(
            "SELECT project.storage_scope_id::text,bundle.object_key,bundle.sha256,\
                    bundle.physical_bytes \
             FROM projects project JOIN bundles bundle \
               ON bundle.id=project.working_head_bundle_id \
             JOIN project_bundle_admissions admission \
               ON admission.project_id=project.id \
              AND admission.storage_scope_id=project.storage_scope_id \
              AND admission.bundle_id=bundle.id \
             WHERE project.id=$1::uuid AND project.state='active'",
        )
        .bind(project_id.to_string())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| GitExecutorError::Unavailable)?
        .ok_or(GitExecutorError::Unavailable)?;
        let scope: String = row.try_get(0).map_err(|_| GitExecutorError::Unavailable)?;
        let object_key: String = row.try_get(1).map_err(|_| GitExecutorError::Unavailable)?;
        let expected_sha: Vec<u8> = row.try_get(2).map_err(|_| GitExecutorError::Unavailable)?;
        let expected_size: i64 = row.try_get(3).map_err(|_| GitExecutorError::Unavailable)?;
        let storage_scope_id =
            StorageScopeId::from_str(&scope).map_err(|_| GitExecutorError::Unavailable)?;
        let expected_size =
            u64::try_from(expected_size).map_err(|_| GitExecutorError::Unavailable)?;
        self.materializer
            .load_verified_snapshot(
                project_id,
                storage_scope_id,
                &object_key,
                expected_size,
                &expected_sha,
            )
            .await
            .map_err(map_materialization_error)
    }
}

async fn rotate_recovery_checkpoints(
    connection: &mut PgConnection,
    project_id: crate::project::ProjectId,
    scope_id: StorageScopeId,
    actor_user_id: crate::identity::UserId,
    previous_bundle_id: &str,
) -> Result<(), GitExecutorError> {
    let rows: Vec<(String, i16)> = sqlx::query_as(
        "SELECT id::text,recovery_position FROM project_bundle_refs \
         WHERE project_id=$1::uuid AND kind='recovery' ORDER BY created_at,id FOR UPDATE",
    )
    .bind(project_id.to_string())
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| GitExecutorError::Unavailable)?;
    if rows.len() > MAX_RECOVERY_CHECKPOINTS {
        return Err(GitExecutorError::Unavailable);
    }
    let mut occupied = [false; MAX_RECOVERY_CHECKPOINTS];
    for (_, position) in &rows {
        let index = position
            .checked_sub(1)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value < occupied.len())
            .ok_or(GitExecutorError::Unavailable)?;
        if occupied[index] {
            return Err(GitExecutorError::Unavailable);
        }
        occupied[index] = true;
    }
    let position = if rows.len() == MAX_RECOVERY_CHECKPOINTS {
        let (id, position) = rows.first().ok_or(GitExecutorError::Unavailable)?;
        let affected = sqlx::query(
            "DELETE FROM project_bundle_refs WHERE id=$1::uuid \
             AND project_id=$2::uuid AND kind='recovery'",
        )
        .bind(id)
        .bind(project_id.to_string())
        .execute(&mut *connection)
        .await
        .map_err(|_| GitExecutorError::Unavailable)?
        .rows_affected();
        if affected != 1 {
            return Err(GitExecutorError::Unavailable);
        }
        *position
    } else {
        occupied
            .iter()
            .position(|value| !value)
            .and_then(|value| i16::try_from(value + 1).ok())
            .ok_or(GitExecutorError::Unavailable)?
    };
    sqlx::query(
        "INSERT INTO project_bundle_refs \
         (id,project_id,storage_scope_id,bundle_id,kind,recovery_position,actor_user_id) \
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'recovery',$5,$6::uuid)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(project_id.to_string())
    .bind(scope_id.to_string())
    .bind(previous_bundle_id)
    .bind(position)
    .bind(actor_user_id.to_string())
    .execute(&mut *connection)
    .await
    .map_err(|_| GitExecutorError::Unavailable)?;
    Ok(())
}

async fn lock_scope_and_enforce_quota(
    connection: &mut PgConnection,
    scope_id: StorageScopeId,
    project_id: crate::project::ProjectId,
    incoming_bundle_id: &str,
    quota: EffectiveQuota,
) -> Result<(), GitExecutorError> {
    let found: Option<String> =
        sqlx::query_scalar("SELECT id::text FROM storage_scopes WHERE id=$1::uuid FOR UPDATE")
            .bind(scope_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| GitExecutorError::Unavailable)?;
    if found.is_none() {
        return Err(GitExecutorError::Unavailable);
    }
    let (used, reserved): (String, String) = sqlx::query_as(
        "WITH live_bundles AS ( \
           SELECT project.working_head_bundle_id AS bundle_id FROM projects project \
           WHERE project.storage_scope_id=$1::uuid AND project.id<>$2::uuid \
             AND project.working_head_bundle_id IS NOT NULL \
           UNION SELECT reference.bundle_id FROM project_bundle_refs reference \
           WHERE reference.storage_scope_id=$1::uuid \
           UNION SELECT $3::uuid \
         ), used AS ( \
           SELECT COALESCE(SUM(bundle.physical_bytes),0)::text AS bytes \
           FROM live_bundles live JOIN bundles bundle ON bundle.id=live.bundle_id \
         ), reserved AS ( \
           SELECT COALESCE(SUM(reservation.reserved_bytes),0)::text AS bytes \
           FROM storage_reservations reservation JOIN save_sessions session \
             ON session.id=reservation.save_session_id \
           WHERE reservation.storage_scope_id=$1::uuid \
             AND reservation.expires_at>transaction_timestamp() \
             AND session.state IN ('created','uploading','verifying') \
         ) SELECT used.bytes,reserved.bytes FROM used CROSS JOIN reserved",
    )
    .bind(scope_id.to_string())
    .bind(project_id.to_string())
    .bind(incoming_bundle_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| GitExecutorError::Unavailable)?;
    let used = used
        .parse::<u64>()
        .map_err(|_| GitExecutorError::Unavailable)?;
    let reserved = reserved
        .parse::<u64>()
        .map_err(|_| GitExecutorError::Unavailable)?;
    let projected = used
        .checked_add(reserved)
        .ok_or(GitExecutorError::TransferLimitExceeded)?;
    if quota.limit_bytes().is_some_and(|limit| projected > limit) {
        return Err(GitExecutorError::TransferLimitExceeded);
    }
    Ok(())
}

const fn map_materialization_error(error: MaterializationError) -> GitExecutorError {
    match error {
        MaterializationError::InvalidBundle => GitExecutorError::InvalidRemote,
        MaterializationError::Storage
        | MaterializationError::Database
        | MaterializationError::GcFenced => GitExecutorError::Unavailable,
    }
}
