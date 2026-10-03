use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use sqlx::Row;
use tokio::time;

use crate::database::DatabasePool;
use crate::identity::UserId;

use super::{PersonalWorkspace, StorageScopeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceQueryError {
    UserUnavailable,
    PersistenceUnavailable,
    InvalidPersistedState,
    OperationTimeout,
}

impl fmt::Display for WorkspaceQueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UserUnavailable => "workspace user is unavailable",
            Self::PersistenceUnavailable => "workspace persistence is unavailable",
            Self::InvalidPersistedState => "workspace persistence state is invalid",
            Self::OperationTimeout => "workspace query timed out",
        })
    }
}

impl std::error::Error for WorkspaceQueryError {}

#[derive(Clone)]
pub(crate) struct WorkspaceQueryService {
    pool: DatabasePool,
    operation_deadline: Duration,
}

impl WorkspaceQueryService {
    #[must_use]
    pub(crate) const fn new(pool: DatabasePool, operation_deadline: Duration) -> Self {
        Self {
            pool,
            operation_deadline,
        }
    }

    pub(crate) async fn list_personal(
        &self,
        user_id: UserId,
    ) -> Result<Vec<PersonalWorkspace>, WorkspaceQueryError> {
        time::timeout(self.operation_deadline, self.load_personal(user_id))
            .await
            .map_err(|_| WorkspaceQueryError::OperationTimeout)?
    }

    async fn load_personal(
        &self,
        user_id: UserId,
    ) -> Result<Vec<PersonalWorkspace>, WorkspaceQueryError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| WorkspaceQueryError::PersistenceUnavailable)?;
        let rows = sqlx::query(
            "SELECT u.id::text AS owner_id, u.display_name, u.status, \
                    s.id::text AS storage_scope_id \
             FROM users u \
             LEFT JOIN storage_scopes s ON s.owner_user_id = u.id \
             WHERE u.id = $1::uuid \
             ORDER BY s.id ASC",
        )
        .bind(user_id.to_string())
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| WorkspaceQueryError::PersistenceUnavailable)?;

        let [row] = rows.as_slice() else {
            return if rows.is_empty() {
                Err(WorkspaceQueryError::UserUnavailable)
            } else {
                Err(WorkspaceQueryError::InvalidPersistedState)
            };
        };
        let status: String = row
            .try_get("status")
            .map_err(|_| WorkspaceQueryError::InvalidPersistedState)?;
        if status != "active" {
            return Err(WorkspaceQueryError::UserUnavailable);
        }
        let owner_id: String = row
            .try_get("owner_id")
            .map_err(|_| WorkspaceQueryError::InvalidPersistedState)?;
        let owner_id =
            UserId::from_str(&owner_id).map_err(|_| WorkspaceQueryError::InvalidPersistedState)?;
        if owner_id != user_id {
            return Err(WorkspaceQueryError::InvalidPersistedState);
        }
        let scope_id: Option<String> = row
            .try_get("storage_scope_id")
            .map_err(|_| WorkspaceQueryError::InvalidPersistedState)?;
        let scope_id = scope_id
            .ok_or(WorkspaceQueryError::InvalidPersistedState)?
            .parse::<StorageScopeId>()
            .map_err(|_| WorkspaceQueryError::InvalidPersistedState)?;
        let display_label = row
            .try_get("display_name")
            .map_err(|_| WorkspaceQueryError::InvalidPersistedState)?;
        let workspace = PersonalWorkspace::new(owner_id, display_label, scope_id)
            .map_err(|_| WorkspaceQueryError::InvalidPersistedState)?;
        Ok(vec![workspace])
    }
}
