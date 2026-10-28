#![allow(unused_imports)]
use super::*;
use super::teams::*;
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
use super::{DEFAULT_OPERATION_TIMEOUT, MIN_OPERATION_TIMEOUT, MAX_OPERATION_TIMEOUT, TeamServicePolicy, TeamPrincipal, TeamAuditContext, TeamMutationResult, TeamServiceError, TeamService};



pub(crate) async fn organization_authorization(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn authorize_team(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn lock_authorized_team(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn lock_authorized_team_for_project(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn lock_organization(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn probe_team_organization(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) fn ensure_team_version(team: &Team, expected: TeamVersion) -> Result<(), TeamServiceError> {    if team.lock_version() != expected {
        return Err(TeamServiceError::StaleVersion);
    }
    Ok(())
}


pub(crate) async fn lock_project(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn lock_project_binding_mutations(    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), TeamServiceError> {
    sqlx::query("SELECT pg_advisory_xact_lock(1413827917, hashtext($1))")
        .bind(organization_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(map_sql_error)?;
    Ok(())
}


pub(crate) async fn membership_version(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn project_role_version(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) fn parse_organization_status(value: &str) -> Result<OrganizationStatus, TeamServiceError> {    match value {
        "active" => Ok(OrganizationStatus::Active),
        "archived" => Ok(OrganizationStatus::Archived),
        _ => Err(TeamServiceError::InvariantViolation),
    }
}


pub(crate) fn parse_membership(    organization_id: OrganizationId,
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


pub(crate) fn parse_team_role(value: &str) -> Result<TeamRole, TeamServiceError> {    match value {
        "maintainer" => Ok(TeamRole::Maintainer),
        "member" => Ok(TeamRole::Member),
        _ => Err(TeamServiceError::InvariantViolation),
    }
}


#[allow(
    clippy::too_many_arguments,
    reason = "audit fields are explicit security context"
)]
pub(crate) async fn append_audit(    transaction: &mut Transaction<'_, Postgres>,
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


pub(crate) async fn transaction_now(    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, TeamServiceError> {
    let value: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_sql_error)?;
    Timestamp::from_datetime(value).map_err(|_| TeamServiceError::InvariantViolation)
}


pub(crate) async fn commit(transaction: Transaction<'_, Postgres>) -> Result<(), TeamServiceError> {    transaction.commit().await.map_err(map_sql_error)
}


pub(crate) fn map_repository_error(error: TeamRepositoryError) -> TeamServiceError {    match error {
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


pub(crate) fn map_sql_error(error: sqlx::Error) -> TeamServiceError {    if error
        .as_database_error()
        .is_some_and(|database| matches!(database.code().as_deref(), Some("57014" | "55P03")))
    {
        TeamServiceError::OperationTimeout
    } else {
        TeamServiceError::DatabaseUnavailable
    }
}


pub(crate) fn map_project_access_error(error: ProjectAccessError) -> TeamServiceError {    match error {
        ProjectAccessError::ProjectUnavailable
        | ProjectAccessError::ProjectNotOrganizationOwned => TeamServiceError::ProjectUnavailable,
        ProjectAccessError::MemberUnavailable => TeamServiceError::UserUnavailable,
        ProjectAccessError::AlreadyGranted => TeamServiceError::InvariantViolation,
        ProjectAccessError::OperationTimeout => TeamServiceError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => TeamServiceError::DatabaseUnavailable,
        ProjectAccessError::InvalidPersistedState => TeamServiceError::InvariantViolation,
    }
}

