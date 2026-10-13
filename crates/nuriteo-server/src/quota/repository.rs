use sqlx::{Postgres, Transaction};

use crate::project::ProjectId;
use crate::workspace::StorageScopeId;

/// Transaction-bound persistence primitives shared by SAVE services.
///
/// Every quota-affecting SAVE transaction must acquire the storage scope before
/// its Project and Save rows. SAVE-006 Working Head/reference mutations consume
/// this repository boundary before changing live references.
pub(crate) struct QuotaRepository;

impl QuotaRepository {
    pub(crate) async fn lock_storage_scope(
        transaction: &mut Transaction<'_, Postgres>,
        storage_scope_id: StorageScopeId,
    ) -> Result<bool, sqlx::Error> {
        let found: Option<String> = sqlx::query_scalar(
            "SELECT id::text FROM storage_scopes WHERE id = $1::uuid FOR UPDATE",
        )
        .bind(storage_scope_id.to_string())
        .fetch_optional(&mut **transaction)
        .await?;
        Ok(found.is_some())
    }

    pub(crate) async fn lock_project_scope(
        transaction: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT storage_scope_id::text FROM projects WHERE id = $1::uuid FOR UPDATE",
        )
        .bind(project_id.to_string())
        .fetch_optional(&mut **transaction)
        .await
    }
}
