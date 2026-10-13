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

impl fmt::Debug for GitCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("GitCredential([REDACTED])")
    }
}

impl GitCredential {
    /// Borrows the secret for the duration of one trusted transport call.
    /// Callers must never place this value in argv, environment variables,
    /// URLs, logs, metrics, operation results, or persisted working content.
    #[must_use]
    pub fn expose(&self) -> &[u8] {
        self.0.expose()
    }
}

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

impl GitOperationOutcome {
    pub fn new(
        previous_head_sha: Option<String>,
        head_sha: String,
        changed_objects: u64,
        transferred_bytes: u64,
    ) -> Result<Self, GitOperationError> {
        if previous_head_sha
            .as_deref()
            .is_some_and(|value| !valid_sha(value))
            || !valid_sha(&head_sha)
            || changed_objects > MAX_CHANGED_OBJECTS
            || transferred_bytes > MAX_TRANSFER_BYTES
        {
            return Err(GitOperationError::InvalidInput);
        }
        Ok(Self {
            previous_head_sha,
            head_sha,
            changed_objects,
            transferred_bytes,
            materialized_tree: None,
        })
    }

    #[must_use]
    pub fn previous_head_sha(&self) -> Option<&str> {
        self.previous_head_sha.as_deref()
    }

    #[must_use]
    pub fn head_sha(&self) -> &str {
        &self.head_sha
    }

    #[must_use]
    pub const fn changed_objects(&self) -> u64 {
        self.changed_objects
    }

    #[must_use]
    pub const fn transferred_bytes(&self) -> u64 {
        self.transferred_bytes
    }

    #[must_use]
    pub fn with_materialized_tree(mut self, tree: embedded::GitTreeSnapshot) -> Self {
        self.materialized_tree = Some(tree);
        self
    }

    #[must_use]
    pub fn materialized_tree(&self) -> Option<&embedded::GitTreeSnapshot> {
        self.materialized_tree.as_ref()
    }
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

impl fmt::Debug for GitWorkingHeadPreparation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("GitWorkingHeadPreparation([OPAQUE])")
    }
}

impl GitWorkingHeadPreparation {
    pub(crate) fn new(value: impl Any + Send) -> Self {
        Self(Box::new(value))
    }

    pub(crate) fn into_inner<T: Any + Send>(self) -> Result<T, GitExecutorError> {
        self.0
            .downcast::<T>()
            .map(|value| *value)
            .map_err(|_| GitExecutorError::Unavailable)
    }
}

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

impl GitWorkingHeadStore for UnavailableGitWorkingHeadStore {
    fn prepare<'a>(
        &'a self,
        _input: GitWorkingHeadPrepare<'a>,
    ) -> GitWorkingHeadFuture<'a, GitWorkingHeadPreparation> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }

    fn finalize<'a>(
        &'a self,
        _connection: &'a mut PgConnection,
        _prepared: GitWorkingHeadPreparation,
    ) -> GitWorkingHeadFuture<'a, ()> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }

    fn load<'a>(
        &'a self,
        _connection: &'a mut PgConnection,
        _project_id: ProjectId,
        _actor_user_id: UserId,
    ) -> GitWorkingHeadFuture<'a, embedded::GitTreeSnapshot> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }
}

/// Explicit fail-closed adapter used until a production HTTPS Git transport is
/// configured. It prevents route composition from silently pretending that
/// remote operations are available.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableGitExecutor;

impl GitRemoteExecutor for UnavailableGitExecutor {
    fn import<'a>(&'a self, _input: GitExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }

    fn pull<'a>(&'a self, _input: GitUpdateExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }

    fn commit_and_push<'a>(&'a self, _input: GitPushExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }
}

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

impl fmt::Debug for GitOperationService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitOperationService")
            .field("operation_timeout", &self.operation_timeout)
            .finish_non_exhaustive()
    }
}

impl GitOperationService {
    /// Composes the production embedded HTTPS transport and canonical
    /// S3-backed Working Head store. HTTP route layers should receive this
    /// already-composed service rather than selecting transport defaults.
    #[must_use]
    pub fn production(
        pool: DatabasePool,
        keyring: MasterKeyring,
        store: S3ObjectStore,
        effective_quota: EffectiveQuota,
    ) -> Self {
        let integrations = IntegrationRepository::new(pool.clone(), keyring);
        let guard = transport_security::GitHttpsTransportGuard::new(integrations.clone());
        let executor = Arc::new(embedded::EmbeddedGitRemoteExecutor::new(guard));
        let working_heads = Arc::new(working_head::S3GitWorkingHeadStore::new(
            pool,
            store,
            effective_quota,
        ));
        Self::new(integrations, executor).with_working_head_store(working_heads)
    }

