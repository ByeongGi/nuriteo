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

    pub(crate) fn runtime(&self) -> Result<&Runtime, ProjectHttpError> {
        self.runtime.as_deref().ok_or(ProjectHttpError::Unavailable)
    }
}
