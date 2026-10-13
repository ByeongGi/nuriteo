use std::fmt;

use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;

use crate::identity::{Timestamp, UserId};
use crate::organization::OrganizationId;
use crate::project::{ProjectId, ProjectRole};

use super::{
    Team, TeamDisplayName, TeamId, TeamMembership, TeamMembershipVersion, TeamProjectRoleGrant,
    TeamProjectRoleVersion, TeamRole, TeamSlug, TeamVersion,
};

pub const DEFAULT_TEAM_PAGE_SIZE: u16 = 50;
pub const MAX_TEAM_PAGE_SIZE: u16 = 100;

type TeamRow = (
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    i64,
);
type MembershipRow = (
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    i64,
);
type ProjectRoleRow = (
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    i64,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamConflict {
    IdentifierExists,
    SlugUnavailable,
    MembershipExists,
    ProjectRoleExists,
    TargetUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TeamRepositoryError {
    Conflict(TeamConflict),
    InvalidPageLimit,
    InvalidPersistedState,
    StaleVersion,
    OperationTimeout,
    PersistenceUnavailable,
}

impl fmt::Display for TeamRepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Conflict(TeamConflict::IdentifierExists) => "team identifier already exists",
            Self::Conflict(TeamConflict::SlugUnavailable) => "team slug is unavailable",
            Self::Conflict(TeamConflict::MembershipExists) => "team membership already exists",
            Self::Conflict(TeamConflict::ProjectRoleExists) => "team project role already exists",
            Self::Conflict(TeamConflict::TargetUnavailable) => "team target is unavailable",
            Self::InvalidPageLimit => "team page limit is invalid",
            Self::InvalidPersistedState => "persisted team state is invalid",
            Self::StaleVersion => "team version is stale",
            Self::OperationTimeout => "team persistence operation timed out",
            Self::PersistenceUnavailable => "team persistence is unavailable",
        })
    }
}

impl std::error::Error for TeamRepositoryError {}

macro_rules! page_limit {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $name(u16);

        impl $name {
            pub fn new(value: u16) -> Result<Self, TeamRepositoryError> {
                if !(1..=MAX_TEAM_PAGE_SIZE).contains(&value) {
                    return Err(TeamRepositoryError::InvalidPageLimit);
                }
                Ok(Self(value))
            }

            #[must_use]
            pub const fn get(self) -> u16 {
                self.0
            }

            fn fetch_count(self) -> i64 {
                i64::from(self.0) + 1
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self(DEFAULT_TEAM_PAGE_SIZE)
            }
        }
    };
}

page_limit!(TeamPageLimit);
page_limit!(TeamMemberPageLimit);
page_limit!(TeamProjectRolePageLimit);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamPageKey {
    slug: TeamSlug,
    id: TeamId,
}

impl TeamPageKey {
    #[must_use]
    pub const fn new(slug: TeamSlug, id: TeamId) -> Self {
        Self { slug, id }
    }

    #[must_use]
    pub fn slug(&self) -> &TeamSlug {
        &self.slug
    }