    #[must_use]
    pub fn new(integrations: IntegrationRepository, executor: Arc<dyn GitRemoteExecutor>) -> Self {
        Self {
            providers: GitProviderService::new(integrations.clone()),
            integrations,
            executor,
            working_heads: Arc::new(UnavailableGitWorkingHeadStore),
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }

    #[must_use]
    pub fn with_working_head_store(mut self, store: Arc<dyn GitWorkingHeadStore>) -> Self {
        self.working_heads = store;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Result<Self, GitOperationError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&timeout) {
            return Err(GitOperationError::InvalidInput);
        }
        self.operation_timeout = timeout;
        Ok(self)
    }

    /// Returns providers that an authenticated user can select for an import
    /// or connection. Administrative endpoints should use `GitProviderService`
    /// directly so disabled providers remain manageable there.
    pub async fn list_available_providers(
        &self,
        user_id: UserId,
    ) -> Result<Vec<GitProviderMetadata>, GitOperationError> {
        let mut connection = self.acquire().await?;
        ensure_active_user(&mut connection, user_id).await?;
        self.providers
            .list()
            .await
            .map_err(map_provider_error)
            .map(|providers| {
                providers
                    .into_iter()
                    .filter(|provider| {
                        provider.state == GitProviderState::Active && provider.allows_read
                    })
                    .collect()
            })
    }

    /// Loads the current remote binding after tenant-aware Project read
    /// authorization. Credentials and provider secrets never cross this API.
    pub async fn get_remote(
        &self,
        user_id: UserId,
        project_id: ProjectId,
    ) -> Result<GitRemoteBinding, GitOperationError> {
        self.bounded(async {
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            require_project_read(&mut tx, project_id, user_id).await?;
            let remote = load_remote(&mut tx, project_id).await?;
            tx.commit()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            Ok(remote)
        })
        .await
    }

