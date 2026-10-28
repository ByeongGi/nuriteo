#![allow(unused_imports)]
use super::*;
use super::audit_context::*;
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



impl super::ProjectService {    #[must_use]
    pub const fn new(pool: DatabasePool, policy: ProjectServicePolicy) -> Self {
        Self { pool, policy }
    }
    pub async fn create(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        slug: ProjectSlug,
        name: ProjectName,
        template: ProjectTemplate,
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
                    template,
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
    pub(crate) async fn create_inner(
        &self,
        actor_user_id: UserId,
        owner: ProjectOwner,
        project_id: ProjectId,
        slug: ProjectSlug,
        name: ProjectName,
        template: ProjectTemplate,
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
        let candidate = NewProject::new(
            project_id,
            owner,
            storage_scope_id,
            slug,
            name,
            template,
            now,
        );
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
    pub(crate) async fn get_inner(
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
    pub(crate) async fn list_inner(
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
    pub(crate) async fn list_direct_roles_inner(
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
    pub(crate) async fn rename_inner(
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
    pub(crate) async fn set_archived_inner(
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
    pub(crate) async fn delete_inner(
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
        if confirmation.name != *project.name() {
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
    pub(crate) async fn grant_role_inner(
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
    pub(crate) async fn change_role_inner(
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
}
