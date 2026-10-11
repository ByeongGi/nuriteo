use std::fmt;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;

use crate::access_token::AccessTokenManagementService;
use crate::admin::{AdminHttpPolicy, AdminHttpService};
use crate::auth::{AuthPolicy, AuthService};
use crate::config::{Config, Environment, FileReader, load_secret};
use crate::database::{
    DatabasePool, DatabaseRuntimeConfig, SchemaReadiness, check_schema_readiness,
};
use crate::git_operations::{GitHttpService, GitOperationService};
use crate::git_provider::{GitProviderService, GitProviderValidator};
use crate::health::{HealthPolicy, HealthService};
use crate::identity::SessionPolicy;
use crate::instance_settings::InstanceSettingsRepository;
use crate::integration::{IntegrationRepository, MasterKeyring};
use crate::integration_ca::IntegrationCaHttpService;
use crate::invitations::{InvitationHttpPolicy, InvitationHttpService};
use crate::mfa::MfaHttpService;
use crate::notification::{
    DatabaseDeliveryEligibility, DatabaseInvitationAttemptTokenIssuer, EmailOutboxRepository,
    NotificationHttpService, NotificationWorker, NotificationWorkerPolicy,
    ProductionEmailAttemptPreparer,
};
use crate::object_storage::{ObjectStorageConfig, OperationLimits, S3ObjectStore};
use crate::observability::{
    LogConfig, LogFormat, LogLevel, MetricsService, TelemetryConfig, install_with_telemetry,
};
use crate::oidc::OidcHttpService;
use crate::organization::{OrganizationHttpPolicy, OrganizationHttpService};
use crate::policy::PolicyMaintenanceWorker;
use crate::project::{ProjectHttpPolicy, ProjectHttpService};
use crate::published_example::{
    PublicPreviewAdmissionKey, PublishedExampleHttpService, PublishedExampleServicePolicy,
};
use crate::registry_gateway::RegistryHttpService;
use crate::save::{
    CleanupOperationsPolicy, CleanupOperationsService, CleanupService, ContentServicePolicy,
    SaveHttpConfig, SaveHttpPolicy, SaveHttpService, SaveUploadTransport, WorkerShutdown,
};
use crate::setup::{SetupStatusPolicy, SetupStatusService};
use crate::smtp::SmtpEmailSender;
use crate::team::{TeamHttpPolicy, TeamHttpService};

use super::{
    Supervisor, SupervisorConfig, WorkerError, apply_maintenance_gate, apply_metrics,
    build_router_with_integration_ca_service,
};
use crate::maintenance::{MaintenanceGate, public_router as maintenance_public_router};

