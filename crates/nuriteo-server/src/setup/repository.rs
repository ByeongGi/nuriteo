use sqlx::Row;

use crate::database::DatabasePool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStatusRepositoryError {
    Unavailable,
    InvalidPersistedState,
}

impl std::fmt::Display for SetupStatusRepositoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "setup status persistence is unavailable",
            Self::InvalidPersistedState => "setup status persistence state is invalid",
        })
    }
}

impl std::error::Error for SetupStatusRepositoryError {}

#[derive(Clone)]
pub(super) struct SetupStatusRepository {
    pool: DatabasePool,
}

impl SetupStatusRepository {
    pub(super) const fn new(pool: DatabasePool) -> Self {
        Self { pool }
    }

    pub(super) async fn active_instance_administrator_exists(
        &self,
    ) -> Result<bool, SetupStatusRepositoryError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| SetupStatusRepositoryError::Unavailable)?;
        let row = sqlx::query(
            "SELECT EXISTS (\
                 SELECT 1 FROM users \
                 WHERE status = 'active' AND is_instance_admin\
             ) AS active_instance_administrator_exists",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| SetupStatusRepositoryError::Unavailable)?;
        row.try_get("active_instance_administrator_exists")
            .map_err(|_| SetupStatusRepositoryError::InvalidPersistedState)
    }
}