    pub async fn list_connections(
        &self,
        user_id: UserId,
    ) -> Result<Vec<GitCredentialConnection>, GitOperationError> {
        self.bounded(async {
            let mut connection = self.acquire().await?;
            ensure_active_user(&mut connection, user_id).await?;
            let rows = sqlx::query(
                "SELECT id::text,user_id::text,provider_id::text,credential_version,
                 connection_version,created_at,updated_at FROM user_git_credentials
                 WHERE user_id=$1::uuid ORDER BY created_at,id LIMIT 100",
            )
            .bind(user_id.to_string())
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| GitOperationError::Unavailable)?;
            rows.iter().map(connection_from_row).collect()
        })
        .await
    }

    pub async fn connect(
        &self,
        user_id: UserId,
        session_id: SessionId,
        provider_id: Uuid,
        token: &SecretValue,
        correlation_id: &str,
    ) -> Result<GitCredentialConnection, GitOperationError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
            let mut connection = self.acquire().await?;
            let mut tx = connection.begin().await.map_err(|_| GitOperationError::Unavailable)?;
            ensure_active_user(&mut tx, user_id).await?;
            require_recent_reauthentication(&mut tx, user_id, session_id).await?;
            let provider = lock_provider(&mut tx, provider_id).await?;
            if provider.state != GitProviderState::Active || !provider.allows_read {
                return Err(GitOperationError::ProviderUnavailable);
            }
            let id = Uuid::now_v7();
            let identity = credential_identity(id)?;
            let credential = self
                .integrations
                .upsert_credential_in_transaction(&mut tx, &identity, token)
                .await
                .map_err(map_integration_error)?;
            let row = sqlx::query(
                "INSERT INTO user_git_credentials(id,user_id,provider_id,credential_id,credential_version)
                 VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)
                 RETURNING id::text,user_id::text,provider_id::text,credential_version,
                           connection_version,created_at,updated_at",
            )
            .bind(id.to_string())
            .bind(user_id.to_string())
            .bind(provider_id.to_string())
            .bind(credential.id.to_string())
            .bind(i64::try_from(credential.credential_version).map_err(|_| GitOperationError::Unavailable)?)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(&mut tx, user_id, "git.credential_connected", "user", &user_id.to_string(), correlation_id).await?;
            let result = connection_from_row(&row)?;
            tx.commit().await.map_err(|_| GitOperationError::Unavailable)?;
            Ok(result)
        })
        .await
    }

    pub async fn rotate(
        &self,
        user_id: UserId,
        session_id: SessionId,
        connection_id: Uuid,
        expected_version: u64,
        token: &SecretValue,
        correlation_id: &str,
    ) -> Result<GitCredentialConnection, GitOperationError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            ensure_active_user(&mut tx, user_id).await?;
            require_recent_reauthentication(&mut tx, user_id, session_id).await?;
            let current =
                lock_connection(&mut tx, user_id, connection_id, expected_version).await?;
            let credential = self
                .integrations
                .upsert_credential_in_transaction(
                    &mut tx,
                    &credential_identity(connection_id)?,
                    token,
                )
                .await
                .map_err(map_integration_error)?;
            if credential.credential_version != current.credential_version + 1 {
                return Err(GitOperationError::Conflict);
            }
            let row = sqlx::query(
                "UPDATE user_git_credentials SET credential_version=$3,
                 connection_version=connection_version+1,updated_at=CURRENT_TIMESTAMP
                 WHERE id=$1::uuid AND user_id=$2::uuid
                 RETURNING id::text,user_id::text,provider_id::text,credential_version,
                           connection_version,created_at,updated_at",
            )
            .bind(connection_id.to_string())
            .bind(user_id.to_string())
            .bind(
                i64::try_from(credential.credential_version)
                    .map_err(|_| GitOperationError::Unavailable)?,
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                user_id,
                "git.credential_rotated",
                "user",
                &user_id.to_string(),
                correlation_id,
            )
            .await?;
            let result = connection_from_row(&row)?;
            tx.commit()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            Ok(result)
        })
        .await
    }

    pub async fn disconnect(
        &self,
        user_id: UserId,
        session_id: SessionId,
        connection_id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<(), GitOperationError> {
        self.bounded(async {
            validate_correlation(correlation_id)?;
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            ensure_active_user(&mut tx, user_id).await?;
            require_recent_reauthentication(&mut tx, user_id, session_id).await?;
            let current =
                lock_connection(&mut tx, user_id, connection_id, expected_version).await?;
            let credential_id: String = sqlx::query_scalar(
                "DELETE FROM user_git_credentials WHERE id=$1::uuid AND user_id=$2::uuid
                 RETURNING credential_id::text",
            )
            .bind(connection_id.to_string())
            .bind(user_id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| GitOperationError::Unavailable)?;
            sqlx::query("DELETE FROM integration_credentials WHERE id=$1::uuid")
                .bind(credential_id)
                .execute(&mut *tx)
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            append_audit(
                &mut tx,
                user_id,
                "git.credential_disconnected",
                "user",
                &user_id.to_string(),
                correlation_id,
            )
            .await?;
            let _ = current;
            tx.commit()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            Ok(())
        })
        .await
    }

    pub async fn import(
        &self,
        user_id: UserId,
        project_id: ProjectId,
        repository_url: &str,
        branch: &str,
        correlation_id: &str,
    ) -> Result<(GitRemoteBinding, GitOperationOutcome), GitOperationError> {
        validate_branch(branch)?;
        validate_correlation(correlation_id)?;
        let provider = self
            .providers
            .resolve_active_repository(repository_url)
            .await
            .map_err(map_provider_error)?;
        if !provider.allows_read {
            return Err(GitOperationError::Forbidden);
        }
        self.bounded(async {
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            require_project_write(&mut tx, project_id, user_id).await?;
            let storage_scope_id = project_storage_scope(&mut tx, project_id).await?;
            lock_provider_generation(&mut tx, &provider, false).await?;
            if remote_exists(&mut tx, project_id).await? {
                return Err(GitOperationError::AlreadyConnected);
            }
            let credential =
                load_user_credential(&self.integrations, &mut tx, user_id, provider.id).await?;
            tx.commit()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            let outcome = self
                .executor
                .import(GitExecution {
                    provider: &provider,
                    repository_url,
                    branch,
                    credential: &credential,
                })
                .await
                .map_err(map_executor_error)?;
            validate_import_outcome(&outcome)?;
            let tree = outcome
                .materialized_tree()
                .ok_or(GitOperationError::Unavailable)?;
            let prepared_head = self
                .working_heads
                .prepare(GitWorkingHeadPrepare {
                    project_id,
                    storage_scope_id,
                    actor_user_id: user_id,
                    remote_head_sha: outcome.head_sha(),
                    tree,
                })
                .await
                .map_err(map_executor_error)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            require_project_write(&mut tx, project_id, user_id).await?;
            lock_provider_generation(&mut tx, &provider, false).await?;
            if remote_exists(&mut tx, project_id).await? {
                return Err(GitOperationError::AlreadyConnected);
            }
            self.working_heads
                .finalize(&mut tx, prepared_head)
                .await
                .map_err(map_executor_error)?;
            let row = sqlx::query(
                "INSERT INTO project_git_remotes(project_id,provider_id,repository_url,branch,
                 remote_head_sha,imported_by_user_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid)
                 RETURNING project_id::text,provider_id::text,repository_url,branch,remote_head_sha,
                           remote_version,created_at,updated_at",
            )
            .bind(project_id.to_string())
            .bind(provider.id.to_string())
            .bind(repository_url)
            .bind(branch)
            .bind(&outcome.head_sha)
            .bind(user_id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                user_id,
                "git.project_imported",
                "project",
                &project_id.to_string(),
                correlation_id,
            )
            .await?;
            let binding = remote_from_row(&row)?;
            tx.commit()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            Ok((binding, outcome))
        })
        .await
    }

    pub async fn pull(
        &self,
        user_id: UserId,
        project_id: ProjectId,
        expected_remote_head_sha: &str,
        correlation_id: &str,
    ) -> Result<(GitRemoteBinding, GitOperationOutcome), GitOperationError> {
        validate_expected_sha(expected_remote_head_sha)?;
        self.pull_remote(
            user_id,
            project_id,
            expected_remote_head_sha,
            correlation_id,
        )
        .await
    }

    pub async fn commit_and_push(
        &self,
        user_id: UserId,
        project_id: ProjectId,
        expected_remote_head_sha: &str,
        commit_message: &str,
        correlation_id: &str,
    ) -> Result<(GitRemoteBinding, GitOperationOutcome), GitOperationError> {
        validate_expected_sha(expected_remote_head_sha)?;
        validate_commit_message(commit_message)?;
        self.push_remote_two_phase(
            user_id,
            project_id,
            expected_remote_head_sha,
            commit_message,
            correlation_id,
        )
        .await
    }

    async fn push_remote_two_phase(
        &self,
        user_id: UserId,
        project_id: ProjectId,
        expected_head: &str,
        commit_message: &str,
        correlation_id: &str,
    ) -> Result<(GitRemoteBinding, GitOperationOutcome), GitOperationError> {
        validate_correlation(correlation_id)?;
        // Prepare: capture exact generations and credential, then release every
        // database lock before S3 read or embedded Git I/O.
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| GitOperationError::Unavailable)?;
        require_project_write(&mut tx, project_id, user_id).await?;
        let remote = lock_remote(&mut tx, project_id).await?;
        if remote.remote_head_sha != expected_head {
            return Err(GitOperationError::NonFastForward);
        }
        let provider = lock_provider_by_id(&mut tx, remote.provider_id).await?;
        lock_provider_generation(&mut tx, &provider, true).await?;
        let credential =
            load_user_credential(&self.integrations, &mut tx, user_id, provider.id).await?;
        tx.commit()
            .await
            .map_err(|_| GitOperationError::Unavailable)?;
        let working_tree = self
            .working_heads
            .load(&mut connection, project_id, user_id)
            .await
            .map_err(map_executor_error)?;

        // Execute: libgit2 push is intentionally not wrapped in a cancelling
        // Tokio timeout because its blocking worker cannot be stopped safely.
        let outcome = self
            .executor
            .commit_and_push(GitPushExecution {
                update: GitUpdateExecution {
                    remote: GitExecution {
                        provider: &provider,
                        repository_url: &remote.repository_url,
                        branch: &remote.branch,
                        credential: &credential,
                    },
                    expected_remote_head_sha: expected_head,
                },
                commit_message,
                working_tree: &working_tree,
            })
            .await
            .map_err(map_executor_error)?;
        validate_update_outcome(&outcome, expected_head)
            .map_err(|_| GitOperationError::CommitOutcomeUnknown)?;

        // Finalize: re-authorize and fence every captured generation. From this
        // point onward any failure is outcome-unknown because the remote has
        // already accepted the commit.
        let finalize = async {
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            require_project_write(&mut tx, project_id, user_id).await?;
            let current = lock_remote(&mut tx, project_id).await?;
            if current.remote_version != remote.remote_version
                || current.remote_head_sha != remote.remote_head_sha
                || current.provider_id != remote.provider_id
                || current.repository_url != remote.repository_url
                || current.branch != remote.branch
            {
                return Err(GitOperationError::Conflict);
            }
            let current_provider = lock_provider_by_id(&mut tx, provider.id).await?;
            if current_provider.config_version != provider.config_version {
                return Err(GitOperationError::ProviderUnavailable);
            }
            lock_provider_generation(&mut tx, &current_provider, true).await?;
            let row = sqlx::query(
                "UPDATE project_git_remotes SET remote_head_sha=$2,\
                 remote_version=remote_version+1,updated_at=CURRENT_TIMESTAMP \
                 WHERE project_id=$1::uuid AND remote_version=$3 \
                 RETURNING project_id::text,provider_id::text,repository_url,branch,\
                 remote_head_sha,remote_version,created_at,updated_at",
            )
            .bind(project_id.to_string())
            .bind(outcome.head_sha())
            .bind(i64::try_from(remote.remote_version).map_err(|_| GitOperationError::Unavailable)?)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                user_id,
                "git.project_pushed",
                "project",
                &project_id.to_string(),
                correlation_id,
            )
            .await?;
            let binding = remote_from_row(&row)?;
            tx.commit()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            Ok(binding)
        }
        .await;
        finalize
            .map(|binding| (binding, outcome))
            .map_err(|_| GitOperationError::CommitOutcomeUnknown)
    }

    async fn pull_remote(
        &self,
        user_id: UserId,
        project_id: ProjectId,
        expected_head: &str,
        correlation_id: &str,
    ) -> Result<(GitRemoteBinding, GitOperationOutcome), GitOperationError> {
        validate_correlation(correlation_id)?;
        let operation = async move {
            let mut connection = self.acquire().await?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            require_project_write(&mut tx, project_id, user_id).await?;
            let storage_scope_id = project_storage_scope(&mut tx, project_id).await?;
            let remote = lock_remote(&mut tx, project_id).await?;
            if remote.remote_head_sha != expected_head {
                return Err(GitOperationError::NonFastForward);
            }
            let provider = lock_provider_by_id(&mut tx, remote.provider_id).await?;
            lock_provider_generation(&mut tx, &provider, false).await?;
            let credential =
                load_user_credential(&self.integrations, &mut tx, user_id, provider.id).await?;
            let execution = GitUpdateExecution {
                remote: GitExecution {
                    provider: &provider,
                    repository_url: &remote.repository_url,
                    branch: &remote.branch,
                    credential: &credential,
                },
                expected_remote_head_sha: expected_head,
            };
            tx.commit()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            let outcome = self
                .executor
                .pull(execution)
                .await
                .map_err(map_executor_error)?;
            validate_update_outcome(&outcome, expected_head)?;
            let tree = outcome
                .materialized_tree()
                .ok_or(GitOperationError::Unavailable)?;
            // Bundle encoding and object persistence happen after the first
            // transaction is committed and before the finalize transaction.
            let prepared_head = self
                .working_heads
                .prepare(GitWorkingHeadPrepare {
                    project_id,
                    storage_scope_id,
                    actor_user_id: user_id,
                    remote_head_sha: outcome.head_sha(),
                    tree,
                })
                .await
                .map_err(map_executor_error)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            require_project_write(&mut tx, project_id, user_id).await?;
            let current = lock_remote(&mut tx, project_id).await?;
            if current.remote_version != remote.remote_version
                || current.remote_head_sha != remote.remote_head_sha
                || current.provider_id != remote.provider_id
                || current.repository_url != remote.repository_url
                || current.branch != remote.branch
            {
                return Err(GitOperationError::Conflict);
            }
            let current_provider = lock_provider_by_id(&mut tx, provider.id).await?;
            if current_provider.config_version != provider.config_version {
                return Err(GitOperationError::ProviderUnavailable);
            }
            lock_provider_generation(&mut tx, &current_provider, false).await?;
            self.working_heads
                .finalize(&mut tx, prepared_head)
                .await
                .map_err(map_executor_error)?;
            let row = sqlx::query(
                "UPDATE project_git_remotes SET remote_head_sha=$2,
                 remote_version=remote_version+1,updated_at=CURRENT_TIMESTAMP
                 WHERE project_id=$1::uuid RETURNING project_id::text,provider_id::text,
                 repository_url,branch,remote_head_sha,remote_version,created_at,updated_at",
            )
            .bind(project_id.to_string())
            .bind(&outcome.head_sha)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_database_error)?;
            append_audit(
                &mut tx,
                user_id,
                "git.project_pulled",
                "project",
                &project_id.to_string(),
                correlation_id,
            )
            .await?;
            let binding = remote_from_row(&row)?;
            tx.commit()
                .await
                .map_err(|_| GitOperationError::Unavailable)?;
            Ok((binding, outcome))
        };
        self.bounded(operation).await
    }

    async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<Postgres>, GitOperationError> {
        self.integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| GitOperationError::Unavailable)
    }

    async fn bounded<T>(
        &self,
        future: impl Future<Output = Result<T, GitOperationError>>,
    ) -> Result<T, GitOperationError> {
        time::timeout(self.operation_timeout, future)
            .await
            .map_err(|_| GitOperationError::OperationTimeout)?
    }
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

