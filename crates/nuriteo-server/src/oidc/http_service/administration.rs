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

impl OidcHttpService {
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
}

impl OidcHttpRuntime {
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
}
