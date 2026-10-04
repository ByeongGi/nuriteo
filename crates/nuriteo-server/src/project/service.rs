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
    ProjectSlug, ProjectState, ProjectVersion,
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

impl ProjectServicePolicy {
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

impl Default for ProjectServicePolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}

#[derive(Clone)]
pub struct ProjectAuditContext {
    event_id: AuditEventId,
    actor_user_id: UserId,
    actor_display_name: Option<String>,
    correlation_id: String,
    source_ip: Option<IpAddr>,
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

impl fmt::Debug for ProjectAuditContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectAuditContext")
            .field("event_id", &self.event_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectListPage {
    projects: Vec<Project>,
    next_key: Option<ProjectPageKey>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectRolePageLimit(u16);

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

impl Default for ProjectRolePageLimit {
    fn default() -> Self {
        Self(DEFAULT_PROJECT_ROLE_PAGE_SIZE)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectRolePageKey {
    user_id: UserId,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectProjectRolePage {
    grants: Vec<DirectProjectRoleGrant>,
    next_key: Option<ProjectRolePageKey>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDeleteConfirmation {
    name: ProjectName,
    recently_reauthenticated: bool,
}

impl ProjectDeleteConfirmation {
    #[must_use]
    pub const fn new(name: ProjectName, recently_reauthenticated: bool) -> Self {
        Self {
            name,
            recently_reauthenticated,
        }
    }
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

impl fmt::Display for ProjectServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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

#[derive(Clone)]
pub struct ProjectService {
    pool: DatabasePool,
    policy: ProjectServicePolicy,
}

#[derive(Clone)]
struct MutationDeadline {
    at: tokio_time::Instant,
    commit_started: Arc<AtomicBool>,
}

impl MutationDeadline {
    fn new(timeout: Duration) -> Self {
        Self {
            at: tokio_time::Instant::now() + timeout,
            commit_started: Arc::new(AtomicBool::new(false)),
        }
    }

    fn remaining(&self) -> Result<Duration, ProjectServiceError> {
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

impl ProjectService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: ProjectServicePolicy) -> Self {
        Self { pool, policy }
    }

    pub async fn create(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        slug: ProjectSlug,
        name: ProjectName,
        audit: &ProjectAuditContext,
    ) -> Result<Project, ProjectServiceError> {
        self.ensure_audit_actor(actor_user_id, audit)?;
        let project_id = ProjectId::new();
        let deadline = MutationDeadline::new(self.policy.operation_timeout);
        let result = self
            .within_mutation_deadline(
                &deadline,
                self.create_inner(
                    actor_user_id,
                    owner,
                    project_id,
                    slug,
                    name,
                    audit,
                    &deadline,
                ),
            )
            .await;
        self.finish_mutation(result, audit, project_id, "project.created", &deadline)
            .await
    }

    pub async fn get(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<Project, ProjectServiceError> {
        self.within_deadline(self.get_inner(actor_user_id, owner, project_id))
            .await
    }

    pub async fn list(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        limit: ProjectPageLimit,
        after: Option<&ProjectPageKey>,
    ) -> Result<ProjectListPage, ProjectServiceError> {
        self.list_filtered(actor_user_id, owner, limit, after, None)
            .await
    }

    pub async fn list_filtered(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        limit: ProjectPageLimit,
        after: Option<&ProjectPageKey>,
        state: Option<ProjectState>,
    ) -> Result<ProjectListPage, ProjectServiceError> {
        self.within_deadline(self.list_inner(actor_user_id, owner, limit, after, state))
            .await
    }

    pub async fn list_direct_roles(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        limit: ProjectRolePageLimit,
        after: Option<ProjectRolePageKey>,
    ) -> Result<DirectProjectRolePage, ProjectServiceError> {
        self.within_deadline(self.list_direct_roles_inner(
            actor_user_id,
            owner,
            project_id,
            limit,
            after,
        ))
        .await
    }

    pub async fn rename(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_version: ProjectVersion,
        name: ProjectName,
        audit: &ProjectAuditContext,
    ) -> Result<Project, ProjectServiceError> {
        self.ensure_audit_actor(actor_user_id, audit)?;
        let deadline = MutationDeadline::new(self.policy.operation_timeout);
        let result = self
            .within_mutation_deadline(
                &deadline,
                self.rename_inner(
                    actor_user_id,
                    owner,
                    project_id,
                    expected_version,
                    name,
                    audit,
                    &deadline,
                ),
            )
            .await;
        self.finish_mutation(result, audit, project_id, "project.renamed", &deadline)
            .await
    }

    pub async fn archive(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_version: ProjectVersion,
        audit: &ProjectAuditContext,
    ) -> Result<Project, ProjectServiceError> {
        self.ensure_audit_actor(actor_user_id, audit)?;
        let deadline = MutationDeadline::new(self.policy.operation_timeout);
        let result = self
            .within_mutation_deadline(
                &deadline,
                self.set_archived_inner(
                    actor_user_id,
                    owner,
                    project_id,
                    expected_version,
                    true,
                    audit,
                    &deadline,
                ),
            )
            .await;
        self.finish_mutation(result, audit, project_id, "project.archived", &deadline)
            .await
    }

    pub async fn restore(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_version: ProjectVersion,
        audit: &ProjectAuditContext,
    ) -> Result<Project, ProjectServiceError> {
        self.ensure_audit_actor(actor_user_id, audit)?;
        let deadline = MutationDeadline::new(self.policy.operation_timeout);
        let result = self
            .within_mutation_deadline(
                &deadline,
                self.set_archived_inner(
                    actor_user_id,
                    owner,
                    project_id,
                    expected_version,
                    false,
                    audit,
                    &deadline,
                ),
            )
            .await;
        self.finish_mutation(result, audit, project_id, "project.restored", &deadline)
            .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "destructive mutation inputs remain explicit at the security boundary"
    )]
    pub async fn delete(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_version: ProjectVersion,
        confirmation: &ProjectDeleteConfirmation,
        audit: &ProjectAuditContext,
    ) -> Result<(), ProjectServiceError> {
        self.ensure_audit_actor(actor_user_id, audit)?;
        let deadline = MutationDeadline::new(self.policy.operation_timeout);
        let result = self
            .within_mutation_deadline(
                &deadline,
                self.delete_inner(
                    actor_user_id,
                    owner,
                    project_id,
                    expected_version,
                    confirmation,
                    audit,
                    &deadline,
                ),
            )
            .await;
        self.finish_mutation(result, audit, project_id, "project.deleted", &deadline)
            .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "role mutation inputs remain explicit at the authorization boundary"
    )]
    pub async fn grant_role(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_project_version: ProjectVersion,
        target_user_id: UserId,
        role: ProjectRole,
        audit: &ProjectAuditContext,
    ) -> Result<DirectProjectRoleGrant, ProjectServiceError> {
        self.ensure_audit_actor(actor_user_id, audit)?;
        let deadline = MutationDeadline::new(self.policy.operation_timeout);
        let result = self
            .within_mutation_deadline(
                &deadline,
                self.grant_role_inner(
                    actor_user_id,
                    owner,
                    project_id,
                    expected_project_version,
                    target_user_id,
                    role,
                    audit,
                    &deadline,
                ),
            )
            .await;
        self.finish_mutation(result, audit, project_id, "project.role_granted", &deadline)
            .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "role mutation inputs remain explicit at the authorization boundary"
    )]
    pub async fn change_role(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_project_version: ProjectVersion,
        target_user_id: UserId,
        role: ProjectRole,
        audit: &ProjectAuditContext,
    ) -> Result<DirectProjectRoleGrant, ProjectServiceError> {
        self.ensure_audit_actor(actor_user_id, audit)?;
        let deadline = MutationDeadline::new(self.policy.operation_timeout);
        let result = self
            .within_mutation_deadline(
                &deadline,
                self.change_role_inner(
                    actor_user_id,
                    owner,
                    project_id,
                    expected_project_version,
                    target_user_id,
                    role,
                    audit,
                    &deadline,
                ),
            )
            .await;
        self.finish_mutation(result, audit, project_id, "project.role_changed", &deadline)
            .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "role mutation inputs remain explicit at the authorization boundary"
    )]
    pub async fn revoke_role(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_project_version: ProjectVersion,
        target_user_id: UserId,
        audit: &ProjectAuditContext,
    ) -> Result<ProjectRoleMutationResult, ProjectServiceError> {
        self.ensure_audit_actor(actor_user_id, audit)?;
        let deadline = MutationDeadline::new(self.policy.operation_timeout);
        let result = self
            .within_mutation_deadline(
                &deadline,
                self.revoke_role_inner(
                    actor_user_id,
                    owner,
                    project_id,
                    expected_project_version,
                    target_user_id,
                    audit,
                    &deadline,
                ),
            )
            .await;
        self.finish_mutation(result, audit, project_id, "project.role_revoked", &deadline)
            .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "transactional project creation keeps authorization, audit, and deadline explicit"
    )]
    async fn create_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        slug: ProjectSlug,
        name: ProjectName,
        audit: &ProjectAuditContext,
        deadline: &MutationDeadline,
    ) -> Result<Project, ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        configure_transaction_deadline(&mut transaction, deadline).await?;
        let now = transaction_now(&mut transaction).await?;
        let storage_scope_id = authorize_create(&mut transaction, actor_user_id, owner).await?;
        let candidate = NewProject::new(project_id, owner, storage_scope_id, slug, name, now);
        let project = ProjectRepository::create(&mut transaction, &candidate)
            .await
            .map_err(map_repository_error)?;
        append_success_audit(
            &mut transaction,
            audit,
            now,
            project_id,
            "project.created",
            vec!["project".into(), "owner".into(), "storage_scope".into()],
        )
        .await?;
        commit(transaction, deadline).await?;
        Ok(project)
    }

    async fn get_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<Project, ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        if ProjectRepository::get_by_id(&mut transaction, owner, project_id)
            .await
            .map_err(map_repository_error)?
            .is_none()
        {
            return Err(ProjectServiceError::NotFound);
        }
        let role = ProjectAccessRepository::resolve_effective_role(
            &mut transaction,
            project_id,
            actor_user_id,
        )
        .await
        .map_err(map_access_error)?;
        if role < EffectiveProjectRole::Read {
            return Err(ProjectServiceError::NotFound);
        }
        // Authorization holds the Project SHARE lock. Re-read the canonical row
        // under that lock so an archive racing the initial namespace probe cannot
        // return a stale lifecycle or lock_version projection.
        let project = ProjectRepository::get_by_id(&mut transaction, owner, project_id)
            .await
            .map_err(map_repository_error)?
            .ok_or(ProjectServiceError::NotFound)?;
        transaction
            .commit()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        Ok(project)
    }

    async fn list_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        limit: ProjectPageLimit,
        after: Option<&ProjectPageKey>,
        state: Option<ProjectState>,
    ) -> Result<ProjectListPage, ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        let authorization = authorize_list(&mut transaction, actor_user_id, owner).await?;
        let page = query_authorized_page(
            &mut transaction,
            actor_user_id,
            owner,
            authorization,
            limit,
            after,
            state,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        Ok(page)
    }

