#![allow(unused_imports)]
use super::response_cursors::*;
use super::*;
use std::fmt;

use std::sync::Arc;

use std::time::Duration;

use base64::Engine;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use hmac::{Hmac, KeyInit, Mac};

use serde::{Deserialize, Serialize};

use sha2::Sha256;

use sqlx::{Acquire, Postgres, Transaction};

use subtle::ConstantTimeEq;

use time::OffsetDateTime;

use tokio::time as tokio_time;

use url::Url;

use utoipa::ToSchema;

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

use super::super::{
    DirectProjectRoleGrant, Project, ProjectAuditContext, ProjectDeleteConfirmation, ProjectId,
    ProjectName, ProjectOwner, ProjectPageKey, ProjectPageLimit, ProjectRepository, ProjectRole,
    ProjectRoleMutationResult, ProjectRolePageKey, ProjectRolePageLimit, ProjectService,
    ProjectServiceError, ProjectServicePolicy, ProjectSlug, ProjectState, ProjectTemplate,
    ProjectVersion,
};
use super::{
    BrowserIdentity, CURSOR_KEY_BYTES, CURSOR_PREFIX, CURSOR_TTL_SECONDS, CursorBinding,
    CursorClaims, CursorPosition, CursorSigner, HistoricalPromotionView, MAX_CURSOR_BYTES,
    ProjectAccessTokenIdentity, ProjectHttpError, ProjectHttpPolicy, ProjectHttpService,
    ProjectListView, ProjectRoleListView, ProjectRoleMutationView, ProjectRoleView,
    ProjectVersionCreateView, ProjectVersionListView, ProjectVersionView, ProjectView,
    RecoveryCheckpointListView, RecoveryCheckpointView, RoleOperation, Runtime, SaveProjectContext,
};

impl super::ProjectHttpPolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, ProjectHttpError> {
        if !(Duration::from_millis(100)..=Duration::from_secs(30)).contains(&operation_timeout) {
            return Err(ProjectHttpError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for ProjectHttpPolicy {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(5),
        }
    }
}

impl fmt::Display for ProjectHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "project authentication failed",
            Self::Forbidden => "project request is forbidden",
            Self::NotFound => "project resource was not found",
            Self::InvalidInput => "project request is invalid",
            Self::Conflict => "project state conflicts with the request",
            Self::PreconditionFailed => "project precondition failed",
            Self::ConfirmationRequired => "project confirmation is required",
            Self::AuditUnavailable => "project audit is unavailable",
            Self::Unavailable => "project service is unavailable",
            Self::RateLimited => "project API rate limit exceeded",
            Self::OperationTimeout => "project operation timed out",
            Self::CommitOutcomeUnknown => "project commit outcome is unknown",
            Self::Internal => "project operation failed",
        })
    }
}

impl std::error::Error for ProjectHttpError {}

impl fmt::Debug for ProjectHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl ProjectHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        policy: ProjectHttpPolicy,
        session_policy: SessionPolicy,
    ) -> Result<Self, ProjectHttpError> {
        let cookies =
            BrowserCookieBoundary::new(external_url).map_err(|_| ProjectHttpError::InvalidInput)?;
        let project_policy = ProjectServicePolicy::new(policy.operation_timeout)
            .map_err(|_| ProjectHttpError::InvalidInput)?;
        // Alpha runs one Core replica. Its cursor signing epoch is the process
        // lifetime: restart deliberately invalidates outstanding cursors rather
        // than persisting a new operator secret before HA configuration exists.
        let mut key = [0_u8; CURSOR_KEY_BYTES];
        getrandom::fill(&mut key).map_err(|_| ProjectHttpError::Unavailable)?;
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                operation_timeout: policy.operation_timeout,
                sessions: SessionService::new(pool.clone(), session_policy),
                projects: ProjectService::new(pool.clone(), project_policy),
                access_tokens: AccessTokenAuthenticator::new(pool.clone()),
                pool: pool.clone(),
                cookies,
                cursor: CursorSigner::new(key),
                content: None,
                versions: ProjectVersionService::new(
                    pool.clone(),
                    ProjectVersionServicePolicy::new(policy.operation_timeout)
                        .map_err(|_| ProjectHttpError::InvalidInput)?,
                ),
                history: ProjectHistoryService::new(
                    pool,
                    ProjectHistoryServicePolicy::new(policy.operation_timeout)
                        .map_err(|_| ProjectHttpError::InvalidInput)?,
                ),
            })),
        })
    }

    pub fn production_with_content(
        pool: DatabasePool,
        external_url: &Url,
        policy: ProjectHttpPolicy,
        session_policy: SessionPolicy,
        store: S3ObjectStore,
        content_policy: ContentServicePolicy,
    ) -> Result<Self, ProjectHttpError> {
        let mut service = Self::production(pool.clone(), external_url, policy, session_policy)?;
        let runtime = service
            .runtime
            .as_mut()
            .and_then(Arc::get_mut)
            .ok_or(ProjectHttpError::Internal)?;
        runtime.content = Some(ContentService::new(pool, store, content_policy));
        Ok(service)
    }

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

    pub(crate) fn runtime(&self) -> Result<&Runtime, ProjectHttpError> {
        self.runtime.as_deref().ok_or(ProjectHttpError::Unavailable)
    }
}

impl ProjectAccessTokenIdentity {
    pub(crate) const fn is_human_actor(&self) -> bool {
        matches!(self, Self::User { .. })
    }
}