    #[must_use]
    pub const fn id(&self) -> TeamId {
        self.id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeamMemberPageKey(UserId);

impl TeamMemberPageKey {
    #[must_use]
    pub const fn new(user_id: UserId) -> Self {
        Self(user_id)
    }

    #[must_use]
    pub const fn user_id(self) -> UserId {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeamProjectRolePageKey(ProjectId);

impl TeamProjectRolePageKey {
    #[must_use]
    pub const fn new(project_id: ProjectId) -> Self {
        Self(project_id)
    }

    #[must_use]
    pub const fn project_id(self) -> ProjectId {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamPage {
    teams: Vec<Team>,
    next_key: Option<TeamPageKey>,
}

impl TeamPage {
    #[must_use]
    pub fn teams(&self) -> &[Team] {
        &self.teams
    }

    #[must_use]
    pub const fn next_key(&self) -> Option<&TeamPageKey> {
        self.next_key.as_ref()
    }

    #[must_use]
    pub const fn has_more(&self) -> bool {
        self.next_key.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamMembershipPage {
    items: Vec<TeamMembership>,
    next_key: Option<TeamMemberPageKey>,
}

impl TeamMembershipPage {
    #[must_use]
    pub fn items(&self) -> &[TeamMembership] {
        &self.items
    }

    #[must_use]
    pub const fn next_key(&self) -> Option<TeamMemberPageKey> {
        self.next_key
    }

    #[must_use]
    pub const fn has_more(&self) -> bool {
        self.next_key.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamProjectRolePage {
    items: Vec<TeamProjectRoleGrant>,
    next_key: Option<TeamProjectRolePageKey>,
}

impl TeamProjectRolePage {
    #[must_use]
    pub fn items(&self) -> &[TeamProjectRoleGrant] {
        &self.items
    }

    #[must_use]
    pub const fn next_key(&self) -> Option<TeamProjectRolePageKey> {
        self.next_key
    }

    #[must_use]
    pub const fn has_more(&self) -> bool {
        self.next_key.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTeam {
    pub(crate) id: TeamId,
    pub(crate) organization_id: OrganizationId,
    pub(crate) slug: TeamSlug,
    pub(crate) display_name: TeamDisplayName,
    pub(crate) created_at: Timestamp,
}

impl NewTeam {
    #[must_use]
    pub const fn new(
        id: TeamId,
        organization_id: OrganizationId,
        slug: TeamSlug,
        display_name: TeamDisplayName,
        created_at: Timestamp,
    ) -> Self {
        Self {
            id,
            organization_id,
            slug,
            display_name,
            created_at,
        }
    }
}

pub struct TeamRepository;

impl TeamRepository {
    pub async fn create(
        transaction: &mut Transaction<'_, Postgres>,
        candidate: &NewTeam,
    ) -> Result<Team, TeamRepositoryError> {
        let row = sqlx::query_as::<_, TeamRow>(
            "INSERT INTO teams (id, organization_id, slug, display_name, created_at, updated_at, lock_version) \
             VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $5::timestamptz, 1) \
             RETURNING id::text, organization_id::text, slug, display_name, created_at, updated_at, lock_version",
        )
        .bind(candidate.id.to_string())
        .bind(candidate.organization_id.to_string())
        .bind(candidate.slug.as_str())
        .bind(candidate.display_name.as_str())
        .bind(candidate.created_at.to_string())
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_team_insert_error)?;
        decode_team(row)
    }

    pub async fn get_by_id(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
    ) -> Result<Option<Team>, TeamRepositoryError> {
        fetch_team(transaction, team_id, false).await
    }

    pub async fn lock_by_id(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
    ) -> Result<Option<Team>, TeamRepositoryError> {
        fetch_team(transaction, team_id, true).await
    }

    pub async fn list_visible(
        transaction: &mut Transaction<'_, Postgres>,
        organization_id: OrganizationId,
        actor_user_id: UserId,
        include_all: bool,
        limit: TeamPageLimit,
        after: Option<&TeamPageKey>,
    ) -> Result<TeamPage, TeamRepositoryError> {
        let after_slug = after.map(|value| value.slug.as_str().to_owned());
        let after_id = after.map(|value| value.id.to_string());
        let rows = sqlx::query_as::<_, TeamRow>(
            "SELECT team.id::text, team.organization_id::text, team.slug, team.display_name, \
                    team.created_at, team.updated_at, team.lock_version \
             FROM teams team \
             WHERE team.organization_id = $1::uuid \
               AND ($3 OR EXISTS (SELECT 1 FROM team_memberships membership \
                                   WHERE membership.team_id = team.id AND membership.user_id = $2::uuid)) \
               AND ($4::text IS NULL OR (team.slug, team.id) > ($4::text, $5::uuid)) \
             ORDER BY team.slug, team.id LIMIT $6",
        )
        .bind(organization_id.to_string())
        .bind(actor_user_id.to_string())
        .bind(include_all)
        .bind(after_slug)
        .bind(after_id)
        .bind(limit.fetch_count())
        .fetch_all(&mut **transaction)
        .await
        .map_err(map_query_error)?;
        decode_team_page(rows, limit)
    }

    pub async fn rename(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
        expected: TeamVersion,
        display_name: &TeamDisplayName,
        now: Timestamp,
    ) -> Result<Team, TeamRepositoryError> {
        let row = sqlx::query_as::<_, TeamRow>(
            "UPDATE teams SET display_name = $3, updated_at = $4::timestamptz, \
                    lock_version = lock_version + 1 \
             WHERE id = $1::uuid AND lock_version = $2 \
             RETURNING id::text, organization_id::text, slug, display_name, created_at, updated_at, lock_version",
        )
        .bind(team_id.to_string())
        .bind(expected.get())
        .bind(display_name.as_str())
        .bind(now.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_query_error)?
        .ok_or(TeamRepositoryError::StaleVersion)?;
        decode_team(row)
    }

    pub async fn delete(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
        expected: TeamVersion,
    ) -> Result<bool, TeamRepositoryError> {
        let result = sqlx::query("DELETE FROM teams WHERE id = $1::uuid AND lock_version = $2")
            .bind(team_id.to_string())
            .bind(expected.get())
            .execute(&mut **transaction)
            .await
            .map_err(map_query_error)?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn list_members(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
        limit: TeamMemberPageLimit,
        after: Option<TeamMemberPageKey>,
    ) -> Result<TeamMembershipPage, TeamRepositoryError> {
        let after = after.map(|value| value.0.to_string());
        let rows = sqlx::query_as::<_, MembershipRow>(
            "SELECT team_id::text, organization_id::text, user_id::text, role, created_at, updated_at, lock_version \
             FROM team_memberships WHERE team_id = $1::uuid \
               AND ($2::uuid IS NULL OR user_id > $2::uuid) ORDER BY user_id LIMIT $3",
        )
        .bind(team_id.to_string())
        .bind(after)
        .bind(limit.fetch_count())
        .fetch_all(&mut **transaction)
        .await
        .map_err(map_query_error)?;
        decode_membership_page(rows, limit)
    }

    pub async fn add_member(
        transaction: &mut Transaction<'_, Postgres>,
        team: &Team,
        user_id: UserId,
        role: TeamRole,
        now: Timestamp,
    ) -> Result<TeamMembership, TeamRepositoryError> {
        let row = sqlx::query_as::<_, MembershipRow>(
            "INSERT INTO team_memberships \
             (team_id, organization_id, user_id, role, created_at, updated_at, lock_version) \
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $5::timestamptz, 1) \
             RETURNING team_id::text, organization_id::text, user_id::text, role, created_at, updated_at, lock_version",
        )
        .bind(team.id().to_string())
        .bind(team.organization_id().to_string())
        .bind(user_id.to_string())
        .bind(team_role_name(role))
        .bind(now.to_string())
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_membership_insert_error)?;
        decode_membership(row)
    }

    pub async fn update_member(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
        user_id: UserId,
        expected: TeamMembershipVersion,
        role: TeamRole,
        now: Timestamp,
    ) -> Result<TeamMembership, TeamRepositoryError> {
        let row = sqlx::query_as::<_, MembershipRow>(
            "UPDATE team_memberships SET role = $4, updated_at = $5::timestamptz, \
                    lock_version = lock_version + 1 \
             WHERE team_id = $1::uuid AND user_id = $2::uuid AND lock_version = $3 \
             RETURNING team_id::text, organization_id::text, user_id::text, role, created_at, updated_at, lock_version",
        )
        .bind(team_id.to_string())
        .bind(user_id.to_string())
        .bind(expected.get())
        .bind(team_role_name(role))
        .bind(now.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_query_error)?
        .ok_or(TeamRepositoryError::StaleVersion)?;
        decode_membership(row)
    }

    pub async fn remove_member(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
        user_id: UserId,
        expected: TeamMembershipVersion,
    ) -> Result<bool, TeamRepositoryError> {
        let result = sqlx::query(
            "DELETE FROM team_memberships WHERE team_id = $1::uuid AND user_id = $2::uuid AND lock_version = $3",
        )
        .bind(team_id.to_string())
        .bind(user_id.to_string())
        .bind(expected.get())
        .execute(&mut **transaction)
        .await
        .map_err(map_query_error)?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn list_project_roles(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
        limit: TeamProjectRolePageLimit,
        after: Option<TeamProjectRolePageKey>,
    ) -> Result<TeamProjectRolePage, TeamRepositoryError> {
        let after = after.map(|value| value.0.to_string());
        let rows = sqlx::query_as::<_, ProjectRoleRow>(
            "SELECT team_id::text, organization_id::text, project_id::text, role, created_at, updated_at, lock_version \
             FROM team_project_roles WHERE team_id = $1::uuid \
               AND ($2::uuid IS NULL OR project_id > $2::uuid) ORDER BY project_id LIMIT $3",
        )
        .bind(team_id.to_string())
        .bind(after)
        .bind(limit.fetch_count())
        .fetch_all(&mut **transaction)
        .await
        .map_err(map_query_error)?;
        decode_project_role_page(rows, limit)
    }

    pub async fn add_project_role(
        transaction: &mut Transaction<'_, Postgres>,
        team: &Team,
        project_id: ProjectId,
        role: ProjectRole,
        now: Timestamp,
    ) -> Result<TeamProjectRoleGrant, TeamRepositoryError> {
        let row = sqlx::query_as::<_, ProjectRoleRow>(
            "INSERT INTO team_project_roles \
             (team_id, organization_id, project_id, role, created_at, updated_at, lock_version) \
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $5::timestamptz, 1) \
             RETURNING team_id::text, organization_id::text, project_id::text, role, created_at, updated_at, lock_version",
        )
        .bind(team.id().to_string())
        .bind(team.organization_id().to_string())
        .bind(project_id.to_string())
        .bind(project_role_name(role))
        .bind(now.to_string())
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_project_role_insert_error)?;
        decode_project_role(row)
    }

    pub async fn update_project_role(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
        project_id: ProjectId,
        expected: TeamProjectRoleVersion,
        role: ProjectRole,
        now: Timestamp,
    ) -> Result<TeamProjectRoleGrant, TeamRepositoryError> {
        let row = sqlx::query_as::<_, ProjectRoleRow>(
            "UPDATE team_project_roles SET role = $4, updated_at = $5::timestamptz, \
                    lock_version = lock_version + 1 \
             WHERE team_id = $1::uuid AND project_id = $2::uuid AND lock_version = $3 \
             RETURNING team_id::text, organization_id::text, project_id::text, role, created_at, updated_at, lock_version",
        )
        .bind(team_id.to_string())
        .bind(project_id.to_string())
        .bind(expected.get())
        .bind(project_role_name(role))
        .bind(now.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_query_error)?
        .ok_or(TeamRepositoryError::StaleVersion)?;
        decode_project_role(row)
    }

    pub async fn remove_project_role(
        transaction: &mut Transaction<'_, Postgres>,
        team_id: TeamId,
        project_id: ProjectId,
        expected: TeamProjectRoleVersion,
    ) -> Result<bool, TeamRepositoryError> {
        let result = sqlx::query(
            "DELETE FROM team_project_roles WHERE team_id = $1::uuid AND project_id = $2::uuid AND lock_version = $3",
        )
        .bind(team_id.to_string())
        .bind(project_id.to_string())
        .bind(expected.get())
        .execute(&mut **transaction)
        .await
        .map_err(map_query_error)?;
        Ok(result.rows_affected() == 1)
    }
}

async fn fetch_team(
    transaction: &mut Transaction<'_, Postgres>,
    team_id: TeamId,
    lock: bool,
) -> Result<Option<Team>, TeamRepositoryError> {
    let statement = if lock {
        "SELECT id::text, organization_id::text, slug, display_name, created_at, updated_at, lock_version FROM teams WHERE id = $1::uuid FOR UPDATE"
    } else {
        "SELECT id::text, organization_id::text, slug, display_name, created_at, updated_at, lock_version FROM teams WHERE id = $1::uuid"
    };
    sqlx::query_as::<_, TeamRow>(statement)
        .bind(team_id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_query_error)?
        .map(decode_team)
        .transpose()
}

fn decode_team_page(
    rows: Vec<TeamRow>,
    limit: TeamPageLimit,
) -> Result<TeamPage, TeamRepositoryError> {
    let mut teams = rows
        .into_iter()
        .map(decode_team)
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = teams.len() > usize::from(limit.get());
    teams.truncate(usize::from(limit.get()));
    let next_key = has_more
        .then(|| {
            teams
                .last()
                .map(|team| TeamPageKey::new(team.slug().clone(), team.id()))
        })
        .flatten();
    Ok(TeamPage { teams, next_key })
}

fn decode_membership_page(
    rows: Vec<MembershipRow>,
    limit: TeamMemberPageLimit,
) -> Result<TeamMembershipPage, TeamRepositoryError> {
    let mut items = rows
        .into_iter()
        .map(decode_membership)
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = items.len() > usize::from(limit.get());
    items.truncate(usize::from(limit.get()));
    let next_key = has_more
        .then(|| items.last().map(|item| TeamMemberPageKey(item.user_id())))
        .flatten();
    Ok(TeamMembershipPage { items, next_key })
}

fn decode_project_role_page(
    rows: Vec<ProjectRoleRow>,
    limit: TeamProjectRolePageLimit,
) -> Result<TeamProjectRolePage, TeamRepositoryError> {
    let mut items = rows
        .into_iter()
        .map(decode_project_role)
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = items.len() > usize::from(limit.get());
    items.truncate(usize::from(limit.get()));
    let next_key = has_more
        .then(|| {
            items
                .last()
                .map(|item| TeamProjectRolePageKey(item.project_id()))
        })
        .flatten();
    Ok(TeamProjectRolePage { items, next_key })
}

fn decode_team(row: TeamRow) -> Result<Team, TeamRepositoryError> {
    Team::reconstruct(
        row.0
            .parse()
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        row.1
            .parse()
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        TeamSlug::new(row.2).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        TeamDisplayName::new(row.3).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        Timestamp::from_datetime(row.4).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        Timestamp::from_datetime(row.5).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        TeamVersion::new(row.6).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
    )
    .map_err(|_| TeamRepositoryError::InvalidPersistedState)
}

fn decode_membership(row: MembershipRow) -> Result<TeamMembership, TeamRepositoryError> {
    TeamMembership::reconstruct(
        row.0
            .parse()
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        row.1
            .parse()
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        row.2
            .parse()
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        parse_team_role(&row.3)?,
        Timestamp::from_datetime(row.4).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        Timestamp::from_datetime(row.5).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        TeamMembershipVersion::new(row.6)
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
    )
    .map_err(|_| TeamRepositoryError::InvalidPersistedState)
}

fn decode_project_role(row: ProjectRoleRow) -> Result<TeamProjectRoleGrant, TeamRepositoryError> {
    TeamProjectRoleGrant::reconstruct(
        row.0
            .parse()
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        row.1
            .parse()
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        row.2
            .parse()
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        parse_project_role(&row.3)?,
        Timestamp::from_datetime(row.4).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        Timestamp::from_datetime(row.5).map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
        TeamProjectRoleVersion::new(row.6)
            .map_err(|_| TeamRepositoryError::InvalidPersistedState)?,
    )
    .map_err(|_| TeamRepositoryError::InvalidPersistedState)
}

fn team_role_name(role: TeamRole) -> &'static str {
    match role {
        TeamRole::Maintainer => "maintainer",
        TeamRole::Member => "member",
    }
}

fn parse_team_role(value: &str) -> Result<TeamRole, TeamRepositoryError> {
    match value {
        "maintainer" => Ok(TeamRole::Maintainer),
        "member" => Ok(TeamRole::Member),
        _ => Err(TeamRepositoryError::InvalidPersistedState),
    }
}

fn project_role_name(role: ProjectRole) -> &'static str {
    match role {
        ProjectRole::Read => "read",
        ProjectRole::Write => "write",
        ProjectRole::Admin => "admin",
    }
}

fn parse_project_role(value: &str) -> Result<ProjectRole, TeamRepositoryError> {
    match value {
        "read" => Ok(ProjectRole::Read),
        "write" => Ok(ProjectRole::Write),
        "admin" => Ok(ProjectRole::Admin),
        _ => Err(TeamRepositoryError::InvalidPersistedState),
    }
}

fn map_team_insert_error(error: sqlx::Error) -> TeamRepositoryError {
    if is_timeout_error(&error) {
        return TeamRepositoryError::OperationTimeout;
    }
    if let sqlx::Error::Database(database) = &error {
        return match database.constraint() {
            Some("teams_pkey") => TeamRepositoryError::Conflict(TeamConflict::IdentifierExists),
            Some("teams_organization_slug_unique") => {
                TeamRepositoryError::Conflict(TeamConflict::SlugUnavailable)
            }
            Some("teams_active_organization") | Some("teams_organization_fk") => {
                TeamRepositoryError::Conflict(TeamConflict::TargetUnavailable)
            }
            _ => TeamRepositoryError::PersistenceUnavailable,
        };
    }
    TeamRepositoryError::PersistenceUnavailable
}

fn map_membership_insert_error(error: sqlx::Error) -> TeamRepositoryError {
    if is_timeout_error(&error) {
        return TeamRepositoryError::OperationTimeout;
    }
    if let sqlx::Error::Database(database) = &error {
        return match database.constraint() {
            Some("team_memberships_pkey") => {
                TeamRepositoryError::Conflict(TeamConflict::MembershipExists)
            }
            Some("team_memberships_active_target")
            | Some("team_memberships_team_fk")
            | Some("team_memberships_organization_membership_fk") => {
                TeamRepositoryError::Conflict(TeamConflict::TargetUnavailable)
            }
            _ => TeamRepositoryError::PersistenceUnavailable,
        };
    }
    TeamRepositoryError::PersistenceUnavailable
}

fn map_project_role_insert_error(error: sqlx::Error) -> TeamRepositoryError {
    if is_timeout_error(&error) {
        return TeamRepositoryError::OperationTimeout;
    }
    if let sqlx::Error::Database(database) = &error {
        return match database.constraint() {
            Some("team_project_roles_pkey") => {
                TeamRepositoryError::Conflict(TeamConflict::ProjectRoleExists)
            }
            Some("team_project_roles_active_target")
            | Some("team_project_roles_team_fk")
            | Some("team_project_roles_project_owner_fk") => {
                TeamRepositoryError::Conflict(TeamConflict::TargetUnavailable)
            }
            _ => TeamRepositoryError::PersistenceUnavailable,
        };
    }
    TeamRepositoryError::PersistenceUnavailable
}

fn map_query_error(error: sqlx::Error) -> TeamRepositoryError {
    if is_timeout_error(&error) {
        TeamRepositoryError::OperationTimeout
    } else {
        TeamRepositoryError::PersistenceUnavailable
    }
}

fn is_timeout_error(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|database| matches!(database.code().as_deref(), Some("57014" | "55P03")))
}