    async fn list_direct_roles_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        limit: ProjectRolePageLimit,
        after: Option<ProjectRolePageKey>,
    ) -> Result<DirectProjectRolePage, ProjectServiceError> {
        let ProjectOwner::Organization(organization_id) = owner else {
            return Err(ProjectServiceError::NotFound);
        };
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        if ProjectRepository::get_by_id(&mut transaction, owner, project_id)
            .await
            .map_err(map_repository_error)?
            .is_none()
        {
            return Err(ProjectServiceError::NotFound);
        }
        let effective = ProjectAccessRepository::resolve_effective_role(
            &mut transaction,
            project_id,
            actor_user_id,
        )
        .await
        .map_err(map_access_error)?;
        if effective != EffectiveProjectRole::Admin
            || lock_membership_role(&mut transaction, organization_id, actor_user_id)
                .await?
                .as_deref()
                != Some("owner")
        {
            return Err(ProjectServiceError::Unauthorized);
        }
        let rows = sqlx::query_as::<_, GrantRow>(
            "SELECT project_id::text, organization_id::text, user_id::text, role, \
                    created_at, updated_at, lock_version FROM project_user_roles \
             WHERE project_id=$1::uuid AND organization_id=$2::uuid \
               AND ($3::uuid IS NULL OR user_id>$3::uuid) \
             ORDER BY user_id LIMIT $4",
        )
        .bind(project_id.to_string())
        .bind(organization_id.to_string())
        .bind(after.map(|key| key.user_id().to_string()))
        .bind(i64::from(limit.get()) + 1)
        .fetch_all(&mut *transaction)
        .await
        .map_err(map_service_query_error)?;
        let mut grants = rows
            .into_iter()
            .map(decode_grant)
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = grants.len() > usize::from(limit.get());
        grants.truncate(usize::from(limit.get()));
        let next_key = if has_more {
            Some(ProjectRolePageKey::new(
                grants
                    .last()
                    .ok_or(ProjectServiceError::InvariantViolation)?
                    .user_id(),
            ))
        } else {
            None
        };
        transaction
            .commit()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        Ok(DirectProjectRolePage { grants, next_key })
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "versioned rename keeps authorization, audit, and deadline explicit"
    )]
    async fn rename_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_version: ProjectVersion,
        name: ProjectName,
        audit: &ProjectAuditContext,
        deadline: &MutationDeadline,
    ) -> Result<Project, ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        configure_transaction_deadline(&mut transaction, deadline).await?;
        let (project, now) = authorize_mutation(
            &mut transaction,
            actor_user_id,
            owner,
            project_id,
            EffectiveProjectRole::Admin,
            expected_version,
        )
        .await?;
        ensure_active(&project)?;
        let next =
            reconstruct_changed_project(&project, name.clone(), ProjectState::Active, now, None)?;
        let result = sqlx::query(
            "UPDATE projects SET name=$3, updated_at=$4::timestamptz, \
             lock_version=lock_version+1 WHERE id=$1::uuid AND lock_version=$2 AND state='active'",
        )
        .bind(project_id.to_string())
        .bind(expected_version.get())
        .bind(name.as_str())
        .bind(now.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(map_service_query_error)?;
        require_one_versioned_row(result.rows_affected())?;
        append_success_audit(
            &mut transaction,
            audit,
            now,
            project_id,
            "project.renamed",
            vec!["name".into()],
        )
        .await?;
        commit(transaction, deadline).await?;
        Ok(next)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "lifecycle mutation inputs remain explicit"
    )]
    async fn set_archived_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_version: ProjectVersion,
        archive: bool,
        audit: &ProjectAuditContext,
        deadline: &MutationDeadline,
    ) -> Result<Project, ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        configure_transaction_deadline(&mut transaction, deadline).await?;
        let (project, now) = authorize_mutation(
            &mut transaction,
            actor_user_id,
            owner,
            project_id,
            EffectiveProjectRole::Admin,
            expected_version,
        )
        .await?;
        match (project.state(), archive) {
            (ProjectState::Active, true) | (ProjectState::Archived, false) => {}
            _ => return Err(ProjectServiceError::InvalidLifecycle),
        }
        let (state, archived_at, action) = if archive {
            (ProjectState::Archived, Some(now), "project.archived")
        } else {
            (ProjectState::Active, None, "project.restored")
        };
        let next =
            reconstruct_changed_project(&project, project.name().clone(), state, now, archived_at)?;
        let result = sqlx::query(
            "UPDATE projects SET state=$3, archived_at=$4::timestamptz, \
             updated_at=$5::timestamptz, lock_version=lock_version+1 \
             WHERE id=$1::uuid AND lock_version=$2",
        )
        .bind(project_id.to_string())
        .bind(expected_version.get())
        .bind(if archive { "archived" } else { "active" })
        .bind(archived_at.map(|value| value.to_string()))
        .bind(now.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(map_service_query_error)?;
        require_one_versioned_row(result.rows_affected())?;
        append_success_audit(
            &mut transaction,
            audit,
            now,
            project_id,
            action,
            vec!["state".into(), "archived_at".into()],
        )
        .await?;
        commit(transaction, deadline).await?;
        Ok(next)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "destructive mutation inputs remain explicit"
    )]
    async fn delete_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_version: ProjectVersion,
        confirmation: &ProjectDeleteConfirmation,
        audit: &ProjectAuditContext,
        deadline: &MutationDeadline,
    ) -> Result<(), ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        configure_transaction_deadline(&mut transaction, deadline).await?;
        let (project, now) = authorize_mutation(
            &mut transaction,
            actor_user_id,
            owner,
            project_id,
            EffectiveProjectRole::Admin,
            expected_version,
        )
        .await?;
        if !confirmation.recently_reauthenticated || confirmation.name != *project.name() {
            return Err(ProjectServiceError::ConfirmationRequired);
        }
        sqlx::query("SELECT set_config('nuriteo.project_delete_id',$1,true)")
            .bind(project_id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(map_service_query_error)?;
        let result = sqlx::query("DELETE FROM projects WHERE id=$1::uuid AND lock_version=$2")
            .bind(project_id.to_string())
            .bind(expected_version.get())
            .execute(&mut *transaction)
            .await
            .map_err(map_service_query_error)?;
        require_one_versioned_row(result.rows_affected())?;
        append_success_audit(
            &mut transaction,
            audit,
            now,
            project_id,
            "project.deleted",
            vec!["project".into(), "project_roles".into()],
        )
        .await?;
        commit(transaction, deadline).await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "role mutation inputs remain explicit"
    )]
    async fn grant_role_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_project_version: ProjectVersion,
        target_user_id: UserId,
        role: ProjectRole,
        audit: &ProjectAuditContext,
        deadline: &MutationDeadline,
    ) -> Result<DirectProjectRoleGrant, ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        configure_transaction_deadline(&mut transaction, deadline).await?;
        let now = authorize_role_management(
            &mut transaction,
            actor_user_id,
            owner,
            project_id,
            expected_project_version,
            true,
        )
        .await?;
        let grant =
            ProjectAccessRepository::grant(&mut transaction, project_id, target_user_id, role, now)
                .await
                .map_err(map_access_error)?;
        advance_project_version(&mut transaction, project_id, expected_project_version, now)
            .await?;
        append_role_audit(
            &mut transaction,
            audit,
            now,
            project_id,
            target_user_id,
            "project.role_granted",
            vec!["role".into(), "project.lock_version".into()],
        )
        .await?;
        commit(transaction, deadline).await?;
        Ok(grant)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "role mutation inputs remain explicit"
    )]
    async fn change_role_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_project_version: ProjectVersion,
        target_user_id: UserId,
        role: ProjectRole,
        audit: &ProjectAuditContext,
        deadline: &MutationDeadline,
    ) -> Result<DirectProjectRoleGrant, ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        configure_transaction_deadline(&mut transaction, deadline).await?;
        let now = authorize_role_management(
            &mut transaction,
            actor_user_id,
            owner,
            project_id,
            expected_project_version,
            true,
        )
        .await?;
        if !ProjectAccessRepository::revoke(&mut transaction, project_id, target_user_id)
            .await
            .map_err(map_access_error)?
        {
            return Err(ProjectServiceError::MemberUnavailable);
        }
        let grant =
            ProjectAccessRepository::grant(&mut transaction, project_id, target_user_id, role, now)
                .await
                .map_err(map_access_error)?;
        advance_project_version(&mut transaction, project_id, expected_project_version, now)
            .await?;
        append_role_audit(
            &mut transaction,
            audit,
            now,
            project_id,
            target_user_id,
            "project.role_changed",
            vec!["role".into(), "project.lock_version".into()],
        )
        .await?;
        commit(transaction, deadline).await?;
        Ok(grant)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "role mutation inputs remain explicit"
    )]
    async fn revoke_role_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_project_version: ProjectVersion,
        target_user_id: UserId,
        audit: &ProjectAuditContext,
        deadline: &MutationDeadline,
    ) -> Result<ProjectRoleMutationResult, ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        configure_transaction_deadline(&mut transaction, deadline).await?;
        let now = authorize_role_management(
            &mut transaction,
            actor_user_id,
            owner,
            project_id,
            expected_project_version,
            false,
        )
        .await?;
        let changed = ProjectAccessRepository::revoke(&mut transaction, project_id, target_user_id)
            .await
            .map_err(map_access_error)?;
        if changed {
            advance_project_version(&mut transaction, project_id, expected_project_version, now)
                .await?;
        }
        append_role_audit(
            &mut transaction,
            audit,
            now,
            project_id,
            target_user_id,
            "project.role_revoked",
            if changed {
                vec!["role".into(), "project.lock_version".into()]
            } else {
                vec![]
            },
        )
        .await?;
        commit(transaction, deadline).await?;
        Ok(if changed {
            ProjectRoleMutationResult::Changed
        } else {
            ProjectRoleMutationResult::AlreadyAbsent
        })
    }

    async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<Postgres>, ProjectServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)
    }

    async fn within_deadline<T>(
        &self,
        future: impl Future<Output = Result<T, ProjectServiceError>>,
    ) -> Result<T, ProjectServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, future)
            .await
            .map_err(|_| ProjectServiceError::OperationTimeout)?
    }

    async fn within_mutation_deadline<T>(
        &self,
        deadline: &MutationDeadline,
        future: impl Future<Output = Result<T, ProjectServiceError>>,
    ) -> Result<T, ProjectServiceError> {
        tokio::pin!(future);
        tokio::select! {
            biased;
            _ = tokio_time::sleep_until(deadline.at) => {
                if deadline.commit_started.load(Ordering::Acquire) {
                    future.await
                } else {
                    Err(ProjectServiceError::OperationTimeout)
                }
            }
            result = &mut future => result,
        }
    }

    fn ensure_audit_actor(
        &self,
        actor_user_id: UserId,
        audit: &ProjectAuditContext,
    ) -> Result<(), ProjectServiceError> {
        if actor_user_id != audit.actor_user_id {
            return Err(ProjectServiceError::InvalidInput);
        }
        Ok(())
    }

    async fn finish_mutation<T>(
        &self,
        result: Result<T, ProjectServiceError>,
        audit: &ProjectAuditContext,
        project_id: ProjectId,
        action: &str,
        deadline: &MutationDeadline,
    ) -> Result<T, ProjectServiceError> {
        if let Err(error) = result {
            if error.requires_failure_audit() {
                self.within_mutation_deadline(
                    deadline,
                    self.record_failure(audit, project_id, action, error, deadline),
                )
                .await
                .map_err(|_| ProjectServiceError::AuditUnavailable)?;
            }
            return Err(error);
        }
        result
    }

    async fn record_failure(
        &self,
        audit: &ProjectAuditContext,
        project_id: ProjectId,
        action: &str,
        error: ProjectServiceError,
        deadline: &MutationDeadline,
    ) -> Result<(), ProjectServiceError> {
        let mut connection = self.acquire().await?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)?;
        configure_transaction_deadline(&mut transaction, deadline).await?;
        let now = transaction_now(&mut transaction).await?;
        let event = build_audit_event(
            audit,
            now,
            project_id,
            action,
            error.audit_result(),
            Some(error.reason_code().into()),
            vec![],
            "project",
            project_id.to_string(),
        )?;
        AuditWriter::append(&mut transaction, &event)
            .await
            .map_err(|_| ProjectServiceError::AuditUnavailable)?;
        commit(transaction, deadline).await
    }
}

