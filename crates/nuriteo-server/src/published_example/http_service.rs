use std::{fmt, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use sha2::Sha256;
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    audit::AuditEventId,
    database::DatabasePool,
    identity::{
        BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionPolicy,
        SessionService, SessionServiceError, UserId,
    },
    object_storage::S3ObjectStore,
    project::{Project, ProjectAuditContext, ProjectId, ProjectName, ProjectOwner, ProjectSlug},
    save::ProjectVersionId,
};

use super::{
    CreatePublishedExample, ForkPublishedExample, PublicPublishedExample, PublishedContentDownload,
    PublishedContentError, PublishedContentService, PublishedExample,
    PublishedExampleDeleteConfirmation, PublishedExampleError, PublishedExampleForkError,
    PublishedExampleForkKey, PublishedExampleForkPolicy, PublishedExampleForkService,
    PublishedExampleId, PublishedExampleName, PublishedExamplePublicId, PublishedExampleService,
    PublishedExampleServicePolicy, PublishedExampleState, PublishedExampleVersion,
    PublishedExampleVersionId, PublishedExampleVisibility,
};

const PUBLIC_PREVIEW_BINDINGS_PER_MINUTE: i32 = 120;

mod management;
mod public_access;

pub use management::{
    PublishedExampleCreateView, PublishedExampleVersionMutationView, PublishedExampleVersionView,
    PublishedExampleView,
};
pub use public_access::{
    ForkedProjectView, PublicPublishedExampleListView, PublicPublishedExampleView,
    PublishedExampleForkView,
};

#[derive(Clone)]
pub struct PublicPreviewAdmissionKey([u8; 32]);

impl PublicPreviewAdmissionKey {
    pub fn from_base64url(value: &str) -> Result<Self, PublishedExampleHttpError> {
        let decoded = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| PublishedExampleHttpError::InvalidInput)?;
        let bytes: [u8; 32] = decoded
            .try_into()
            .map_err(|_| PublishedExampleHttpError::InvalidInput)?;
        Ok(Self(bytes))
    }
}

impl fmt::Debug for PublicPreviewAdmissionKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PublicPreviewAdmissionKey([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishedExampleHttpError {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    InvalidInput,
    Conflict,
    QuotaExceeded,
    RateLimited,
    PreconditionFailed,
    ConfirmationRequired,
    Unavailable,
    OperationTimeout,
    CommitOutcomeUnknown,
    Internal,
}

impl fmt::Display for PublishedExampleHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "Published Example authentication failed",
            Self::Forbidden => "Published Example request is forbidden",
            Self::NotFound => "Published Example was not found",
            Self::InvalidInput => "Published Example request is invalid",
            Self::Conflict => "Published Example state conflicts with the request",
            Self::QuotaExceeded => "Published Example fork exceeds storage quota",
            Self::RateLimited => "Public Preview binding rate limit exceeded",
            Self::PreconditionFailed => "Published Example generation is stale",
            Self::ConfirmationRequired => "Published Example deletion confirmation is required",
            Self::Unavailable => "Published Example service is unavailable",
            Self::OperationTimeout => "Published Example operation timed out",
            Self::CommitOutcomeUnknown => "Published Example commit outcome is unknown",
            Self::Internal => "Published Example operation failed",
        })
    }
}

impl std::error::Error for PublishedExampleHttpError {}

#[derive(Clone)]
pub struct PublishedExampleHttpService {
    runtime: Option<Arc<Runtime>>,
}

struct Runtime {
    pool: DatabasePool,
    cookies: BrowserCookieBoundary,
    sessions: SessionService,
    examples: PublishedExampleService,
    forks: PublishedExampleForkService,
    content: PublishedContentService,
    preview_admission_key: Option<PublicPreviewAdmissionKey>,
}

