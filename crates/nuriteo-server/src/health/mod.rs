use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::time;

use crate::database::{DatabasePool, SchemaReadiness, check_schema_readiness};
use crate::object_storage::S3ObjectStore;

mod client;

pub(crate) use client::run_http_healthcheck;

type ProbeFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ()>> + Send + 'a>>;

trait DatabaseProbe: Send + Sync {
    fn readiness(&self) -> ProbeFuture<'_, SchemaReadiness>;
}

trait StorageProbe: Send + Sync {
    fn readiness(&self) -> ProbeFuture<'_, ()>;
}

impl DatabaseProbe for DatabasePool {
    fn readiness(&self) -> ProbeFuture<'_, SchemaReadiness> {
        Box::pin(async { check_schema_readiness(self).await.map_err(|_| ()) })
    }
}

impl StorageProbe for S3ObjectStore {
    fn readiness(&self) -> ProbeFuture<'_, ()> {
        Box::pin(async { self.check_readiness().await.map_err(|_| ()) })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthPolicy {
    database_timeout: Duration,
    storage_timeout: Duration,
    overall_timeout: Duration,
    max_concurrent: usize,
}

impl HealthPolicy {
    pub fn new(
        database_timeout: Duration,
        storage_timeout: Duration,
        overall_timeout: Duration,
        max_concurrent: usize,
    ) -> Result<Self, HealthPolicyError> {
        let valid_dependency = |value: Duration| {
            (Duration::from_millis(100)..=Duration::from_secs(10)).contains(&value)
        };
        if !valid_dependency(database_timeout) || !valid_dependency(storage_timeout) {
            return Err(HealthPolicyError::InvalidDependencyTimeout);
        }
        if !(Duration::from_millis(100)..=Duration::from_secs(15)).contains(&overall_timeout) {
            return Err(HealthPolicyError::InvalidOverallTimeout);
        }
        if !(1..=64).contains(&max_concurrent) {
            return Err(HealthPolicyError::InvalidConcurrency);
        }
        Ok(Self {
            database_timeout,
            storage_timeout,
            overall_timeout,
            max_concurrent,
        })
    }
}

impl Default for HealthPolicy {
    fn default() -> Self {
        Self {
            database_timeout: Duration::from_secs(2),
            storage_timeout: Duration::from_secs(2),
            overall_timeout: Duration::from_secs(3),
            max_concurrent: 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthPolicyError {
    InvalidDependencyTimeout,
    InvalidOverallTimeout,
    InvalidConcurrency,
}

impl std::fmt::Display for HealthPolicyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDependencyTimeout => "health dependency timeout is invalid",
            Self::InvalidOverallTimeout => "health overall timeout is invalid",
            Self::InvalidConcurrency => "health concurrency limit is invalid",
        })
    }
}

impl std::error::Error for HealthPolicyError {}

#[derive(Clone)]
pub struct HealthService {
    database: Option<Arc<dyn DatabaseProbe>>,
    storage: Option<Arc<dyn StorageProbe>>,
    policy: HealthPolicy,
    gate: Arc<Semaphore>,
}

impl HealthService {
    #[must_use]
    pub fn unconfigured() -> Self {
        Self::from_parts(None, None, HealthPolicy::default())
    }

    #[must_use]
    pub fn production(
        database: DatabasePool,
        storage: S3ObjectStore,
        policy: HealthPolicy,
    ) -> Self {
        Self::from_parts(Some(Arc::new(database)), Some(Arc::new(storage)), policy)
    }

    fn from_parts(
        database: Option<Arc<dyn DatabaseProbe>>,
        storage: Option<Arc<dyn StorageProbe>>,
        policy: HealthPolicy,
    ) -> Self {
        Self {
            database,
            storage,
            policy,
            gate: Arc::new(Semaphore::new(policy.max_concurrent)),
        }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/health/live", get(live))
            .route("/health/ready", get(ready))
            .with_state(self)
    }

    pub async fn readiness(&self) -> ReadinessState {
        let Ok(_permit) = self.gate.clone().try_acquire_owned() else {
            return ReadinessState::Unavailable(UnavailableCategory::Capacity);
        };
        let (Some(database), Some(storage)) = (&self.database, &self.storage) else {
            return ReadinessState::Unavailable(UnavailableCategory::Configuration);
        };

        let checks = async {
            tokio::join!(
                time::timeout(self.policy.database_timeout, database.readiness()),
                time::timeout(self.policy.storage_timeout, storage.readiness())
            )
        };
        let Ok((database, storage)) = time::timeout(self.policy.overall_timeout, checks).await
        else {
            return ReadinessState::Unavailable(UnavailableCategory::Deadline);
        };

        match database {
            Err(_) => ReadinessState::Unavailable(UnavailableCategory::DatabaseTimeout),
            Ok(Err(())) => ReadinessState::Unavailable(UnavailableCategory::Database),
            Ok(Ok(SchemaReadiness::Ready { .. })) => match storage {
                Err(_) => ReadinessState::Unavailable(UnavailableCategory::StorageTimeout),
                Ok(Err(())) => ReadinessState::Unavailable(UnavailableCategory::Storage),
                Ok(Ok(())) => ReadinessState::Ready,
            },
            Ok(Ok(SchemaReadiness::Pending { .. })) => {
                ReadinessState::Unavailable(UnavailableCategory::SchemaPending)
            }
            Ok(Ok(SchemaReadiness::Dirty { .. })) => {
                ReadinessState::Unavailable(UnavailableCategory::SchemaDirty)
            }
            Ok(Ok(SchemaReadiness::ChecksumMismatch { .. })) => {
                ReadinessState::Unavailable(UnavailableCategory::SchemaChecksumMismatch)
            }
            Ok(Ok(SchemaReadiness::Unsupported { .. })) => {
                ReadinessState::Unavailable(UnavailableCategory::SchemaUnsupported)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadinessState {
    Ready,
    Unavailable(UnavailableCategory),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableCategory {
    Configuration,
    Capacity,
    Deadline,
    DatabaseTimeout,
    Database,
    SchemaPending,
    SchemaDirty,
    SchemaChecksumMismatch,
    SchemaUnsupported,
    StorageTimeout,
    Storage,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<UnavailableCategory>,
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "live",
        category: None,
    })
}

async fn ready(
    axum::extract::State(service): axum::extract::State<HealthService>,
) -> (StatusCode, Json<HealthResponse>) {
    match service.readiness().await {
        ReadinessState::Ready => (
            StatusCode::OK,
            Json(HealthResponse {
                status: "ready",
                category: None,
            }),
        ),
        ReadinessState::Unavailable(category) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "unavailable",
                category: Some(category),
            }),
        ),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HealthcheckResponse {
    status: String,
}

impl HealthcheckResponse {
    pub(crate) fn is_ready(&self) -> bool {
        self.status == "ready"
    }
}

#[cfg(test)]
mod tests;
