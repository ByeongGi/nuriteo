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

use super::super::{
    GitCredentialConnection, GitOperationError, GitOperationOutcome, GitOperationService,
    GitRemoteBinding,
};
use super::{GitHttpError, GitHttpService, Runtime, format_time};

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

impl GitHttpService {
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

impl Runtime {
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
