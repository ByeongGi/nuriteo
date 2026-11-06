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

#[derive(Debug, Clone, Copy)]
pub(crate) enum RoleOperation {
    Grant,
    Change,
    Revoke,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRoleView {
    project_id: String,
    organization_id: String,
    user_id: String,
    role: ProjectRole,
    created_at: String,
    updated_at: String,
    version: i64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRoleListView {
    pub(crate) items: Vec<ProjectRoleView>,
    pub(crate) next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRoleMutationView {
    pub(crate) changed: bool,
    pub(crate) grant: Option<ProjectRoleView>,
    pub(crate) project_version: i64,
}

impl From<DirectProjectRoleGrant> for ProjectRoleView {
    fn from(grant: DirectProjectRoleGrant) -> Self {
        Self {
            project_id: grant.project_id().to_string(),
            organization_id: grant.organization_id().to_string(),
            user_id: grant.user_id().to_string(),
            role: grant.role(),
            created_at: grant.created_at().to_string(),
            updated_at: grant.updated_at().to_string(),
            version: grant.lock_version().get(),
        }
    }
}

impl ProjectHttpService {
    pub(crate) async fn list_roles(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        limit: ProjectRolePageLimit,
        cursor: Option<&str>,
    ) -> Result<ProjectRoleListView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let binding = CursorBinding::roles(identity.user_id, owner, project_id, limit.get());
        let after = cursor
            .map(|value| {
                runtime
                    .cursor
                    .decode_role(value, &binding, OffsetDateTime::now_utc())
            })
            .transpose()?;
        let page = runtime
            .projects
            .list_direct_roles(identity.user_id, owner, project_id, limit, after)
            .await
            .map_err(map_project_error)?;
        let next_cursor = page
            .next_key()
            .map(|key| {
                runtime
                    .cursor
                    .encode_role(key, &binding, OffsetDateTime::now_utc())
            })
            .transpose()?;
        Ok(ProjectRoleListView {
            items: page
                .grants()
                .iter()
                .cloned()
                .map(ProjectRoleView::from)
                .collect(),
            next_cursor,
        })
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "HTTP role mutation keeps its security inputs explicit"
    )]
    pub(crate) async fn mutate_role(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        version: ProjectVersion,
        target: UserId,
        role: Option<ProjectRole>,
        operation: RoleOperation,
        correlation_id: &str,
    ) -> Result<ProjectRoleMutationView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let audit = identity.audit(correlation_id);
        let (grant, changed) = match operation {
            RoleOperation::Grant => {
                let grant = runtime
                    .projects
                    .grant_role(
                        identity.user_id,
                        owner,
                        project_id,
                        version,
                        target,
                        role.ok_or(ProjectHttpError::InvalidInput)?,
                        &audit,
                    )
                    .await
                    .map_err(map_project_error)?;
                (Some(ProjectRoleView::from(grant)), true)
            }
            RoleOperation::Change => {
                let grant = runtime
                    .projects
                    .change_role(
                        identity.user_id,
                        owner,
                        project_id,
                        version,
                        target,
                        role.ok_or(ProjectHttpError::InvalidInput)?,
                        &audit,
                    )
                    .await
                    .map_err(map_project_error)?;
                (Some(ProjectRoleView::from(grant)), true)
            }
            RoleOperation::Revoke => {
                let result = runtime
                    .projects
                    .revoke_role(identity.user_id, owner, project_id, version, target, &audit)
                    .await
                    .map_err(map_project_error)?;
                (None, result == ProjectRoleMutationResult::Changed)
            }
        };
        let project_version = if changed {
            version
                .next()
                .map_err(|_| ProjectHttpError::Internal)?
                .get()
        } else {
            version.get()
        };
        Ok(ProjectRoleMutationView {
            changed,
            grant,
            project_version,
        })
    }
}
