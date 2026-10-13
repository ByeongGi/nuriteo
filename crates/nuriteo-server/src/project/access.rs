use std::fmt;

use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::identity::{Timestamp, UserId};
use crate::organization::OrganizationId;
use crate::team::TeamId;

use super::{ProjectId, ProjectOwner};

const MAX_ROLE_VERSION: i64 = i64::MAX - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRole {
    Read,
    Write,
    Admin,
}

impl ProjectRole {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Admin => "admin",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, ProjectAccessError> {
        match value {
            "read" => Ok(Self::Read),
            "write" => Ok(Self::Write),
            "admin" => Ok(Self::Admin),
            _ => Err(ProjectAccessError::InvalidPersistedState),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectiveProjectRole {
    None,
    Read,
    Write,
    Admin,
}

impl From<ProjectRole> for EffectiveProjectRole {
    fn from(value: ProjectRole) -> Self {
        match value {
            ProjectRole::Read => Self::Read,
            ProjectRole::Write => Self::Write,
            ProjectRole::Admin => Self::Admin,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProjectRoleVersion(i64);

impl ProjectRoleVersion {
    pub fn new(value: i64) -> Result<Self, ProjectAccessError> {
        if !(1..=MAX_ROLE_VERSION).contains(&value) {
            return Err(ProjectAccessError::InvalidPersistedState);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectProjectRoleGrant {
    project_id: ProjectId,
    organization_id: OrganizationId,
    user_id: UserId,
    role: ProjectRole,
    created_at: Timestamp,
    updated_at: Timestamp,
    lock_version: ProjectRoleVersion,
}

impl DirectProjectRoleGrant {
    #[allow(
        clippy::too_many_arguments,
        reason = "persistence reconstruction validates one complete role row"
    )]
    pub fn reconstruct(
        project_id: ProjectId,
        organization_id: OrganizationId,
        user_id: UserId,
        role: ProjectRole,
        created_at: Timestamp,
        updated_at: Timestamp,
        lock_version: ProjectRoleVersion,
    ) -> Result<Self, ProjectAccessError> {
        if updated_at < created_at {
            return Err(ProjectAccessError::InvalidPersistedState);
        }
        Ok(Self {
            project_id,
            organization_id,
            user_id,
            role,
            created_at,
            updated_at,
            lock_version,
        })
    }

    #[must_use]
    pub const fn project_id(&self) -> ProjectId {
        self.project_id
    }

    #[must_use]
    pub const fn organization_id(&self) -> OrganizationId {
        self.organization_id
    }

    #[must_use]
    pub const fn user_id(&self) -> UserId {
        self.user_id
    }

    #[must_use]
    pub const fn role(&self) -> ProjectRole {
        self.role
    }

    #[must_use]
    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    #[must_use]
    pub const fn updated_at(&self) -> Timestamp {
        self.updated_at
    }

    #[must_use]
    pub const fn lock_version(&self) -> ProjectRoleVersion {
        self.lock_version
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectAccessError {
    ProjectUnavailable,
    ProjectNotOrganizationOwned,
    MemberUnavailable,
    AlreadyGranted,
    InvalidPersistedState,
    OperationTimeout,
    PersistenceUnavailable,
}

impl fmt::Display for ProjectAccessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ProjectUnavailable => "project is unavailable",
            Self::ProjectNotOrganizationOwned => "project does not accept direct user roles",
            Self::MemberUnavailable => "project role member is unavailable",
            Self::AlreadyGranted => "project role already exists",
            Self::InvalidPersistedState => "persisted project role state is invalid",
            Self::OperationTimeout => "project role persistence operation timed out",
            Self::PersistenceUnavailable => "project role persistence is unavailable",
        })
    }
}

impl std::error::Error for ProjectAccessError {}

type GrantRow = (
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    i64,
);

pub struct ProjectAccessRepository;

impl ProjectAccessRepository {
    /// Adds one direct User role without committing the caller-owned
    /// transaction. Duplicate grants fail closed. PRJ-004 changes a role by
    /// revoking and granting inside the same transaction as its audit append.
    /// Authorization and audit orchestration remain outside this boundary.
    pub async fn grant(
        transaction: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
        user_id: UserId,
        role: ProjectRole,
        now: Timestamp,
    ) -> Result<DirectProjectRoleGrant, ProjectAccessError> {
        let organization_id =
            lock_organization_project(transaction, project_id, LockMode::Update, true).await?;
        lock_active_membership(transaction, organization_id, user_id).await?;

        let row = sqlx::query_as::<_, GrantRow>(
            "INSERT INTO project_user_roles \
             (project_id, organization_id, user_id, role, created_at, updated_at, lock_version) \
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $5::timestamptz, 1) \
             RETURNING project_id::text, organization_id::text, user_id::text, role, \
                       created_at, updated_at, lock_version",
        )
        .bind(project_id.to_string())
        .bind(organization_id.to_string())
        .bind(user_id.to_string())
        .bind(role.as_str())
        .bind(now.to_string())
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_grant_error)?;
        decode_grant(row)
    }

    /// Removes one direct role while preserving transaction ownership for the
    /// authorization and audit caller. Missing roles are idempotent, and target
    /// membership or User activity is deliberately not required for cleanup.
    /// Existing User and membership rows are nevertheless locked, without
    /// validating their state, to preserve the global Organization -> Project
    /// -> User -> membership -> grant order used by grant and resolution.
    pub async fn revoke(
        transaction: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
        user_id: UserId,
    ) -> Result<bool, ProjectAccessError> {
        let organization_id =
            lock_organization_project(transaction, project_id, LockMode::Update, false).await?;
        lock_user_if_present(transaction, user_id).await?;
        let _ = lock_membership_role(transaction, organization_id, user_id).await?;
        let deleted = sqlx::query_scalar::<_, String>(
            "DELETE FROM project_user_roles \
             WHERE project_id = $1::uuid AND organization_id = $2::uuid AND user_id = $3::uuid \
             RETURNING project_id::text",
        )
        .bind(project_id.to_string())
        .bind(organization_id.to_string())
        .bind(user_id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_query_error)?;
        Ok(deleted.is_some())
    }

    /// Computes the effective role while locking every row that contributes
    /// authority. `None` is a deliberate least-privilege result.
    pub async fn resolve_effective_role(
        transaction: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
        user_id: UserId,
    ) -> Result<EffectiveProjectRole, ProjectAccessError> {
        Self::resolve_effective_role_with_lock(transaction, project_id, user_id, LockMode::Share)
            .await
    }

    /// Computes the effective role while taking an update lock on the Project.
    /// Application services use this variant before a Project or direct-role
    /// mutation so concurrent authorization checks cannot deadlock while both
    /// transactions attempt to upgrade a shared Project lock.
    pub async fn resolve_effective_role_for_update(
        transaction: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
        user_id: UserId,
    ) -> Result<EffectiveProjectRole, ProjectAccessError> {
        Self::resolve_effective_role_with_lock(transaction, project_id, user_id, LockMode::Update)
            .await
    }

    async fn resolve_effective_role_with_lock(
        transaction: &mut Transaction<'_, Postgres>,
        project_id: ProjectId,
        user_id: UserId,
        project_lock: LockMode,
    ) -> Result<EffectiveProjectRole, ProjectAccessError> {
        match read_project_owner_hint(transaction, project_id).await? {
            ProjectOwner::User(owner_id) => {
                let project = lock_project_owner(transaction, project_id, project_lock).await?;
                if project.owner != ProjectOwner::User(owner_id)
                    || !lock_active_user(transaction, user_id).await?
                {
                    return Ok(EffectiveProjectRole::None);
                }
                Ok(if owner_id == user_id {
                    EffectiveProjectRole::Admin
                } else {
                    EffectiveProjectRole::None
                })
            }
            ProjectOwner::Organization(organization_id) => {
                let organization_status =
                    lock_organization_status(transaction, organization_id).await?;
                let project = lock_project_owner(transaction, project_id, project_lock).await?;
                if project.owner != ProjectOwner::Organization(organization_id) {
                    return Err(ProjectAccessError::InvalidPersistedState);
                }
                if organization_status != "active"
                    || !lock_active_user(transaction, user_id).await?
                {
                    return Ok(EffectiveProjectRole::None);
                }
                let Some(membership_role) =
                    lock_membership_role(transaction, organization_id, user_id).await?
                else {
                    return Ok(EffectiveProjectRole::None);
                };
                if membership_role == "owner" {
                    return Ok(EffectiveProjectRole::Admin);
                }
                if membership_role != "member" {
                    return Err(ProjectAccessError::InvalidPersistedState);
                }
                let team_roles =
                    lock_team_project_roles(transaction, organization_id, project_id, user_id)
                        .await?;
                let direct_role: Option<String> = sqlx::query_scalar(
                    "SELECT role FROM project_user_roles \
                     WHERE project_id = $1::uuid AND organization_id = $2::uuid \
                       AND user_id = $3::uuid FOR SHARE",
                )
                .bind(project_id.to_string())
                .bind(organization_id.to_string())
                .bind(user_id.to_string())
                .fetch_optional(&mut **transaction)
                .await
                .map_err(map_query_error)?;
                let direct_role = direct_role
                    .map(|value| ProjectRole::parse(&value))
                    .transpose()?;
                Ok(direct_role
                    .into_iter()
                    .chain(team_roles)
                    .map(EffectiveProjectRole::from)
                    .max()
                    .unwrap_or(EffectiveProjectRole::None))
            }
        }
    }
}

/// Locks Team authority in the global Organization -> Project -> User ->
/// Organization membership -> Team UUID -> Team membership -> grant order.
///
/// The first statement fixes the set of Teams visible to this resolution. A
/// membership inserted after that snapshot may only cause a conservative
/// denial until the next request; it can never introduce authority without
/// its Team having been locked first.
async fn lock_team_project_roles(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    project_id: ProjectId,
    user_id: UserId,
) -> Result<Vec<ProjectRole>, ProjectAccessError> {
    let team_rows: Vec<String> = sqlx::query_scalar(
        "SELECT team.id::text \
         FROM teams team \
         JOIN team_memberships membership \
           ON membership.team_id = team.id \
          AND membership.organization_id = team.organization_id \
         WHERE team.organization_id = $1::uuid \
           AND membership.user_id = $2::uuid \
         ORDER BY team.id \
         FOR SHARE OF team",
    )
    .bind(organization_id.to_string())
    .bind(user_id.to_string())
    .fetch_all(&mut **transaction)
    .await
    .map_err(map_query_error)?;

    let team_ids = team_rows
        .into_iter()
        .map(|value| {
            value
                .parse::<TeamId>()
                .map_err(|_| ProjectAccessError::InvalidPersistedState)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if team_ids.is_empty() {
        return Ok(Vec::new());
    }
    let team_id_values = team_ids.iter().map(ToString::to_string).collect::<Vec<_>>();

    let membership_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT team_id::text, role \
         FROM team_memberships \
         WHERE organization_id = $1::uuid \
           AND user_id = $2::uuid \
           AND team_id::text = ANY($3::text[]) \
         ORDER BY team_id \
         FOR SHARE",
    )
    .bind(organization_id.to_string())
    .bind(user_id.to_string())
    .bind(&team_id_values)
    .fetch_all(&mut **transaction)
    .await
    .map_err(map_query_error)?;
    if membership_rows.len() != team_ids.len() {
        return Ok(Vec::new());
    }
    for ((team_id, role), expected_team_id) in membership_rows.iter().zip(&team_ids) {
        let parsed_team_id = team_id
            .parse::<TeamId>()
            .map_err(|_| ProjectAccessError::InvalidPersistedState)?;
        if parsed_team_id != *expected_team_id || !matches!(role.as_str(), "maintainer" | "member")
        {
            return Err(ProjectAccessError::InvalidPersistedState);
        }
    }

    let grant_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT team_id::text, role \
         FROM team_project_roles \
         WHERE organization_id = $1::uuid \
           AND project_id = $2::uuid \
           AND team_id::text = ANY($3::text[]) \
         ORDER BY team_id \
         FOR SHARE",
    )
    .bind(organization_id.to_string())
    .bind(project_id.to_string())
    .bind(&team_id_values)
    .fetch_all(&mut **transaction)
    .await
    .map_err(map_query_error)?;

    grant_rows
        .into_iter()
        .map(|(team_id, role)| {
            team_id
                .parse::<TeamId>()
                .map_err(|_| ProjectAccessError::InvalidPersistedState)?;
            ProjectRole::parse(&role)
        })
        .collect()
}

#[derive(Clone, Copy)]
enum LockMode {
    Share,
    Update,
}

struct LockedProject {
    owner: ProjectOwner,
    state: String,
}

async fn lock_organization_project(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    mode: LockMode,
    require_active: bool,
) -> Result<OrganizationId, ProjectAccessError> {
    let ProjectOwner::Organization(organization_id) =
        read_project_owner_hint(transaction, project_id).await?
    else {
        return Err(ProjectAccessError::ProjectNotOrganizationOwned);
    };
    let organization_status = lock_organization_status(transaction, organization_id).await?;
    let project = lock_project_owner(transaction, project_id, mode).await?;
    if project.owner != ProjectOwner::Organization(organization_id) {
        return Err(ProjectAccessError::InvalidPersistedState);
    }
    if require_active && project.state != "active" {
        return Err(ProjectAccessError::ProjectUnavailable);
    }
    if require_active && organization_status != "active" {
        return Err(ProjectAccessError::ProjectUnavailable);
    }
    Ok(organization_id)
}

async fn read_project_owner_hint(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<ProjectOwner, ProjectAccessError> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT owner_user_id::text, owner_organization_id::text \
         FROM projects WHERE id = $1::uuid",
    )
    .bind(project_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_query_error)?;
    let Some((owner_user_id, owner_organization_id)) = row else {
        return Err(ProjectAccessError::ProjectUnavailable);
    };
    decode_owner(owner_user_id, owner_organization_id)
}

async fn lock_project_owner(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    mode: LockMode,
) -> Result<LockedProject, ProjectAccessError> {
    let statement = match mode {
        LockMode::Share => {
            "SELECT owner_user_id::text, owner_organization_id::text, state \
             FROM projects WHERE id = $1::uuid FOR SHARE"
        }
        LockMode::Update => {
            "SELECT owner_user_id::text, owner_organization_id::text, state \
             FROM projects WHERE id = $1::uuid FOR UPDATE"
        }
    };
    let row: Option<(Option<String>, Option<String>, String)> = sqlx::query_as(statement)
        .bind(project_id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_query_error)?;
    let Some((owner_user_id, owner_organization_id, state)) = row else {
        return Err(ProjectAccessError::ProjectUnavailable);
    };
    let owner = decode_owner(owner_user_id, owner_organization_id)?;
    if !matches!(state.as_str(), "active" | "archived") {
        return Err(ProjectAccessError::InvalidPersistedState);
    }
    Ok(LockedProject { owner, state })
}

fn decode_owner(
    owner_user_id: Option<String>,
    owner_organization_id: Option<String>,
) -> Result<ProjectOwner, ProjectAccessError> {
    let owner_user_id = owner_user_id
        .map(|value| value.parse())
        .transpose()
        .map_err(|_| ProjectAccessError::InvalidPersistedState)?;
    let owner_organization_id = owner_organization_id
        .map(|value| value.parse())
        .transpose()
        .map_err(|_| ProjectAccessError::InvalidPersistedState)?;
    ProjectOwner::from_nullable_ids(owner_user_id, owner_organization_id)
        .map_err(|_| ProjectAccessError::InvalidPersistedState)
}

async fn lock_active_user(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<bool, ProjectAccessError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM users WHERE id = $1::uuid FOR SHARE")
            .bind(user_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_query_error)?;
    match status.as_deref() {
        Some("active") => Ok(true),
        Some("disabled") | None => Ok(false),
        Some(_) => Err(ProjectAccessError::InvalidPersistedState),
    }
}

async fn lock_user_if_present(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(), ProjectAccessError> {
    sqlx::query_scalar::<_, String>("SELECT id::text FROM users WHERE id = $1::uuid FOR SHARE")
        .bind(user_id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_query_error)?;
    Ok(())
}

async fn lock_organization_status(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<String, ProjectAccessError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM organizations WHERE id = $1::uuid FOR SHARE")
            .bind(organization_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_query_error)?;
    let Some(status) = status else {
        return Err(ProjectAccessError::ProjectUnavailable);
    };
    match status.as_str() {
        "active" | "archived" => Ok(status),
        _ => Err(ProjectAccessError::InvalidPersistedState),
    }
}

async fn lock_active_membership(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    user_id: UserId,
) -> Result<(), ProjectAccessError> {
    if !lock_active_user(transaction, user_id).await? {
        return Err(ProjectAccessError::MemberUnavailable);
    }
    let role = lock_membership_role(transaction, organization_id, user_id).await?;
    if !matches!(role.as_deref(), Some("owner" | "member")) {
        return Err(ProjectAccessError::MemberUnavailable);
    }
    Ok(())
}

async fn lock_membership_role(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    user_id: UserId,
) -> Result<Option<String>, ProjectAccessError> {
    sqlx::query_scalar(
        "SELECT role FROM organization_memberships \
         WHERE organization_id = $1::uuid AND user_id = $2::uuid FOR SHARE",
    )
    .bind(organization_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_query_error)
}

fn decode_grant(row: GrantRow) -> Result<DirectProjectRoleGrant, ProjectAccessError> {
    DirectProjectRoleGrant::reconstruct(
        row.0
            .parse()
            .map_err(|_| ProjectAccessError::InvalidPersistedState)?,
        row.1
            .parse()
            .map_err(|_| ProjectAccessError::InvalidPersistedState)?,
        row.2
            .parse()
            .map_err(|_| ProjectAccessError::InvalidPersistedState)?,
        ProjectRole::parse(&row.3)?,
        Timestamp::from_datetime(row.4).map_err(|_| ProjectAccessError::InvalidPersistedState)?,
        Timestamp::from_datetime(row.5).map_err(|_| ProjectAccessError::InvalidPersistedState)?,
        ProjectRoleVersion::new(row.6)?,
    )
}

fn map_grant_error(error: sqlx::Error) -> ProjectAccessError {
    if is_timeout_error(&error) {
        return ProjectAccessError::OperationTimeout;
    }
    match error.as_database_error().and_then(|error| error.code()) {
        Some(code) if code == "23505" => ProjectAccessError::AlreadyGranted,
        Some(code) if code == "23503" || code == "23514" => ProjectAccessError::MemberUnavailable,
        _ => ProjectAccessError::PersistenceUnavailable,
    }
}

fn map_query_error(error: sqlx::Error) -> ProjectAccessError {
    if is_timeout_error(&error) {
        ProjectAccessError::OperationTimeout
    } else {
        ProjectAccessError::PersistenceUnavailable
    }
}

fn is_timeout_error(error: &sqlx::Error) -> bool {
    matches!(
        error.as_database_error().and_then(|error| error.code()),
        Some(code) if code == "57014" || code == "55P03"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn roles_are_ordered_and_wire_values_are_closed() {
        assert!(ProjectRole::Read < ProjectRole::Write);
        assert!(ProjectRole::Write < ProjectRole::Admin);
        assert!(EffectiveProjectRole::None < EffectiveProjectRole::Read);
        assert_eq!(
            serde_json::to_string(&ProjectRole::Admin).unwrap(),
            "\"admin\""
        );
        assert!(serde_json::from_str::<ProjectRole>("\"owner\"").is_err());
    }

    #[test]
    fn grant_reconstruction_is_checked_and_errors_are_context_free() {
        let created_at = Timestamp::from_str("2026-10-04T00:00:00Z").unwrap();
        let earlier = Timestamp::from_str("2026-10-03T23:59:59Z").unwrap();
        let result = DirectProjectRoleGrant::reconstruct(
            "0199ee6c-c777-7000-8000-000000004001".parse().unwrap(),
            "0199ee6c-c777-7000-8000-000000004002".parse().unwrap(),
            "0199ee6c-c777-7000-8000-000000004003".parse().unwrap(),
            ProjectRole::Read,
            created_at,
            earlier,
            ProjectRoleVersion::new(1).unwrap(),
        );
        assert_eq!(result, Err(ProjectAccessError::InvalidPersistedState));
        assert!(ProjectRoleVersion::new(0).is_err());
        assert_eq!(
            ProjectAccessError::PersistenceUnavailable.to_string(),
            "project role persistence is unavailable"
        );
    }
}
