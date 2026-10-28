#![allow(unused_imports)]
use super::connection_rows::*;
use super::materialization::*;
use super::*;

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

pub(crate) use http_routes::openapi_router;

use super::{
    CREDENTIAL_KIND, DEFAULT_OPERATION_TIMEOUT, GitCredential, GitCredentialConnection,
    GitExecution, GitExecutionFuture, GitExecutorError, GitOperationError, GitOperationOutcome,
    GitOperationService, GitPushExecution, GitRemoteBinding, GitRemoteExecutor, GitUpdateExecution,
    GitWorkingHeadFuture, GitWorkingHeadPreparation, GitWorkingHeadPrepare, GitWorkingHeadStore,
    INSTANCE_ID, INTEGRATION_TYPE, MAX_BRANCH_BYTES, MAX_CHANGED_OBJECTS, MAX_COMMIT_MESSAGE_BYTES,
    MAX_OPERATION_TIMEOUT, MAX_TRANSFER_BYTES, MIN_OPERATION_TIMEOUT, UnavailableGitExecutor,
    UnavailableGitWorkingHeadStore, map_executor_error, map_integration_error, map_provider_error,
};
pub use http_service::{GitHttpError, GitHttpService};

impl super::GitOperationService {
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

    pub(crate) async fn push_remote_two_phase(
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

    pub(crate) async fn pull_remote(
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

    pub(crate) async fn acquire(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<Postgres>, GitOperationError> {
        self.integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| GitOperationError::Unavailable)
    }

    pub(crate) async fn bounded<T>(
        &self,
        future: impl Future<Output = Result<T, GitOperationError>>,
    ) -> Result<T, GitOperationError> {
        time::timeout(self.operation_timeout, future)
            .await
            .map_err(|_| GitOperationError::OperationTimeout)?
    }
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

pub(crate) async fn ensure_active_user(
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

pub(crate) async fn require_recent_reauthentication(
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

pub(crate) async fn require_project_write(
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

pub(crate) async fn require_project_read(
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
