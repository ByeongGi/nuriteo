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
use super::{GitHttpError, GitHttpService, Runtime, format_time, map_operation_error};

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
pub struct GitConnectionView {
    pub id: String,
    pub provider_id: String,
    pub credential_version: u64,
    pub connection_version: u64,
    pub created_at: String,
    pub updated_at: String,
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

impl GitHttpService {
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
}
fn map_secret_error(error: IntegrationError) -> GitHttpError {
    match error {
        IntegrationError::InvalidInput => GitHttpError::InvalidInput,
        _ => GitHttpError::Internal,
    }
}
