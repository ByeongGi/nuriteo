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
use crate::project::{ProjectHttpPolicy, ProjectHttpService};
use crate::save::{
    CleanupOperationsPolicy, CleanupOperationsService, CleanupService, ContentServicePolicy,
    SaveHttpConfig, SaveHttpPolicy, SaveHttpService, WorkerShutdown,
};
use crate::setup::{SetupStatusPolicy, SetupStatusService};

use super::{Supervisor, SupervisorConfig, WorkerError, build_router_with_save_service};

const PRODUCTION_WORKERS: NonZeroUsize = NonZeroUsize::new(3).unwrap();

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
    ProjectConfiguration,
    SaveConfiguration,
    CleanupConfiguration,
    Bind,
    ManagementBind,
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
            Self::ProjectConfiguration => "project-configuration",
            Self::SaveConfiguration => "save-configuration",
            Self::CleanupConfiguration => "cleanup-configuration",
            Self::Bind => "bind",
            Self::ManagementBind => "management-bind",
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
    let save_config =
        SaveHttpConfig::load(environment, files).map_err(|_| ServeError::SaveConfiguration)?;

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
    if store
        .check_browser_upload_cors(&global.public.external_url)
        .await
        .is_err()
    {
        close_pool(pool, close_timeout).await?;
        return Err(ServeError::StorageInitialization);
    }
    let listener = match tokio::net::TcpListener::bind(global.server.listen_addr).await {
        Ok(listener) => listener,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::Bind);
        }
    };
    let management_listener =
        match tokio::net::TcpListener::bind(global.server.management_listen_addr).await {
            Ok(listener) => listener,
            Err(_) => {
                close_pool(pool, close_timeout).await?;
                return Err(ServeError::ManagementBind);
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
    let health = HealthService::production(pool.clone(), store.clone(), HealthPolicy::default());
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
    let projects = match ProjectHttpService::production_with_content(
        pool.clone(),
        &global.public.external_url,
        ProjectHttpPolicy::default(),
        SessionPolicy::default(),
        store.clone(),
        ContentServicePolicy::default(),
    ) {
        Ok(projects) => projects,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::ProjectConfiguration);
        }
    };
    let save = match SaveHttpService::production(
        pool.clone(),
        projects.clone(),
        store.clone(),
        save_config.idempotency_secret(),
        save_config.effective_quota(),
        SaveHttpPolicy::default(),
        global.cleanup.worker_policy,
    )
    .await
    {
        Ok(save) => save,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::SaveConfiguration);
        }
    };
    let operations_policy = match CleanupOperationsPolicy::new(
        global.cleanup.stale_threshold,
        global.cleanup.failed_threshold,
        global.cleanup.status_timeout,
    ) {
        Ok(policy) => policy,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::CleanupConfiguration);
        }
    };
    let operations = CleanupOperationsService::new(pool.clone(), operations_policy);
    let cleanup = CleanupService::new(pool.clone(), store, global.cleanup.worker_policy);
    let router = build_router_with_save_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
    );
    let management_router = operations.router();
    let cleanup_drain_timeout = global
        .server
        .shutdown_drain_timeout
        .saturating_sub(std::time::Duration::from_millis(100));
    let mut supervisor = Supervisor::new(SupervisorConfig::new(
        global.server.shutdown_drain_timeout,
        PRODUCTION_WORKERS,
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
    if supervisor
        .register("management-http", move |mut shutdown| async move {
            axum::serve(management_listener, management_router)
                .with_graceful_shutdown(async move { shutdown.requested().await })
                .await
                .map_err(|_| WorkerError::new("management-http-server"))
        })
        .is_err()
    {
        close_pool(pool, close_timeout).await?;
        return Err(ServeError::Lifecycle);
    }
    if supervisor
        .register("save-cleanup", move |mut shutdown| async move {
            let worker = cleanup.start_worker();
            match worker
                .run_until(
                    async move { shutdown.requested().await },
                    cleanup_drain_timeout,
                )
                .await
            {
                WorkerShutdown::Drained => Ok(()),
                WorkerShutdown::DeadlineExceeded => Err(WorkerError::new("cleanup-drain-timeout")),
                WorkerShutdown::WorkerFailed => Err(WorkerError::new("cleanup-worker-failed")),
            }
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
            (ServeError::ProjectConfiguration, "project-configuration"),
            (ServeError::CleanupConfiguration, "cleanup-configuration"),
            (ServeError::SaveConfiguration, "save-configuration"),
            (ServeError::Bind, "bind"),
            (ServeError::ManagementBind, "management-bind"),
            (ServeError::Lifecycle, "lifecycle"),
            (ServeError::DatabaseClose, "database-close"),
        ];
        for (error, expected) in cases {
            assert_eq!(error.category(), expected);
            assert_eq!(error.to_string(), expected);
        }
    }
}
