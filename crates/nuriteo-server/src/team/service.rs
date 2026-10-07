use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::time::Duration;

use serde_json::json;
use sqlx::{Acquire, Postgres, Transaction, pool::PoolConnection};
use time::OffsetDateTime;
use tokio::time as tokio_time;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::database::DatabasePool;
use crate::identity::{Timestamp, UserId};
use crate::organization::{OrganizationId, OrganizationRole, OrganizationStatus};
use crate::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId, ProjectRole,
};

use super::{
    NewTeam, Team, TeamAction, TeamAuthorization, TeamAuthorizationPrincipal, TeamConflict,
    TeamDisplayName, TeamId, TeamMemberPageKey, TeamMemberPageLimit, TeamMembership,
    TeamMembershipPage, TeamMembershipVersion, TeamOrganizationMembership, TeamPage, TeamPageKey,
    TeamPageLimit, TeamProjectRoleGrant, TeamProjectRolePage, TeamProjectRolePageKey,
    TeamProjectRolePageLimit, TeamProjectRoleVersion, TeamRepository, TeamRepositoryError,
    TeamRole, TeamSlug, TeamVersion,
};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeamServicePolicy {
    operation_timeout: Duration,
}

impl TeamServicePolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, TeamServiceError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(TeamServiceError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }

    #[must_use]
    pub const fn operation_timeout(self) -> Duration {
        self.operation_timeout
    }
}

impl Default for TeamServicePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamPrincipal {
    User(UserId),
    InstanceAdministrator(UserId),
}

impl TeamPrincipal {
    #[must_use]
    pub const fn user_id(self) -> UserId {
        match self {
            Self::User(id) | Self::InstanceAdministrator(id) => id,
        }
    }
}

#[derive(Clone)]
pub struct TeamAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    actor_display_name: Option<String>,
    correlation_id: String,
    source_ip: Option<IpAddr>,
}

impl TeamAuditContext {
    #[must_use]
    pub fn new(
        event_id: AuditEventId,
        actor_user_id: UserId,
        actor_display_name: Option<String>,
        correlation_id: String,
        source_ip: Option<IpAddr>,
    ) -> Self {
        Self {
            event_id,
            actor_user_id,
            actor_display_name,
            correlation_id,
            source_ip,
        }
    }
}

impl fmt::Debug for TeamAuditContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TeamAuditContext")
            .field("event_id", &self.event_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamMutationResult {
    Changed,
    AlreadyAbsent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TeamServiceError {
    InvalidInput,
    NotFound,
    Unauthorized,
    UserUnavailable,
    OrganizationUnavailable,
    TeamUnavailable,
    ProjectUnavailable,
    DuplicateSlug,
    MembershipAlreadyExists,
    MembershipNotFound,
    ProjectRoleAlreadyExists,
    ProjectRoleNotFound,
    StaleVersion,
    AuditUnavailable,
    DatabaseUnavailable,
    OperationTimeout,
    InvariantViolation,
}

impl fmt::Display for TeamServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "team input is invalid",
            Self::NotFound => "team was not found",
            Self::Unauthorized => "team operation is not authorized",
            Self::UserUnavailable => "team user is unavailable",
            Self::OrganizationUnavailable => "team organization is unavailable",
            Self::TeamUnavailable => "team is unavailable",
            Self::ProjectUnavailable => "team project is unavailable",
            Self::DuplicateSlug => "team slug already exists",
            Self::MembershipAlreadyExists => "team membership already exists",
            Self::MembershipNotFound => "team membership was not found",
            Self::ProjectRoleAlreadyExists => "team project role already exists",
            Self::ProjectRoleNotFound => "team project role was not found",
            Self::StaleVersion => "team version is stale",
            Self::AuditUnavailable => "team audit persistence is unavailable",
            Self::DatabaseUnavailable => "team persistence is unavailable",
            Self::OperationTimeout => "team operation timed out",
            Self::InvariantViolation => "team state is invalid",
        })
    }
}

impl std::error::Error for TeamServiceError {}

