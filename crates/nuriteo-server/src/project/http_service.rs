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

use super::{
    DirectProjectRoleGrant, Project, ProjectAuditContext, ProjectDeleteConfirmation, ProjectId,
    ProjectName, ProjectOwner, ProjectPageKey, ProjectPageLimit, ProjectRepository, ProjectRole,
    ProjectRoleMutationResult, ProjectRolePageKey, ProjectRolePageLimit, ProjectService,
    ProjectServiceError, ProjectServicePolicy, ProjectSlug, ProjectState, ProjectVersion,
};

const CURSOR_PREFIX: &str = "nrt_project_cursor_";
const CURSOR_TTL_SECONDS: i64 = 15 * 60;
const REAUTHENTICATION_WINDOW_SECONDS: i64 = 15 * 60;
const CURSOR_KEY_BYTES: usize = 32;
const MAX_CURSOR_BYTES: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectHttpPolicy {
    operation_timeout: Duration,
}

impl ProjectHttpPolicy {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectHttpError {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    InvalidInput,
    Conflict,
    PreconditionFailed,
    ConfirmationRequired,
    AuditUnavailable,
    Unavailable,
    RateLimited,
    OperationTimeout,
    CommitOutcomeUnknown,
    Internal,
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

#[derive(Clone)]
pub struct ProjectHttpService {
    runtime: Option<Arc<Runtime>>,
}

struct Runtime {
    pool: DatabasePool,
    operation_timeout: Duration,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    projects: ProjectService,
    access_tokens: AccessTokenAuthenticator,
    cursor: CursorSigner,
    content: Option<ContentService>,
    versions: ProjectVersionService,
    history: ProjectHistoryService,
}

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
        let confirmation = ProjectDeleteConfirmation::new(name, identity.recently_reauthenticated);
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

