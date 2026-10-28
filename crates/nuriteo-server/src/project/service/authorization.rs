#![allow(unused_imports)]
use super::audit_context::*;
use super::commit::*;
use super::projects::*;
use super::*;
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
use super::{
    COMMIT_RESOLUTION_GRACE, DATABASE_TIMEOUT_RESOLUTION_MARGIN, DEFAULT_OPERATION_TIMEOUT,
    DEFAULT_PROJECT_ROLE_PAGE_SIZE, DirectProjectRolePage, GrantRow, ListAuthorization,
    MAX_OPERATION_TIMEOUT, MAX_PROJECT_ROLE_PAGE_SIZE, MIN_DATABASE_TIMEOUT, MIN_OPERATION_TIMEOUT,
    MutationDeadline, ProjectAuditContext, ProjectDeleteConfirmation, ProjectListPage,
    ProjectRoleMutationResult, ProjectRolePageKey, ProjectRolePageLimit, ProjectRow,
    ProjectService, ProjectServiceError, ProjectServicePolicy,
};

impl super::ProjectService {
    #[allow(
        clippy::too_many_arguments,
        reason = "role mutation inputs remain explicit"
    )]
    pub(crate) async fn revoke_role_inner(
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
    pub(crate) async fn acquire(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<Postgres>, ProjectServiceError> {
        self.pool
            .acquire()
            .await
            .map_err(|_| ProjectServiceError::DatabaseUnavailable)
    }
    pub(crate) async fn within_deadline<T>(
        &self,
        future: impl Future<Output = Result<T, ProjectServiceError>>,
    ) -> Result<T, ProjectServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, future)
            .await
            .map_err(|_| ProjectServiceError::OperationTimeout)?
    }
    pub(crate) async fn within_mutation_deadline<T>(
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
    pub(crate) fn ensure_audit_actor(
        &self,
        actor_user_id: UserId,
        audit: &ProjectAuditContext,
    ) -> Result<(), ProjectServiceError> {
        if actor_user_id != audit.actor_user_id {
            return Err(ProjectServiceError::InvalidInput);
        }
        Ok(())
    }
    pub(crate) async fn finish_mutation<T>(
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
    pub(crate) async fn record_failure(
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
    pub(crate) const fn requires_failure_audit(self) -> bool {
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

    pub(crate) const fn audit_result(self) -> AuditResult {
        match self {
            Self::NotFound
            | Self::Unauthorized
            | Self::UserUnavailable
            | Self::Archived
            | Self::ConfirmationRequired => AuditResult::Denied,
            _ => AuditResult::Failed,
        }
    }

    pub(crate) const fn reason_code(self) -> &'static str {
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

pub(crate) async fn authorize_create(
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

pub(crate) async fn authorize_list(
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

pub(crate) async fn authorize_mutation(
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

pub(crate) async fn authorize_role_management(
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

pub(crate) async fn require_active_user(
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

pub(crate) async fn require_active_organization(
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

pub(crate) async fn lock_membership_role(
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

pub(crate) async fn storage_scope_for_owner(
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

pub(crate) async fn query_authorized_page(
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
                        storage_scope_id::text, slug, name, template_id, state, created_at, updated_at, \
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
                        storage_scope_id::text, slug, name, template_id, state, created_at, updated_at, \
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
                        p.storage_scope_id::text, p.slug, p.name, p.template_id, p.state, p.created_at, \
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

pub(crate) fn decode_list_page(
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

pub(crate) fn decode_project(row: ProjectRow) -> Result<Project, ProjectServiceError> {
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
    let template =
        ProjectTemplate::parse(&row.6).map_err(|_| ProjectServiceError::InvariantViolation)?;
    let state = match row.7.as_str() {
        "active" => ProjectState::Active,
        "archived" => ProjectState::Archived,
        _ => return Err(ProjectServiceError::InvariantViolation),
    };
    let created_at =
        Timestamp::from_datetime(row.8).map_err(|_| ProjectServiceError::InvariantViolation)?;
    let updated_at =
        Timestamp::from_datetime(row.9).map_err(|_| ProjectServiceError::InvariantViolation)?;
    let archived_at = row
        .10
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| ProjectServiceError::InvariantViolation)?;
    let version =
        ProjectVersion::new(row.11).map_err(|_| ProjectServiceError::InvariantViolation)?;
    Project::reconstruct(
        id,
        owner,
        storage_scope_id,
        slug,
        name,
        template,
        state,
        created_at,
        updated_at,
        archived_at,
        version,
    )
    .map_err(|_| ProjectServiceError::InvariantViolation)
}

pub(crate) fn decode_grant(row: GrantRow) -> Result<DirectProjectRoleGrant, ProjectServiceError> {
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

pub(crate) fn reconstruct_changed_project(
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
        project.template(),
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

pub(crate) fn ensure_active(project: &Project) -> Result<(), ProjectServiceError> {
    if project.state() != ProjectState::Active {
        return Err(ProjectServiceError::Archived);
    }
    Ok(())
}

pub(crate) fn require_one_versioned_row(rows_affected: u64) -> Result<(), ProjectServiceError> {
    if rows_affected != 1 {
        return Err(ProjectServiceError::StaleVersion);
    }
    Ok(())
}

pub(crate) async fn advance_project_version(
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

pub(crate) async fn append_success_audit(
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
pub(crate) async fn append_role_audit(
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
pub(crate) fn build_audit_event(
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

pub(crate) async fn transaction_now(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Timestamp, ProjectServiceError> {
    let value: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_service_query_error)?;
    Timestamp::from_datetime(value).map_err(|_| ProjectServiceError::InvariantViolation)
}
