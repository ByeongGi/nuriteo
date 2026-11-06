use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sqlx::Row;
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::database::DatabasePool;
use crate::identity::{
    BrowserRequestHeaders, CookieLifetime, IssuedBrowserCookies, Session, SessionToken, Timestamp,
};
use crate::integration::{IntegrationAdminActor, SecretValue};

use super::super::{
    OidcCallbackInput, OidcProviderError, OidcProviderInput, OidcProviderMetadata,
    OidcProviderState, OidcProviderUpdate,
};
use super::{OidcHttpRuntime, OidcHttpService, timestamp};

const BINDING_BYTES: usize = 32;
const MAX_COOKIE_BYTES: usize = 16 * 1024;

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

pub(crate) struct OidcBeginResponse {
    pub(crate) location: String,
    pub(crate) binding_cookie: String,
}

pub(crate) struct OidcSessionResponse {
    pub(crate) cookies: IssuedBrowserCookies,
    pub(crate) clear_binding_cookie: Option<String>,
}

impl OidcHttpService {
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
}

impl OidcHttpRuntime {
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