impl ProjectServiceError {
    const fn requires_failure_audit(self) -> bool {
        matches!(
            self,
            Self::NotFound
                | Self::Unauthorized
                | Self::UserUnavailable
                | Self::Archived
                | Self::InvalidLifecycle
                | Self::NamespaceUnavailable
                | Self::MemberUnavailable
                | Self::RoleAlreadyExists
                | Self::StaleVersion
                | Self::ConfirmationRequired
        )
    }

    const fn audit_result(self) -> AuditResult {
        match self {
            Self::NotFound
            | Self::Unauthorized
            | Self::UserUnavailable
            | Self::Archived
            | Self::ConfirmationRequired => AuditResult::Denied,
            _ => AuditResult::Failed,
        }
    }

    const fn reason_code(self) -> &'static str {
        match self {
            Self::InvalidInput => "INVALID_INPUT",
            Self::NotFound => "NOT_FOUND",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::UserUnavailable => "USER_UNAVAILABLE",
            Self::Archived => "PROJECT_ARCHIVED",
            Self::InvalidLifecycle => "INVALID_LIFECYCLE",
            Self::NamespaceUnavailable => "NAMESPACE_UNAVAILABLE",
            Self::MemberUnavailable => "MEMBER_UNAVAILABLE",
            Self::RoleAlreadyExists => "ROLE_ALREADY_EXISTS",
            Self::StaleVersion => "STALE_VERSION",
            Self::ConfirmationRequired => "CONFIRMATION_REQUIRED",
            Self::AuditUnavailable => "AUDIT_UNAVAILABLE",
            Self::DatabaseUnavailable => "DATABASE_UNAVAILABLE",
            Self::OperationTimeout => "OPERATION_TIMEOUT",
            Self::CommitOutcomeUnknown => "COMMIT_OUTCOME_UNKNOWN",
            Self::InvariantViolation => "INVARIANT_VIOLATION",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListAuthorization {
    PersonalOwner,
    OrganizationOwner,
    OrganizationMember,
}

async fn authorize_create(
    transaction: &mut Transaction<'_, Postgres>,
    actor_user_id: UserId,
    owner: ProjectOwner,
) -> Result<StorageScopeId, ProjectServiceError> {
    match owner {
        ProjectOwner::User(owner_user_id) => {
            if actor_user_id != owner_user_id {
                return Err(ProjectServiceError::Unauthorized);
            }
            require_active_user(transaction, actor_user_id).await?;
            storage_scope_for_owner(transaction, owner).await
        }
        ProjectOwner::Organization(organization_id) => {
            require_active_organization(transaction, organization_id).await?;
            require_active_user(transaction, actor_user_id).await?;
            let role = lock_membership_role(transaction, organization_id, actor_user_id).await?;
            if role.as_deref() != Some("owner") {
                return Err(ProjectServiceError::Unauthorized);
            }
            storage_scope_for_owner(transaction, owner).await
        }
    }
}

async fn authorize_list(
    transaction: &mut Transaction<'_, Postgres>,
    actor_user_id: UserId,
    owner: ProjectOwner,
) -> Result<ListAuthorization, ProjectServiceError> {
    match owner {
        ProjectOwner::User(owner_user_id) => {
            if actor_user_id != owner_user_id {
                return Err(ProjectServiceError::NotFound);
            }
            require_active_user(transaction, actor_user_id).await?;
            Ok(ListAuthorization::PersonalOwner)
        }
        ProjectOwner::Organization(organization_id) => {
            require_active_organization(transaction, organization_id).await?;
            require_active_user(transaction, actor_user_id).await?;
            match lock_membership_role(transaction, organization_id, actor_user_id)
                .await?
                .as_deref()
            {
                Some("owner") => Ok(ListAuthorization::OrganizationOwner),
                Some("member") => Ok(ListAuthorization::OrganizationMember),
                None => Err(ProjectServiceError::NotFound),
                Some(_) => Err(ProjectServiceError::InvariantViolation),
            }
        }
    }
}

async fn authorize_mutation(
    transaction: &mut Transaction<'_, Postgres>,
    actor_user_id: UserId,
    owner: ProjectOwner,
    project_id: ProjectId,
    required_role: EffectiveProjectRole,
    expected_version: ProjectVersion,
) -> Result<(Project, Timestamp), ProjectServiceError> {
    if ProjectRepository::get_by_id(transaction, owner, project_id)
        .await
        .map_err(map_repository_error)?
        .is_none()
    {
        return Err(ProjectServiceError::NotFound);
    }
    let role = ProjectAccessRepository::resolve_effective_role_for_update(
        transaction,
        project_id,
        actor_user_id,
    )
    .await
    .map_err(map_access_error)?;
    if role < required_role {
        return Err(ProjectServiceError::Unauthorized);
    }
    let project = ProjectRepository::get_by_id(transaction, owner, project_id)
        .await
        .map_err(map_repository_error)?
        .ok_or(ProjectServiceError::NotFound)?;
    if project.lock_version() != expected_version {
        return Err(ProjectServiceError::StaleVersion);
    }
    let now = transaction_now(transaction).await?;
    Ok((project, now))
}

async fn authorize_role_management(
    transaction: &mut Transaction<'_, Postgres>,
    actor_user_id: UserId,
    owner: ProjectOwner,
    project_id: ProjectId,
    expected_version: ProjectVersion,
    require_active_project: bool,
) -> Result<Timestamp, ProjectServiceError> {
    let ProjectOwner::Organization(organization_id) = owner else {
        return Err(ProjectServiceError::Unauthorized);
    };
    let (project, now) = authorize_mutation(
        transaction,
        actor_user_id,
        owner,
        project_id,
        EffectiveProjectRole::Admin,
        expected_version,
    )
    .await?;
    if require_active_project {
        ensure_active(&project)?;
    }
    let role = lock_membership_role(transaction, organization_id, actor_user_id).await?;
    if role.as_deref() != Some("owner") {
        return Err(ProjectServiceError::Unauthorized);
    }
    Ok(now)
}

async fn require_active_user(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(), ProjectServiceError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM users WHERE id=$1::uuid FOR SHARE")
            .bind(user_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_service_query_error)?;
    match status.as_deref() {
        Some("active") => Ok(()),
        Some("disabled") | None => Err(ProjectServiceError::UserUnavailable),
        Some(_) => Err(ProjectServiceError::InvariantViolation),
    }
}

async fn require_active_organization(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
) -> Result<(), ProjectServiceError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM organizations WHERE id=$1::uuid FOR SHARE")
            .bind(organization_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(map_service_query_error)?;
    match status.as_deref() {
        Some("active") => Ok(()),
        Some("archived") => Err(ProjectServiceError::Archived),
        None => Err(ProjectServiceError::NotFound),
        Some(_) => Err(ProjectServiceError::InvariantViolation),
    }
}

async fn lock_membership_role(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: OrganizationId,
    user_id: UserId,
) -> Result<Option<String>, ProjectServiceError> {
    sqlx::query_scalar(
        "SELECT role FROM organization_memberships \
         WHERE organization_id=$1::uuid AND user_id=$2::uuid FOR SHARE",
    )
    .bind(organization_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_service_query_error)
}

async fn storage_scope_for_owner(
    transaction: &mut Transaction<'_, Postgres>,
    owner: ProjectOwner,
) -> Result<StorageScopeId, ProjectServiceError> {
    let value: Option<String> = match owner {
        ProjectOwner::User(id) => {
            sqlx::query_scalar(
                "SELECT id::text FROM storage_scopes \
             WHERE owner_user_id=$1::uuid AND owner_organization_id IS NULL FOR SHARE",
            )
            .bind(id.to_string())
            .fetch_optional(&mut **transaction)
            .await
        }
        ProjectOwner::Organization(id) => {
            sqlx::query_scalar(
                "SELECT id::text FROM storage_scopes \
             WHERE owner_organization_id=$1::uuid AND owner_user_id IS NULL FOR SHARE",
            )
            .bind(id.to_string())
            .fetch_optional(&mut **transaction)
            .await
        }
    }
    .map_err(map_service_query_error)?;
    value
        .ok_or(ProjectServiceError::InvariantViolation)?
        .parse()
        .map_err(|_| ProjectServiceError::InvariantViolation)
}

async fn query_authorized_page(
    transaction: &mut Transaction<'_, Postgres>,
    actor_user_id: UserId,
    owner: ProjectOwner,
    authorization: ListAuthorization,
    limit: ProjectPageLimit,
    after: Option<&ProjectPageKey>,
    state: Option<ProjectState>,
) -> Result<ProjectListPage, ProjectServiceError> {
    let after_slug = after.map(|key| key.slug().as_str().to_owned());
    let after_id = after.map(|key| key.id().to_string());
    let fetch_count = i64::from(limit.get()) + 1;
    let state = state.map(ProjectState::as_str);
    let rows = match (owner, authorization) {
        (ProjectOwner::User(owner_id), ListAuthorization::PersonalOwner) => {
            sqlx::query_as::<_, ProjectRow>(
                "SELECT id::text, owner_user_id::text, owner_organization_id::text, \
                        storage_scope_id::text, slug, name, state, created_at, updated_at, \
                        archived_at, lock_version FROM projects \
                 WHERE owner_user_id=$1::uuid AND owner_organization_id IS NULL \
                   AND ($2::text IS NULL OR (slug,id)>($2::text,$3::uuid)) \
                   AND ($5::text IS NULL OR state=$5::text) \
                 ORDER BY slug,id LIMIT $4",
            )
            .bind(owner_id.to_string())
            .bind(&after_slug)
            .bind(&after_id)
            .bind(fetch_count)
            .bind(state)
            .fetch_all(&mut **transaction)
            .await
        }
        (ProjectOwner::Organization(owner_id), ListAuthorization::OrganizationOwner) => {
            sqlx::query_as::<_, ProjectRow>(
                "SELECT id::text, owner_user_id::text, owner_organization_id::text, \
                        storage_scope_id::text, slug, name, state, created_at, updated_at, \
                        archived_at, lock_version FROM projects \
                 WHERE owner_organization_id=$1::uuid AND owner_user_id IS NULL \
                   AND ($2::text IS NULL OR (slug,id)>($2::text,$3::uuid)) \
                   AND ($5::text IS NULL OR state=$5::text) \
                 ORDER BY slug,id LIMIT $4",
            )
            .bind(owner_id.to_string())
            .bind(&after_slug)
            .bind(&after_id)
            .bind(fetch_count)
            .bind(state)
            .fetch_all(&mut **transaction)
            .await
        }
        (ProjectOwner::Organization(owner_id), ListAuthorization::OrganizationMember) => {
            sqlx::query_as::<_, ProjectRow>(
                "SELECT p.id::text, p.owner_user_id::text, p.owner_organization_id::text, \
                        p.storage_scope_id::text, p.slug, p.name, p.state, p.created_at, \
                        p.updated_at, p.archived_at, p.lock_version FROM projects p \
                 JOIN project_user_roles role ON role.project_id=p.id \
                    AND role.organization_id=p.owner_organization_id \
                 WHERE p.owner_organization_id=$1::uuid AND p.owner_user_id IS NULL \
                   AND role.user_id=$2::uuid \
                   AND ($3::text IS NULL OR (p.slug,p.id)>($3::text,$4::uuid)) \
                   AND ($6::text IS NULL OR p.state=$6::text) \
                 ORDER BY p.slug,p.id LIMIT $5",
            )
            .bind(owner_id.to_string())
            .bind(actor_user_id.to_string())
            .bind(&after_slug)
            .bind(&after_id)
            .bind(fetch_count)
            .bind(state)
            .fetch_all(&mut **transaction)
            .await
        }
        _ => return Err(ProjectServiceError::InvariantViolation),
    }
    .map_err(map_service_query_error)?;
    decode_list_page(rows, limit)
}

fn decode_list_page(
    rows: Vec<ProjectRow>,
    limit: ProjectPageLimit,
) -> Result<ProjectListPage, ProjectServiceError> {
    let mut projects = rows
        .into_iter()
        .map(decode_project)
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = projects.len() > usize::from(limit.get());
    projects.truncate(usize::from(limit.get()));
    let next_key = if has_more {
        let last = projects
            .last()
            .ok_or(ProjectServiceError::InvariantViolation)?;
        Some(ProjectPageKey::new(last.slug().clone(), last.id()))
    } else {
        None
    };
    Ok(ProjectListPage { projects, next_key })
}

fn decode_project(row: ProjectRow) -> Result<Project, ProjectServiceError> {
    let id = row
        .0
        .parse()
        .map_err(|_| ProjectServiceError::InvariantViolation)?;
    let owner_user_id = row
        .1
        .map(|value| value.parse())
        .transpose()
        .map_err(|_| ProjectServiceError::InvariantViolation)?;
    let owner_organization_id = row
        .2
        .map(|value| value.parse())
        .transpose()
        .map_err(|_| ProjectServiceError::InvariantViolation)?;
    let owner = ProjectOwner::from_nullable_ids(owner_user_id, owner_organization_id)
        .map_err(|_| ProjectServiceError::InvariantViolation)?;
    let storage_scope_id = row
        .3
        .parse()
        .map_err(|_| ProjectServiceError::InvariantViolation)?;
    let slug = ProjectSlug::new(row.4).map_err(|_| ProjectServiceError::InvariantViolation)?;
    let name = ProjectName::new(row.5).map_err(|_| ProjectServiceError::InvariantViolation)?;
    let state = match row.6.as_str() {
        "active" => ProjectState::Active,
        "archived" => ProjectState::Archived,
        _ => return Err(ProjectServiceError::InvariantViolation),
    };
    let created_at =
        Timestamp::from_datetime(row.7).map_err(|_| ProjectServiceError::InvariantViolation)?;
    let updated_at =
        Timestamp::from_datetime(row.8).map_err(|_| ProjectServiceError::InvariantViolation)?;
    let archived_at = row
        .9
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| ProjectServiceError::InvariantViolation)?;
    let version =
        ProjectVersion::new(row.10).map_err(|_| ProjectServiceError::InvariantViolation)?;
    Project::reconstruct(
        id,
        owner,
        storage_scope_id,
        slug,
        name,
        state,
        created_at,
        updated_at,
        archived_at,
        version,
    )
    .map_err(|_| ProjectServiceError::InvariantViolation)
}

fn decode_grant(row: GrantRow) -> Result<DirectProjectRoleGrant, ProjectServiceError> {
    DirectProjectRoleGrant::reconstruct(
        row.0
            .parse()
            .map_err(|_| ProjectServiceError::InvariantViolation)?,
        row.1
            .parse()
            .map_err(|_| ProjectServiceError::InvariantViolation)?,
        row.2
            .parse()
            .map_err(|_| ProjectServiceError::InvariantViolation)?,
        ProjectRole::parse(&row.3).map_err(map_access_error)?,
        Timestamp::from_datetime(row.4).map_err(|_| ProjectServiceError::InvariantViolation)?,
        Timestamp::from_datetime(row.5).map_err(|_| ProjectServiceError::InvariantViolation)?,
        ProjectRoleVersion::new(row.6).map_err(map_access_error)?,
    )
    .map_err(map_access_error)
}

fn reconstruct_changed_project(
    project: &Project,
    name: ProjectName,
    state: ProjectState,
    updated_at: Timestamp,
    archived_at: Option<Timestamp>,
) -> Result<Project, ProjectServiceError> {
    Project::reconstruct(
        project.id(),
        project.owner(),
        project.storage_scope_id(),
        project.slug().clone(),
        name,
        state,
        project.created_at(),
        updated_at,
        archived_at,
        project
            .lock_version()
            .next()
            .map_err(|_| ProjectServiceError::StaleVersion)?,
    )
    .map_err(|_| ProjectServiceError::InvariantViolation)
}

fn ensure_active(project: &Project) -> Result<(), ProjectServiceError> {
    if project.state() != ProjectState::Active {
        return Err(ProjectServiceError::Archived);
    }
    Ok(())
}

fn require_one_versioned_row(rows_affected: u64) -> Result<(), ProjectServiceError> {
    if rows_affected != 1 {
        return Err(ProjectServiceError::StaleVersion);
    }
    Ok(())
}

async fn advance_project_version(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    expected_version: ProjectVersion,
    now: Timestamp,
) -> Result<(), ProjectServiceError> {
    let result = sqlx::query(
        "UPDATE projects SET updated_at=$3::timestamptz, lock_version=lock_version+1 \
         WHERE id=$1::uuid AND lock_version=$2",
    )
    .bind(project_id.to_string())
    .bind(expected_version.get())
    .bind(now.to_string())
    .execute(&mut **transaction)
    .await
    .map_err(map_service_query_error)?;
    require_one_versioned_row(result.rows_affected())
}

async fn append_success_audit(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &ProjectAuditContext,
    occurred_at: Timestamp,
    project_id: ProjectId,
    action: &str,
    changed_fields: Vec<String>,
) -> Result<(), ProjectServiceError> {
    let event = build_audit_event(
        audit,
        occurred_at,
        project_id,
        action,
        AuditResult::Succeeded,
        None,
        changed_fields,
        "project",
        project_id.to_string(),
    )?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| ProjectServiceError::AuditUnavailable)
}

