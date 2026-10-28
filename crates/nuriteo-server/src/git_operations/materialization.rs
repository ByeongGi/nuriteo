#![allow(unused_imports)]
use super::*;
use super::remotes::*;
use super::connection_rows::*;

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

pub use http_service::{GitHttpError, GitHttpService};
use super::{INSTANCE_ID, INTEGRATION_TYPE, CREDENTIAL_KIND, DEFAULT_OPERATION_TIMEOUT, MIN_OPERATION_TIMEOUT, MAX_OPERATION_TIMEOUT, MAX_BRANCH_BYTES, MAX_COMMIT_MESSAGE_BYTES, MAX_CHANGED_OBJECTS, MAX_TRANSFER_BYTES, GitCredentialConnection, GitCredential, GitRemoteBinding, GitOperationOutcome, GitExecution, GitUpdateExecution, GitPushExecution, GitExecutionFuture, GitRemoteExecutor, GitWorkingHeadFuture, GitWorkingHeadPrepare, GitWorkingHeadPreparation, GitWorkingHeadStore, UnavailableGitWorkingHeadStore, UnavailableGitExecutor, GitExecutorError, GitOperationService, GitOperationError, map_integration_error, map_provider_error, map_executor_error};



impl fmt::Debug for super::GitCredential { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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


impl fmt::Debug for GitWorkingHeadPreparation { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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


impl GitWorkingHeadStore for UnavailableGitWorkingHeadStore { fn prepare<'a>(
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


impl GitRemoteExecutor for UnavailableGitExecutor { fn import<'a>(&'a self, _input: GitExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }

    fn pull<'a>(&'a self, _input: GitUpdateExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }

    fn commit_and_push<'a>(&'a self, _input: GitPushExecution<'a>) -> GitExecutionFuture<'a> {
        Box::pin(async { Err(GitExecutorError::Unavailable) })
    }
}


impl fmt::Debug for GitOperationService { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitOperationService")
            .field("operation_timeout", &self.operation_timeout)
            .finish_non_exhaustive()
    }
}
