use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::database::DatabasePool;
use crate::git_provider::{
    GitProviderService, GitProviderValidator, endpoint_binding as git_binding,
};
use crate::identity::{
    BrowserCookieBoundary, BrowserRequestHeaders, SessionPolicy, SessionService,
};
use crate::integration::{
    CaBundleMetadata, CaCandidatePreflight, CaEndpointBinding, CaPreflightProof,
    IntegrationAdminActor, IntegrationAdminService, IntegrationError, IntegrationRepository,
    MasterKeyring, ValidatedCaBundle,
};
use crate::oidc::{OidcEndpointValidator, OidcProviderService};
use crate::registry_gateway::{RegistryGatewayService, endpoint_binding as registry_binding};
use crate::smtp::{SmtpConfigHandle, SmtpSecurity, preflight as smtp_preflight};

const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCaView {
    pub id: String,
    pub integration_type: String,
    pub integration_id: String,
    pub version: u64,
    pub state: String,
    pub fingerprints: Vec<String>,
    pub earliest_expiry: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCaCollectionView {
    pub items: Vec<IntegrationCaView>,
    pub version: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntegrationCaHttpError {
    AuthenticationFailed,
    Forbidden,
    InvalidInput,
    NotFound,
    ReauthenticationRequired,
    PreflightFailed,
    Conflict,
    Unavailable,
}

impl fmt::Display for IntegrationCaHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "authentication failed",
            Self::Forbidden => "administrator access is required",
            Self::InvalidInput => "integration CA input is invalid",
            Self::NotFound => "integration was not found",
            Self::ReauthenticationRequired => "recent administrator authentication is required",
            Self::PreflightFailed => "integration CA preflight failed",
            Self::Conflict => "integration CA state changed concurrently",
            Self::Unavailable => "integration CA service is unavailable",
        })
    }
}

impl std::error::Error for IntegrationCaHttpError {}

#[derive(Clone)]
pub struct IntegrationCaHttpService {
    runtime: Option<Arc<Runtime>>,
}

struct Runtime {
    pool: DatabasePool,
    cookies: BrowserCookieBoundary,
    sessions: SessionService,
    admin: IntegrationAdminService,
    oidc: OidcProviderService,
    oidc_validator: OidcEndpointValidator,
    git: GitProviderService,
    git_validator: GitProviderValidator,
    registry: RegistryGatewayService,
    smtp: Option<SmtpConfigHandle>,
}

impl fmt::Debug for IntegrationCaHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IntegrationCaHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl IntegrationCaHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        keyring: MasterKeyring,
        session_policy: SessionPolicy,
        smtp: Option<SmtpConfigHandle>,
    ) -> Result<Self, IntegrationCaHttpError> {
        let cookies = BrowserCookieBoundary::new(external_url)
            .map_err(|_| IntegrationCaHttpError::InvalidInput)?;
        let repository = IntegrationRepository::new(pool.clone(), keyring);
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                pool: pool.clone(),
                cookies,
                sessions: SessionService::new(pool, session_policy),
                admin: IntegrationAdminService::new(repository.clone()),
                oidc: OidcProviderService::new(repository.clone()),
                oidc_validator: OidcEndpointValidator::new(PREFLIGHT_TIMEOUT)
                    .map_err(|_| IntegrationCaHttpError::Unavailable)?,
                git: GitProviderService::new(repository.clone()),
                git_validator: GitProviderValidator::new(PREFLIGHT_TIMEOUT)
                    .map_err(|_| IntegrationCaHttpError::Unavailable)?,
                registry: RegistryGatewayService::new(repository),
                smtp,
            })),
        })
    }

    pub(crate) async fn list(
        &self,
        request: BrowserRequestHeaders<'_>,
        integration_type: &str,
        integration_id: &str,
    ) -> Result<IntegrationCaCollectionView, IntegrationCaHttpError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        let endpoint = runtime.binding(integration_type, integration_id).await?;
        let items = runtime
            .admin
            .list_ca_metadata(
                actor,
                endpoint.integration_type(),
                endpoint.integration_id(),
            )
            .await
            .map_err(map_integration_error)?;
        collection(items)
    }

    pub(crate) async fn stage(
        &self,
        request: BrowserRequestHeaders<'_>,
        integration_type: &str,
        integration_id: &str,
        expected_version: u64,
        pem: Vec<u8>,
        correlation_id: &str,
    ) -> Result<IntegrationCaView, IntegrationCaHttpError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        let endpoint = runtime.binding(integration_type, integration_id).await?;
        let bundle = ValidatedCaBundle::parse(pem).map_err(map_integration_error)?;
        view(
            runtime
                .admin
                .stage_ca_candidate_versioned(
                    actor,
                    &endpoint,
                    bundle,
                    expected_version,
                    correlation_id,
                )
                .await
                .map_err(map_integration_error)?,
        )
    }

    pub(crate) async fn activate(
        &self,
        request: BrowserRequestHeaders<'_>,
        integration_type: &str,
        integration_id: &str,
        candidate_id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<IntegrationCaView, IntegrationCaHttpError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        let endpoint = runtime.binding(integration_type, integration_id).await?;
        let current = runtime
            .admin
            .list_ca_metadata(
                actor,
                endpoint.integration_type(),
                endpoint.integration_id(),
            )
            .await
            .map_err(map_integration_error)?;
        let candidate = current
            .iter()
            .find(|value| {
                value.id == candidate_id && matches!(value.state.as_str(), "candidate" | "active")
            })
            .ok_or(IntegrationCaHttpError::Conflict)?;
        if candidate.version != expected_version {
            return Err(IntegrationCaHttpError::Conflict);
        }
        let preflight = runtime.preflight(integration_type, integration_id)?;
        view(
            runtime
                .admin
                .activate_ca_candidate(actor, candidate_id, &endpoint, correlation_id, &preflight)
                .await
                .map_err(map_integration_error)?,
        )
    }

    fn runtime(&self) -> Result<&Runtime, IntegrationCaHttpError> {
        self.runtime
            .as_deref()
            .ok_or(IntegrationCaHttpError::Unavailable)
    }
}

