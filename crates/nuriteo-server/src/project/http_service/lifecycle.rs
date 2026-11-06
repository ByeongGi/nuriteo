#![allow(unused_imports)]
use super::super::{
    DirectProjectRoleGrant, Project, ProjectAuditContext, ProjectDeleteConfirmation, ProjectId,
    ProjectName, ProjectOwner, ProjectPageKey, ProjectPageLimit, ProjectRepository, ProjectRole,
    ProjectRoleMutationResult, ProjectRolePageKey, ProjectRolePageLimit, ProjectService,
    ProjectServiceError, ProjectServicePolicy, ProjectSlug, ProjectState, ProjectTemplate,
    ProjectVersion,
};
use super::response_cursors::*;
use super::{
    BrowserIdentity, CURSOR_KEY_BYTES, CURSOR_PREFIX, CURSOR_TTL_SECONDS, CursorBinding,
    CursorClaims, CursorPosition, CursorSigner, MAX_CURSOR_BYTES, ProjectHttpError,
    ProjectHttpPolicy, ProjectHttpService, Runtime,
};
use crate::access_token::{
    AccessTokenAuthenticator, AccessTokenPrincipal, AccessTokenRequest, AccessTokenScope,
    AccessTokenServiceError, ApiCategory,
};
use crate::audit::AuditEventId;
use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionPolicy,
    SessionService, SessionServiceError, UserId,
};
use crate::object_storage::S3ObjectStore;
use crate::project::ProjectAccessError;
use crate::project::{EffectiveProjectRole, ProjectAccessRepository};
use crate::save::{
    ContentDescriptor, ContentDownload, ContentError, ContentService, ContentServicePolicy,
    CreateProjectVersion, ExplicitProjectVersion, HistoricalPromotionOutcome,
    HistoricalReferenceKind, ProjectHistoryError, ProjectHistoryService,
    ProjectHistoryServicePolicy, ProjectVersionError, ProjectVersionName, ProjectVersionPageKey,
    ProjectVersionPageLimit, ProjectVersionService, ProjectVersionServicePolicy,
    PromoteHistoricalReference, RecoveryCheckpoint,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::{Acquire, Postgres, Transaction};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use subtle::ConstantTimeEq;
use time::OffsetDateTime;
use tokio::time as tokio_time;
use url::Url;
use utoipa::ToSchema;

pub(crate) enum ProjectAccessTokenIdentity {
    User {
        user_id: UserId,
        display_name: String,
    },
    Project {
        bound_project_id: ProjectId,
    },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectView {
    pub(crate) id: String,
    pub(crate) owner_type: &'static str,
    pub(crate) owner_id: String,
    pub(crate) storage_scope_id: String,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) template_id: &'static str,
    pub(crate) state: &'static str,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) archived_at: Option<String>,
    pub(crate) version: i64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectListView {
    pub(crate) items: Vec<ProjectView>,
    pub(crate) next_cursor: Option<String>,
}

impl From<Project> for ProjectView {
    fn from(project: Project) -> Self {
        let (owner_type, owner_id) = match project.owner() {
            ProjectOwner::User(id) => ("user", id.to_string()),
            ProjectOwner::Organization(id) => ("organization", id.to_string()),
        };
        Self {
            id: project.id().to_string(),
            owner_type,
            owner_id,
            storage_scope_id: project.storage_scope_id().to_string(),
            slug: project.slug().to_string(),
            name: project.name().as_str().to_owned(),
            template_id: project.template().as_str(),
            state: match project.state() {
                ProjectState::Active => "active",
                ProjectState::Archived => "archived",
            },
            created_at: project.created_at().to_string(),
            updated_at: project.updated_at().to_string(),
            archived_at: project.archived_at().map(|value| value.to_string()),
            version: project.lock_version().get(),
        }
    }
}

impl ProjectHttpService {
    pub(crate) async fn create(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        slug: ProjectSlug,
        name: ProjectName,
        template: ProjectTemplate,
        correlation_id: &str,
    ) -> Result<ProjectView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .projects
            .create(
                identity.user_id,
                owner,
                slug,
                name,
                template,
                &identity.audit(correlation_id),
            )
            .await
            .map(ProjectView::from)
            .map_err(map_project_error)
    }

    pub(crate) async fn get(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<ProjectView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .projects
            .get(identity.user_id, owner, project_id)
            .await
            .map(ProjectView::from)
            .map_err(map_project_error)
    }

    pub(crate) async fn authenticate_access_token(
        &self,
        bearer: &str,
        required_scope: AccessTokenScope,
        project_id: ProjectId,
        category: ApiCategory,
    ) -> Result<ProjectAccessTokenIdentity, ProjectHttpError> {
        let runtime = self.runtime()?;
        let principal = runtime
            .access_tokens
            .authenticate(AccessTokenRequest {
                bearer,
                required_scope,
                project_id: Some(project_id),
                source_ip: None,
                category,
            })
            .await
            .map_err(map_access_token_error)?;
        match principal {
            AccessTokenPrincipal::User(user_id) => {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| ProjectHttpError::Unavailable)?;
                let row: Option<(String, String)> =
                    sqlx::query_as("SELECT display_name,status FROM users WHERE id=$1::uuid")
                        .bind(user_id.to_string())
                        .fetch_optional(&mut *connection)
                        .await
                        .map_err(|_| ProjectHttpError::Unavailable)?;
                let (display_name, status) = row.ok_or(ProjectHttpError::AuthenticationFailed)?;
                if status != "active" {
                    return Err(ProjectHttpError::AuthenticationFailed);
                }
                Ok(ProjectAccessTokenIdentity::User {
                    user_id,
                    display_name,
                })
            }
            AccessTokenPrincipal::Project(bound_project_id) => {
                Ok(ProjectAccessTokenIdentity::Project { bound_project_id })
            }
        }
    }

    pub(crate) async fn get_as_access_token(
        &self,
        identity: &ProjectAccessTokenIdentity,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<ProjectView, ProjectHttpError> {
        let runtime = self.runtime()?;
        match identity {
            ProjectAccessTokenIdentity::User { user_id, .. } => runtime
                .projects
                .get(*user_id, owner, project_id)
                .await
                .map(ProjectView::from)
                .map_err(map_project_error),
            ProjectAccessTokenIdentity::Project { bound_project_id }
                if *bound_project_id == project_id =>
            {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| ProjectHttpError::Unavailable)?;
                let mut transaction = connection
                    .begin()
                    .await
                    .map_err(|_| ProjectHttpError::Unavailable)?;
                let project = ProjectRepository::get_by_id(&mut transaction, owner, project_id)
                    .await
                    .map_err(|_| ProjectHttpError::Unavailable)?
                    .ok_or(ProjectHttpError::NotFound)?;
                transaction
                    .rollback()
                    .await
                    .map_err(|_| ProjectHttpError::Unavailable)?;
                Ok(ProjectView::from(project))
            }
            ProjectAccessTokenIdentity::Project { .. } => Err(ProjectHttpError::Forbidden),
        }
    }

    pub(crate) async fn archive_or_restore_as_access_token(
        &self,
        identity: &ProjectAccessTokenIdentity,
        owner: ProjectOwner,
        project_id: ProjectId,
        version: ProjectVersion,
        restore: bool,
        correlation_id: &str,
    ) -> Result<ProjectView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let ProjectAccessTokenIdentity::User {
            user_id,
            display_name,
        } = identity
        else {
            // Project Automation Tokens deliberately cannot perform lifecycle
            // mutations because Project audit events require a live human actor.
            return Err(ProjectHttpError::Forbidden);
        };
        let audit = ProjectAuditContext::new(
            AuditEventId::new(),
            *user_id,
            Some(display_name.clone()),
            correlation_id.to_owned(),
            None,
        );
        let result = if restore {
            runtime
                .projects
                .restore(*user_id, owner, project_id, version, &audit)
                .await
        } else {
            runtime
                .projects
                .archive(*user_id, owner, project_id, version, &audit)
                .await
        };
        result.map(ProjectView::from).map_err(map_project_error)
    }

    pub(crate) async fn list(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        state: Option<ProjectState>,
        limit: ProjectPageLimit,
        cursor: Option<&str>,
    ) -> Result<ProjectListView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let binding = CursorBinding::projects(identity.user_id, owner, state, limit.get());
        let after = cursor
            .map(|value| {
                runtime
                    .cursor
                    .decode_project(value, &binding, OffsetDateTime::now_utc())
            })
            .transpose()?;
        let page = runtime
            .projects
            .list_filtered(identity.user_id, owner, limit, after.as_ref(), state)
            .await
            .map_err(map_project_error)?;
        let next_cursor = page
            .next_key()
            .map(|key| {
                runtime
                    .cursor
                    .encode_project(key, &binding, OffsetDateTime::now_utc())
            })
            .transpose()?;
        Ok(ProjectListView {
            items: page
                .projects()
                .iter()
                .cloned()
                .map(ProjectView::from)
                .collect(),
            next_cursor,
        })
    }

    pub(crate) async fn rename(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        version: ProjectVersion,
        name: ProjectName,
        correlation_id: &str,
    ) -> Result<ProjectView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .projects
            .rename(
                identity.user_id,
                owner,
                project_id,
                version,
                name,
                &identity.audit(correlation_id),
            )
            .await
            .map(ProjectView::from)
            .map_err(map_project_error)
    }

    pub(crate) async fn archive_or_restore(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        version: ProjectVersion,
        restore: bool,
        correlation_id: &str,
    ) -> Result<ProjectView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let audit = identity.audit(correlation_id);
        let result = if restore {
            runtime
                .projects
                .restore(identity.user_id, owner, project_id, version, &audit)
                .await
        } else {
            runtime
                .projects
                .archive(identity.user_id, owner, project_id, version, &audit)
                .await
        };
        result.map(ProjectView::from).map_err(map_project_error)
    }

    pub(crate) async fn delete(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        version: ProjectVersion,
        name: ProjectName,
        correlation_id: &str,
    ) -> Result<(), ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let confirmation = ProjectDeleteConfirmation::new(name);
        runtime
            .projects
            .delete(
                identity.user_id,
                owner,
                project_id,
                version,
                &confirmation,
                &identity.audit(correlation_id),
            )
            .await
            .map_err(map_project_error)
    }
}

impl ProjectAccessTokenIdentity {
    pub(crate) const fn is_human_actor(&self) -> bool {
        matches!(self, Self::User { .. })
    }
}