#[derive(Clone)]
pub struct TeamService {
    pool: DatabasePool,
    policy: TeamServicePolicy,
}

impl TeamService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: TeamServicePolicy) -> Self {
        Self { pool, policy }
    }

    pub async fn create(
        &self,
        principal: TeamPrincipal,
        organization_id: OrganizationId,
        slug: TeamSlug,
        display_name: TeamDisplayName,
        audit: &TeamAuditContext,
    ) -> Result<Team, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(self.create_inner(
            principal,
            organization_id,
            slug,
            display_name,
            audit,
        ))
        .await
    }

    pub async fn get(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
    ) -> Result<Team, TeamServiceError> {
        self.within_deadline(self.get_inner(principal, team_id))
            .await
    }

    pub async fn list(
        &self,
        principal: TeamPrincipal,
        organization_id: OrganizationId,
        limit: TeamPageLimit,
        after: Option<&TeamPageKey>,
    ) -> Result<TeamPage, TeamServiceError> {
        self.within_deadline(self.list_inner(principal, organization_id, limit, after))
            .await
    }

    pub async fn rename(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        expected: TeamVersion,
        display_name: TeamDisplayName,
        audit: &TeamAuditContext,
    ) -> Result<Team, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(self.rename_inner(principal, team_id, expected, display_name, audit))
            .await
    }

    pub async fn delete(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        expected: TeamVersion,
        audit: &TeamAuditContext,
    ) -> Result<TeamMutationResult, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(self.delete_inner(principal, team_id, expected, audit))
            .await
    }

    pub async fn list_members(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        limit: TeamMemberPageLimit,
        after: Option<TeamMemberPageKey>,
    ) -> Result<TeamMembershipPage, TeamServiceError> {
        self.within_deadline(self.list_members_inner(principal, team_id, limit, after))
            .await
    }

    pub async fn add_member(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        user_id: UserId,
        role: TeamRole,
        audit: &TeamAuditContext,
    ) -> Result<TeamMembership, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(self.add_member_inner(principal, team_id, user_id, role, audit))
            .await
    }

    pub async fn change_member_role(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        user_id: UserId,
        expected: TeamMembershipVersion,
        role: TeamRole,
        audit: &TeamAuditContext,
    ) -> Result<TeamMembership, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(
            self.change_member_role_inner(principal, team_id, user_id, expected, role, audit),
        )
        .await
    }

    pub async fn remove_member(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        user_id: UserId,
        expected: TeamMembershipVersion,
        audit: &TeamAuditContext,
    ) -> Result<TeamMutationResult, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(self.remove_member_inner(principal, team_id, user_id, expected, audit))
            .await
    }

    pub async fn list_project_roles(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        limit: TeamProjectRolePageLimit,
        after: Option<TeamProjectRolePageKey>,
    ) -> Result<TeamProjectRolePage, TeamServiceError> {
        self.within_deadline(self.list_project_roles_inner(principal, team_id, limit, after))
            .await
    }

    pub async fn add_project_role(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        project_id: ProjectId,
        role: ProjectRole,
        audit: &TeamAuditContext,
    ) -> Result<TeamProjectRoleGrant, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(
            self.add_project_role_inner(principal, team_id, project_id, role, audit),
        )
        .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "optimistic binding mutation is explicit"
    )]
    pub async fn change_project_role(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        project_id: ProjectId,
        expected: TeamProjectRoleVersion,
        role: ProjectRole,
        audit: &TeamAuditContext,
    ) -> Result<TeamProjectRoleGrant, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(
            self.change_project_role_inner(principal, team_id, project_id, expected, role, audit),
        )
        .await
    }

    pub async fn remove_project_role(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        project_id: ProjectId,
        expected: TeamProjectRoleVersion,
        audit: &TeamAuditContext,
    ) -> Result<TeamMutationResult, TeamServiceError> {
        self.ensure_audit_actor(principal, audit)?;
        self.within_deadline(
            self.remove_project_role_inner(principal, team_id, project_id, expected, audit),
        )
        .await
    }

    async fn create_inner(
        &self,
        principal: TeamPrincipal,
        organization_id: OrganizationId,
        slug: TeamSlug,
        display_name: TeamDisplayName,
        audit: &TeamAuditContext,
    ) -> Result<Team, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let authorization =
            organization_authorization(&mut transaction, principal, organization_id).await?;
        if !authorization.allows(TeamAction::Create) {
            return Err(TeamServiceError::Unauthorized);
        }
        let now = transaction_now(&mut transaction).await?;
        let team = TeamRepository::create(
            &mut transaction,
            &NewTeam::new(TeamId::new(), organization_id, slug, display_name, now),
        )
        .await
        .map_err(map_repository_error)?;
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.created",
            "team",
            team.id().to_string(),
            vec!["team".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(team)
    }

    async fn get_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
    ) -> Result<Team, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = TeamRepository::get_by_id(&mut transaction, team_id)
            .await
            .map_err(map_repository_error)?
            .ok_or(TeamServiceError::NotFound)?;
        authorize_team(&mut transaction, principal, &team, TeamAction::View).await?;
        Ok(team)
    }

    async fn list_inner(
        &self,
        principal: TeamPrincipal,
        organization_id: OrganizationId,
        limit: TeamPageLimit,
        after: Option<&TeamPageKey>,
    ) -> Result<TeamPage, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let authorization =
            organization_authorization(&mut transaction, principal, organization_id).await?;
        let include_all = authorization.allows(TeamAction::Create);
        TeamRepository::list_visible(
            &mut transaction,
            organization_id,
            principal.user_id(),
            include_all,
            limit,
            after,
        )
        .await
        .map_err(map_repository_error)
    }

    async fn rename_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        expected: TeamVersion,
        display_name: TeamDisplayName,
        audit: &TeamAuditContext,
    ) -> Result<Team, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team =
            lock_authorized_team(&mut transaction, principal, team_id, TeamAction::Rename).await?;
        ensure_team_version(&team, expected)?;
        let now = transaction_now(&mut transaction).await?;
        let updated =
            TeamRepository::rename(&mut transaction, team_id, expected, &display_name, now)
                .await
                .map_err(map_repository_error)?;
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.renamed",
            "team",
            team_id.to_string(),
            vec!["display_name".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(updated)
    }

    async fn delete_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        expected: TeamVersion,
        audit: &TeamAuditContext,
    ) -> Result<TeamMutationResult, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team =
            lock_authorized_team(&mut transaction, principal, team_id, TeamAction::Delete).await?;
        ensure_team_version(&team, expected)?;
        let now = transaction_now(&mut transaction).await?;
        if !TeamRepository::delete(&mut transaction, team_id, expected)
            .await
            .map_err(map_repository_error)?
        {
            return Err(TeamServiceError::StaleVersion);
        }
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.deleted",
            "team",
            team_id.to_string(),
            vec!["team".into(), "memberships".into(), "project_roles".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(TeamMutationResult::Changed)
    }

    async fn list_members_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        limit: TeamMemberPageLimit,
        after: Option<TeamMemberPageKey>,
    ) -> Result<TeamMembershipPage, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = TeamRepository::get_by_id(&mut transaction, team_id)
            .await
            .map_err(map_repository_error)?
            .ok_or(TeamServiceError::NotFound)?;
        authorize_team(&mut transaction, principal, &team, TeamAction::View).await?;
        TeamRepository::list_members(&mut transaction, team_id, limit, after)
            .await
            .map_err(map_repository_error)
    }

    async fn add_member_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        user_id: UserId,
        role: TeamRole,
        audit: &TeamAuditContext,
    ) -> Result<TeamMembership, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = lock_authorized_team(
            &mut transaction,
            principal,
            team_id,
            TeamAction::ManageMembers,
        )
        .await?;
        let now = transaction_now(&mut transaction).await?;
        let item = TeamRepository::add_member(&mut transaction, &team, user_id, role, now)
            .await
            .map_err(map_repository_error)?;
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.member_added",
            "team_membership",
            user_id.to_string(),
            vec!["membership".into(), "role".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(item)
    }

    async fn change_member_role_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        user_id: UserId,
        expected: TeamMembershipVersion,
        role: TeamRole,
        audit: &TeamAuditContext,
    ) -> Result<TeamMembership, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = lock_authorized_team(
            &mut transaction,
            principal,
            team_id,
            TeamAction::ManageMembers,
        )
        .await?;
        let now = transaction_now(&mut transaction).await?;
        let item =
            TeamRepository::update_member(&mut transaction, team_id, user_id, expected, role, now)
                .await
                .map_err(map_repository_error)?;
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.member_role_changed",
            "team_membership",
            user_id.to_string(),
            vec!["role".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(item)
    }

    async fn remove_member_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        user_id: UserId,
        expected: TeamMembershipVersion,
        audit: &TeamAuditContext,
    ) -> Result<TeamMutationResult, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = lock_authorized_team(
            &mut transaction,
            principal,
            team_id,
            TeamAction::ManageMembers,
        )
        .await?;
        if membership_version(&mut transaction, team_id, user_id)
            .await?
            .is_none()
        {
            return Ok(TeamMutationResult::AlreadyAbsent);
        }
        let now = transaction_now(&mut transaction).await?;
        if !TeamRepository::remove_member(&mut transaction, team_id, user_id, expected)
            .await
            .map_err(map_repository_error)?
        {
            return Err(TeamServiceError::StaleVersion);
        }
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.member_removed",
            "team_membership",
            user_id.to_string(),
            vec!["membership".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(TeamMutationResult::Changed)
    }

    async fn list_project_roles_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        limit: TeamProjectRolePageLimit,
        after: Option<TeamProjectRolePageKey>,
    ) -> Result<TeamProjectRolePage, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = TeamRepository::get_by_id(&mut transaction, team_id)
            .await
            .map_err(map_repository_error)?
            .ok_or(TeamServiceError::NotFound)?;
        authorize_team(&mut transaction, principal, &team, TeamAction::View).await?;
        TeamRepository::list_project_roles(&mut transaction, team_id, limit, after)
            .await
            .map_err(map_repository_error)
    }

    async fn add_project_role_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        project_id: ProjectId,
        role: ProjectRole,
        audit: &TeamAuditContext,
    ) -> Result<TeamProjectRoleGrant, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = lock_authorized_team_for_project(
            &mut transaction,
            principal,
            team_id,
            project_id,
            TeamAction::ManageProjectRoles,
        )
        .await?;
        let now = transaction_now(&mut transaction).await?;
        let item = TeamRepository::add_project_role(&mut transaction, &team, project_id, role, now)
            .await
            .map_err(map_repository_error)?;
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.project_role_added",
            "team_project_role",
            project_id.to_string(),
            vec!["project_role".into(), "role".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(item)
    }

    async fn change_project_role_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        project_id: ProjectId,
        expected: TeamProjectRoleVersion,
        role: ProjectRole,
        audit: &TeamAuditContext,
    ) -> Result<TeamProjectRoleGrant, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = lock_authorized_team_for_project(
            &mut transaction,
            principal,
            team_id,
            project_id,
            TeamAction::ManageProjectRoles,
        )
        .await?;
        let now = transaction_now(&mut transaction).await?;
        let item = TeamRepository::update_project_role(
            &mut transaction,
            team_id,
            project_id,
            expected,
            role,
            now,
        )
        .await
        .map_err(map_repository_error)?;
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.project_role_changed",
            "team_project_role",
            project_id.to_string(),
            vec!["role".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(item)
    }

    async fn remove_project_role_inner(
        &self,
        principal: TeamPrincipal,
        team_id: TeamId,
        project_id: ProjectId,
        expected: TeamProjectRoleVersion,
        audit: &TeamAuditContext,
    ) -> Result<TeamMutationResult, TeamServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = self.begin(&mut connection).await?;
        let team = lock_authorized_team_for_project(
            &mut transaction,
            principal,
            team_id,
            project_id,
            TeamAction::ManageProjectRoles,
        )
        .await?;
        if project_role_version(&mut transaction, team_id, project_id)
            .await?
            .is_none()
        {
            return Ok(TeamMutationResult::AlreadyAbsent);
        }
        let now = transaction_now(&mut transaction).await?;
        if !TeamRepository::remove_project_role(&mut transaction, team_id, project_id, expected)
            .await
            .map_err(map_repository_error)?
        {
            return Err(TeamServiceError::StaleVersion);
        }
        append_audit(
            &mut transaction,
            audit,
            now,
            &team,
            "team.project_role_removed",
            "team_project_role",
            project_id.to_string(),
            vec!["project_role".into()],
        )
        .await?;
        commit(transaction).await?;
        Ok(TeamMutationResult::Changed)
    }

    async fn acquire(&self) -> Result<PoolConnection<Postgres>, TeamServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| TeamServiceError::DatabaseUnavailable)
    }

    async fn begin<'a>(
        &self,
        connection: &'a mut PoolConnection<Postgres>,
    ) -> Result<Transaction<'a, Postgres>, TeamServiceError> {
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| TeamServiceError::DatabaseUnavailable)?;
        let timeout_ms = i64::try_from(self.policy.operation_timeout.as_millis())
            .map_err(|_| TeamServiceError::InvalidInput)?;
        sqlx::query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)")
            .bind(format!("{timeout_ms}ms"))
            .execute(&mut *transaction)
            .await
            .map_err(|_| TeamServiceError::DatabaseUnavailable)?;
        Ok(transaction)
    }

    async fn within_deadline<T>(
        &self,
        operation: impl Future<Output = Result<T, TeamServiceError>>,
    ) -> Result<T, TeamServiceError> {
        tokio_time::timeout(
            self.policy.operation_timeout + Duration::from_secs(2),
            operation,
        )
        .await
        .map_err(|_| TeamServiceError::OperationTimeout)?
    }

    fn ensure_audit_actor(
        &self,
        principal: TeamPrincipal,
        audit: &TeamAuditContext,
    ) -> Result<(), TeamServiceError> {
        if principal.user_id() != audit.actor_user_id {
            return Err(TeamServiceError::InvalidInput);
        }
        Ok(())
    }
}

