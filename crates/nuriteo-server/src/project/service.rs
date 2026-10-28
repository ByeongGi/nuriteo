use std::fmt;

use std::future::Future;

use std::net::IpAddr;

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use std::time::Duration;

use serde_json::json;

use sqlx::{Acquire, Postgres, Transaction};

use time::OffsetDateTime;

use tokio::time as tokio_time;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};

use crate::database::DatabasePool;

use crate::identity::{Timestamp, UserId};

use crate::organization::OrganizationId;

use crate::workspace::StorageScopeId;

use super::{
    DirectProjectRoleGrant, EffectiveProjectRole, NewProject, Project, ProjectAccessError,
    ProjectAccessRepository, ProjectConflict, ProjectId, ProjectName, ProjectOwner, ProjectPageKey,
    ProjectPageLimit, ProjectRepository, ProjectRepositoryError, ProjectRole, ProjectRoleVersion,
    ProjectSlug, ProjectState, ProjectTemplate, ProjectVersion,
};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);

const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

const MIN_DATABASE_TIMEOUT: Duration = Duration::from_millis(1);

// Leave a small application-resolution window so PostgreSQL can return its
// typed timeout before the absolute Tokio deadline cancels the transaction.
const DATABASE_TIMEOUT_RESOLUTION_MARGIN: Duration = Duration::from_millis(25);

// COMMIT is a protocol boundary: after it is sent, a missing response does not
// prove whether PostgreSQL committed. Keep this grace independent from the
// operation budget so callers receive a bounded, honest outcome classification.
const COMMIT_RESOLUTION_GRACE: Duration = Duration::from_secs(2);

pub const DEFAULT_PROJECT_ROLE_PAGE_SIZE: u16 = 50;

pub const MAX_PROJECT_ROLE_PAGE_SIZE: u16 = 100;

type ProjectRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    Option<OffsetDateTime>,
    i64,
);

type GrantRow = (
    String,
    String,
    String,
    String,
    OffsetDateTime,
    OffsetDateTime,
    i64,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectServicePolicy {
    operation_timeout: Duration,
}

#[derive(Clone)]
pub struct ProjectAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    actor_display_name: Option<String>,
    correlation_id: String,
    source_ip: Option<IpAddr>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectListPage {
    projects: Vec<Project>,
    next_key: Option<ProjectPageKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectRolePageLimit(u16);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectRolePageKey {
    user_id: UserId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectProjectRolePage {
    grants: Vec<DirectProjectRoleGrant>,
    next_key: Option<ProjectRolePageKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDeleteConfirmation {
    name: ProjectName,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectRoleMutationResult {
    Changed,
    AlreadyAbsent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectServiceError {
    InvalidInput,
    NotFound,
    Unauthorized,
    UserUnavailable,
    Archived,
    InvalidLifecycle,
    NamespaceUnavailable,
    MemberUnavailable,
    RoleAlreadyExists,
    StaleVersion,
    ConfirmationRequired,
    AuditUnavailable,
    DatabaseUnavailable,
    OperationTimeout,
    CommitOutcomeUnknown,
    InvariantViolation,
}

#[derive(Clone)]
pub struct ProjectService {
    pool: DatabasePool,
    policy: ProjectServicePolicy,
}

#[derive(Clone)]
pub(crate) struct MutationDeadline {
    at: tokio_time::Instant,
    commit_started: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ListAuthorization {
    PersonalOwner,
    OrganizationOwner,
    OrganizationMember,
}

#[cfg(test)]
mod tests;

mod audit_context;
pub(crate) use audit_context::*;
mod projects;
pub(crate) use projects::*;
mod authorization;
pub(crate) use authorization::*;
mod commit;
pub(crate) use commit::*;
