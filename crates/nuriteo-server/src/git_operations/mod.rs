//! User-scoped Git credentials and bounded server-side remote operations.
//!
//! The browser receives connection metadata and operation summaries only. The
//! decrypted HTTPS credential is handed directly to the in-process executor and
//! is never represented by an API DTO.

use std::any::Any;

use std::fmt;

use std::future::Future;

use std::pin::Pin;

use std::str::FromStr;

use std::sync::Arc;

use std::time::Duration;

use ::time::OffsetDateTime;

use sqlx::{Acquire, PgConnection, Postgres, Row, Transaction};

use tokio::time;

use uuid::Uuid;

use crate::database::DatabasePool;

use crate::git_provider::{
    GitProviderError, GitProviderMetadata, GitProviderService, GitProviderState,
};

use crate::identity::{SessionId, UserId};

use crate::integration::{
    CredentialIdentity, IntegrationError, IntegrationRepository, MasterKeyring, SecretValue,
};

use crate::object_storage::S3ObjectStore;

use crate::project::{EffectiveProjectRole, ProjectAccessRepository, ProjectId};

use crate::quota::EffectiveQuota;

use crate::workspace::StorageScopeId;

pub mod embedded;

mod http_routes;

mod http_service;

pub mod transport_security;

pub mod working_head;

pub(crate) use http_routes::openapi_router;

pub use http_service::{GitHttpError, GitHttpService};

const INSTANCE_ID: &str = "instance";

const INTEGRATION_TYPE: &str = "git_user";

const CREDENTIAL_KIND: &str = "https_token";

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

const MIN_OPERATION_TIMEOUT: Duration = Duration::from_secs(1);

const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(60);

const MAX_BRANCH_BYTES: usize = 255;

const MAX_COMMIT_MESSAGE_BYTES: usize = 10 * 1024;

const MAX_CHANGED_OBJECTS: u64 = 100_000;

const MAX_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCredentialConnection {
    pub id: Uuid,
    pub user_id: UserId,
    pub provider_id: Uuid,
    pub credential_version: u64,
    pub connection_version: u64,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

/// Decrypted credential available only to the in-process transport adapter.
/// Its `Debug` implementation is inherited from `SecretValue` and redacted.
pub struct GitCredential(SecretValue);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRemoteBinding {
    pub project_id: ProjectId,
    pub provider_id: Uuid,
    pub repository_url: String,
    pub branch: String,
    pub remote_head_sha: String,
    pub remote_version: u64,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitOperationOutcome {
    previous_head_sha: Option<String>,
    head_sha: String,
    changed_objects: u64,
    transferred_bytes: u64,
    materialized_tree: Option<embedded::GitTreeSnapshot>,
}

#[derive(Debug)]
pub struct GitExecution<'a> {
    pub provider: &'a GitProviderMetadata,
    pub repository_url: &'a str,
    pub branch: &'a str,
    pub credential: &'a GitCredential,
}

#[derive(Debug)]
pub struct GitUpdateExecution<'a> {
    pub remote: GitExecution<'a>,
    pub expected_remote_head_sha: &'a str,
}

#[derive(Debug)]
pub struct GitPushExecution<'a> {
    pub update: GitUpdateExecution<'a>,
    pub commit_message: &'a str,
    pub working_tree: &'a embedded::GitTreeSnapshot,
}

pub type GitExecutionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<GitOperationOutcome, GitExecutorError>> + Send + 'a>>;

/// Narrow adapter boundary for a bounded HTTPS Git implementation.
/// Implementations must not log, persist, or return `GitCredential` contents.
pub trait GitRemoteExecutor: Send + Sync {
    fn import<'a>(&'a self, input: GitExecution<'a>) -> GitExecutionFuture<'a>;
    fn pull<'a>(&'a self, input: GitUpdateExecution<'a>) -> GitExecutionFuture<'a>;
    fn commit_and_push<'a>(&'a self, input: GitPushExecution<'a>) -> GitExecutionFuture<'a>;
}

pub type GitWorkingHeadFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitExecutorError>> + Send + 'a>>;

