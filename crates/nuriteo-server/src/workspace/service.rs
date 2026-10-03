use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use sqlx::Row;
use tokio::time;

use crate::database::DatabasePool;
use crate::identity::UserId;
use crate::organization::OrganizationId;

use super::{OrganizationWorkspace, PersonalWorkspace, StorageScopeId, Workspace};

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

    pub(crate) async fn list_for_user(
        &self,
        user_id: UserId,
    ) -> Result<Vec<Workspace>, WorkspaceQueryError> {
        time::timeout(self.operation_deadline, self.load_for_user(user_id))
            .await
            .map_err(|_| WorkspaceQueryError::OperationTimeout)?
    }

    async fn load_for_user(&self, user_id: UserId) -> Result<Vec<Workspace>, WorkspaceQueryError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| WorkspaceQueryError::PersistenceUnavailable)?;
        let rows = sqlx::query(
            "SELECT 'user' AS owner_type, u.id::text AS owner_id, \
                    u.display_name AS display_label, u.status AS owner_status, \
                    NULL::text AS membership_role, s.id::text AS storage_scope_id, \
                    0 AS owner_rank, '' AS sort_key \
             FROM users u \
             LEFT JOIN storage_scopes s ON s.owner_user_id = u.id \
             WHERE u.id = $1::uuid \
             UNION ALL \
             SELECT 'organization', o.id::text, o.display_name, o.status, m.role, \
                    s.id::text, 1, o.slug \
             FROM organization_memberships m \
             LEFT JOIN organizations o ON o.id = m.organization_id \
             LEFT JOIN storage_scopes s ON s.owner_organization_id = o.id \
             WHERE m.user_id = $1::uuid \
             ORDER BY owner_rank, sort_key, owner_id, storage_scope_id",
        )
        .bind(user_id.to_string())
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| WorkspaceQueryError::PersistenceUnavailable)?;

        let mut rows = rows.into_iter();
        let personal = rows.next().ok_or(WorkspaceQueryError::UserUnavailable)?;
        let owner_type: String = read(&personal, "owner_type")?;
        let status: String = read(&personal, "owner_status")?;
        if owner_type != "user" || status != "active" {
            return Err(WorkspaceQueryError::UserUnavailable);
        }
        let personal_owner = parse_user(read(&personal, "owner_id")?)?;
        if personal_owner != user_id {
            return Err(WorkspaceQueryError::InvalidPersistedState);
        }
        let personal_scope = parse_scope(read_optional(&personal, "storage_scope_id")?)?;
        let personal_label = read(&personal, "display_label")?;
        let mut workspaces = vec![Workspace::Personal(
            PersonalWorkspace::new(personal_owner, personal_label, personal_scope)
                .map_err(|_| WorkspaceQueryError::InvalidPersistedState)?,
        )];

        let mut previous_organization = None;
        for row in rows {
            let owner_type: String = read(&row, "owner_type")?;
            if owner_type != "organization" {
                return Err(WorkspaceQueryError::InvalidPersistedState);
            }
            let organization_id = parse_organization(read(&row, "owner_id")?)?;
            if previous_organization == Some(organization_id) {
                return Err(WorkspaceQueryError::InvalidPersistedState);
            }
            previous_organization = Some(organization_id);
            let role: Option<String> = read_optional(&row, "membership_role")?;
            if !matches!(role.as_deref(), Some("owner" | "member")) {
                return Err(WorkspaceQueryError::InvalidPersistedState);
            }
            let scope_id = parse_scope(read_optional(&row, "storage_scope_id")?)?;
            let status: String = read(&row, "owner_status")?;
            match status.as_str() {
                "active" => {
                    let label = read(&row, "display_label")?;
                    workspaces.push(Workspace::Organization(
                        OrganizationWorkspace::new(organization_id, label, scope_id)
                            .map_err(|_| WorkspaceQueryError::InvalidPersistedState)?,
                    ));
                }
                "archived" => {}
                _ => return Err(WorkspaceQueryError::InvalidPersistedState),
            }
        }
        Ok(workspaces)
    }
}

fn read<T>(row: &sqlx::postgres::PgRow, column: &str) -> Result<T, WorkspaceQueryError>
where
    for<'r> T: sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get(column)
        .map_err(|_| WorkspaceQueryError::InvalidPersistedState)
}

fn read_optional<T>(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<T>, WorkspaceQueryError>
where
    for<'r> T: sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get(column)
        .map_err(|_| WorkspaceQueryError::InvalidPersistedState)
}

fn parse_user(value: String) -> Result<UserId, WorkspaceQueryError> {
    UserId::from_str(&value).map_err(|_| WorkspaceQueryError::InvalidPersistedState)
}

fn parse_organization(value: String) -> Result<OrganizationId, WorkspaceQueryError> {
    OrganizationId::from_str(&value).map_err(|_| WorkspaceQueryError::InvalidPersistedState)
}

fn parse_scope(value: Option<String>) -> Result<StorageScopeId, WorkspaceQueryError> {
    value
        .ok_or(WorkspaceQueryError::InvalidPersistedState)?
        .parse()
        .map_err(|_| WorkspaceQueryError::InvalidPersistedState)
}