impl Runtime {
    async fn actor(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<IntegrationAdminActor, IntegrationCaHttpError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(|_| IntegrationCaHttpError::AuthenticationFailed)?
            .into_session_token();
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(|_| IntegrationCaHttpError::AuthenticationFailed)?;
        let allowed: Option<bool> = sqlx::query_scalar(
            "SELECT status='active' AND is_instance_admin FROM users WHERE id=$1::uuid",
        )
        .bind(session.user_id().to_string())
        .fetch_optional(
            &mut *self
                .pool
                .acquire()
                .await
                .map_err(|_| IntegrationCaHttpError::Unavailable)?,
        )
        .await
        .map_err(|_| IntegrationCaHttpError::Unavailable)?;
        if allowed != Some(true) {
            return Err(IntegrationCaHttpError::Forbidden);
        }
        Ok(IntegrationAdminActor {
            user_id: session.user_id(),
            session_id: session.id(),
        })
    }

    async fn binding(
        &self,
        integration_type: &str,
        integration_id: &str,
    ) -> Result<CaEndpointBinding, IntegrationCaHttpError> {
        match integration_type {
            "oidc" => {
                let id = parse_uuid(integration_id)?;
                let provider = self
                    .oidc
                    .list_providers()
                    .await
                    .map_err(|_| IntegrationCaHttpError::Unavailable)?
                    .into_iter()
                    .find(|value| value.id == id)
                    .ok_or(IntegrationCaHttpError::NotFound)?;
                let issuer = Url::parse(&provider.issuer)
                    .map_err(|_| IntegrationCaHttpError::Unavailable)?;
                CaEndpointBinding::new(
                    "oidc",
                    integration_id,
                    issuer
                        .host_str()
                        .ok_or(IntegrationCaHttpError::Unavailable)?,
                    issuer
                        .port_or_known_default()
                        .ok_or(IntegrationCaHttpError::Unavailable)?,
                    "https",
                )
                .map_err(map_integration_error)
            }
            "git_provider" => {
                let id = parse_uuid(integration_id)?;
                let provider = self
                    .git
                    .list()
                    .await
                    .map_err(|_| IntegrationCaHttpError::Unavailable)?
                    .into_iter()
                    .find(|value| value.id == id)
                    .ok_or(IntegrationCaHttpError::NotFound)?;
                git_binding(&provider).map_err(|_| IntegrationCaHttpError::Unavailable)
            }
            "registry" => {
                let id = parse_uuid(integration_id)?;
                let registry = self
                    .registry
                    .list()
                    .await
                    .map_err(|_| IntegrationCaHttpError::Unavailable)?
                    .into_iter()
                    .find(|value| value.id == id)
                    .ok_or(IntegrationCaHttpError::NotFound)?;
                registry_binding(&registry).map_err(|_| IntegrationCaHttpError::Unavailable)
            }
            "smtp" if integration_id == "default" => {
                let smtp = self
                    .smtp
                    .as_ref()
                    .ok_or(IntegrationCaHttpError::NotFound)?
                    .current();
                let transport = match smtp.security() {
                    SmtpSecurity::ImplicitTls => "implicit-tls",
                    SmtpSecurity::StartTls => "starttls",
                };
                CaEndpointBinding::new("smtp", "default", smtp.host(), smtp.port(), transport)
                    .map_err(map_integration_error)
            }
            _ => Err(IntegrationCaHttpError::InvalidInput),
        }
    }

