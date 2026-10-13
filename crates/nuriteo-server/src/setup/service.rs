use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::time;
use utoipa::ToSchema;

use crate::database::DatabasePool;

use super::repository::{SetupStatusRepository, SetupStatusRepositoryError};

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(2);
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) type RepositoryFuture<'a> =
    Pin<Box<dyn Future<Output = Result<bool, SetupStatusRepositoryError>> + Send + 'a>>;

pub(super) trait SetupStatusReader: Send + Sync {
    fn active_instance_administrator_exists(&self) -> RepositoryFuture<'_>;
}

impl SetupStatusReader for SetupStatusRepository {
    fn active_instance_administrator_exists(&self) -> RepositoryFuture<'_> {
        Box::pin(self.active_instance_administrator_exists())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    bootstrap_required: bool,
}

impl SetupStatus {
    #[must_use]
    pub const fn bootstrap_required(self) -> bool {
        self.bootstrap_required
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SetupStatusPolicy {
    operation_timeout: Duration,
}

impl SetupStatusPolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, SetupStatusPolicyError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(SetupStatusPolicyError::InvalidOperationTimeout);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for SetupStatusPolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStatusPolicyError {
    InvalidOperationTimeout,
}

impl fmt::Display for SetupStatusPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("setup status operation timeout is invalid")
    }
}

impl std::error::Error for SetupStatusPolicyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStatusServiceError {
    Unavailable,
    OperationTimeout,
    Internal,
}

impl fmt::Display for SetupStatusServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "setup status service is unavailable",
            Self::OperationTimeout => "setup status operation timed out",
            Self::Internal => "setup status operation failed",
        })
    }
}

impl std::error::Error for SetupStatusServiceError {}

#[derive(Clone)]
pub struct SetupStatusService {
    reader: Option<Arc<dyn SetupStatusReader>>,
    policy: SetupStatusPolicy,
}

impl fmt::Debug for SetupStatusService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SetupStatusService")
            .field("configured", &self.reader.is_some())
            .field("policy", &self.policy)
            .finish()
    }
}

impl SetupStatusService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self {
            reader: None,
            policy: SetupStatusPolicy {
                operation_timeout: DEFAULT_OPERATION_TIMEOUT,
            },
        }
    }

    #[must_use]
    pub fn production(pool: DatabasePool, policy: SetupStatusPolicy) -> Self {
        Self {
            reader: Some(Arc::new(SetupStatusRepository::new(pool))),
            policy,
        }
    }

    pub async fn status(&self) -> Result<SetupStatus, SetupStatusServiceError> {
        let reader = self
            .reader
            .as_deref()
            .ok_or(SetupStatusServiceError::Unavailable)?;
        let active_administrator = time::timeout(
            self.policy.operation_timeout,
            reader.active_instance_administrator_exists(),
        )
        .await
        .map_err(|_| SetupStatusServiceError::OperationTimeout)?
        .map_err(map_repository_error)?;
        Ok(SetupStatus {
            bootstrap_required: !active_administrator,
        })
    }

    #[cfg(test)]
    pub(super) fn from_reader(
        reader: Arc<dyn SetupStatusReader>,
        policy: SetupStatusPolicy,
    ) -> Self {
        Self {
            reader: Some(reader),
            policy,
        }
    }
}

const fn map_repository_error(error: SetupStatusRepositoryError) -> SetupStatusServiceError {
    match error {
        SetupStatusRepositoryError::Unavailable => SetupStatusServiceError::Unavailable,
        SetupStatusRepositoryError::InvalidPersistedState => SetupStatusServiceError::Internal,
    }
}