impl fmt::Display for GitOperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Git operation input is invalid",
            Self::AuthenticationFailed => "Git credential was rejected",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::Forbidden => "Git operation is not authorized",
            Self::NotFound => "Git resource was not found",
            Self::AlreadyConnected => "Git resource is already connected",
            Self::Conflict => "Git resource changed concurrently",
            Self::NonFastForward => "remote Git head changed",
            Self::ProviderUnavailable => "Git provider is unavailable",
            Self::CredentialUnavailable => "Git credential is unavailable",
            Self::TransferLimitExceeded => "Git transfer limit was exceeded",
            Self::OperationTimeout => "Git operation timed out",
            Self::CommitOutcomeUnknown => {
                "remote Git push succeeded but local commit outcome is unknown"
            }
            Self::Unavailable => "Git operation service is unavailable",
        })
    }
}

impl std::error::Error for GitOperationError {}

async fn ensure_active_user(
    connection: &mut PgConnection,
    user_id: UserId,
) -> Result<(), GitOperationError> {
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1::uuid AND status='active')",
    )
    .bind(user_id.to_string())
    .fetch_one(connection)
    .await
    .map_err(|_| GitOperationError::Unavailable)?;
    if active {
        Ok(())
    } else {
        Err(GitOperationError::AuthenticationFailed)
    }
}