#[allow(
    clippy::too_many_arguments,
    reason = "audit fields are explicit security context"
)]
async fn append_role_audit(
    transaction: &mut Transaction<'_, Postgres>,
    audit: &ProjectAuditContext,
    occurred_at: Timestamp,
    project_id: ProjectId,
    target_user_id: UserId,
    action: &str,
    changed_fields: Vec<String>,
) -> Result<(), ProjectServiceError> {
    let event = build_audit_event(
        audit,
        occurred_at,
        project_id,
        action,
        AuditResult::Succeeded,
        None,
        changed_fields,
        "project_user_role",
        target_user_id.to_string(),
    )?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| ProjectServiceError::AuditUnavailable)
}

#[allow(
    clippy::too_many_arguments,
    reason = "audit fields are explicit security context"
)]
fn build_audit_event(
    audit: &ProjectAuditContext,
    occurred_at: Timestamp,
    project_id: ProjectId,
    action: &str,
    result: AuditResult,
    reason_code: Option<String>,
    changed_fields: Vec<String>,
    target_kind: &str,
    target_id: String,
) -> Result<AuditEvent, ProjectServiceError> {
    AuditEvent::new(AuditEventFields {
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
            kind: ScopeType::Project,
            id: project_id.to_string(),
        },
        result,
        reason_code,
        correlation_id: audit.correlation_id.clone(),
        source_ip: audit.source_ip,
        schema_version: 1,
        changed_fields,
        metadata: AuditMetadata::new(json!({"source": "project-service"}))
            .map_err(|_| ProjectServiceError::InvariantViolation)?,
    })
    .map_err(|_| ProjectServiceError::InvalidInput)
}