impl fmt::Debug for PublishedExampleHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedExampleHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl PublishedExampleHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        store: S3ObjectStore,
        service_policy: PublishedExampleServicePolicy,
        session_policy: SessionPolicy,
        preview_admission_key: Option<PublicPreviewAdmissionKey>,
    ) -> Result<Self, PublishedExampleHttpError> {
        let cookies = BrowserCookieBoundary::new(external_url).map_err(map_browser_error)?;
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                content: PublishedContentService::new(pool.clone(), store.clone()),
                examples: PublishedExampleService::new(pool.clone(), service_policy),
                forks: PublishedExampleForkService::new(
                    pool.clone(),
                    store,
                    PublishedExampleForkPolicy::default(),
                ),
                sessions: SessionService::new(pool.clone(), session_policy),
                preview_admission_key,
                pool,
                cookies,
            })),
        })
    }

    fn runtime(&self) -> Result<&Runtime, PublishedExampleHttpError> {
        self.runtime
            .as_deref()
            .ok_or(PublishedExampleHttpError::Unavailable)
    }
}

struct BrowserIdentity {
    user_id: UserId,
    display_name: String,
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
    ) -> Result<BrowserIdentity, PublishedExampleHttpError> {
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
        let actor: Option<(bool, String)> =
            sqlx::query_as("SELECT status='active',display_name FROM users WHERE id=$1::uuid")
                .bind(fields.user_id.to_string())
                .fetch_optional(
                    &mut *self
                        .pool
                        .acquire()
                        .await
                        .map_err(|_| PublishedExampleHttpError::Unavailable)?,
                )
                .await
                .map_err(|_| PublishedExampleHttpError::Unavailable)?;
        let Some((true, display_name)) = actor else {
            return Err(PublishedExampleHttpError::AuthenticationFailed);
        };
        Ok(BrowserIdentity {
            user_id: fields.user_id,
            display_name,
        })
    }
}

fn map_browser_error(error: BrowserCookieError) -> PublishedExampleHttpError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            PublishedExampleHttpError::AuthenticationFailed
        }
        _ => PublishedExampleHttpError::Forbidden,
    }
}

fn map_session_error(error: SessionServiceError) -> PublishedExampleHttpError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            PublishedExampleHttpError::AuthenticationFailed
        }
        SessionServiceError::OperationTimeout => PublishedExampleHttpError::OperationTimeout,
        SessionServiceError::DatabaseUnavailable => PublishedExampleHttpError::Unavailable,
        _ => PublishedExampleHttpError::Internal,
    }
}

fn map_domain_error(error: PublishedExampleError) -> PublishedExampleHttpError {
    match error {
        PublishedExampleError::InvalidInput => PublishedExampleHttpError::InvalidInput,
        PublishedExampleError::NotFound => PublishedExampleHttpError::NotFound,
        PublishedExampleError::Forbidden => PublishedExampleHttpError::Forbidden,
        PublishedExampleError::ProjectUnavailable
        | PublishedExampleError::VersionUnavailable
        | PublishedExampleError::InvalidLifecycle
        | PublishedExampleError::PublicIdConflict => PublishedExampleHttpError::Conflict,
        PublishedExampleError::StaleGeneration => PublishedExampleHttpError::PreconditionFailed,
        PublishedExampleError::ConfirmationRequired => {
            PublishedExampleHttpError::ConfirmationRequired
        }
        PublishedExampleError::OperationTimeout => PublishedExampleHttpError::OperationTimeout,
        PublishedExampleError::DatabaseUnavailable => PublishedExampleHttpError::Unavailable,
        PublishedExampleError::CommitOutcomeUnknown => {
            PublishedExampleHttpError::CommitOutcomeUnknown
        }
        PublishedExampleError::EntropyUnavailable | PublishedExampleError::InvariantViolation => {
            PublishedExampleHttpError::Internal
        }
    }
}

const fn visibility_name(value: PublishedExampleVisibility) -> &'static str {
    match value {
        PublishedExampleVisibility::Unlisted => "unlisted",
        PublishedExampleVisibility::Public => "public",
    }
}

const fn state_name(value: PublishedExampleState) -> &'static str {
    match value {
        PublishedExampleState::Published => "published",
        PublishedExampleState::Unpublished => "unpublished",
    }
}
