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

use super::OidcSessionResponse;
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

impl OidcHttpService {
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
}