async fn transaction_now(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, ProjectServiceError> {
    let value: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_service_query_error)?;
    Timestamp::from_datetime(value).map_err(|_| ProjectServiceError::InvariantViolation)
}

async fn configure_transaction_deadline(
    transaction: &mut Transaction<'_, Postgres>,
    deadline: &MutationDeadline,
) -> Result<(), ProjectServiceError> {
    let timeout = postgres_timeout(deadline.remaining()?);
    sqlx::query(
        "SELECT set_config('statement_timeout', $1, true), \
                set_config('lock_timeout', $1, true)",
    )
    .bind(timeout)
    .execute(&mut **transaction)
    .await
    .map_err(map_service_query_error)?;
    Ok(())
}

fn postgres_timeout(remaining: Duration) -> String {
    let millis = remaining
        .saturating_sub(DATABASE_TIMEOUT_RESOLUTION_MARGIN)
        .max(MIN_DATABASE_TIMEOUT)
        .as_millis()
        .min(i32::MAX as u128);
    format!("{millis}ms")
}

async fn commit(
    mut transaction: Transaction<'_, Postgres>,
    deadline: &MutationDeadline,
) -> Result<(), ProjectServiceError> {
    configure_transaction_deadline(&mut transaction, deadline).await?;
    // Once COMMIT is sent, the operation deadline no longer cancels it: doing
    // so could turn a committed mutation into an apparent rollback. A separate
    // bounded resolution grace classifies response loss as unknown instead.
    deadline.commit_started.store(true, Ordering::Release);
    resolve_commit(transaction.commit(), COMMIT_RESOLUTION_GRACE).await
}

