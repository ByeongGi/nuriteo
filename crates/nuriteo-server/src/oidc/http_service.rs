use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sqlx::Row;
use time::OffsetDateTime;
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserRequestHeaders, CookieLifetime, IssuedBrowserCookies, Session,
    SessionPolicy, SessionService, SessionToken, Timestamp,
};
use crate::integration::{
    IntegrationAdminActor, IntegrationRepository, MasterKeyring, SecretValue,
};

use super::{
    OidcCallbackInput, OidcEndpointValidator, OidcLoginService, OidcProviderError,
    OidcProviderInput, OidcProviderMetadata, OidcProviderService, OidcProviderState,
    OidcProviderUpdate,
};

const BINDING_BYTES: usize = 32;
const MAX_COOKIE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OidcProviderView {
    pub id: String,
    pub display_name: String,
    pub issuer: String,
    pub client_id: String,
    pub state: String,
    pub config_version: u64,
    pub secret_version: u64,
    pub linked_identity_count: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OidcProviderCollectionView {
    pub items: Vec<OidcProviderView>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OidcLoginProviderView {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OidcLoginProviderCollectionView {
    pub items: Vec<OidcLoginProviderView>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OidcIdentityView {
    pub provider_id: String,
    pub provider_display_name: String,
    pub linked_at: String,
    pub last_authenticated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OidcIdentityCollectionView {
    pub items: Vec<OidcIdentityView>,
}

pub(crate) struct OidcBeginResponse {
    pub(crate) location: String,
    pub(crate) binding_cookie: String,
}

pub(crate) struct OidcSessionResponse {
    pub(crate) cookies: IssuedBrowserCookies,
    pub(crate) clear_binding_cookie: Option<String>,
}

#[derive(Clone)]
pub struct OidcHttpService {
    runtime: Option<Arc<OidcHttpRuntime>>,
}

struct OidcHttpRuntime {
    pool: DatabasePool,
    cookies: BrowserCookieBoundary,
    sessions: SessionService,
    providers: OidcProviderService,
    validator: OidcEndpointValidator,
    login: OidcLoginService,
    binding_cookie_name: &'static str,
    secure_cookie: bool,
}

impl fmt::Debug for OidcHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl OidcHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        keyring: MasterKeyring,
        session_policy: SessionPolicy,
    ) -> Result<Self, OidcProviderError> {
        let cookies = BrowserCookieBoundary::new(external_url)
            .map_err(|_| OidcProviderError::InvalidInput)?;
        let integrations = IntegrationRepository::new(pool.clone(), keyring);
        let providers = OidcProviderService::new(integrations);
        let validator = OidcEndpointValidator::new(Duration::from_secs(15))?;
        let sessions = SessionService::new(pool.clone(), session_policy);
        let login = OidcLoginService::new(providers.clone(), validator.clone(), sessions.clone());
        let secure_cookie = external_url.scheme() == "https";
        Ok(Self {
            runtime: Some(Arc::new(OidcHttpRuntime {
                pool,
                cookies,
                sessions,
                providers,
                validator,
                login,
                binding_cookie_name: if secure_cookie {
                    "__Host-nuriteo_oidc_binding"
                } else {
                    "nuriteo_dev_oidc_binding"
                },
                secure_cookie,
            })),
        })
    }

    pub(crate) async fn login_providers(
        &self,
    ) -> Result<OidcLoginProviderCollectionView, OidcProviderError> {
        let items = self
            .runtime()?
            .providers
            .list_providers()
            .await?
            .into_iter()
            .filter(|provider| provider.state == OidcProviderState::Active)
            .map(|provider| OidcLoginProviderView {
                id: provider.id.to_string(),
                display_name: provider.display_name,
            })
            .collect();
        Ok(OidcLoginProviderCollectionView { items })
    }

    pub(crate) async fn admin_providers(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<OidcProviderCollectionView, OidcProviderError> {
        let runtime = self.runtime()?;
        let (_, session) = runtime.authenticate(request).await?;
        runtime.require_admin(&session).await?;
        let items = runtime
            .providers
            .list_providers()
            .await?
            .into_iter()
            .map(provider_view)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(OidcProviderCollectionView { items })
    }

    pub(crate) async fn identities(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<OidcIdentityCollectionView, OidcProviderError> {
        let runtime = self.runtime()?;
        let (_, session) = runtime.authenticate(request).await?;
        let rows = sqlx::query(
            "SELECT identity.provider_id::text,provider.display_name,identity.linked_at,
                    identity.last_authenticated_at
             FROM oidc_identities identity
             JOIN oidc_providers provider ON provider.id=identity.provider_id
             WHERE identity.user_id=$1::uuid
             ORDER BY lower(provider.display_name),identity.provider_id LIMIT 100",
        )
        .bind(session.user_id().to_string())
        .fetch_all(
            &mut *runtime
                .pool
                .acquire()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?,
        )
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        let items = rows
            .into_iter()
            .map(|row| {
                Ok(OidcIdentityView {
                    provider_id: row
                        .try_get("provider_id")
                        .map_err(|_| OidcProviderError::Unavailable)?,
                    provider_display_name: row
                        .try_get("display_name")
                        .map_err(|_| OidcProviderError::Unavailable)?,
                    linked_at: timestamp(
                        row.try_get("linked_at")
                            .map_err(|_| OidcProviderError::Unavailable)?,
                    )?,
                    last_authenticated_at: row
                        .try_get::<Option<OffsetDateTime>, _>("last_authenticated_at")
                        .map_err(|_| OidcProviderError::Unavailable)?
                        .map(timestamp)
                        .transpose()?,
                })
            })
            .collect::<Result<Vec<_>, OidcProviderError>>()?;
        Ok(OidcIdentityCollectionView { items })
    }

    pub(crate) async fn begin(
        &self,
        provider_id: Uuid,
    ) -> Result<OidcBeginResponse, OidcProviderError> {
        let runtime = self.runtime()?;
        let authorization = runtime.login.begin(provider_id).await?;
        let binding_cookie = runtime.binding_cookie(&authorization.browser_binding, 600)?;
        Ok(OidcBeginResponse {
            location: authorization.url,
            binding_cookie,
        })
    }

    pub(crate) async fn callback(
        &self,
        provider_id: Uuid,
        issuer: &str,
        state: &str,
        code: &str,
        cookie_headers: &[&str],
        correlation_id: &str,
    ) -> Result<OidcSessionResponse, OidcProviderError> {
        let runtime = self.runtime()?;
        let binding = runtime.binding_from_headers(cookie_headers)?;
        let existing = runtime
            .cookies
            .validate_optional_safe_session(cookie_headers)
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        let issued = runtime
            .login
            .callback(OidcCallbackInput {
                provider_id,
                issuer,
                state,
                code,
                browser_binding: &binding,
                existing_session: existing.as_ref(),
                correlation_id,
            })
            .await?;
        Ok(OidcSessionResponse {
            cookies: runtime.session_cookies(&issued)?,
            clear_binding_cookie: Some(runtime.binding_cookie("deleted", 0)?),
        })
    }

    pub(crate) async fn unlink(
        &self,
        request: BrowserRequestHeaders<'_>,
        provider_id: Uuid,
        correlation_id: &str,
    ) -> Result<OidcSessionResponse, OidcProviderError> {
        let runtime = self.runtime()?;
        let token = runtime
            .cookies
            .validate(request)
            .map_err(|_| OidcProviderError::ValidationFailed)?
            .into_session_token();
        let issued = runtime
            .login
            .unlink_self(&token, provider_id, correlation_id)
            .await?;
        Ok(OidcSessionResponse {
            cookies: runtime.session_cookies(&issued)?,
            clear_binding_cookie: None,
        })
    }

    pub(crate) async fn create(
        &self,
        request: BrowserRequestHeaders<'_>,
        display_name: String,
        issuer: String,
        client_id: String,
        client_secret: Vec<u8>,
        correlation_id: &str,
    ) -> Result<OidcProviderView, OidcProviderError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        let input = OidcProviderInput::new(display_name, issuer, client_id)?;
        let secret =
            SecretValue::new(client_secret).map_err(|_| OidcProviderError::InvalidInput)?;
        provider_view(
            runtime
                .providers
                .create_provider(actor, &input, &secret, correlation_id)
                .await?,
        )
    }

    pub(crate) async fn update(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        display_name: String,
        client_id: String,
        correlation_id: &str,
    ) -> Result<OidcProviderView, OidcProviderError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        let update = OidcProviderUpdate::new(display_name, client_id)?;
        provider_view(
            runtime
                .providers
                .update_provider(actor, id, version, &update, correlation_id)
                .await?,
        )
    }

    pub(crate) async fn disable(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation_id: &str,
    ) -> Result<OidcProviderView, OidcProviderError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        provider_view(
            runtime
                .providers
                .disable_provider(actor, id, version, correlation_id)
                .await?,
        )
    }

    pub(crate) async fn rotate_secret(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        secret: Vec<u8>,
        correlation_id: &str,
    ) -> Result<OidcProviderView, OidcProviderError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        let secret = SecretValue::new(secret).map_err(|_| OidcProviderError::InvalidInput)?;
        provider_view(
            runtime
                .providers
                .rotate_client_secret(actor, id, version, &secret, correlation_id)
                .await?,
        )
    }

    pub(crate) async fn activate(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        redirect_uri: &str,
        correlation_id: &str,
    ) -> Result<OidcProviderView, OidcProviderError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        provider_view(
            runtime
                .providers
                .validate_and_activate(
                    &runtime.validator,
                    actor,
                    id,
                    version,
                    redirect_uri,
                    correlation_id,
                )
                .await?,
        )
    }

    pub(crate) async fn delete(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation_id: &str,
    ) -> Result<(), OidcProviderError> {
        let runtime = self.runtime()?;
        let actor = runtime.actor(request).await?;
        runtime
            .providers
            .delete_provider(actor, id, version, correlation_id)
            .await
    }

    fn runtime(&self) -> Result<&OidcHttpRuntime, OidcProviderError> {
        self.runtime
            .as_deref()
            .ok_or(OidcProviderError::Unavailable)
    }
}