const PRODUCTION_WORKERS: NonZeroUsize = NonZeroUsize::new(5).unwrap();
const INSTANCE_SETTINGS_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const PREVIEW_SIGNING_KEY: &str = "NURITEO_PREVIEW_SIGNING_KEY";
const PREVIEW_SIGNING_KEY_FILE: &str = "NURITEO_PREVIEW_SIGNING_KEY_FILE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServeError {
    Configuration,
    DatabaseConfiguration,
    DatabaseConnectivity,
    InstanceSettings,
    StorageConfiguration,
    StorageInitialization,
    AuthenticationConfiguration,
    AdminConfiguration,
    InvitationConfiguration,
    OrganizationConfiguration,
    ProjectConfiguration,
    TeamConfiguration,
    MfaConfiguration,
    OidcConfiguration,
    RegistryConfiguration,
    GitConfiguration,
    PublishedExampleConfiguration,
    NotificationConfiguration,
    AccessTokenConfiguration,
    SaveConfiguration,
    CleanupConfiguration,
    ObservabilityConfiguration,
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
            Self::InstanceSettings => "instance-settings",
            Self::StorageConfiguration => "storage-configuration",
            Self::StorageInitialization => "storage-initialization",
            Self::AuthenticationConfiguration => "authentication-configuration",
            Self::AdminConfiguration => "admin-configuration",
            Self::InvitationConfiguration => "invitation-configuration",
            Self::OrganizationConfiguration => "organization-configuration",
            Self::ProjectConfiguration => "project-configuration",
            Self::TeamConfiguration => "team-configuration",
            Self::MfaConfiguration => "mfa-configuration",
            Self::OidcConfiguration => "oidc-configuration",
            Self::RegistryConfiguration => "registry-configuration",
            Self::GitConfiguration => "git-configuration",
            Self::PublishedExampleConfiguration => "published-example-configuration",
            Self::NotificationConfiguration => "notification-configuration",
            Self::AccessTokenConfiguration => "access-token-configuration",
            Self::SaveConfiguration => "save-configuration",
            Self::CleanupConfiguration => "cleanup-configuration",
            Self::ObservabilityConfiguration => "observability-configuration",
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
    let load_report = Config::load(environment, files).map_err(|_| ServeError::Configuration)?;
    let global = load_report.config;
    let telemetry_config = TelemetryConfig::load(environment, files)
        .map_err(|_| ServeError::ObservabilityConfiguration)?;
    let _telemetry = install_with_telemetry(
        LogConfig {
            format: match global.server.log_format {
                crate::config::LogFormat::Text => LogFormat::Text,
                crate::config::LogFormat::Json => LogFormat::Json,
            },
            level: match global.server.log_level {
                crate::config::LogLevel::Error => LogLevel::Error,
                crate::config::LogLevel::Warn => LogLevel::Warn,
                crate::config::LogLevel::Info => LogLevel::Info,
                crate::config::LogLevel::Debug => LogLevel::Debug,
            },
        },
        &telemetry_config,
    )
    .map_err(|_| ServeError::ObservabilityConfiguration)?;
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
    let schema_readiness = tokio::time::timeout(
        INSTANCE_SETTINGS_STARTUP_TIMEOUT,
        check_schema_readiness(&pool),
    )
    .await;
    let effective_instance_settings =
        if matches!(schema_readiness, Ok(Ok(SchemaReadiness::Ready { .. }))) {
            let instance_settings = match InstanceSettingsRepository::new(
                pool.clone(),
                INSTANCE_SETTINGS_STARTUP_TIMEOUT,
            ) {
                Ok(repository) => repository,
                Err(_) => {
                    close_pool(pool, close_timeout).await?;
                    return Err(ServeError::InstanceSettings);
                }
            };
            let effective = match instance_settings
                .materialize(&load_report.instance_settings)
                .await
            {
                Ok(effective) => effective,
                Err(_) => {
                    close_pool(pool, close_timeout).await?;
                    return Err(ServeError::InstanceSettings);
                }
            };
            Some(effective)
        } else {
            None
        };
    let store = match S3ObjectStore::new(&storage, OperationLimits::default()).await {
        Ok(store) => store,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::StorageInitialization);
        }
    };
    if save_config.upload_transport() == SaveUploadTransport::Direct
        && store
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
    let health = HealthService::production(pool.clone(), store.clone(), HealthPolicy::default());
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
    let maintenance_gate = MaintenanceGate::default();
    let admin = match effective_instance_settings.clone() {
        Some(settings) => match AdminHttpService::production(
            pool.clone(),
            &global.public.external_url,
            AdminHttpPolicy::default(),
            SessionPolicy::default(),
            settings,
            health.clone(),
            operations.clone(),
        ) {
            Ok(admin) => admin.with_maintenance_gate(maintenance_gate.clone()),
            Err(_) => {
                close_pool(pool, close_timeout).await?;
                return Err(ServeError::AdminConfiguration);
            }
        },
        None => AdminHttpService::unconfigured(),
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
        save_config.upload_transport(),
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
    let teams = match TeamHttpService::production(
        pool.clone(),
        &global.public.external_url,
        TeamHttpPolicy::default(),
        SessionPolicy::default(),
    ) {
        Ok(teams) => teams,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::TeamConfiguration);
        }
    };
    let keyring = match MasterKeyring::load(environment, files) {
        Ok(keyring) => keyring,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::MfaConfiguration);
        }
    };
    let (notification_worker, smtp_runtime_config) =
        if let Some(settings) = effective_instance_settings.as_ref() {
            let integrations = IntegrationRepository::new(pool.clone(), keyring.clone());
            let smtp = match integrations
                .smtp_config("default", settings, environment, files)
                .await
            {
                Ok(smtp) => smtp,
                Err(_) => {
                    close_pool(pool, close_timeout).await?;
                    return Err(ServeError::NotificationConfiguration);
                }
            };
            match smtp {
                Some(config) => {
                    let config = crate::smtp::SmtpConfigHandle::new(Arc::new(config));
                    let repository =
                        EmailOutboxRepository::new(pool.clone(), INSTANCE_SETTINGS_STARTUP_TIMEOUT)
                            .map_err(|_| ServeError::NotificationConfiguration)?;
                    let worker = NotificationWorker::new(
                        repository,
                        Arc::new(DatabaseDeliveryEligibility::new(pool.clone())),
                        Arc::new(ProductionEmailAttemptPreparer::new(
                            global.public.external_url.clone(),
                        )),
                        Some(Arc::new(DatabaseInvitationAttemptTokenIssuer::new(
                            pool.clone(),
                        ))),
                        Arc::new(SmtpEmailSender::new(config.clone())),
                        NotificationWorkerPolicy::default(),
                    )
                    .map_err(|_| ServeError::NotificationConfiguration)?;
                    (Some(worker), Some(config))
                }
                None => (None, None),
            }
        } else {
            (None, None)
        };
    let mfa = match MfaHttpService::production(
        pool.clone(),
        &global.public.external_url,
        keyring.clone(),
        SessionPolicy::default(),
    ) {
        Ok(mfa) => mfa,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::MfaConfiguration);
        }
    };
    let notifications = match NotificationHttpService::production(
        pool.clone(),
        &global.public.external_url,
        SessionPolicy::default(),
    ) {
        Ok(notifications) => notifications,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::NotificationConfiguration);
        }
    };
    let oidc = match OidcHttpService::production(
        pool.clone(),
        &global.public.external_url,
        keyring.clone(),
        SessionPolicy::default(),
    ) {
        Ok(oidc) => oidc,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::OidcConfiguration);
        }
    };
    let registry = match RegistryHttpService::production(
        pool.clone(),
        &global.public.external_url,
        keyring.clone(),
        SessionPolicy::default(),
    ) {
        Ok(registry) => registry,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::RegistryConfiguration);
        }
    };
    let access_tokens = match AccessTokenManagementService::production(
        pool.clone(),
        &global.public.external_url,
        SessionPolicy::default(),
    ) {
        Ok(access_tokens) => access_tokens,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::AccessTokenConfiguration);
        }
    };
    let preview_admission_key = load_secret(
        environment,
        files,
        PREVIEW_SIGNING_KEY,
        PREVIEW_SIGNING_KEY_FILE,
    )
    .map_err(|_| ServeError::PublishedExampleConfiguration)?
    .map(|value| PublicPreviewAdmissionKey::from_base64url(value.expose_secret()))
    .transpose()
    .map_err(|_| ServeError::PublishedExampleConfiguration)?;
    let published_examples = match PublishedExampleHttpService::production(
        pool.clone(),
        &global.public.external_url,
        store.clone(),
        PublishedExampleServicePolicy::default(),
        SessionPolicy::default(),
        preview_admission_key,
    ) {
        Ok(service) => service,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::PublishedExampleConfiguration);
        }
    };
    let git = match GitHttpService::production(
        pool.clone(),
        &global.public.external_url,
        SessionPolicy::default(),
        GitOperationService::production(
            pool.clone(),
            keyring.clone(),
            store.clone(),
            save_config.effective_quota(),
        ),
        GitProviderService::new(IntegrationRepository::new(pool.clone(), keyring.clone())),
        GitProviderValidator::new(Duration::from_secs(10))
            .map_err(|_| ServeError::GitConfiguration)?,
    ) {
        Ok(service) => service,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::GitConfiguration);
        }
    };
    let integration_ca = match IntegrationCaHttpService::production(
        pool.clone(),
        &global.public.external_url,
        keyring,
        SessionPolicy::default(),
        smtp_runtime_config,
    ) {
        Ok(service) => service,
        Err(_) => {
            close_pool(pool, close_timeout).await?;
            return Err(ServeError::Configuration);
        }
    };
    let maintenance = PolicyMaintenanceWorker::new(
        pool.clone(),
        store.clone(),
        INSTANCE_SETTINGS_STARTUP_TIMEOUT,
    )
    .map_err(|_| ServeError::CleanupConfiguration)?;
    let cleanup = CleanupService::new(pool.clone(), store, global.cleanup.worker_policy);
    let router = build_router_with_integration_ca_service(
        health,
        auth,
        invitations,
        organizations,
        projects,
        save,
        setup,
        admin,
        teams,
        mfa,
        notifications,
        access_tokens,
        oidc,
        registry,
        published_examples,
        git,
        integration_ca,
    );
    let router = router.merge(maintenance_public_router(maintenance_gate.clone()));
    let router = apply_maintenance_gate(router, maintenance_gate);
    let metrics = MetricsService::new();
    let router = apply_metrics(router, metrics.clone());
    let management_router = operations.with_metrics(metrics).router();
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
    if supervisor
        .register("policy-maintenance", move |mut shutdown| async move {
            maintenance
                .run_until(async move { shutdown.requested().await })
                .await
                .map_err(|_| WorkerError::new("policy-maintenance-failed"))
        })
        .is_err()
    {
        close_pool(pool, close_timeout).await?;
        return Err(ServeError::Lifecycle);
    }
    if let Some(worker) = notification_worker
        && worker.register(&mut supervisor).is_err()
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
            (ServeError::InstanceSettings, "instance-settings"),
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
            (ServeError::TeamConfiguration, "team-configuration"),
            (ServeError::MfaConfiguration, "mfa-configuration"),
            (ServeError::CleanupConfiguration, "cleanup-configuration"),
            (
                ServeError::ObservabilityConfiguration,
                "observability-configuration",
            ),
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