async fn organization_authorization(
    transaction: &mut Transaction<'_, Postgres>,
    principal: TeamPrincipal,
    organization_id: OrganizationId,
) -> Result<TeamAuthorization, TeamServiceError> {
    let row = sqlx::query_as::<_, (String, String, bool, Option<String>)>(
        "SELECT organization.status, actor.status, actor.is_instance_admin, membership.role \
         FROM organizations organization JOIN users actor ON actor.id = $2::uuid \
         LEFT JOIN organization_memberships membership \
           ON membership.organization_id = organization.id AND membership.user_id = actor.id \
         WHERE organization.id = $1::uuid FOR SHARE OF organization, actor",
    )
    .bind(organization_id.to_string())
    .bind(principal.user_id().to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)?
    .ok_or(TeamServiceError::OrganizationUnavailable)?;
    if row.1 != "active" {
        return Err(TeamServiceError::UserUnavailable);
    }
    let status = parse_organization_status(&row.0)?;
    let principal = match principal {
        TeamPrincipal::InstanceAdministrator(_) if row.2 => {
            TeamAuthorizationPrincipal::InstanceAdministrator
        }
        TeamPrincipal::InstanceAdministrator(_) => return Err(TeamServiceError::Unauthorized),
        TeamPrincipal::User(_) => TeamAuthorizationPrincipal::User {
            organization_membership: parse_membership(organization_id, row.3.as_deref(), status),
            team_role: None,
        },
    };
    Ok(TeamAuthorization::new(organization_id, status, principal))
}