impl OidcHttpRuntime {
    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<(SessionToken, Session), OidcProviderError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(|_| OidcProviderError::AuthenticationFailed)?
            .into_session_token();
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(|_| OidcProviderError::AuthenticationFailed)?;
        Ok((token, session))
    }

    async fn require_admin(&self, session: &Session) -> Result<(), OidcProviderError> {
        let allowed: Option<bool> = sqlx::query_scalar(
            "SELECT status='active' AND is_instance_admin FROM users WHERE id=$1::uuid",
        )
        .bind(session.user_id().to_string())
        .fetch_optional(
            &mut *self
                .pool
                .acquire()
                .await
                .map_err(|_| OidcProviderError::Unavailable)?,
        )
        .await
        .map_err(|_| OidcProviderError::Unavailable)?;
        if allowed == Some(true) {
            Ok(())
        } else {
            Err(OidcProviderError::Forbidden)
        }
    }

    async fn actor(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<IntegrationAdminActor, OidcProviderError> {
        let (_, session) = self.authenticate(request).await?;
        Ok(IntegrationAdminActor {
            user_id: session.user_id(),
            session_id: session.id(),
        })
    }

    fn session_cookies(
        &self,
        issued: &crate::identity::IssuedSession,
    ) -> Result<IssuedBrowserCookies, OidcProviderError> {
        let fields = issued.session().clone().into_fields();
        let now = Timestamp::from_datetime(OffsetDateTime::now_utc())
            .map_err(|_| OidcProviderError::Unavailable)?;
        let lifetime = CookieLifetime::new(now, fields.absolute_expires_at)
            .map_err(|_| OidcProviderError::Unavailable)?;
        self.cookies
            .issue(issued.token(), lifetime)
            .map_err(|_| OidcProviderError::Unavailable)
    }

    fn binding_cookie(&self, value: &str, max_age: u16) -> Result<String, OidcProviderError> {
        if max_age > 0 {
            let decoded = URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| OidcProviderError::Unavailable)?;
            if decoded.len() != BINDING_BYTES {
                return Err(OidcProviderError::Unavailable);
            }
        }
        Ok(format!(
            "{}={}; Path=/; Max-Age={max_age}; {}HttpOnly; SameSite=Lax",
            self.binding_cookie_name,
            value,
            if self.secure_cookie { "Secure; " } else { "" }
        ))
    }

    fn binding_from_headers(&self, headers: &[&str]) -> Result<String, OidcProviderError> {
        if headers.iter().map(|value| value.len()).sum::<usize>() > MAX_COOKIE_BYTES {
            return Err(OidcProviderError::ValidationFailed);
        }
        let values = headers
            .iter()
            .flat_map(|header| header.split(';'))
            .filter_map(|pair| {
                let (name, value) = pair.trim().split_once('=')?;
                (name == self.binding_cookie_name).then(|| value.to_owned())
            })
            .collect::<Vec<_>>();
        let [value] = values.as_slice() else {
            return Err(OidcProviderError::ValidationFailed);
        };
        let decoded = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        if decoded.len() != BINDING_BYTES {
            return Err(OidcProviderError::ValidationFailed);
        }
        Ok(value.clone())
    }
}

fn provider_view(value: OidcProviderMetadata) -> Result<OidcProviderView, OidcProviderError> {
    Ok(OidcProviderView {
        id: value.id.to_string(),
        display_name: value.display_name,
        issuer: value.issuer,
        client_id: value.client_id,
        state: match value.state {
            OidcProviderState::Active => "active",
            OidcProviderState::Disabled => "disabled",
        }
        .to_owned(),
        config_version: value.config_version,
        secret_version: value.secret_version,
        linked_identity_count: value.linked_identity_count,
        created_at: timestamp(value.created_at)?,
        updated_at: timestamp(value.updated_at)?,
    })
}

fn timestamp(value: OffsetDateTime) -> Result<String, OidcProviderError> {
    Timestamp::from_datetime(value)
        .map(|value| value.to_string())
        .map_err(|_| OidcProviderError::Unavailable)
}