    fn preflight(
        &self,
        integration_type: &str,
        integration_id: &str,
    ) -> Result<IntegrationPreflight, IntegrationCaHttpError> {
        Ok(match integration_type {
            "oidc" => IntegrationPreflight::Oidc {
                id: parse_uuid(integration_id)?,
                service: self.oidc.clone(),
                validator: self.oidc_validator.clone(),
            },
            "git_provider" => IntegrationPreflight::Git {
                id: parse_uuid(integration_id)?,
                service: self.git.clone(),
                validator: self.git_validator.clone(),
            },
            "registry" => IntegrationPreflight::Registry {
                id: parse_uuid(integration_id)?,
                service: self.registry.clone(),
            },
            "smtp" if integration_id == "default" => IntegrationPreflight::Smtp(
                self.smtp.clone().ok_or(IntegrationCaHttpError::NotFound)?,
            ),
            _ => return Err(IntegrationCaHttpError::InvalidInput),
        })
    }
}

enum IntegrationPreflight {
    Oidc {
        id: Uuid,
        service: OidcProviderService,
        validator: OidcEndpointValidator,
    },
    Git {
        id: Uuid,
        service: GitProviderService,
        validator: GitProviderValidator,
    },
    Registry {
        id: Uuid,
        service: RegistryGatewayService,
    },
    Smtp(SmtpConfigHandle),
}

impl CaCandidatePreflight for IntegrationPreflight {
    fn preflight<'a>(
        &'a self,
        candidate: &'a ValidatedCaBundle,
        endpoint: &'a CaEndpointBinding,
    ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>> {
        Box::pin(async move {
            match self {
                Self::Oidc {
                    id,
                    service,
                    validator,
                } => validator
                    .preflight_ca_candidate(service, *id, candidate, endpoint)
                    .await
                    .map_err(|_| IntegrationError::PreflightFailed)?,
                Self::Git {
                    id,
                    service,
                    validator,
                } => validator
                    .preflight_ca_candidate(service, *id, candidate, endpoint)
                    .await
                    .map_err(|_| IntegrationError::PreflightFailed)?,
                Self::Registry { id, service } => service
                    .preflight_ca_candidate(*id, candidate, endpoint)
                    .await
                    .map_err(|_| IntegrationError::PreflightFailed)?,
                Self::Smtp(config) => {
                    let candidate_config = config
                        .current()
                        .with_integration_ca(candidate)
                        .map_err(|_| IntegrationError::PreflightFailed)?;
                    smtp_preflight(&candidate_config)
                        .await
                        .map(|_| ())
                        .map_err(|_| IntegrationError::PreflightFailed)?;
                }
            }
            Ok(CaPreflightProof {
                endpoint_fingerprint: endpoint.fingerprint(),
            })
        })
    }

    fn activated(&self, candidate: &ValidatedCaBundle) -> Result<(), IntegrationError> {
        if let Self::Smtp(config) = self {
            let activated = config
                .current()
                .with_integration_ca(candidate)
                .map_err(|_| IntegrationError::Unavailable)?;
            config.replace(Arc::new(activated));
        }
        Ok(())
    }
}

fn parse_uuid(value: &str) -> Result<Uuid, IntegrationCaHttpError> {
    Uuid::parse_str(value)
        .ok()
        .filter(|value| value.get_version_num() == 7)
        .ok_or(IntegrationCaHttpError::InvalidInput)
}

fn collection(
    values: Vec<CaBundleMetadata>,
) -> Result<IntegrationCaCollectionView, IntegrationCaHttpError> {
    let version = values.first().map_or(0, |value| value.version);
    Ok(IntegrationCaCollectionView {
        items: values.into_iter().map(view).collect::<Result<_, _>>()?,
        version,
    })
}

fn view(value: CaBundleMetadata) -> Result<IntegrationCaView, IntegrationCaHttpError> {
    Ok(IntegrationCaView {
        id: value.id.to_string(),
        integration_type: match value.integration_type.as_str() {
            "git" => "git_provider".into(),
            _ => value.integration_type,
        },
        integration_id: value.integration_id,
        version: value.version,
        state: value.state,
        fingerprints: value.fingerprints,
        earliest_expiry: crate::identity::Timestamp::from_datetime(value.earliest_expiry)
            .map_err(|_| IntegrationCaHttpError::Unavailable)?
            .to_string(),
    })
}

const fn map_integration_error(error: IntegrationError) -> IntegrationCaHttpError {
    match error {
        IntegrationError::InvalidInput | IntegrationError::InvalidCaBundle => {
            IntegrationCaHttpError::InvalidInput
        }
        IntegrationError::ReauthenticationRequired => {
            IntegrationCaHttpError::ReauthenticationRequired
        }
        IntegrationError::PreflightFailed => IntegrationCaHttpError::PreflightFailed,
        IntegrationError::Conflict => IntegrationCaHttpError::Conflict,
        IntegrationError::KeyConfiguration
        | IntegrationError::CredentialUnavailable
        | IntegrationError::Unavailable => IntegrationCaHttpError::Unavailable,
    }
}