pub struct GitWorkingHeadPrepare<'a> {
    pub project_id: ProjectId,
    pub storage_scope_id: StorageScopeId,
    pub actor_user_id: UserId,
    pub remote_head_sha: &'a str,
    pub tree: &'a embedded::GitTreeSnapshot,
}

pub struct GitWorkingHeadPreparation(Box<dyn Any + Send>);

pub trait GitWorkingHeadStore: Send + Sync {
    fn prepare<'a>(
        &'a self,
        input: GitWorkingHeadPrepare<'a>,
    ) -> GitWorkingHeadFuture<'a, GitWorkingHeadPreparation>;

    /// Finalizes a previously persisted Bundle. Implementations must not
    /// perform object-storage or other network I/O through this boundary.
    fn finalize<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        prepared: GitWorkingHeadPreparation,
    ) -> GitWorkingHeadFuture<'a, ()>;

    fn load<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        project_id: ProjectId,
        actor_user_id: UserId,
    ) -> GitWorkingHeadFuture<'a, embedded::GitTreeSnapshot>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableGitWorkingHeadStore;

/// Explicit fail-closed adapter used until a production HTTPS Git transport is
/// configured. It prevents route composition from silently pretending that
/// remote operations are available.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableGitExecutor;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitExecutorError {
    AuthenticationFailed,
    NonFastForward,
    RepositoryUnavailable,
    TransferLimitExceeded,
    InvalidRemote,
    Unavailable,
}

#[derive(Clone)]
pub struct GitOperationService {
    integrations: IntegrationRepository,
    providers: GitProviderService,
    executor: Arc<dyn GitRemoteExecutor>,
    working_heads: Arc<dyn GitWorkingHeadStore>,
    operation_timeout: Duration,
}

#[cfg(test)]
const fn map_finalize_error(
    error: GitOperationError,
    remote_push_completed: bool,
) -> GitOperationError {
    if remote_push_completed {
        GitOperationError::CommitOutcomeUnknown
    } else {
        error
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum GitOperationError {
    InvalidInput,
    AuthenticationFailed,
    ReauthenticationRequired,
    Forbidden,
    NotFound,
    AlreadyConnected,
    Conflict,
    NonFastForward,
    ProviderUnavailable,
    CredentialUnavailable,
    TransferLimitExceeded,
    OperationTimeout,
    /// The remote accepted a push, but Nuriteo could not durably finalize its
    /// local head record. Callers must reconcile the remote before retrying;
    /// blindly retrying can create a second commit.
    CommitOutcomeUnknown,
    Unavailable,
}

const fn map_integration_error(error: IntegrationError) -> GitOperationError {
    match error {
        IntegrationError::InvalidInput => GitOperationError::InvalidInput,
        IntegrationError::CredentialUnavailable | IntegrationError::KeyConfiguration => {
            GitOperationError::CredentialUnavailable
        }
        IntegrationError::Conflict => GitOperationError::Conflict,
        _ => GitOperationError::Unavailable,
    }
}

const fn map_provider_error(error: GitProviderError) -> GitOperationError {
    match error {
        GitProviderError::InvalidInput => GitOperationError::InvalidInput,
        GitProviderError::NotFound => GitOperationError::ProviderUnavailable,
        GitProviderError::Conflict => GitOperationError::Conflict,
        _ => GitOperationError::Unavailable,
    }
}

const fn map_executor_error(error: GitExecutorError) -> GitOperationError {
    match error {
        GitExecutorError::AuthenticationFailed => GitOperationError::AuthenticationFailed,
        GitExecutorError::NonFastForward => GitOperationError::NonFastForward,
        GitExecutorError::TransferLimitExceeded => GitOperationError::TransferLimitExceeded,
        GitExecutorError::InvalidRemote => GitOperationError::InvalidInput,
        GitExecutorError::RepositoryUnavailable | GitExecutorError::Unavailable => {
            GitOperationError::Unavailable
        }
    }
}

#[cfg(test)]
mod tests;

mod materialization;
pub(crate) use materialization::*;
mod remotes;
pub(crate) use remotes::*;
mod connection_rows;
pub(crate) use connection_rows::*;
