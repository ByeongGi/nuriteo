#![allow(unused_imports)]
use super::*;
use super::projects::*;
use super::authorization::*;
use super::commit::*;
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


use super::super::{
    DirectProjectRoleGrant, EffectiveProjectRole, NewProject, Project, ProjectAccessError,
    ProjectAccessRepository, ProjectConflict, ProjectId, ProjectName, ProjectOwner, ProjectPageKey,
    ProjectPageLimit, ProjectRepository, ProjectRepositoryError, ProjectRole, ProjectRoleVersion,
    ProjectSlug, ProjectState, ProjectTemplate, ProjectVersion,
};
use super::{DEFAULT_OPERATION_TIMEOUT, MIN_OPERATION_TIMEOUT, MAX_OPERATION_TIMEOUT, MIN_DATABASE_TIMEOUT, DATABASE_TIMEOUT_RESOLUTION_MARGIN, COMMIT_RESOLUTION_GRACE, DEFAULT_PROJECT_ROLE_PAGE_SIZE, MAX_PROJECT_ROLE_PAGE_SIZE, ProjectRow, GrantRow, ProjectServicePolicy, ProjectAuditContext, ProjectListPage, ProjectRolePageLimit, ProjectRolePageKey, DirectProjectRolePage, ProjectDeleteConfirmation, ProjectRoleMutationResult, ProjectServiceError, ProjectService, MutationDeadline, ListAuthorization};



impl super::ProjectServicePolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, ProjectServiceError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(ProjectServiceError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }

    #[must_use]
    pub const fn operation_timeout(self) -> Duration {
        self.operation_timeout
    }
}


impl Default for ProjectServicePolicy { fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}


impl ProjectAuditContext {
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

    pub(crate) const fn event_id(&self) -> AuditEventId {
        self.event_id
    }

    pub(crate) const fn actor_user_id(&self) -> UserId {
        self.actor_user_id
    }

    pub(crate) fn actor_display_name(&self) -> Option<String> {
        self.actor_display_name.clone()
    }

    pub(crate) fn correlation_id(&self) -> String {
        self.correlation_id.clone()
    }

    pub(crate) const fn source_ip(&self) -> Option<IpAddr> {
        self.source_ip
    }
}


impl fmt::Debug for ProjectAuditContext { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectAuditContext")
            .field("event_id", &self.event_id)
            .finish_non_exhaustive()
    }
}


impl ProjectListPage {
    #[must_use]
    pub fn projects(&self) -> &[Project] {
        &self.projects
    }

    #[must_use]
    pub const fn next_key(&self) -> Option<&ProjectPageKey> {
        self.next_key.as_ref()
    }

    #[must_use]
    pub const fn has_more(&self) -> bool {
        self.next_key.is_some()
    }
}


impl ProjectRolePageLimit {
    pub fn new(value: u16) -> Result<Self, ProjectServiceError> {
        if !(1..=MAX_PROJECT_ROLE_PAGE_SIZE).contains(&value) {
            return Err(ProjectServiceError::InvalidInput);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u16 {
        self.0
    }
}


impl Default for ProjectRolePageLimit { fn default() -> Self {
        Self(DEFAULT_PROJECT_ROLE_PAGE_SIZE)
    }
}


impl ProjectRolePageKey {
    #[must_use]
    pub const fn new(user_id: UserId) -> Self {
        Self { user_id }
    }

    #[must_use]
    pub const fn user_id(self) -> UserId {
        self.user_id
    }
}


impl DirectProjectRolePage {
    #[must_use]
    pub fn grants(&self) -> &[DirectProjectRoleGrant] {
        &self.grants
    }

    #[must_use]
    pub const fn next_key(&self) -> Option<ProjectRolePageKey> {
        self.next_key
    }

    #[must_use]
    pub const fn has_more(&self) -> bool {
        self.next_key.is_some()
    }
}


impl ProjectDeleteConfirmation {
    #[must_use]
    pub const fn new(name: ProjectName) -> Self {
        Self { name }
    }
}


impl fmt::Display for ProjectServiceError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "project input is invalid",
            Self::NotFound => "project was not found",
            Self::Unauthorized => "project operation is not authorized",
            Self::UserUnavailable => "project user is unavailable",
            Self::Archived => "project is archived",
            Self::InvalidLifecycle => "project lifecycle transition is invalid",
            Self::NamespaceUnavailable => "project namespace is unavailable",
            Self::MemberUnavailable => "project role member is unavailable",
            Self::RoleAlreadyExists => "project role already exists",
            Self::StaleVersion => "project version is stale",
            Self::ConfirmationRequired => "project deletion confirmation is required",
            Self::AuditUnavailable => "project audit persistence is unavailable",
            Self::DatabaseUnavailable => "project persistence is unavailable",
            Self::OperationTimeout => "project operation timed out",
            Self::CommitOutcomeUnknown => "project commit outcome is unknown",
            Self::InvariantViolation => "project state is invalid",
        })
    }
}


impl std::error::Error for ProjectServiceError {}


impl MutationDeadline {
    pub(crate) fn new(timeout: Duration) -> Self {
        Self {
            at: tokio_time::Instant::now() + timeout,
            commit_started: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn remaining(&self) -> Result<Duration, ProjectServiceError> {
        let remaining = self
            .at
            .saturating_duration_since(tokio_time::Instant::now());
        if remaining.is_zero() {
            Err(ProjectServiceError::OperationTimeout)
        } else {
            Ok(remaining)
        }
    }
}