async fn authorize_team(
    transaction: &mut Transaction<'_, Postgres>,
    principal: TeamPrincipal,
    team: &Team,
    action: TeamAction,
) -> Result<(), TeamServiceError> {
    let row = sqlx::query_as::<_, (String, String, bool, Option<String>, Option<String>)>(
        "SELECT organization.status, actor.status, actor.is_instance_admin, organization_membership.role, team_membership.role \
         FROM organizations organization JOIN users actor ON actor.id = $2::uuid \
         LEFT JOIN organization_memberships organization_membership \
           ON organization_membership.organization_id = organization.id AND organization_membership.user_id = actor.id \
         LEFT JOIN team_memberships team_membership \
           ON team_membership.team_id = $3::uuid AND team_membership.user_id = actor.id \
         WHERE organization.id = $1::uuid FOR SHARE OF organization, actor",
    )
    .bind(team.organization_id().to_string())
    .bind(principal.user_id().to_string())
    .bind(team.id().to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)?
    .ok_or(TeamServiceError::NotFound)?;
    if row.1 != "active" {
        return Err(TeamServiceError::Unauthorized);
    }
    let status = parse_organization_status(&row.0)?;
    let authorization_principal = match principal {
        TeamPrincipal::InstanceAdministrator(_) if row.2 => {
            TeamAuthorizationPrincipal::InstanceAdministrator
        }
        TeamPrincipal::InstanceAdministrator(_) => return Err(TeamServiceError::Unauthorized),
        TeamPrincipal::User(_) => TeamAuthorizationPrincipal::User {
            organization_membership: parse_membership(
                team.organization_id(),
                row.3.as_deref(),
                status,
            ),
            team_role: row.4.as_deref().map(parse_team_role).transpose()?,
        },
    };
    if !TeamAuthorization::new(team.organization_id(), status, authorization_principal)
        .allows(action)
    {
        return Err(TeamServiceError::Unauthorized);
    }
    Ok(())
}

