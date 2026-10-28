#![allow(unused_imports)]
use super::authorization::*;
use super::*;
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

use super::super::{
    NewTeam, Team, TeamAction, TeamAuthorization, TeamAuthorizationPrincipal, TeamConflict,
    TeamDisplayName, TeamId, TeamMemberPageKey, TeamMemberPageLimit, TeamMembership,
    TeamMembershipPage, TeamMembershipVersion, TeamOrganizationMembership, TeamPage, TeamPageKey,
    TeamPageLimit, TeamProjectRoleGrant, TeamProjectRolePage, TeamProjectRolePageKey,
    TeamProjectRolePageLimit, TeamProjectRoleVersion, TeamRepository, TeamRepositoryError,
    TeamRole, TeamSlug, TeamVersion,
};
use super::{
    DEFAULT_OPERATION_TIMEOUT, MAX_OPERATION_TIMEOUT, MIN_OPERATION_TIMEOUT, TeamAuditContext,
    TeamMutationResult, TeamPrincipal, TeamService, TeamServiceError, TeamServicePolicy,
};

impl super::TeamServicePolicy {
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

impl TeamPrincipal {
    #[must_use]
    pub const fn user_id(self) -> UserId {
        match self {
            Self::User(id) | Self::InstanceAdministrator(id) => id,
        }
    }
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

    pub(crate) async fn create_inner(
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

    pub(crate) async fn get_inner(
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

    pub(crate) async fn list_inner(
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

    pub(crate) async fn rename_inner(
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

    pub(crate) async fn delete_inner(
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

    pub(crate) async fn list_members_inner(
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

    pub(crate) async fn add_member_inner(
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

    pub(crate) async fn change_member_role_inner(
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

    pub(crate) async fn remove_member_inner(
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

    pub(crate) async fn list_project_roles_inner(
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

    pub(crate) async fn add_project_role_inner(
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

    pub(crate) async fn change_project_role_inner(
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

    pub(crate) async fn remove_project_role_inner(
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

    pub(crate) async fn acquire(&self) -> Result<PoolConnection<Postgres>, TeamServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| TeamServiceError::DatabaseUnavailable)
    }

    pub(crate) async fn begin<'a>(
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

    pub(crate) async fn within_deadline<T>(
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

    pub(crate) fn ensure_audit_actor(
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
