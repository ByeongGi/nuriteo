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


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamPrincipal {
    User(UserId),
    InstanceAdministrator(UserId),
}


#[derive(Clone)]
pub struct TeamAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    actor_display_name: Option<String>,
    correlation_id: String,
    source_ip: Option<IpAddr>,
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


#[derive(Clone)]
pub struct TeamService {
    pool: DatabasePool,
    policy: TeamServicePolicy,
}

mod teams;
pub(crate) use teams::*;
mod authorization;
pub(crate) use authorization::*;