async fn resolve_commit(
    commit: impl Future<Output = Result<(), sqlx::Error>>,
    resolution_grace: Duration,
) -> Result<(), ProjectServiceError> {
    match tokio_time::timeout(resolution_grace, commit).await {
        Ok(result) => result.map_err(map_commit_error),
        Err(_) => Err(ProjectServiceError::CommitOutcomeUnknown),
    }
}

fn map_commit_error(error: sqlx::Error) -> ProjectServiceError {
    match error.as_database_error().and_then(|error| error.code()) {
        Some(code) if code == "57014" || code == "55P03" => ProjectServiceError::OperationTimeout,
        Some(_) => ProjectServiceError::DatabaseUnavailable,
        None => ProjectServiceError::CommitOutcomeUnknown,
    }
}

fn map_service_query_error(error: sqlx::Error) -> ProjectServiceError {
    match error.as_database_error().and_then(|error| error.code()) {
        Some(code) if code == "57014" || code == "55P03" => ProjectServiceError::OperationTimeout,
        _ => ProjectServiceError::DatabaseUnavailable,
    }
}

fn map_repository_error(error: ProjectRepositoryError) -> ProjectServiceError {
    match error {
        ProjectRepositoryError::Conflict(ProjectConflict::NamespaceUnavailable) => {
            ProjectServiceError::NamespaceUnavailable
        }
        ProjectRepositoryError::Conflict(
            ProjectConflict::IdentifierExists | ProjectConflict::OwnerScopeMismatch,
        )
        | ProjectRepositoryError::InvalidPersistedState => ProjectServiceError::InvariantViolation,
        ProjectRepositoryError::InvalidPageLimit => ProjectServiceError::InvalidInput,
        ProjectRepositoryError::OperationTimeout => ProjectServiceError::OperationTimeout,
        ProjectRepositoryError::PersistenceUnavailable => ProjectServiceError::DatabaseUnavailable,
    }
}

fn map_access_error(error: ProjectAccessError) -> ProjectServiceError {
    match error {
        ProjectAccessError::ProjectUnavailable => ProjectServiceError::NotFound,
        ProjectAccessError::ProjectNotOrganizationOwned => ProjectServiceError::Unauthorized,
        ProjectAccessError::MemberUnavailable => ProjectServiceError::MemberUnavailable,
        ProjectAccessError::AlreadyGranted => ProjectServiceError::RoleAlreadyExists,
        ProjectAccessError::InvalidPersistedState => ProjectServiceError::InvariantViolation,
        ProjectAccessError::OperationTimeout => ProjectServiceError::OperationTimeout,
        ProjectAccessError::PersistenceUnavailable => ProjectServiceError::DatabaseUnavailable,
    }
}

#[cfg(test)]
mod tests;
