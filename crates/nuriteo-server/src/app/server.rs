use std::fmt;
use std::num::NonZeroUsize;

use crate::config::{Config, Environment, FileReader};
use crate::database::{DatabasePool, DatabaseRuntimeConfig};
use crate::health::{HealthPolicy, HealthService};
use crate::object_storage::{ObjectStorageConfig, OperationLimits, S3ObjectStore};

use super::{Supervisor, SupervisorConfig, WorkerError, build_router_with_health};

const HTTP_WORKERS: NonZeroUsize = NonZeroUsize::MIN;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServeError {
    Configuration,
    DatabaseConfiguration,
    DatabaseConnectivity,
    StorageConfiguration,
    StorageInitialization,
    Bind,
    Lifecycle,
    DatabaseClose,
}

impl ServeError {
    pub(crate) const fn category(self) -> &'static str {
        match self {
            Self::Configuration => "configuration",
            Self::DatabaseConfiguration => "database-configuration",
            Self::DatabaseConnectivity => "database-connectivity",
            Self::StorageConfiguration => "storage-configuration",
            Self::StorageInitialization => "storage-initialization",
            Self::Bind => "bind",
            Self::Lifecycle => "lifecycle",
            Self::DatabaseClose => "database-close",
        }
    }
}

impl fmt::Display for ServeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.category())
    }
}

impl std::error::Error for ServeError {}

pub(crate) async fn run_server(
    environment: &impl Environment,
    files: &impl FileReader,
) -> Result<(), ServeError> {
    let global = Config::load(environment, files)
        .map_err(|_| ServeError::Configuration)?
        .config;
    let database = DatabaseRuntimeConfig::load(environment, files)
        .map_err(|_| ServeError::DatabaseConfiguration)?;
    let storage = ObjectStorageConfig::load(environment, files)
        .map_err(|_| ServeError::StorageConfiguration)?;

    let pool = DatabasePool::connect(database.pool_config())
        .await
        .map_err(|_| ServeError::DatabaseConnectivity)?;
    let close_timeout = database.close_timeout();
    let store = match S3ObjectStore::new(&storage, OperationLimits::default()).await {
        Ok(store) => store,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::StorageInitialization);
        }
    };
    let listener = match tokio::net::TcpListener::bind(global.server.listen_addr).await {
        Ok(listener) => listener,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::Bind);
        }
    };

    let health = HealthService::production(pool.clone(), store, HealthPolicy::default());
    let router = build_router_with_health(health);
    let mut supervisor = Supervisor::new(SupervisorConfig::new(
        global.server.shutdown_drain_timeout,
        HTTP_WORKERS,
    ));
    if supervisor
        .register("http", move |mut shutdown| async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.requested().await })
                .await
                .map_err(|_| WorkerError::new("http-server"))
        })
        .is_err()
    {
        close_pool(pool, close_timeout).await?;
        return Err(ServeError::Lifecycle);
    }

    let lifecycle = supervisor.run_until_os_signal().await;
    let close = close_pool(pool, close_timeout).await;
    match (lifecycle, close) {
        (_, Err(error)) => Err(error),
        (Err(_), Ok(())) => Err(ServeError::Lifecycle),
        (Ok(_), Ok(())) => Ok(()),
    }
}

async fn close_pool(pool: DatabasePool, timeout: std::time::Duration) -> Result<(), ServeError> {
    pool.close(timeout)
        .await
        .map_err(|_| ServeError::DatabaseClose)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_categories_are_stable_and_context_free() {
        let cases = [
            (ServeError::Configuration, "configuration"),
            (ServeError::DatabaseConfiguration, "database-configuration"),
            (ServeError::DatabaseConnectivity, "database-connectivity"),
            (ServeError::StorageConfiguration, "storage-configuration"),
            (ServeError::StorageInitialization, "storage-initialization"),
            (ServeError::Bind, "bind"),
            (ServeError::Lifecycle, "lifecycle"),
            (ServeError::DatabaseClose, "database-close"),
        ];
        for (error, expected) in cases {
            assert_eq!(error.category(), expected);
            assert_eq!(error.to_string(), expected);
        }
    }
}
