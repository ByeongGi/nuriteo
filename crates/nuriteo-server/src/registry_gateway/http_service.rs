use std::fmt;
use std::sync::Arc;

use serde::Serialize;
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserRequestHeaders, SessionPolicy, SessionService,
};
use crate::integration::{
    IntegrationAdminActor, IntegrationRepository, MasterKeyring, SecretValue,
};

use super::{
    RegistryConnectionInput, RegistryConnectionMetadata, RegistryError, RegistryGatewayService,
    RegistryState,
};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAdminView {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub state: String,
    pub is_default: bool,
    pub config_version: u64,
    pub credential_version: u64,
    pub validated_at: Option<String>,
}
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryScopeView {
    pub scope: String,
    pub connection_id: String,
}
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryCollectionView {
    pub items: Vec<RegistryAdminView>,
    pub scopes: Vec<RegistryScopeView>,
}

#[derive(Clone)]
pub struct RegistryHttpService {
    runtime: Option<Arc<Runtime>>,
}
struct Runtime {
    pool: DatabasePool,
    cookies: BrowserCookieBoundary,
    sessions: SessionService,
    gateway: RegistryGatewayService,
}
impl fmt::Debug for RegistryHttpService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegistryHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}
impl RegistryHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }
    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        keyring: MasterKeyring,
        policy: SessionPolicy,
    ) -> Result<Self, RegistryError> {
        let cookies =
            BrowserCookieBoundary::new(external_url).map_err(|_| RegistryError::InvalidInput)?;
        let sessions = SessionService::new(pool.clone(), policy);
        let gateway =
            RegistryGatewayService::new(IntegrationRepository::new(pool.clone(), keyring));
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                pool,
                cookies,
                sessions,
                gateway,
            })),
        })
    }
    pub(crate) async fn list(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<RegistryCollectionView, RegistryError> {
        let runtime = self.runtime()?;
        runtime.actor(request).await?;
        let items = runtime
            .gateway
            .list()
            .await?
            .into_iter()
            .map(view)
            .collect();
        let scopes = runtime
            .gateway
            .list_scope_routes()
            .await?
            .into_iter()
            .map(|(scope, id)| RegistryScopeView {
                scope,
                connection_id: id.to_string(),
            })
            .collect();
        Ok(RegistryCollectionView { items, scopes })
    }
    pub(crate) async fn create(
        &self,
        request: BrowserRequestHeaders<'_>,
        name: String,
        url: String,
        token: Vec<u8>,
        correlation: &str,
    ) -> Result<RegistryAdminView, RegistryError> {
        let r = self.runtime()?;
        let actor = r.actor(request).await?;
        let input = RegistryConnectionInput::new(name, url)?;
        let token = SecretValue::new(token).map_err(|_| RegistryError::InvalidInput)?;
        Ok(view(
            r.gateway.create(actor, &input, &token, correlation).await?,
        ))
    }
    pub(crate) async fn rename(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        name: &str,
        correlation: &str,
    ) -> Result<RegistryAdminView, RegistryError> {
        let r = self.runtime()?;
        Ok(view(
            r.gateway
                .rename(r.actor(request).await?, id, version, name, correlation)
                .await?,
        ))
    }
    pub(crate) async fn rotate(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        token: Vec<u8>,
        correlation: &str,
    ) -> Result<RegistryAdminView, RegistryError> {
        let r = self.runtime()?;
        let token = SecretValue::new(token).map_err(|_| RegistryError::InvalidInput)?;
        Ok(view(
            r.gateway
                .rotate_token(r.actor(request).await?, id, version, &token, correlation)
                .await?,
        ))
    }
    pub(crate) async fn activate(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation: &str,
    ) -> Result<RegistryAdminView, RegistryError> {
        let r = self.runtime()?;
        Ok(view(
            r.gateway
                .validate_and_activate(r.actor(request).await?, id, version, correlation)
                .await?,
        ))
    }
    pub(crate) async fn disable(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation: &str,
    ) -> Result<RegistryAdminView, RegistryError> {
        let r = self.runtime()?;
        Ok(view(
            r.gateway
                .disable(r.actor(request).await?, id, version, correlation)
                .await?,
        ))
    }
    pub(crate) async fn set_default(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation: &str,
    ) -> Result<RegistryAdminView, RegistryError> {
        let r = self.runtime()?;
        Ok(view(
            r.gateway
                .set_default(r.actor(request).await?, id, version, correlation)
                .await?,
        ))
    }
    pub(crate) async fn map_scope(
        &self,
        request: BrowserRequestHeaders<'_>,
        scope: &str,
        id: Uuid,
        correlation: &str,
    ) -> Result<(), RegistryError> {
        let r = self.runtime()?;
        r.gateway
            .map_scope(r.actor(request).await?, scope, id, correlation)
            .await
    }
    pub(crate) async fn delete(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        version: u64,
        correlation: &str,
    ) -> Result<(), RegistryError> {
        let r = self.runtime()?;
        r.gateway
            .delete(r.actor(request).await?, id, version, correlation)
            .await
    }
    fn runtime(&self) -> Result<&Runtime, RegistryError> {
        self.runtime.as_deref().ok_or(RegistryError::Unavailable)
    }
}
impl Runtime {
    async fn actor(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<IntegrationAdminActor, RegistryError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(|_| RegistryError::AuthenticationFailed)?
            .into_session_token();
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(|_| RegistryError::AuthenticationFailed)?;
        let admin: Option<bool> = sqlx::query_scalar(
            "SELECT status='active' AND is_instance_admin FROM users WHERE id=$1::uuid",
        )
        .bind(session.user_id().to_string())
        .fetch_optional(
            &mut *self
                .pool
                .acquire()
                .await
                .map_err(|_| RegistryError::Unavailable)?,
        )
        .await
        .map_err(|_| RegistryError::Unavailable)?;
        if admin != Some(true) {
            return Err(RegistryError::Forbidden);
        }
        Ok(IntegrationAdminActor {
            user_id: session.user_id(),
            session_id: session.id(),
        })
    }
}
fn view(value: RegistryConnectionMetadata) -> RegistryAdminView {
    RegistryAdminView {
        id: value.id.to_string(),
        display_name: value.display_name,
        base_url: value.base_url,
        state: match value.state {
            RegistryState::Active => "active",
            RegistryState::Disabled => "disabled",
        }
        .into(),
        is_default: value.is_default,
        config_version: value.config_version,
        credential_version: value.credential_version,
        validated_at: value.validated_at.map(|v| v.to_string()),
    }
}
