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

impl GitHttpService {
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
}