    fn runtime(&self) -> Result<&Runtime, ProjectHttpError> {
        self.runtime.as_deref().ok_or(ProjectHttpError::Unavailable)
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum RoleOperation {
    Grant,
    Change,
    Revoke,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SaveProjectContext {
    pub(crate) actor_user_id: UserId,
    pub(crate) project_id: ProjectId,
    pub(crate) storage_scope_id: crate::workspace::StorageScopeId,
    pub(crate) project_version: ProjectVersion,
}

struct BrowserIdentity {
    user_id: UserId,
    display_name: String,
    recently_reauthenticated: bool,
}

pub(crate) enum ProjectAccessTokenIdentity {
    User {
        user_id: UserId,
        display_name: String,
    },
    Project {
        bound_project_id: ProjectId,
    },
}

impl ProjectAccessTokenIdentity {
    pub(crate) const fn is_human_actor(&self) -> bool {
        matches!(self, Self::User { .. })
    }
}

impl BrowserIdentity {
    fn audit(&self, correlation_id: &str) -> ProjectAuditContext {
        ProjectAuditContext::new(
            AuditEventId::new(),
            self.user_id,
            Some(self.display_name.clone()),
            correlation_id.to_owned(),
            None,
        )
    }
}

impl Runtime {
    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<BrowserIdentity, ProjectHttpError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(map_browser_error)?
            .into_session_token();
        let fields = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_session_error)?
            .into_fields();
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| ProjectHttpError::Unavailable)?;
        let row: Option<(String, String)> =
            sqlx::query_as("SELECT display_name,status FROM users WHERE id=$1::uuid")
                .bind(fields.user_id.to_string())
                .fetch_optional(&mut *connection)
                .await
                .map_err(|_| ProjectHttpError::Unavailable)?;
        let (display_name, status) = row.ok_or(ProjectHttpError::AuthenticationFailed)?;
        if status != "active" {
            return Err(ProjectHttpError::AuthenticationFailed);
        }
        // Session authentication refreshes `last_seen_at` with the database clock.
        // Compare reauthentication freshness in that same clock domain so small
        // host/database skew cannot reject a just-completed reauthentication.
        let now = fields.last_seen_at.into_datetime();
        let recently_reauthenticated = fields.last_reauthenticated_at.is_some_and(|at| {
            let age = now - at.into_datetime();
            !age.is_negative() && age.whole_seconds() <= REAUTHENTICATION_WINDOW_SECONDS
        });
        Ok(BrowserIdentity {
            user_id: fields.user_id,
            display_name,
            recently_reauthenticated,
        })
    }
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
    pub(crate) state: &'static str,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) archived_at: Option<String>,
    pub(crate) version: i64,
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

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectListView {
    pub(crate) items: Vec<ProjectView>,
    pub(crate) next_cursor: Option<String>,
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

#[derive(Clone)]
struct CursorSigner {
    key: [u8; CURSOR_KEY_BYTES],
}

#[derive(Debug, Serialize, Deserialize)]
struct CursorClaims {
    version: u8,
    kind: String,
    actor_id: String,
    owner_type: String,
    owner_id: String,
    project_id: Option<String>,
    state: String,
    page_size: u16,
    expires_at: i64,
    after_slug: Option<String>,
    after_project_id: Option<String>,
    after_user_id: Option<String>,
    after_version_created_at: Option<i128>,
    after_version_id: Option<String>,
}

struct CursorBinding {
    kind: &'static str,
    actor_id: String,
    owner_type: &'static str,
    owner_id: String,
    project_id: Option<String>,
    state: &'static str,
    page_size: u16,
}

enum CursorPosition {
    Project { slug: String, id: String },
    Role { user_id: String },
    Version { created_at: i128, id: String },
}

impl CursorBinding {
    fn projects(
        actor: UserId,
        owner: ProjectOwner,
        state: Option<ProjectState>,
        page_size: u16,
    ) -> Self {
        let (owner_type, owner_id) = owner_parts(owner);
        Self {
            kind: "projects",
            actor_id: actor.to_string(),
            owner_type,
            owner_id,
            project_id: None,
            state: match state {
                Some(ProjectState::Active) => "active",
                Some(ProjectState::Archived) => "archived",
                None => "all",
            },
            page_size,
        }
    }
    fn roles(actor: UserId, owner: ProjectOwner, project: ProjectId, page_size: u16) -> Self {
        let (owner_type, owner_id) = owner_parts(owner);
        Self {
            kind: "roles",
            actor_id: actor.to_string(),
            owner_type,
            owner_id,
            project_id: Some(project.to_string()),
            state: "roles",
            page_size,
        }
    }
    fn versions(actor: UserId, owner: ProjectOwner, project: ProjectId, page_size: u16) -> Self {
        let (owner_type, owner_id) = owner_parts(owner);
        Self {
            kind: "versions",
            actor_id: actor.to_string(),
            owner_type,
            owner_id,
            project_id: Some(project.to_string()),
            state: "versions",
            page_size,
        }
    }
}

fn owner_parts(owner: ProjectOwner) -> (&'static str, String) {
    match owner {
        ProjectOwner::User(id) => ("user", id.to_string()),
        ProjectOwner::Organization(id) => ("organization", id.to_string()),
    }
}

impl CursorSigner {
    const fn new(key: [u8; CURSOR_KEY_BYTES]) -> Self {
        Self { key }
    }

    fn encode_project(
        &self,
        key: &ProjectPageKey,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<String, ProjectHttpError> {
        self.encode(
            binding,
            now,
            CursorPosition::Project {
                slug: key.slug().to_string(),
                id: key.id().to_string(),
            },
        )
    }
    fn encode_role(
        &self,
        key: ProjectRolePageKey,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<String, ProjectHttpError> {
        self.encode(
            binding,
            now,
            CursorPosition::Role {
                user_id: key.user_id().to_string(),
            },
        )
    }
    fn encode_version(
        &self,
        key: ProjectVersionPageKey,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<String, ProjectHttpError> {
        self.encode(
            binding,
            now,
            CursorPosition::Version {
                created_at: key.created_at().unix_timestamp_nanos(),
                id: key.id().to_string(),
            },
        )
    }
    fn encode(
        &self,
        binding: &CursorBinding,
        now: OffsetDateTime,
        position: CursorPosition,
    ) -> Result<String, ProjectHttpError> {
        let (
            after_slug,
            after_project_id,
            after_user_id,
            after_version_created_at,
            after_version_id,
        ) = match position {
            CursorPosition::Project { slug, id } => (Some(slug), Some(id), None, None, None),
            CursorPosition::Role { user_id } => (None, None, Some(user_id), None, None),
            CursorPosition::Version { created_at, id } => {
                (None, None, None, Some(created_at), Some(id))
            }
        };
        let claims = CursorClaims {
            version: 1,
            kind: binding.kind.into(),
            actor_id: binding.actor_id.clone(),
            owner_type: binding.owner_type.into(),
            owner_id: binding.owner_id.clone(),
            project_id: binding.project_id.clone(),
            state: binding.state.into(),
            page_size: binding.page_size,
            expires_at: now.unix_timestamp() + CURSOR_TTL_SECONDS,
            after_slug,
            after_project_id,
            after_user_id,
            after_version_created_at,
            after_version_id,
        };
        let payload = serde_json::to_vec(&claims).map_err(|_| ProjectHttpError::Internal)?;
        let signature = hmac_sha256(&self.key, &payload);
        Ok(format!(
            "{CURSOR_PREFIX}{}.{}",
            URL_SAFE_NO_PAD.encode(payload),
            URL_SAFE_NO_PAD.encode(signature)
        ))
    }
    fn decode_project(
        &self,
        value: &str,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<ProjectPageKey, ProjectHttpError> {
        let claims = self.decode(value, binding, now)?;
        match (
            claims.after_slug,
            claims.after_project_id,
            claims.after_user_id,
        ) {
            (Some(slug), Some(id), None) => Ok(ProjectPageKey::new(
                slug.parse().map_err(|_| ProjectHttpError::InvalidInput)?,
                id.parse().map_err(|_| ProjectHttpError::InvalidInput)?,
            )),
            _ => Err(ProjectHttpError::InvalidInput),
        }
    }
    fn decode_role(
        &self,
        value: &str,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<ProjectRolePageKey, ProjectHttpError> {
        let claims = self.decode(value, binding, now)?;
        match (
            claims.after_slug,
            claims.after_project_id,
            claims.after_user_id,
        ) {
            (None, None, Some(id)) => Ok(ProjectRolePageKey::new(
                id.parse().map_err(|_| ProjectHttpError::InvalidInput)?,
            )),
            _ => Err(ProjectHttpError::InvalidInput),
        }
    }
    fn decode_version(
        &self,
        value: &str,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<ProjectVersionPageKey, ProjectHttpError> {
        let claims = self.decode(value, binding, now)?;
        match (
            claims.after_slug,
            claims.after_project_id,
            claims.after_user_id,
            claims.after_version_created_at,
            claims.after_version_id,
        ) {
            (None, None, None, Some(created_at), Some(id)) => Ok(ProjectVersionPageKey::new(
                OffsetDateTime::from_unix_timestamp_nanos(created_at)
                    .map_err(|_| ProjectHttpError::InvalidInput)?,
                id.parse().map_err(|_| ProjectHttpError::InvalidInput)?,
            )),
            _ => Err(ProjectHttpError::InvalidInput),
        }
    }
    fn decode(
        &self,
        value: &str,
        binding: &CursorBinding,
        now: OffsetDateTime,
    ) -> Result<CursorClaims, ProjectHttpError> {
        if value.len() > MAX_CURSOR_BYTES {
            return Err(ProjectHttpError::InvalidInput);
        }
        let encoded = value
            .strip_prefix(CURSOR_PREFIX)
            .ok_or(ProjectHttpError::InvalidInput)?;
        let (payload, signature) = encoded
            .split_once('.')
            .ok_or(ProjectHttpError::InvalidInput)?;
        if signature.contains('.') {
            return Err(ProjectHttpError::InvalidInput);
        }
        let payload = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| ProjectHttpError::InvalidInput)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| ProjectHttpError::InvalidInput)?;
        let expected = hmac_sha256(&self.key, &payload);
        if signature.len() != expected.len() || !bool::from(signature.ct_eq(expected.as_slice())) {
            return Err(ProjectHttpError::InvalidInput);
        }
        let claims: CursorClaims =
            serde_json::from_slice(&payload).map_err(|_| ProjectHttpError::InvalidInput)?;
        if claims.version != 1
            || claims.expires_at <= now.unix_timestamp()
            || claims.kind != binding.kind
            || claims.actor_id != binding.actor_id
            || claims.owner_type != binding.owner_type
            || claims.owner_id != binding.owner_id
            || claims.project_id != binding.project_id
            || claims.state != binding.state
            || claims.page_size != binding.page_size
        {
            return Err(ProjectHttpError::InvalidInput);
        }
        Ok(claims)
    }
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .expect("HMAC-SHA256 accepts a key of any bounded length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

async fn configure_save_authorization_deadline(
    transaction: &mut Transaction<'_, Postgres>,
    operation_timeout: Duration,
) -> Result<(), ProjectHttpError> {
    let millis = operation_timeout
        .saturating_sub(Duration::from_millis(25))
        .max(Duration::from_millis(1))
        .as_millis()
        .min(i32::MAX as u128);
    sqlx::query(
        "SELECT set_config('statement_timeout', $1, true), \
                set_config('lock_timeout', $1, true)",
    )
    .bind(format!("{millis}ms"))
    .execute(&mut **transaction)
    .await
    .map_err(map_save_authorization_query)?;
    Ok(())
}

fn map_save_authorization_query(error: sqlx::Error) -> ProjectHttpError {
    if error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| matches!(code.as_ref(), "57014" | "55P03"))
    {
        ProjectHttpError::OperationTimeout
    } else {
        ProjectHttpError::Unavailable
    }
}

fn map_version_error(error: ProjectVersionError) -> ProjectHttpError {
    match error {
        ProjectVersionError::InvalidInput => ProjectHttpError::InvalidInput,
        ProjectVersionError::NotFound => ProjectHttpError::NotFound,
        ProjectVersionError::Forbidden => ProjectHttpError::Forbidden,
        ProjectVersionError::ProjectUnavailable
        | ProjectVersionError::WorkingHeadUnavailable
        | ProjectVersionError::IdempotencyConflict
        | ProjectVersionError::NameConflict => ProjectHttpError::Conflict,
        ProjectVersionError::StaleProjectVersion => ProjectHttpError::PreconditionFailed,
        ProjectVersionError::OperationTimeout => ProjectHttpError::OperationTimeout,
        ProjectVersionError::DatabaseUnavailable => ProjectHttpError::Unavailable,
        ProjectVersionError::CommitOutcomeUnknown => ProjectHttpError::CommitOutcomeUnknown,
        ProjectVersionError::InvariantViolation => ProjectHttpError::Internal,
    }
}

fn map_history_error(error: ProjectHistoryError) -> ProjectHttpError {
    match error {
        ProjectHistoryError::InvalidInput => ProjectHttpError::InvalidInput,
        ProjectHistoryError::NotFound => ProjectHttpError::NotFound,
        ProjectHistoryError::Forbidden => ProjectHttpError::Forbidden,
        ProjectHistoryError::ProjectUnavailable | ProjectHistoryError::IdempotencyConflict => {
            ProjectHttpError::Conflict
        }
        ProjectHistoryError::StaleProjectVersion => ProjectHttpError::PreconditionFailed,
        ProjectHistoryError::OperationTimeout => ProjectHttpError::OperationTimeout,
        ProjectHistoryError::DatabaseUnavailable => ProjectHttpError::Unavailable,
        ProjectHistoryError::AuditUnavailable => ProjectHttpError::AuditUnavailable,
        ProjectHistoryError::CommitOutcomeUnknown => ProjectHttpError::CommitOutcomeUnknown,
        ProjectHistoryError::InvariantViolation => ProjectHttpError::Internal,
    }
}

fn map_session_error(error: SessionServiceError) -> ProjectHttpError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            ProjectHttpError::AuthenticationFailed
        }
        SessionServiceError::DatabaseUnavailable => ProjectHttpError::Unavailable,
        SessionServiceError::OperationTimeout => ProjectHttpError::OperationTimeout,
        _ => ProjectHttpError::Internal,
    }
}

fn map_access_token_error(error: AccessTokenServiceError) -> ProjectHttpError {
    match error {
        AccessTokenServiceError::AuthenticationFailed => ProjectHttpError::AuthenticationFailed,
        AccessTokenServiceError::Forbidden => ProjectHttpError::Forbidden,
        AccessTokenServiceError::RateLimited => ProjectHttpError::RateLimited,
        AccessTokenServiceError::OperationTimeout => ProjectHttpError::OperationTimeout,
        AccessTokenServiceError::Unavailable => ProjectHttpError::Unavailable,
        AccessTokenServiceError::InvalidPersistedState => ProjectHttpError::Internal,
    }
}

fn map_browser_error(error: BrowserCookieError) -> ProjectHttpError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            ProjectHttpError::AuthenticationFailed
        }
        _ => ProjectHttpError::Forbidden,
    }
}
fn map_project_error(error: ProjectServiceError) -> ProjectHttpError {
    match error {
        ProjectServiceError::InvalidInput => ProjectHttpError::InvalidInput,
        ProjectServiceError::NotFound => ProjectHttpError::NotFound,
        ProjectServiceError::Unauthorized
        | ProjectServiceError::UserUnavailable
        | ProjectServiceError::MemberUnavailable => ProjectHttpError::Forbidden,
        ProjectServiceError::Archived
        | ProjectServiceError::InvalidLifecycle
        | ProjectServiceError::NamespaceUnavailable
        | ProjectServiceError::RoleAlreadyExists => ProjectHttpError::Conflict,
        ProjectServiceError::StaleVersion => ProjectHttpError::PreconditionFailed,
        ProjectServiceError::ConfirmationRequired => ProjectHttpError::ConfirmationRequired,
        ProjectServiceError::AuditUnavailable => ProjectHttpError::AuditUnavailable,
        ProjectServiceError::DatabaseUnavailable => ProjectHttpError::Unavailable,
        ProjectServiceError::OperationTimeout => ProjectHttpError::OperationTimeout,
        ProjectServiceError::CommitOutcomeUnknown => ProjectHttpError::CommitOutcomeUnknown,
        ProjectServiceError::InvariantViolation => ProjectHttpError::Internal,
    }
}

fn map_content_error(error: ContentError) -> ProjectHttpError {
    match error {
        ContentError::InvalidInput => ProjectHttpError::InvalidInput,
        // Read endpoints preserve the Project GET enumeration boundary: an
        // authenticated non-member cannot distinguish a private Project from
        // an absent one. Mutation authorization continues to use Forbidden.
        ContentError::Unauthorized => ProjectHttpError::NotFound,
        ContentError::NotFound | ContentError::NoWorkingHead => ProjectHttpError::NotFound,
        ContentError::ProjectUnavailable | ContentError::ObjectMismatch => {
            ProjectHttpError::Conflict
        }
        ContentError::StaleDescriptor => ProjectHttpError::PreconditionFailed,
        ContentError::ObjectUnavailable | ContentError::PersistenceUnavailable => {
            ProjectHttpError::Unavailable
        }
        ContentError::OperationTimeout => ProjectHttpError::OperationTimeout,
        ContentError::InvariantViolation => ProjectHttpError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_is_authenticated_expiring_and_bound() {
        let signer = CursorSigner::new([7; 32]);
        let actor: UserId = "0199ee6c-c777-7000-8000-000000000001".parse().unwrap();
        let owner = ProjectOwner::User(actor);
        let project: ProjectId = "0199ee6c-c777-7000-8000-000000000002".parse().unwrap();
        let key = ProjectPageKey::new("alpha".parse().unwrap(), project);
        let binding = CursorBinding::projects(actor, owner, Some(ProjectState::Active), 50);
        let now = OffsetDateTime::from_unix_timestamp(2_000_000_000).unwrap();
        let encoded = signer.encode_project(&key, &binding, now).unwrap();
        assert_eq!(signer.decode_project(&encoded, &binding, now).unwrap(), key);
        let mut tampered = encoded.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        assert!(
            signer
                .decode_project(std::str::from_utf8(&tampered).unwrap(), &binding, now)
                .is_err()
        );
        let encoded = signer.encode_project(&key, &binding, now).unwrap();
        assert!(
            signer
                .decode_project(&encoded, &binding, now + time::Duration::minutes(15))
                .is_err()
        );
        let wrong = CursorBinding::projects(actor, owner, Some(ProjectState::Archived), 50);
        assert!(signer.decode_project(&encoded, &wrong, now).is_err());
        let wrong = CursorBinding::projects(actor, owner, Some(ProjectState::Active), 100);
        assert!(signer.decode_project(&encoded, &wrong, now).is_err());
    }
}
