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

mod administration;
mod identities;
mod login;

pub(crate) use administration::{OidcProviderCollectionView, OidcProviderView};
pub(crate) use identities::OidcIdentityCollectionView;
pub(crate) use login::{OidcBeginResponse, OidcLoginProviderCollectionView, OidcSessionResponse};

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
}

fn timestamp(value: OffsetDateTime) -> Result<String, OidcProviderError> {
    Timestamp::from_datetime(value)
        .map(|value| value.to_string())
        .map_err(|_| OidcProviderError::Unavailable)
}