async fn lock_authorized_team(
    transaction: &mut Transaction<'_, Postgres>,
    principal: TeamPrincipal,
    team_id: TeamId,
    action: TeamAction,
) -> Result<Team, TeamServiceError> {
    // Every mutation establishes the global Organization -> User -> Team lock
    // order before taking the Team update lock. This prevents inverse locking
    // with Organization archive/member lifecycle transactions.
    let organization_id = probe_team_organization(transaction, team_id).await?;
    let _ = organization_authorization(transaction, principal, organization_id).await?;
    let team = TeamRepository::lock_by_id(transaction, team_id)
        .await
        .map_err(map_repository_error)?
        .ok_or(TeamServiceError::NotFound)?;
    authorize_team(transaction, principal, &team, action).await?;
    Ok(team)
}

async fn lock_authorized_team_for_project(
    transaction: &mut Transaction<'_, Postgres>,
    principal: TeamPrincipal,
    team_id: TeamId,
    project_id: ProjectId,
    action: TeamAction,
) -> Result<Team, TeamServiceError> {
    let organization_id = probe_team_organization(transaction, team_id).await?;
    // Effective-role resolution SHARE-locks all Teams that contribute to the
    // actor's authority. Without this bounded Organization-wide mutation lock,
    // two binding requests could each upgrade a different target Team and
    // deadlock. This lock is transaction-scoped and covered by lock_timeout.
    lock_project_binding_mutations(transaction, organization_id).await?;
    lock_organization(transaction, organization_id).await?;
    lock_project(transaction, organization_id, project_id).await?;
    match principal {
        TeamPrincipal::User(user_id) => {
            // The Project resolver owns the canonical Organization -> Project
            // -> User -> membership -> Team/grant lock order and admits both
            // Organization Owners and effective Project Admins.
            let role = ProjectAccessRepository::resolve_effective_role_for_update(
                transaction,
                project_id,
                user_id,
            )
            .await
            .map_err(map_project_access_error)?;
            if role != EffectiveProjectRole::Admin {
                return Err(TeamServiceError::Unauthorized);
            }
        }
        TeamPrincipal::InstanceAdministrator(_) => {
            // Operational authority is checked explicitly and is never
            // converted into a Project role.
            let _ = organization_authorization(transaction, principal, organization_id).await?;
        }
    }
    let team = TeamRepository::lock_by_id(transaction, team_id)
        .await
        .map_err(map_repository_error)?
        .ok_or(TeamServiceError::NotFound)?;
    if team.organization_id() != organization_id {
        return Err(TeamServiceError::InvariantViolation);
    }
    if action != TeamAction::ManageProjectRoles {
        return Err(TeamServiceError::InvariantViolation);
    }
    Ok(team)
}

