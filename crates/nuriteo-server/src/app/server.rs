use std::fmt;
use std::num::NonZeroUsize;

use crate::auth::{AuthPolicy, AuthService};
use crate::config::{Config, Environment, FileReader};
use crate::database::{DatabasePool, DatabaseRuntimeConfig};
use crate::health::{HealthPolicy, HealthService};
use crate::identity::SessionPolicy;
use crate::invitations::{InvitationHttpPolicy, InvitationHttpService};
use crate::object_storage::{ObjectStorageConfig, OperationLimits, S3ObjectStore};
use crate::organization::{OrganizationHttpPolicy, OrganizationHttpService};
use crate::setup::{SetupStatusPolicy, SetupStatusService};

use super::{Supervisor, SupervisorConfig, WorkerError, build_router_with_setup_service};

const HTTP_WORKERS: NonZeroUsize = NonZeroUsize::MIN;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServeError {
    Configuration,
    DatabaseConfiguration,
    DatabaseConnectivity,
    StorageConfiguration,
    StorageInitialization,
    AuthenticationConfiguration,
    InvitationConfiguration,
    OrganizationConfiguration,
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
            Self::AuthenticationConfiguration => "authentication-configuration",
            Self::InvitationConfiguration => "invitation-configuration",
            Self::OrganizationConfiguration => "organization-configuration",
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

    let auth = match AuthService::production(
        pool.clone(),
        &global.public.external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    ) {
        Ok(auth) => auth,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::AuthenticationConfiguration);
        }
    };
    let invitations = match InvitationHttpService::production(
        pool.clone(),
        &global.public.external_url,
        InvitationHttpPolicy::default(),
        SessionPolicy::default(),
    ) {
        Ok(invitations) => invitations,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::InvitationConfiguration);
        }
    };
    let health = HealthService::production(pool.clone(), store, HealthPolicy::default());
    let organizations = match OrganizationHttpService::production(
        pool.clone(),
        &global.public.external_url,
        OrganizationHttpPolicy::default(),
        SessionPolicy::default(),
    ) {
        Ok(organizations) => organizations,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::OrganizationConfiguration);
        }
    };
    let setup = SetupStatusService::production(pool.clone(), SetupStatusPolicy::default());
    let router = build_router_with_setup_service(health, auth, invitations, organizations, setup);
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
            (
                ServeError::AuthenticationConfiguration,
                "authentication-configuration",
            ),
            (
                ServeError::InvitationConfiguration,
                "invitation-configuration",
            ),
            (
                ServeError::OrganizationConfiguration,
                "organization-configuration",
            ),
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
