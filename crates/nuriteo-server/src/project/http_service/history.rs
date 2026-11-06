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
pub(crate) struct SaveProjectContext {
    pub(crate) actor_user_id: UserId,
    pub(crate) project_id: ProjectId,
    pub(crate) storage_scope_id: crate::workspace::StorageScopeId,
    pub(crate) project_version: ProjectVersion,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectVersionView {
    id: String,
    project_id: String,
    bundle_id: String,
    name: String,
    created_by_user_id: String,
    source_project_version: i64,
    created_at: String,
    sha256: String,
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
    format: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectVersionCreateView {
    pub(crate) version: ProjectVersionView,
    pub(crate) idempotent_retry: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectVersionListView {
    pub(crate) items: Vec<ProjectVersionView>,
    pub(crate) next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCheckpointView {
    id: String,
    project_id: String,
    bundle_id: String,
    position: u8,
    created_by_user_id: String,
    created_at: String,
    sha256: String,
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
    format: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCheckpointListView {
    pub(crate) items: Vec<RecoveryCheckpointView>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoricalPromotionView {
    operation_id: String,
    reference_kind: String,
    reference_id: String,
    bundle_id: String,
    pub(crate) project_version: i64,
    changed: bool,
    idempotent_retry: bool,
}

impl From<&ExplicitProjectVersion> for ProjectVersionView {
    fn from(version: &ExplicitProjectVersion) -> Self {
        Self {
            id: version.id().to_string(),
            project_id: version.project_id().to_string(),
            bundle_id: version.bundle_id().to_string(),
            name: version.name().as_str().to_owned(),
            created_by_user_id: version.actor_user_id().to_string(),
            source_project_version: version.source_project_version().get(),
            created_at: version.created_at().to_string(),
            sha256: hex_lower(version.sha256()),
            physical_bytes: version.physical_bytes(),
            logical_bytes: version.logical_bytes(),
            file_count: version.file_count(),
            format: version.format().to_owned(),
        }
    }
}

impl From<&RecoveryCheckpoint> for RecoveryCheckpointView {
    fn from(checkpoint: &RecoveryCheckpoint) -> Self {
        Self {
            id: checkpoint.id().to_string(),
            project_id: checkpoint.project_id().to_string(),
            bundle_id: checkpoint.bundle_id().to_string(),
            position: checkpoint.position(),
            created_by_user_id: checkpoint.actor_user_id().to_string(),
            created_at: checkpoint.created_at().to_string(),
            sha256: hex_lower(checkpoint.sha256()),
            physical_bytes: checkpoint.physical_bytes(),
            logical_bytes: checkpoint.logical_bytes(),
            file_count: checkpoint.file_count(),
            format: checkpoint.format().to_owned(),
        }
    }
}

impl From<HistoricalPromotionOutcome> for HistoricalPromotionView {
    fn from(outcome: HistoricalPromotionOutcome) -> Self {
        Self {
            operation_id: outcome.operation_id().to_string(),
            reference_kind: outcome.reference_kind().as_str().to_owned(),
            reference_id: outcome.reference_id().to_string(),
            bundle_id: outcome.bundle_id().to_string(),
            project_version: outcome.project_version().get(),
            changed: outcome.changed(),
            idempotent_retry: outcome.is_idempotent_retry(),
        }
    }
}

impl ProjectHttpService {
    pub(crate) async fn content_descriptor(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<ContentDescriptor, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .content
            .as_ref()
            .ok_or(ProjectHttpError::Unavailable)?
            .describe(identity.user_id, owner, project_id)
            .await
            .map_err(map_content_error)
    }

    pub(crate) async fn create_version(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_project_version: ProjectVersion,
        name: ProjectVersionName,
        idempotency_key: crate::save::IdempotencyKey,
    ) -> Result<ProjectVersionCreateView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let outcome = runtime
            .versions
            .create(CreateProjectVersion {
                owner,
                project_id,
                actor_user_id: identity.user_id,
                expected_project_version,
                name,
                idempotency_key,
            })
            .await
            .map_err(map_version_error)?;
        Ok(ProjectVersionCreateView {
            version: ProjectVersionView::from(outcome.version()),
            idempotent_retry: outcome.is_idempotent_retry(),
        })
    }

    pub(crate) async fn list_versions(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        limit: ProjectVersionPageLimit,
        cursor: Option<&str>,
    ) -> Result<ProjectVersionListView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let binding = CursorBinding::versions(identity.user_id, owner, project_id, limit.get());
        let after = cursor
            .map(|value| {
                runtime
                    .cursor
                    .decode_version(value, &binding, OffsetDateTime::now_utc())
            })
            .transpose()?;
        let page = runtime
            .versions
            .list(identity.user_id, owner, project_id, limit, after)
            .await
            .map_err(map_version_error)?;
        let next_cursor = page
            .next_key()
            .map(|key| {
                runtime
                    .cursor
                    .encode_version(key, &binding, OffsetDateTime::now_utc())
            })
            .transpose()?;
        Ok(ProjectVersionListView {
            items: page
                .versions()
                .iter()
                .map(ProjectVersionView::from)
                .collect(),
            next_cursor,
        })
    }

    pub(crate) async fn list_recovery_checkpoints(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<RecoveryCheckpointListView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let items = runtime
            .history
            .list_recovery_checkpoints(identity.user_id, owner, project_id)
            .await
            .map_err(map_history_error)?;
        Ok(RecoveryCheckpointListView {
            items: items.iter().map(RecoveryCheckpointView::from).collect(),
        })
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "HTTP history mutation keeps preconditions explicit"
    )]
    pub(crate) async fn promote_history(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        expected_project_version: ProjectVersion,
        reference_kind: HistoricalReferenceKind,
        reference_id: uuid::Uuid,
        idempotency_key: crate::save::IdempotencyKey,
        correlation_id: &str,
    ) -> Result<HistoricalPromotionView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .history
            .promote(PromoteHistoricalReference {
                owner,
                project_id,
                actor_user_id: identity.user_id,
                expected_project_version,
                reference_kind,
                reference_id,
                idempotency_key,
                audit: identity.audit(correlation_id),
            })
            .await
            .map(HistoricalPromotionView::from)
            .map_err(map_history_error)
    }

    pub(crate) async fn reconcile_history(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        idempotency_key: &crate::save::IdempotencyKey,
    ) -> Result<HistoricalPromotionView, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .history
            .reconcile(identity.user_id, owner, project_id, idempotency_key)
            .await
            .map(HistoricalPromotionView::from)
            .map_err(map_history_error)
    }

    pub(crate) async fn download_content(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
        bundle_id: &str,
        etag: &str,
    ) -> Result<ContentDownload, ProjectHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .content
            .as_ref()
            .ok_or(ProjectHttpError::Unavailable)?
            .download(identity.user_id, owner, project_id, bundle_id, etag)
            .await
            .map_err(map_content_error)
    }

