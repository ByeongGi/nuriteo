use std::{fmt, sync::Arc};

use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    database::DatabasePool,
    git_provider::{
        GitProviderError, GitProviderInput, GitProviderKind, GitProviderMetadata,
        GitProviderService, GitProviderState, GitProviderUpdate, GitProviderValidator,
    },
    identity::{
        BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionId, SessionPolicy,
        SessionService, SessionServiceError, UserId,
    },
    integration::{IntegrationAdminActor, IntegrationError, SecretValue},
    project::ProjectId,
};

use super::{
    GitCredentialConnection, GitOperationError, GitOperationOutcome, GitOperationService,
    GitRemoteBinding,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitHttpError {
    InvalidInput,
    AuthenticationFailed,
    Forbidden,
    ReauthenticationRequired,
    NotFound,
    AlreadyConnected,
    Conflict,
    NonFastForward,
    ProviderUnavailable,
    CredentialUnavailable,
    TransferLimitExceeded,
    OperationTimeout,
    CommitOutcomeUnknown,
    Unavailable,
    Internal,
}

impl fmt::Display for GitHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Git request is invalid",
            Self::AuthenticationFailed => "Git request authentication failed",
            Self::Forbidden => "Git request is forbidden",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::NotFound => "Git resource was not found",
            Self::AlreadyConnected => "Git resource is already connected",
            Self::Conflict => "Git resource changed concurrently",
            Self::NonFastForward => "remote Git head changed",
            Self::ProviderUnavailable => "Git provider is unavailable",
            Self::CredentialUnavailable => "Git credential is unavailable",
            Self::TransferLimitExceeded => "Git transfer limit was exceeded",
            Self::OperationTimeout => "Git operation timed out",
            Self::CommitOutcomeUnknown => "Git push outcome requires reconciliation",
            Self::Unavailable => "Git service is unavailable",
            Self::Internal => "Git operation failed",
        })
    }
}

impl std::error::Error for GitHttpError {}

mod connections;
mod providers;
mod remotes;

pub use connections::{GitConnectionView, GitProviderView};
pub use providers::GitProviderAdminView;
pub use remotes::{GitOperationView, GitRemoteView};

#[derive(Clone)]
pub struct GitHttpService {
    runtime: Option<Arc<Runtime>>,
}

struct Runtime {
    pool: DatabasePool,
    cookies: BrowserCookieBoundary,
    sessions: SessionService,
    operations: GitOperationService,
    providers: GitProviderService,
    provider_validator: GitProviderValidator,
}

impl fmt::Debug for GitHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl GitHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        session_policy: SessionPolicy,
        operations: GitOperationService,
        providers: GitProviderService,
        provider_validator: GitProviderValidator,
    ) -> Result<Self, GitHttpError> {
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                cookies: BrowserCookieBoundary::new(external_url).map_err(map_browser_error)?,
                sessions: SessionService::new(pool.clone(), session_policy),
                pool,
                operations,
                providers,
                provider_validator,
            })),
        })
    }

    fn runtime(&self) -> Result<&Runtime, GitHttpError> {
        self.runtime.as_deref().ok_or(GitHttpError::Unavailable)
    }
}

impl Runtime {
    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<BrowserIdentity, GitHttpError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(map_browser_error)?
            .into_session_token();
        self.sessions
            .authenticate(&token)
            .await
            .map(|session| BrowserIdentity {
                user_id: session.user_id(),
                session_id: session.id(),
            })
            .map_err(map_session_error)
    }
}

#[derive(Debug, Clone, Copy)]
struct BrowserIdentity {
    user_id: UserId,
    session_id: SessionId,
}

fn format_time(value: OffsetDateTime) -> Result<String, GitHttpError> {
    value.format(&Rfc3339).map_err(|_| GitHttpError::Internal)
}

fn map_browser_error(error: BrowserCookieError) -> GitHttpError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            GitHttpError::AuthenticationFailed
        }
        _ => GitHttpError::Forbidden,
    }
}

fn map_session_error(error: SessionServiceError) -> GitHttpError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            GitHttpError::AuthenticationFailed
        }
        SessionServiceError::OperationTimeout => GitHttpError::OperationTimeout,
        SessionServiceError::DatabaseUnavailable => GitHttpError::Unavailable,
        _ => GitHttpError::Internal,
    }
}

const fn map_operation_error(error: GitOperationError) -> GitHttpError {
    match error {
        GitOperationError::InvalidInput => GitHttpError::InvalidInput,
        GitOperationError::AuthenticationFailed => GitHttpError::AuthenticationFailed,
        GitOperationError::Forbidden => GitHttpError::Forbidden,
        GitOperationError::ReauthenticationRequired => GitHttpError::ReauthenticationRequired,
        GitOperationError::NotFound => GitHttpError::NotFound,
        GitOperationError::AlreadyConnected => GitHttpError::AlreadyConnected,
        GitOperationError::Conflict => GitHttpError::Conflict,
        GitOperationError::NonFastForward => GitHttpError::NonFastForward,
        GitOperationError::ProviderUnavailable => GitHttpError::ProviderUnavailable,
        GitOperationError::CredentialUnavailable => GitHttpError::CredentialUnavailable,
        GitOperationError::TransferLimitExceeded => GitHttpError::TransferLimitExceeded,
        GitOperationError::OperationTimeout => GitHttpError::OperationTimeout,
        GitOperationError::CommitOutcomeUnknown => GitHttpError::CommitOutcomeUnknown,
        GitOperationError::Unavailable => GitHttpError::Unavailable,
    }
}