async fn require_recent_reauthentication(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    session_id: SessionId,
) -> Result<(), GitOperationError> {
    let recent: Option<bool> = sqlx::query_scalar(
        "SELECT session.last_reauthenticated_at IS NOT NULL \
         AND session.last_reauthenticated_at>=transaction_timestamp()-\
             make_interval(mins=>(policy.value #>> '{}')::integer) \
         AND session.last_reauthenticated_at<=transaction_timestamp() \
         FROM sessions session CROSS JOIN instance_settings policy \
         WHERE session.id=$1::uuid AND session.user_id=$2::uuid \
           AND session.revoked_at IS NULL AND session.rotated_at IS NULL \
           AND session.idle_expires_at>transaction_timestamp() \
           AND session.absolute_expires_at>transaction_timestamp() \
           AND policy.key='security.reauthentication_window_minutes' \
         FOR UPDATE OF session",
    )
    .bind(session_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?;
    match recent {
        Some(true) => Ok(()),
        Some(false) => Err(GitOperationError::ReauthenticationRequired),
        None => Err(GitOperationError::AuthenticationFailed),
    }
}

async fn require_project_write(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    user_id: UserId,
) -> Result<(), GitOperationError> {
    let role = ProjectAccessRepository::resolve_effective_role_for_update(tx, project_id, user_id)
        .await
        .map_err(|_| GitOperationError::Unavailable)?;
    if role >= EffectiveProjectRole::Write {
        Ok(())
    } else {
        Err(GitOperationError::NotFound)
    }
}

async fn require_project_read(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
    user_id: UserId,
) -> Result<(), GitOperationError> {
    let role = ProjectAccessRepository::resolve_effective_role(tx, project_id, user_id)
        .await
        .map_err(|_| GitOperationError::Unavailable)?;
    if role >= EffectiveProjectRole::Read {
        Ok(())
    } else {
        Err(GitOperationError::NotFound)
    }
}

async fn project_storage_scope(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<StorageScopeId, GitOperationError> {
    let value: String = sqlx::query_scalar(
        "SELECT storage_scope_id::text FROM projects WHERE id=$1::uuid AND state='active'",
    )
    .bind(project_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?
    .ok_or(GitOperationError::NotFound)?;
    StorageScopeId::from_str(&value).map_err(|_| GitOperationError::Unavailable)
}

async fn lock_provider(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<GitProviderMetadata, GitOperationError> {
    lock_provider_by_id(tx, id).await
}

async fn lock_provider_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<GitProviderMetadata, GitOperationError> {
    let row = sqlx::query(
        "SELECT id::text,display_name,provider_kind,canonical_host,canonical_port,api_base_url,
         oauth_authorization_url,oauth_token_url,oauth_client_id,status,allows_read,allows_write,
         config_version,validated_at,created_at,updated_at FROM git_providers
         WHERE id=$1::uuid FOR SHARE",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?
    .ok_or(GitOperationError::ProviderUnavailable)?;
    decode_provider(&row)
}

async fn lock_provider_generation(
    tx: &mut Transaction<'_, Postgres>,
    expected: &GitProviderMetadata,
    write: bool,
) -> Result<(), GitOperationError> {
    let actual = lock_provider_by_id(tx, expected.id).await?;
    if actual.state != GitProviderState::Active
        || actual.config_version != expected.config_version
        || !actual.allows_read
        || (write && !actual.allows_write)
    {
        return Err(GitOperationError::ProviderUnavailable);
    }
    Ok(())
}

async fn load_user_credential(
    integrations: &IntegrationRepository,
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    provider_id: Uuid,
) -> Result<GitCredential, GitOperationError> {
    let row = sqlx::query(
        "SELECT id::text,credential_id::text,credential_version FROM user_git_credentials
         WHERE user_id=$1::uuid AND provider_id=$2::uuid FOR SHARE",
    )
    .bind(user_id.to_string())
    .bind(provider_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?
    .ok_or(GitOperationError::CredentialUnavailable)?;
    let id = parse_uuid(row.get::<&str, _>("id"))?;
    let credential_id = parse_uuid(row.get::<&str, _>("credential_id"))?;
    let version = parse_version(row.get("credential_version"))?;
    let (identity, stored_version, secret) = integrations
        .read_credential_by_id_in_transaction(tx, credential_id)
        .await
        .map_err(map_integration_error)?;
    if identity != credential_identity(id)? || stored_version != version {
        return Err(GitOperationError::CredentialUnavailable);
    }
    Ok(GitCredential(secret))
}

async fn lock_connection(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    id: Uuid,
    expected_version: u64,
) -> Result<GitCredentialConnection, GitOperationError> {
    let row = sqlx::query(
        "SELECT id::text,user_id::text,provider_id::text,credential_version,connection_version,
         created_at,updated_at FROM user_git_credentials WHERE id=$1::uuid AND user_id=$2::uuid FOR UPDATE",
    ).bind(id.to_string()).bind(user_id.to_string()).fetch_optional(&mut **tx).await
        .map_err(|_| GitOperationError::Unavailable)?.ok_or(GitOperationError::NotFound)?;
    let current = connection_from_row(&row)?;
    if current.connection_version != expected_version {
        return Err(GitOperationError::Conflict);
    }
    Ok(current)
}

async fn remote_exists(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<bool, GitOperationError> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM project_git_remotes WHERE project_id=$1::uuid)")
        .bind(project_id.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| GitOperationError::Unavailable)
}

async fn lock_remote(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<GitRemoteBinding, GitOperationError> {
    let row = sqlx::query(
        "SELECT project_id::text,provider_id::text,repository_url,branch,remote_head_sha,
         remote_version,created_at,updated_at FROM project_git_remotes WHERE project_id=$1::uuid FOR UPDATE",
    ).bind(project_id.to_string()).fetch_optional(&mut **tx).await
        .map_err(|_| GitOperationError::Unavailable)?.ok_or(GitOperationError::NotFound)?;
    remote_from_row(&row)
}

async fn load_remote(
    tx: &mut Transaction<'_, Postgres>,
    project_id: ProjectId,
) -> Result<GitRemoteBinding, GitOperationError> {
    let row = sqlx::query(
        "SELECT project_id::text,provider_id::text,repository_url,branch,remote_head_sha,\
         remote_version,created_at,updated_at FROM project_git_remotes WHERE project_id=$1::uuid",
    )
    .bind(project_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitOperationError::Unavailable)?
    .ok_or(GitOperationError::NotFound)?;
    remote_from_row(&row)
}

fn connection_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<GitCredentialConnection, GitOperationError> {
    Ok(GitCredentialConnection {
        id: parse_uuid(row.get::<&str, _>("id"))?,
        user_id: UserId::from_uuid(parse_uuid(row.get::<&str, _>("user_id"))?)
            .map_err(|_| GitOperationError::Unavailable)?,
        provider_id: parse_uuid(row.get::<&str, _>("provider_id"))?,
        credential_version: parse_version(row.get("credential_version"))?,
        connection_version: parse_version(row.get("connection_version"))?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn remote_from_row(row: &sqlx::postgres::PgRow) -> Result<GitRemoteBinding, GitOperationError> {
    let project_id = ProjectId::from_uuid(parse_uuid(row.get::<&str, _>("project_id"))?)
        .map_err(|_| GitOperationError::Unavailable)?;
    let value = GitRemoteBinding {
        project_id,
        provider_id: parse_uuid(row.get::<&str, _>("provider_id"))?,
        repository_url: row.get("repository_url"),
        branch: row.get("branch"),
        remote_head_sha: row.get("remote_head_sha"),
        remote_version: parse_version(row.get("remote_version"))?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    };
    validate_branch(&value.branch)?;
    validate_expected_sha(&value.remote_head_sha)?;
    Ok(value)
}

fn decode_provider(row: &sqlx::postgres::PgRow) -> Result<GitProviderMetadata, GitOperationError> {
    crate::git_provider::metadata_from_database_row(row).map_err(map_provider_error)
}

fn credential_identity(id: Uuid) -> Result<CredentialIdentity, GitOperationError> {
    CredentialIdentity::new(
        INSTANCE_ID,
        INTEGRATION_TYPE,
        id.to_string(),
        CREDENTIAL_KIND,
    )
    .map_err(map_integration_error)
}

fn validate_import_outcome(outcome: &GitOperationOutcome) -> Result<(), GitOperationError> {
    if outcome.previous_head_sha.is_some()
        || !valid_sha(&outcome.head_sha)
        || outcome.changed_objects > MAX_CHANGED_OBJECTS
        || outcome.transferred_bytes > MAX_TRANSFER_BYTES
    {
        Err(GitOperationError::InvalidInput)
    } else {
        Ok(())
    }
}

fn validate_update_outcome(
    outcome: &GitOperationOutcome,
    expected_head: &str,
) -> Result<(), GitOperationError> {
    if outcome.previous_head_sha.as_deref() != Some(expected_head) {
        return Err(GitOperationError::NonFastForward);
    }
    if !valid_sha(&outcome.head_sha)
        || outcome.changed_objects > MAX_CHANGED_OBJECTS
        || outcome.transferred_bytes > MAX_TRANSFER_BYTES
    {
        return Err(GitOperationError::InvalidInput);
    }
    Ok(())
}

fn validate_expected_sha(value: &str) -> Result<(), GitOperationError> {
    if valid_sha(value) {
        Ok(())
    } else {
        Err(GitOperationError::InvalidInput)
    }
}

fn valid_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_branch(value: &str) -> Result<(), GitOperationError> {
    let invalid = value.is_empty()
        || value.len() > MAX_BRANCH_BYTES
        || value.starts_with('/')
        || value.ends_with('/')
        || value.starts_with('.')
        || value.ends_with('.')
        || value.ends_with(".lock")
        || value.contains("..")
        || value.contains("@{")
        || value.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        });
    if invalid {
        Err(GitOperationError::InvalidInput)
    } else {
        Ok(())
    }
}

fn validate_commit_message(value: &str) -> Result<(), GitOperationError> {
    if value.is_empty() || value.len() > MAX_COMMIT_MESSAGE_BYTES || value.contains('\0') {
        Err(GitOperationError::InvalidInput)
    } else {
        Ok(())
    }
}

fn validate_correlation(value: &str) -> Result<(), GitOperationError> {
    if (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(GitOperationError::InvalidInput)
    }
}

fn parse_uuid(value: &str) -> Result<Uuid, GitOperationError> {
    Uuid::from_str(value).map_err(|_| GitOperationError::Unavailable)
}

fn parse_version(value: i64) -> Result<u64, GitOperationError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(GitOperationError::Unavailable)
}

async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    action: &str,
    scope_type: &str,
    scope_id: &str,
    correlation_id: &str,
) -> Result<(), GitOperationError> {
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,
         target_id,scope_type,scope_id,result,correlation_id,changed_fields,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,$3,'git_operation',$4,$5,$4,'succeeded',$6,$7,'{}'::jsonb)",
    ).bind(Uuid::now_v7().to_string()).bind(actor.to_string()).bind(action).bind(scope_id)
        .bind(scope_type).bind(correlation_id).bind(vec!["git_state".to_owned()])
        .execute(&mut **tx).await.map_err(|_| GitOperationError::Unavailable)?;
    Ok(())
}

fn map_database_error(error: sqlx::Error) -> GitOperationError {
    match error
        .as_database_error()
        .and_then(|value| value.code())
        .as_deref()
    {
        Some("23505") => GitOperationError::AlreadyConnected,
        Some("23503") => GitOperationError::NotFound,
        Some("23514" | "P0001") => GitOperationError::Conflict,
        _ => GitOperationError::Unavailable,
    }
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