    /// Authenticates the browser and establishes the exact active Project scope
    /// for a Save mutation. Save domain services re-check this role under their
    /// own transaction locks before every state or capability mutation.
    pub(crate) async fn authorize_save(
        &self,
        request: BrowserRequestHeaders<'_>,
        owner: ProjectOwner,
        project_id: ProjectId,
    ) -> Result<SaveProjectContext, ProjectHttpError> {
        let runtime = self.runtime()?;
        tokio_time::timeout(runtime.operation_timeout, async {
            let identity = runtime.authenticate(request).await?;
            let project = runtime
                .projects
                .get(identity.user_id, owner, project_id)
                .await
                .map_err(map_project_error)?;
            if project.state() != ProjectState::Active {
                return Err(ProjectHttpError::Conflict);
            }
            let mut connection = runtime
                .pool
                .acquire()
                .await
                .map_err(|_| ProjectHttpError::Unavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(map_save_authorization_query)?;
            configure_save_authorization_deadline(&mut transaction, runtime.operation_timeout)
                .await?;
            let role = ProjectAccessRepository::resolve_effective_role(
                &mut transaction,
                project_id,
                identity.user_id,
            )
            .await
            .map_err(|error| match error {
                ProjectAccessError::OperationTimeout => ProjectHttpError::OperationTimeout,
                _ => ProjectHttpError::Unavailable,
            })?;
            transaction
                .rollback()
                .await
                .map_err(map_save_authorization_query)?;
            if role < EffectiveProjectRole::Write {
                return Err(ProjectHttpError::Forbidden);
            }
            Ok(SaveProjectContext {
                actor_user_id: identity.user_id,
                project_id: project.id(),
                storage_scope_id: project.storage_scope_id(),
                project_version: project.lock_version(),
            })
        })
        .await
        .map_err(|_| ProjectHttpError::OperationTimeout)?
    }
}
