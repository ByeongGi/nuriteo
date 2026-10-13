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

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitProviderView {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub host: String,
    pub allows_write: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitProviderAdminView {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub api_base_url: String,
    pub oauth_authorization_url: Option<String>,
    pub oauth_token_url: Option<String>,
    pub oauth_client_id: Option<String>,
    pub state: String,
    pub allows_read: bool,
    pub allows_write: bool,
    pub config_version: u64,
    pub validated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitConnectionView {
    pub id: String,
    pub provider_id: String,
    pub credential_version: u64,
    pub connection_version: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteView {
    pub project_id: String,
    pub provider_id: String,
    pub repository_url: String,
    pub branch: String,
    pub remote_head_sha: String,
    pub remote_version: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationView {
    pub remote: GitRemoteView,
    pub previous_head_sha: Option<String>,
    pub head_sha: String,
    pub changed_objects: u64,
    pub transferred_bytes: u64,
}

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

    pub(crate) async fn list_providers(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<Vec<GitProviderView>, GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .operations
            .list_available_providers(identity.user_id)
            .await
            .map(|items| items.iter().map(GitProviderView::from).collect())
            .map_err(map_operation_error)
    }

    pub(crate) async fn list_admin_providers(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<Vec<GitProviderAdminView>, GitHttpError> {
        let runtime = self.runtime()?;
        runtime.admin_actor(request).await?;
        runtime
            .providers
            .list()
            .await
            .map_err(map_provider_error)?
            .iter()
            .map(GitProviderAdminView::try_from)
            .collect()
    }

    pub(crate) async fn create_admin_provider(
        &self,
        request: BrowserRequestHeaders<'_>,
        input: GitProviderInput,
        correlation_id: &str,
    ) -> Result<GitProviderAdminView, GitHttpError> {
        let runtime = self.runtime()?;
        let actor = runtime.admin_actor(request).await?;
        let value = runtime
            .providers
            .create(actor, &input, correlation_id)
            .await
            .map_err(map_provider_error)?;
        GitProviderAdminView::try_from(&value)
    }

    pub(crate) async fn update_admin_provider(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        update: GitProviderUpdate,
        correlation_id: &str,
    ) -> Result<GitProviderAdminView, GitHttpError> {
        let runtime = self.runtime()?;
        let actor = runtime.admin_actor(request).await?;
        let value = runtime
            .providers
            .update(actor, id, version, &update, correlation_id)
            .await
            .map_err(map_provider_error)?;
        GitProviderAdminView::try_from(&value)
    }

    pub(crate) async fn activate_admin_provider(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation_id: &str,
    ) -> Result<GitProviderAdminView, GitHttpError> {
        let runtime = self.runtime()?;
        let actor = runtime.admin_actor(request).await?;
        let value = runtime
            .provider_validator
            .validate_and_activate(&runtime.providers, actor, id, version, correlation_id)
            .await
            .map_err(map_provider_error)?;
        GitProviderAdminView::try_from(&value)
    }

    pub(crate) async fn disable_admin_provider(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation_id: &str,
    ) -> Result<GitProviderAdminView, GitHttpError> {
        let runtime = self.runtime()?;
        let actor = runtime.admin_actor(request).await?;
        let value = runtime
            .providers
            .disable(actor, id, version, correlation_id)
            .await
            .map_err(map_provider_error)?;
        GitProviderAdminView::try_from(&value)
    }

    pub(crate) async fn delete_admin_provider(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation_id: &str,
    ) -> Result<(), GitHttpError> {
        let runtime = self.runtime()?;
        let actor = runtime.admin_actor(request).await?;
        runtime
            .providers
            .delete(actor, id, version, correlation_id)
            .await
            .map_err(map_provider_error)
    }

    pub(crate) async fn list_connections(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<Vec<GitConnectionView>, GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .operations
            .list_connections(identity.user_id)
            .await
            .map(|items| items.iter().map(GitConnectionView::try_from).collect())
            .map_err(map_operation_error)?
    }

    pub(crate) async fn connect(
        &self,
        request: BrowserRequestHeaders<'_>,
        provider_id: Uuid,
        token: Vec<u8>,
        correlation_id: &str,
    ) -> Result<GitConnectionView, GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let token = SecretValue::new(token).map_err(map_secret_error)?;
        runtime
            .operations
            .connect(
                identity.user_id,
                identity.session_id,
                provider_id,
                &token,
                correlation_id,
            )
            .await
            .map_err(map_operation_error)
            .and_then(|value| GitConnectionView::try_from(&value))
    }

    pub(crate) async fn rotate(
        &self,
        request: BrowserRequestHeaders<'_>,
        connection_id: Uuid,
        expected_version: u64,
        token: Vec<u8>,
        correlation_id: &str,
    ) -> Result<GitConnectionView, GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let token = SecretValue::new(token).map_err(map_secret_error)?;
        runtime
            .operations
            .rotate(
                identity.user_id,
                identity.session_id,
                connection_id,
                expected_version,
                &token,
                correlation_id,
            )
            .await
            .map_err(map_operation_error)
            .and_then(|value| GitConnectionView::try_from(&value))
    }

    pub(crate) async fn disconnect(
        &self,
        request: BrowserRequestHeaders<'_>,
        connection_id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<(), GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .operations
            .disconnect(
                identity.user_id,
                identity.session_id,
                connection_id,
                expected_version,
                correlation_id,
            )
            .await
            .map_err(map_operation_error)
    }

    pub(crate) async fn get_remote(
        &self,
        request: BrowserRequestHeaders<'_>,
        project_id: ProjectId,
    ) -> Result<GitRemoteView, GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .operations
            .get_remote(identity.user_id, project_id)
            .await
            .map_err(map_operation_error)
            .and_then(|value| GitRemoteView::try_from(&value))
    }

    pub(crate) async fn import(
        &self,
        request: BrowserRequestHeaders<'_>,
        project_id: ProjectId,
        repository_url: &str,
        branch: &str,
        correlation_id: &str,
    ) -> Result<GitOperationView, GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let (remote, outcome) = runtime
            .operations
            .import(
                identity.user_id,
                project_id,
                repository_url,
                branch,
                correlation_id,
            )
            .await
            .map_err(map_operation_error)?;
        GitOperationView::from_parts(&remote, &outcome)
    }

    pub(crate) async fn pull(
        &self,
        request: BrowserRequestHeaders<'_>,
        project_id: ProjectId,
        expected_head: &str,
        correlation_id: &str,
    ) -> Result<GitOperationView, GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let (remote, outcome) = runtime
            .operations
            .pull(identity.user_id, project_id, expected_head, correlation_id)
            .await
            .map_err(map_operation_error)?;
        GitOperationView::from_parts(&remote, &outcome)
    }

    pub(crate) async fn commit_and_push(
        &self,
        request: BrowserRequestHeaders<'_>,
        project_id: ProjectId,
        expected_head: &str,
        commit_message: &str,
        correlation_id: &str,
    ) -> Result<GitOperationView, GitHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let (remote, outcome) = runtime
            .operations
            .commit_and_push(
                identity.user_id,
                project_id,
                expected_head,
                commit_message,
                correlation_id,
            )
            .await
            .map_err(map_operation_error)?;
        GitOperationView::from_parts(&remote, &outcome)
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

    async fn admin_actor(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<IntegrationAdminActor, GitHttpError> {
        let identity = self.authenticate(request).await?;
        let active_admin: Option<bool> = sqlx::query_scalar(
            "SELECT status='active' AND is_instance_admin FROM users WHERE id=$1::uuid",
        )
        .bind(identity.user_id.to_string())
        .fetch_optional(
            &mut *self
                .pool
                .acquire()
                .await
                .map_err(|_| GitHttpError::Unavailable)?,
        )
        .await
        .map_err(|_| GitHttpError::Unavailable)?;
        if active_admin != Some(true) {
            return Err(GitHttpError::Forbidden);
        }
        Ok(IntegrationAdminActor {
            user_id: identity.user_id,
            session_id: identity.session_id,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct BrowserIdentity {
    user_id: UserId,
    session_id: SessionId,
}

impl From<&GitProviderMetadata> for GitProviderView {
    fn from(value: &GitProviderMetadata) -> Self {
        Self {
            id: value.id.to_string(),
            display_name: value.display_name.clone(),
            kind: match value.kind {
                GitProviderKind::GitHub => "github",
                GitProviderKind::GitHubEnterprise => "github_enterprise",
                GitProviderKind::GitLab => "gitlab",
                GitProviderKind::GitLabSelfManaged => "gitlab_self_managed",
                GitProviderKind::Generic => "generic",
            }
            .to_owned(),
            host: format!("{}:{}", value.canonical_host, value.canonical_port),
            allows_write: value.allows_write,
        }
    }
}

impl TryFrom<&GitProviderMetadata> for GitProviderAdminView {
    type Error = GitHttpError;

    fn try_from(value: &GitProviderMetadata) -> Result<Self, Self::Error> {
        Ok(Self {
            id: value.id.to_string(),
            display_name: value.display_name.clone(),
            kind: provider_kind(value.kind).to_owned(),
            host: value.canonical_host.clone(),
            port: value.canonical_port,
            api_base_url: value.api_base_url.clone(),
            oauth_authorization_url: value.oauth_authorization_url.clone(),
            oauth_token_url: value.oauth_token_url.clone(),
            oauth_client_id: value.oauth_client_id.clone(),
            state: match value.state {
                GitProviderState::Active => "active",
                GitProviderState::Disabled => "disabled",
            }
            .to_owned(),
            allows_read: value.allows_read,
            allows_write: value.allows_write,
            config_version: value.config_version,
            validated_at: value.validated_at.map(format_time).transpose()?,
        })
    }
}

const fn provider_kind(value: GitProviderKind) -> &'static str {
    match value {
        GitProviderKind::GitHub => "github",
        GitProviderKind::GitHubEnterprise => "github_enterprise",
        GitProviderKind::GitLab => "gitlab",
        GitProviderKind::GitLabSelfManaged => "gitlab_self_managed",
        GitProviderKind::Generic => "generic",
    }
}

impl TryFrom<&GitCredentialConnection> for GitConnectionView {
    type Error = GitHttpError;

    fn try_from(value: &GitCredentialConnection) -> Result<Self, Self::Error> {
        Ok(Self {
            id: value.id.to_string(),
            provider_id: value.provider_id.to_string(),
            credential_version: value.credential_version,
            connection_version: value.connection_version,
            created_at: format_time(value.created_at)?,
            updated_at: format_time(value.updated_at)?,
        })
    }
}

impl TryFrom<&GitRemoteBinding> for GitRemoteView {
    type Error = GitHttpError;

    fn try_from(value: &GitRemoteBinding) -> Result<Self, Self::Error> {
        Ok(Self {
            project_id: value.project_id.to_string(),
            provider_id: value.provider_id.to_string(),
            repository_url: value.repository_url.clone(),
            branch: value.branch.clone(),
            remote_head_sha: value.remote_head_sha.clone(),
            remote_version: value.remote_version,
            created_at: format_time(value.created_at)?,
            updated_at: format_time(value.updated_at)?,
        })
    }
}

impl GitOperationView {
    fn from_parts(
        remote: &GitRemoteBinding,
        outcome: &GitOperationOutcome,
    ) -> Result<Self, GitHttpError> {
        Ok(Self {
            remote: GitRemoteView::try_from(remote)?,
            previous_head_sha: outcome.previous_head_sha().map(str::to_owned),
            head_sha: outcome.head_sha().to_owned(),
            changed_objects: outcome.changed_objects(),
            transferred_bytes: outcome.transferred_bytes(),
        })
    }
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

fn map_secret_error(error: IntegrationError) -> GitHttpError {
    match error {
        IntegrationError::InvalidInput => GitHttpError::InvalidInput,
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

const fn map_provider_error(error: GitProviderError) -> GitHttpError {
    match error {
        GitProviderError::InvalidInput => GitHttpError::InvalidInput,
        GitProviderError::ReauthenticationRequired => GitHttpError::ReauthenticationRequired,
        GitProviderError::NotFound => GitHttpError::NotFound,
        GitProviderError::MustDisable
        | GitProviderError::HostAlreadyRegistered
        | GitProviderError::Conflict => GitHttpError::Conflict,
        GitProviderError::NetworkDenied | GitProviderError::ValidationFailed => {
            GitHttpError::ProviderUnavailable
        }
        GitProviderError::Unavailable => GitHttpError::Unavailable,
    }
}