async fn lock_organization(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), TeamServiceError> {
    let exists: Option<bool> = sqlx::query_scalar(
        "SELECT status = 'active' FROM organizations WHERE id = $1::uuid FOR SHARE",
    )
    .bind(organization_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    if exists != Some(true) {
        return Err(TeamServiceError::OrganizationUnavailable);
    }
    Ok(())
}

async fn probe_team_organization(
    transaction: &mut Transaction<'_, Postgres>,
    team_id: TeamId,
) -> Result<OrganizationId, TeamServiceError> {
    let value: String =
        sqlx::query_scalar("SELECT organization_id::text FROM teams WHERE id = $1::uuid")
            .bind(team_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_sql_error)?
            .ok_or(TeamServiceError::NotFound)?;
    value
        .parse()
        .map_err(|_| TeamServiceError::InvariantViolation)
}

fn ensure_team_version(team: &Team, expected: TeamVersion) -> Result<(), TeamServiceError> {
    if team.lock_version() != expected {
        return Err(TeamServiceError::StaleVersion);
    }
    Ok(())
}

async fn lock_project(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    project_id: ProjectId,
) -> Result<(), TeamServiceError> {
    let available: Option<bool> = sqlx::query_scalar(
        "SELECT state = 'active' AND owner_user_id IS NULL \
                AND owner_organization_id = $2::uuid \
         FROM projects WHERE id = $1::uuid FOR UPDATE",
    )
    .bind(project_id.to_string())
    .bind(organization_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)?;
    if available != Some(true) {
        return Err(TeamServiceError::ProjectUnavailable);
    }
    Ok(())
}

async fn lock_project_binding_mutations(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), TeamServiceError> {
    sqlx::query("SELECT pg_advisory_xact_lock(1413827917, hashtext($1))")
        .bind(organization_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(map_sql_error)?;
    Ok(())
}

async fn membership_version(
    transaction: &mut Transaction<'_, Postgres>,
    team_id: TeamId,
    user_id: UserId,
) -> Result<Option<i64>, TeamServiceError> {
    sqlx::query_scalar(
        "SELECT lock_version FROM team_memberships WHERE team_id = $1::uuid AND user_id = $2::uuid FOR UPDATE",
    )
    .bind(team_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)
}

async fn project_role_version(
    transaction: &mut Transaction<'_, Postgres>,
    team_id: TeamId,
    project_id: ProjectId,
) -> Result<Option<i64>, TeamServiceError> {
    sqlx::query_scalar(
        "SELECT lock_version FROM team_project_roles WHERE team_id = $1::uuid AND project_id = $2::uuid FOR UPDATE",
    )
    .bind(team_id.to_string())
    .bind(project_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_sql_error)
}

fn parse_organization_status(value: &str) -> Result<OrganizationStatus, TeamServiceError> {
    match value {
        "active" => Ok(OrganizationStatus::Active),
        "archived" => Ok(OrganizationStatus::Archived),
        _ => Err(TeamServiceError::InvariantViolation),
    }
}

fn parse_membership(
    organization_id: OrganizationId,
    value: Option<&str>,
    status: OrganizationStatus,
) -> TeamOrganizationMembership {
    let role = match value {
        Some("owner") => Some(OrganizationRole::Owner),
        Some("member") => Some(OrganizationRole::Member),
        _ => None,
    };
    match (role, status) {
        (Some(role), OrganizationStatus::Active) => TeamOrganizationMembership::Active {
            organization_id,
            role,
        },
        (Some(role), OrganizationStatus::Archived) => TeamOrganizationMembership::Inactive {
            organization_id,
            role,
        },
        (None, _) => TeamOrganizationMembership::None,
    }
}

fn parse_team_role(value: &str) -> Result<TeamRole, TeamServiceError> {
    match value {
        "maintainer" => Ok(TeamRole::Maintainer),
        "member" => Ok(TeamRole::Member),
        _ => Err(TeamServiceError::InvariantViolation),
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "audit fields are explicit security context"
)]
async fn append_audit(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &TeamAuditContext,
    occurred_at: Timestamp,
    team: &Team,
    action: &str,
    target_kind: &str,
    target_id: String,
    changed_fields: Vec<String>,
) -> Result<(), TeamServiceError> {
    let event = AuditEvent::new(AuditEventFields {
        id: audit.event_id,
        occurred_at,
        actor: AuditActor {
            kind: ActorType::User,
            id: audit.actor_user_id.to_string(),
            user_id: Some(audit.actor_user_id),
            display_name: audit.actor_display_name.clone(),
        },
        action_code: action.into(),
        target: AuditTarget {
            kind: target_kind.into(),
            id: target_id,
        },
        scope: AuditScope {
            kind: ScopeType::Organization,
            id: team.organization_id().to_string(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: audit.correlation_id.clone(),
        source_ip: audit.source_ip,
        schema_version: 1,
        changed_fields,
        metadata: AuditMetadata::new(
            json!({"source": "team-service", "team_id": team.id().to_string()}),
        )
        .map_err(|_| TeamServiceError::InvariantViolation)?,
    })
    .map_err(|_| TeamServiceError::InvalidInput)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| TeamServiceError::AuditUnavailable)
}

async fn transaction_now(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, TeamServiceError> {
    let value: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_sql_error)?;
    Timestamp::from_datetime(value).map_err(|_| TeamServiceError::InvariantViolation)
}

async fn commit(transaction: Transaction<'_, Postgres>) -> Result<(), TeamServiceError> {
    transaction.commit().await.map_err(map_sql_error)
}

fn map_repository_error(error: TeamRepositoryError) -> TeamServiceError {
    match error {
        TeamRepositoryError::Conflict(TeamConflict::SlugUnavailable) => {
            TeamServiceError::DuplicateSlug
        }
        TeamRepositoryError::Conflict(TeamConflict::MembershipExists) => {
            TeamServiceError::MembershipAlreadyExists
        }
        TeamRepositoryError::Conflict(TeamConflict::ProjectRoleExists) => {
            TeamServiceError::ProjectRoleAlreadyExists
        }
        TeamRepositoryError::Conflict(TeamConflict::TargetUnavailable) => {
            TeamServiceError::TeamUnavailable
        }
        TeamRepositoryError::Conflict(TeamConflict::IdentifierExists)
        | TeamRepositoryError::InvalidPersistedState => TeamServiceError::InvariantViolation,
        TeamRepositoryError::InvalidPageLimit => TeamServiceError::InvalidInput,
        TeamRepositoryError::StaleVersion => TeamServiceError::StaleVersion,
        TeamRepositoryError::OperationTimeout => TeamServiceError::OperationTimeout,
        TeamRepositoryError::PersistenceUnavailable => TeamServiceError::DatabaseUnavailable,
    }
}

fn map_sql_error(error: sqlx::Error) -> TeamServiceError {
    if error
        .as_database_error()
        .is_some_and(|database| matches!(database.code().as_deref(), Some("57014" | "55P03")))
    {
        TeamServiceError::OperationTimeout
    } else {
        TeamServiceError::DatabaseUnavailable
    }
}

fn map_project_access_error(error: ProjectAccessError) -> TeamServiceError {
    match error {
        ProjectAccessError::ProjectUnavailable
        | ProjectAccessError::ProjectNotOrganizationOwned => TeamServiceError::ProjectUnavailable,
        ProjectAccessError::MemberUnavailable => TeamServiceError::UserUnavailable,
        ProjectAccessError::AlreadyGranted => TeamServiceError::InvariantViolation,
        ProjectAccessError::OperationTimeout => TeamServiceError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => TeamServiceError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => TeamServiceError::InvariantViolation,
    }
}
