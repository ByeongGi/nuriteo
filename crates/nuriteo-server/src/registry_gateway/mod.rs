//! Multi-registry npm gateway with exact scope routing and no fallback.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::time::Duration;

use ::time::OffsetDateTime;
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use reqwest::{Certificate, Client, StatusCode};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Postgres, Row, Transaction};
use tokio::net::lookup_host;
use tokio::time;
use url::Url;
use uuid::Uuid;

use crate::integration::{
    CaEndpointBinding, CredentialIdentity, IntegrationAdminActor, IntegrationError,
    IntegrationRepository, SecretValue, ValidatedCaBundle, authorize_recent_admin,
};

mod http_routes;
mod http_service;
pub(crate) use http_routes::openapi_router;
pub use http_service::RegistryHttpService;
pub(crate) use http_service::{RegistryAdminView, RegistryCollectionView};

const INTEGRATION_TYPE: &str = "registry";
const CREDENTIAL_KIND: &str = "auth_token";
const INSTANCE_ID: &str = "instance";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_DNS_ADDRESSES: usize = 16;
const PREFLIGHT_LIMIT: usize = 64 * 1024;
const METADATA_LIMIT: usize = 2 * 1024 * 1024;
const PACKAGE_SEGMENT: &AsciiSet = &CONTROLS.add(b'/').add(b'?').add(b'#').add(b'%').add(b' ');

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryState {
    Active,
    Disabled,
}

impl RegistryState {
    fn parse(value: &str) -> Result<Self, RegistryError> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            _ => Err(RegistryError::Unavailable),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryConnectionInput {
    display_name: String,
    base_url: String,
    canonical_host: String,
    canonical_port: u16,
    base_path: String,
}

impl RegistryConnectionInput {
    pub fn new(
        display_name: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Result<Self, RegistryError> {
        let display_name = display_name.into();
        let base_url = base_url.into();
        let parsed = validate_base_url(&base_url)?;
        let canonical_host = parsed
            .host_str()
            .ok_or(RegistryError::InvalidInput)?
            .to_ascii_lowercase();
        let canonical_port = parsed
            .port_or_known_default()
            .ok_or(RegistryError::InvalidInput)?;
        let base_path = canonical_base_path(parsed.path())?;
        if !valid_text(&display_name, 200) {
            return Err(RegistryError::InvalidInput);
        }
        Ok(Self {
            display_name,
            base_url: normalized_base_url(&parsed, &base_path),
            canonical_host,
            canonical_port,
            base_path,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryConnectionMetadata {
    pub id: Uuid,
    pub display_name: String,
    pub base_url: String,
    pub canonical_host: String,
    pub canonical_port: u16,
    pub base_path: String,
    pub state: RegistryState,
    pub is_default: bool,
    pub config_version: u64,
    pub credential_version: u64,
    pub validated_at: Option<OffsetDateTime>,
}

pub struct RegistryPayload {
    pub connection_id: Uuid,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl fmt::Debug for RegistryPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RegistryPayload")
            .field("connection_id", &self.connection_id)
            .field("content_type", &self.content_type)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

#[derive(Clone)]
pub struct RegistryGatewayService {
    integrations: IntegrationRepository,
    timeout: Duration,
    allow_test_addresses: bool,
}

impl fmt::Debug for RegistryGatewayService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RegistryGatewayService")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl RegistryGatewayService {
    #[must_use]
    pub const fn new(integrations: IntegrationRepository) -> Self {
        Self {
            integrations,
            timeout: DEFAULT_TIMEOUT,
            allow_test_addresses: false,
        }
    }

    #[cfg(test)]
    fn allowing_test_addresses(mut self) -> Self {
        self.allow_test_addresses = true;
        self
    }

    pub async fn list(&self) -> Result<Vec<RegistryConnectionMetadata>, RegistryError> {
        let mut connection = self.acquire().await?;
        let rows = sqlx::query(
            "SELECT id::text,display_name,base_url,canonical_host,canonical_port,base_path,status,
             is_default,config_version,credential_version,validated_at
             FROM registry_connections ORDER BY lower(display_name),id LIMIT 100",
        )
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| RegistryError::Unavailable)?;
        rows.iter().map(metadata_from_row).collect()
    }

    pub async fn list_scope_routes(&self) -> Result<Vec<(String, Uuid)>, RegistryError> {
        let mut connection = self.acquire().await?;
        sqlx::query("SELECT scope,connection_id::text FROM registry_scope_routes ORDER BY scope")
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| RegistryError::Unavailable)?
            .into_iter()
            .map(|row| {
                Ok((
                    row.get("scope"),
                    Uuid::from_str(row.get::<String, _>("connection_id").as_str())
                        .map_err(|_| RegistryError::Unavailable)?,
                ))
            })
            .collect()
    }

    pub async fn rename(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        display_name: &str,
        correlation_id: &str,
    ) -> Result<RegistryConnectionMetadata, RegistryError> {
        if !valid_text(display_name, 200) {
            return Err(RegistryError::InvalidInput);
        }
        validate_correlation(correlation_id)?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let current = load_for_update(&mut tx, id, expected_version).await?;
        if current.state != RegistryState::Disabled {
            return Err(RegistryError::MustDisable);
        }
        sqlx::query("UPDATE registry_connections SET display_name=$2,config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid")
            .bind(id.to_string()).bind(display_name).execute(&mut *tx).await.map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "registry.connection_updated",
            id,
            expected_version + 1,
            correlation_id,
        )
        .await?;
        let metadata = load_metadata(&mut tx, id).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(metadata)
    }

    pub async fn disable(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<RegistryConnectionMetadata, RegistryError> {
        validate_correlation(correlation_id)?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let current = load_for_update(&mut tx, id, expected_version).await?;
        if current.state != RegistryState::Active {
            return Err(RegistryError::Conflict);
        }
        sqlx::query("UPDATE registry_connections SET status='disabled',is_default=FALSE,disabled_at=CURRENT_TIMESTAMP,config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid")
            .bind(id.to_string()).execute(&mut *tx).await.map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "registry.connection_disabled",
            id,
            expected_version + 1,
            correlation_id,
        )
        .await?;
        let metadata = load_metadata(&mut tx, id).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(metadata)
    }

    pub async fn delete(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<(), RegistryError> {
        validate_correlation(correlation_id)?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let current = load_for_update(&mut tx, id, expected_version).await?;
        if current.state != RegistryState::Disabled {
            return Err(RegistryError::MustDisable);
        }
        let credential_id: String = sqlx::query_scalar(
            "SELECT credential_id::text FROM registry_connections WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| RegistryError::Unavailable)?;
        sqlx::query("DELETE FROM registry_connections WHERE id=$1::uuid")
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(map_database_error)?;
        sqlx::query("DELETE FROM integration_credentials WHERE id=$1::uuid")
            .bind(credential_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        append_audit(
            &mut tx,
            actor,
            "registry.connection_deleted",
            id,
            expected_version,
            correlation_id,
        )
        .await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(())
    }

    pub async fn create(
        &self,
        actor: IntegrationAdminActor,
        input: &RegistryConnectionInput,
        token: &SecretValue,
        correlation_id: &str,
    ) -> Result<RegistryConnectionMetadata, RegistryError> {
        validate_correlation(correlation_id)?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO registry_connections(id,display_name,base_url,canonical_host,canonical_port,base_path)
             VALUES($1::uuid,$2,$3,$4,$5,$6)",
        )
        .bind(id.to_string())
        .bind(&input.display_name)
        .bind(&input.base_url)
        .bind(&input.canonical_host)
        .bind(i32::from(input.canonical_port))
        .bind(&input.base_path)
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        let identity = credential_identity(id)?;
        let credential = self
            .integrations
            .upsert_credential_in_transaction(&mut tx, &identity, token)
            .await
            .map_err(map_integration_error)?;
        sqlx::query(
            "UPDATE registry_connections SET credential_id=$2::uuid,credential_version=$3,
             config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .bind(credential.id.to_string())
        .bind(i64::try_from(credential.credential_version).map_err(|_| RegistryError::Unavailable)?)
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "registry.connection_created",
            id,
            2,
            correlation_id,
        )
        .await?;
        let metadata = load_metadata(&mut tx, id).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(metadata)
    }

    pub async fn rotate_token(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        token: &SecretValue,
        correlation_id: &str,
    ) -> Result<RegistryConnectionMetadata, RegistryError> {
        validate_correlation(correlation_id)?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let current = load_for_update(&mut tx, id, expected_version).await?;
        if current.state != RegistryState::Disabled {
            return Err(RegistryError::MustDisable);
        }
        let credential = self
            .integrations
            .upsert_credential_in_transaction(&mut tx, &credential_identity(id)?, token)
            .await
            .map_err(map_integration_error)?;
        sqlx::query(
            "UPDATE registry_connections SET credential_version=$2,config_version=config_version+1,
             validation_config_version=NULL,validation_credential_version=NULL,
             validation_fingerprint=NULL,validation_ca_fingerprint=NULL,validated_at=NULL,
             updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .bind(i64::try_from(credential.credential_version).map_err(|_| RegistryError::Unavailable)?)
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "registry.credential_rotated",
            id,
            expected_version + 1,
            correlation_id,
        )
        .await?;
        let metadata = load_metadata(&mut tx, id).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(metadata)
    }

    pub async fn validate_and_activate(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<RegistryConnectionMetadata, RegistryError> {
        validate_correlation(correlation_id)?;
        let runtime = self.runtime_candidate(actor, id, expected_version).await?;
        let fingerprint = self.preflight(&runtime).await?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let current = load_for_update(&mut tx, id, expected_version).await?;
        if current != runtime.metadata {
            return Err(RegistryError::Conflict);
        }
        let ca_fingerprint = active_ca_fingerprint(&mut tx, &runtime.binding).await?;
        if ca_fingerprint != runtime.ca_fingerprint {
            return Err(RegistryError::Conflict);
        }
        sqlx::query(
            "UPDATE registry_connections SET status='active',disabled_at=NULL,
             validation_config_version=config_version,
             validation_credential_version=credential_version,validation_fingerprint=$2,
             validation_ca_fingerprint=$3,validated_at=CURRENT_TIMESTAMP,
             config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .bind(fingerprint.to_vec())
        .bind(ca_fingerprint.to_vec())
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "registry.connection_activated",
            id,
            expected_version + 1,
            correlation_id,
        )
        .await?;
        let metadata = load_metadata(&mut tx, id).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(metadata)
    }

    /// Runs the normal authenticated Registry metadata preflight with a
    /// staged CA candidate. This does not activate either the CA or Registry.
    pub(crate) async fn preflight_ca_candidate(
        &self,
        id: Uuid,
        candidate_ca: &ValidatedCaBundle,
        endpoint: &CaEndpointBinding,
    ) -> Result<(), RegistryError> {
        let metadata = self
            .list()
            .await?
            .into_iter()
            .find(|connection| connection.id == id)
            .ok_or(RegistryError::NotFound)?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        let runtime =
            load_runtime_with_ca(&self.integrations, &mut tx, metadata, Some(candidate_ca)).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        if runtime.binding.fingerprint() != endpoint.fingerprint() {
            return Err(RegistryError::ValidationFailed);
        }
        self.preflight(&runtime).await.map(|_| ())
    }

    pub async fn set_default(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<RegistryConnectionMetadata, RegistryError> {
        validate_correlation(correlation_id)?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let current = load_for_update(&mut tx, id, expected_version).await?;
        if current.state != RegistryState::Active || current.is_default {
            return Err(RegistryError::Conflict);
        }
        sqlx::query(
            "UPDATE registry_connections SET is_default=FALSE,config_version=config_version+1,
             validation_config_version=config_version,updated_at=CURRENT_TIMESTAMP
             WHERE is_default AND id<>$1::uuid",
        )
        .bind(id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        sqlx::query(
            "UPDATE registry_connections SET is_default=TRUE,config_version=config_version+1,
             validation_config_version=config_version,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "registry.default_changed",
            id,
            expected_version + 1,
            correlation_id,
        )
        .await?;
        let metadata = load_metadata(&mut tx, id).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(metadata)
    }

    pub async fn map_scope(
        &self,
        actor: IntegrationAdminActor,
        scope: &str,
        connection_id: Uuid,
        correlation_id: &str,
    ) -> Result<(), RegistryError> {
        validate_scope(scope)?;
        validate_correlation(correlation_id)?;
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let active: bool = sqlx::query_scalar(
            "SELECT status='active' FROM registry_connections WHERE id=$1::uuid FOR SHARE",
        )
        .bind(connection_id.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| RegistryError::Unavailable)?
        .ok_or(RegistryError::NotFound)?;
        if !active {
            return Err(RegistryError::Disabled);
        }
        sqlx::query(
            "INSERT INTO registry_scope_routes(scope,connection_id) VALUES($1,$2::uuid)
             ON CONFLICT(scope) DO UPDATE SET connection_id=EXCLUDED.connection_id,
             updated_at=CURRENT_TIMESTAMP",
        )
        .bind(scope)
        .bind(connection_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(map_database_error)?;
        append_audit(
            &mut tx,
            actor,
            "registry.scope_mapped",
            connection_id,
            1,
            correlation_id,
        )
        .await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(())
    }

    pub async fn fetch_metadata(&self, package: &str) -> Result<RegistryPayload, RegistryError> {
        validate_package(package)?;
        let runtime = self.runtime_for_package(package).await?;
        let url = metadata_url(&runtime.metadata, package)?;
        let response = self
            .send(&runtime, url, METADATA_LIMIT)
            .await
            .map_err(|error| error.with_connection(runtime.metadata.id))?;
        Ok(RegistryPayload {
            connection_id: runtime.metadata.id,
            content_type: response.content_type,
            body: response.body,
        })
    }

    async fn runtime_candidate(
        &self,
        actor: IntegrationAdminActor,
        id: Uuid,
        version: u64,
    ) -> Result<RegistryRuntime, RegistryError> {
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor)
            .await
            .map_err(map_integration_error)?;
        let metadata = load_for_update(&mut tx, id, version).await?;
        if metadata.state != RegistryState::Disabled {
            return Err(RegistryError::Conflict);
        }
        let runtime = load_runtime(&self.integrations, &mut tx, metadata).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(runtime)
    }

    async fn runtime_for_package(&self, package: &str) -> Result<RegistryRuntime, RegistryError> {
        let scope = package.split_once('/').map(|(scope, _)| scope);
        let mut connection = self.acquire().await?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| RegistryError::Unavailable)?;
        let id: Option<String> = if let Some(scope) = scope {
            let route:Option<(String,String)>=sqlx::query_as(
                "SELECT c.id::text,c.status FROM registry_scope_routes r JOIN registry_connections c
                 ON c.id=r.connection_id WHERE r.scope=$1",
            )
            .bind(scope)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| RegistryError::Unavailable)?;
            match route {
                Some((_, status)) if status != "active" => {
                    return Err(RegistryError::RouteUnavailable);
                }
                Some((id, _)) => Some(id),
                None => None,
            }
        } else {
            None
        };
        let id = match id {
            Some(id) => id,
            None => sqlx::query_scalar(
                "SELECT id::text FROM registry_connections WHERE is_default AND status='active'",
            )
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| RegistryError::Unavailable)?
            .ok_or(RegistryError::RouteUnavailable)?,
        };
        let metadata = load_metadata(
            &mut tx,
            Uuid::from_str(&id).map_err(|_| RegistryError::Unavailable)?,
        )
        .await?;
        let runtime = load_runtime(&self.integrations, &mut tx, metadata).await?;
        tx.commit().await.map_err(|_| RegistryError::Unavailable)?;
        Ok(runtime)
    }

    async fn preflight(&self, runtime: &RegistryRuntime) -> Result<[u8; 32], RegistryError> {
        let url = Url::parse(&format!(
            "{}/-/ping",
            runtime.metadata.base_url.trim_end_matches('/')
        ))
        .map_err(|_| RegistryError::ValidationFailed)?;
        let response = self.send(runtime, url, PREFLIGHT_LIMIT).await?;
        let mut digest = Sha256::new();
        digest.update(b"nuriteo.registry-preflight.v1");
        digest.update(runtime.metadata.id.as_bytes());
        digest.update(runtime.metadata.config_version.to_be_bytes());
        digest.update(runtime.metadata.credential_version.to_be_bytes());
        digest.update(runtime.metadata.base_url.as_bytes());
        digest.update(response.body);
        Ok(digest.finalize().into())
    }

    async fn send(
        &self,
        runtime: &RegistryRuntime,
        url: Url,
        limit: usize,
    ) -> Result<BoundedResponse, RegistryError> {
        if !same_origin_and_path(&runtime.metadata, &url) {
            return Err(RegistryError::NetworkDenied);
        }
        let addresses = resolve_checked(
            &runtime.metadata.canonical_host,
            runtime.metadata.canonical_port,
            self.allow_test_addresses,
        )
        .await?;
        let mut builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .https_only(true)
            .connect_timeout(self.timeout)
            .timeout(self.timeout)
            .resolve_to_addrs(&runtime.metadata.canonical_host, &addresses);
        if let Some(ca) = runtime.ca.as_ref() {
            for certificate in Certificate::from_pem_bundle(ca.pem())
                .map_err(|_| RegistryError::ValidationFailed)?
            {
                builder = builder.add_root_certificate(certificate);
            }
        }
        let mut response = builder
            .build()
            .map_err(|_| RegistryError::ValidationFailed)?
            .get(url)
            .header(
                reqwest::header::AUTHORIZATION,
                format!(
                    "Bearer {}",
                    std::str::from_utf8(runtime.token.expose())
                        .map_err(|_| RegistryError::CredentialUnavailable)?
                ),
            )
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .send()
            .await
            .map_err(|_| RegistryError::UpstreamUnavailable {
                connection_id: runtime.metadata.id,
            })?;
        if response.status().is_redirection() {
            return Err(RegistryError::NetworkDenied);
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Err(RegistryError::UpstreamNotFound {
                connection_id: runtime.metadata.id,
            });
        }
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return Err(RegistryError::UpstreamAuthentication {
                connection_id: runtime.metadata.id,
            });
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|size| size > limit as u64)
        {
            return Err(RegistryError::UpstreamUnavailable {
                connection_id: runtime.metadata.id,
            });
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        let mut body = Vec::new();
        while let Some(chunk) =
            response
                .chunk()
                .await
                .map_err(|_| RegistryError::UpstreamUnavailable {
                    connection_id: runtime.metadata.id,
                })?
        {
            if body
                .len()
                .checked_add(chunk.len())
                .is_none_or(|size| size > limit)
            {
                return Err(RegistryError::UpstreamUnavailable {
                    connection_id: runtime.metadata.id,
                });
            }
            body.extend_from_slice(&chunk);
        }
        let observed = resolve_checked(
            &runtime.metadata.canonical_host,
            runtime.metadata.canonical_port,
            self.allow_test_addresses,
        )
        .await?;
        if observed != addresses {
            return Err(RegistryError::NetworkDenied);
        }
        Ok(BoundedResponse { content_type, body })
    }

    async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<Postgres>, RegistryError> {
        self.integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| RegistryError::Unavailable)
    }
}

struct RegistryRuntime {
    metadata: RegistryConnectionMetadata,
    token: SecretValue,
    ca: Option<ValidatedCaBundle>,
    ca_fingerprint: [u8; 32],
    binding: CaEndpointBinding,
}

impl fmt::Debug for RegistryRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RegistryRuntime")
            .field("metadata", &self.metadata)
            .field("token", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

struct BoundedResponse {
    content_type: Option<String>,
    body: Vec<u8>,
}

async fn load_runtime(
    integrations: &IntegrationRepository,
    tx: &mut Transaction<'_, Postgres>,
    metadata: RegistryConnectionMetadata,
) -> Result<RegistryRuntime, RegistryError> {
    load_runtime_with_ca(integrations, tx, metadata, None).await
}

async fn load_runtime_with_ca(
    integrations: &IntegrationRepository,
    tx: &mut Transaction<'_, Postgres>,
    metadata: RegistryConnectionMetadata,
    ca_override: Option<&ValidatedCaBundle>,
) -> Result<RegistryRuntime, RegistryError> {
    let credential_id: String = sqlx::query_scalar(
        "SELECT credential_id::text FROM registry_connections WHERE id=$1::uuid",
    )
    .bind(metadata.id.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| RegistryError::CredentialUnavailable)?;
    let credential_id =
        Uuid::from_str(&credential_id).map_err(|_| RegistryError::CredentialUnavailable)?;
    let (identity, version, token) = integrations
        .read_credential_by_id_in_transaction(tx, credential_id)
        .await
        .map_err(map_integration_error)?;
    if identity != credential_identity(metadata.id)? || version != metadata.credential_version {
        return Err(RegistryError::CredentialUnavailable);
    }
    let binding = endpoint_binding(&metadata)?;
    let ca = match ca_override {
        Some(bundle) => Some(bundle.clone()),
        None => integrations
            .active_ca_for_endpoint(&binding)
            .await
            .map_err(map_integration_error)?,
    };
    let ca_fingerprint = trust_fingerprint(ca.as_ref());
    Ok(RegistryRuntime {
        metadata,
        token,
        ca,
        ca_fingerprint,
        binding,
    })
}

fn validate_base_url(value: &str) -> Result<Url, RegistryError> {
    let url = Url::parse(value).map_err(|_| RegistryError::InvalidInput)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || value.to_ascii_lowercase().contains("%2e")
        || value.contains("/../")
    {
        return Err(RegistryError::InvalidInput);
    }
    Ok(url)
}

fn canonical_base_path(value: &str) -> Result<String, RegistryError> {
    if value.contains("..") {
        return Err(RegistryError::InvalidInput);
    }
    let value = value.trim_end_matches('/');
    Ok(if value.is_empty() {
        "/".into()
    } else {
        value.into()
    })
}

fn normalized_base_url(url: &Url, path: &str) -> String {
    let mut value = url.clone();
    value.set_path(path);
    value.to_string().trim_end_matches('/').to_owned()
}

fn validate_package(value: &str) -> Result<(), RegistryError> {
    let valid = if let Some((scope, name)) = value.split_once('/') {
        validate_scope(scope).is_ok() && valid_package_part(name)
    } else {
        valid_package_part(value)
    };
    if valid && value.len() <= 214 {
        Ok(())
    } else {
        Err(RegistryError::InvalidPackage)
    }
}

fn validate_scope(value: &str) -> Result<(), RegistryError> {
    if (2..=65).contains(&value.len())
        && value.starts_with('@')
        && value == value.to_ascii_lowercase()
        && value[1..].bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
    {
        Ok(())
    } else {
        Err(RegistryError::InvalidPackage)
    }
}

fn valid_package_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value == value.to_ascii_lowercase()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn metadata_url(
    connection: &RegistryConnectionMetadata,
    package: &str,
) -> Result<Url, RegistryError> {
    let encoded = utf8_percent_encode(package, PACKAGE_SEGMENT).to_string();
    Url::parse(&format!(
        "{}/{}",
        connection.base_url.trim_end_matches('/'),
        encoded
    ))
    .map_err(|_| RegistryError::InvalidInput)
}

fn same_origin_and_path(connection: &RegistryConnectionMetadata, url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case(&connection.canonical_host))
        && url.port_or_known_default() == Some(connection.canonical_port)
        && (connection.base_path == "/"
            || url.path() == connection.base_path
            || url
                .path()
                .starts_with(&format!("{}/", connection.base_path)))
}

async fn resolve_checked(
    host: &str,
    port: u16,
    allow_test: bool,
) -> Result<Vec<SocketAddr>, RegistryError> {
    let resolved = time::timeout(DNS_TIMEOUT, lookup_host((host, port)))
        .await
        .map_err(|_| RegistryError::NetworkDenied)?
        .map_err(|_| RegistryError::NetworkDenied)?
        .take(MAX_DNS_ADDRESSES + 1);
    let mut addresses: Vec<_> = resolved.collect();
    if addresses.is_empty()
        || addresses.len() > MAX_DNS_ADDRESSES
        || (!allow_test && addresses.iter().any(|address| !is_public_ip(address.ip())))
    {
        return Err(RegistryError::NetworkDenied);
    }
    addresses.sort_unstable();
    addresses.dedup();
    Ok(addresses)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, d] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 168 && b == 63 && c == 129 && d == 16)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let s = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xffc0) == 0xfec0
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                || s[0] == 0x2002)
        }
    }
}

pub(crate) fn endpoint_binding(
    metadata: &RegistryConnectionMetadata,
) -> Result<CaEndpointBinding, RegistryError> {
    CaEndpointBinding::new(
        INTEGRATION_TYPE,
        metadata.id.to_string(),
        metadata.canonical_host.clone(),
        metadata.canonical_port,
        "https",
    )
    .map_err(map_integration_error)
}

fn credential_identity(id: Uuid) -> Result<CredentialIdentity, RegistryError> {
    CredentialIdentity::new(
        INSTANCE_ID,
        INTEGRATION_TYPE,
        id.to_string(),
        CREDENTIAL_KIND,
    )
    .map_err(map_integration_error)
}

fn trust_fingerprint(ca: Option<&ValidatedCaBundle>) -> [u8; 32] {
    match ca {
        Some(ca) => Sha256::digest(ca.pem()).into(),
        None => Sha256::digest(b"nuriteo.registry.system-roots.v1").into(),
    }
}

async fn active_ca_fingerprint(
    tx: &mut Transaction<'_, Postgres>,
    binding: &CaEndpointBinding,
) -> Result<[u8; 32], RegistryError> {
    let rows:Vec<Vec<u8>> = sqlx::query_scalar("SELECT pem FROM integration_ca_bundles WHERE integration_type=$1 AND integration_id=$2 AND state='active' AND endpoint_fingerprint=$3")
        .bind(binding.integration_type()).bind(binding.integration_id()).bind(binding.fingerprint().to_vec())
        .fetch_all(&mut **tx).await.map_err(|_|RegistryError::Unavailable)?;
    match rows.as_slice() {
        [] => Ok(trust_fingerprint(None)),
        [pem] => Ok(Sha256::digest(pem).into()),
        _ => Err(RegistryError::Conflict),
    }
}

async fn load_for_update(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    version: u64,
) -> Result<RegistryConnectionMetadata, RegistryError> {
    let row=sqlx::query("SELECT id::text,display_name,base_url,canonical_host,canonical_port,base_path,status,is_default,config_version,credential_version,validated_at FROM registry_connections WHERE id=$1::uuid FOR UPDATE")
        .bind(id.to_string()).fetch_optional(&mut **tx).await.map_err(|_|RegistryError::Unavailable)?.ok_or(RegistryError::NotFound)?;
    let value = metadata_from_row(&row)?;
    if value.config_version != version {
        return Err(RegistryError::Conflict);
    }
    Ok(value)
}
async fn load_metadata(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<RegistryConnectionMetadata, RegistryError> {
    let row=sqlx::query("SELECT id::text,display_name,base_url,canonical_host,canonical_port,base_path,status,is_default,config_version,credential_version,validated_at FROM registry_connections WHERE id=$1::uuid")
        .bind(id.to_string()).fetch_optional(&mut **tx).await.map_err(|_|RegistryError::Unavailable)?.ok_or(RegistryError::NotFound)?;
    metadata_from_row(&row)
}
fn metadata_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<RegistryConnectionMetadata, RegistryError> {
    Ok(RegistryConnectionMetadata {
        id: Uuid::from_str(row.get::<String, _>("id").as_str())
            .map_err(|_| RegistryError::Unavailable)?,
        display_name: row.get("display_name"),
        base_url: row.get("base_url"),
        canonical_host: row.get("canonical_host"),
        canonical_port: u16::try_from(row.get::<i32, _>("canonical_port"))
            .map_err(|_| RegistryError::Unavailable)?,
        base_path: row.get("base_path"),
        state: RegistryState::parse(row.get("status"))?,
        is_default: row.get("is_default"),
        config_version: u64::try_from(row.get::<i64, _>("config_version"))
            .map_err(|_| RegistryError::Unavailable)?,
        credential_version: u64::try_from(row.get::<i64, _>("credential_version"))
            .map_err(|_| RegistryError::Unavailable)?,
        validated_at: row.get("validated_at"),
    })
}

async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: IntegrationAdminActor,
    action: &str,
    id: Uuid,
    version: u64,
    correlation: &str,
) -> Result<(), RegistryError> {
    sqlx::query("INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,target_id,scope_type,scope_id,result,correlation_id,changed_fields,metadata) VALUES($1::uuid,'user',$2,$2::uuid,$3,'registry_connection',$4,'instance','instance','succeeded',$5,$6,$7::jsonb)")
        .bind(Uuid::now_v7().to_string()).bind(actor.user_id.to_string()).bind(action).bind(id.to_string()).bind(correlation).bind(vec!["registry_config".to_owned()]).bind(serde_json::json!({"configVersion":version}).to_string())
        .execute(&mut **tx).await.map_err(|_|RegistryError::Unavailable)?;
    Ok(())
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
fn validate_correlation(value: &str) -> Result<(), RegistryError> {
    if (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(RegistryError::InvalidInput)
    }
}
fn map_database_error(error: sqlx::Error) -> RegistryError {
    match error.as_database_error().and_then(|e| e.code()).as_deref() {
        Some("23505") => RegistryError::Conflict,
        Some("23514" | "P0001") => RegistryError::ValidationFailed,
        _ => RegistryError::Unavailable,
    }
}
const fn map_integration_error(error: IntegrationError) -> RegistryError {
    match error {
        IntegrationError::InvalidInput => RegistryError::InvalidInput,
        IntegrationError::ReauthenticationRequired => RegistryError::ReauthenticationRequired,
        IntegrationError::Conflict => RegistryError::Conflict,
        IntegrationError::CredentialUnavailable | IntegrationError::KeyConfiguration => {
            RegistryError::CredentialUnavailable
        }
        IntegrationError::InvalidCaBundle | IntegrationError::PreflightFailed => {
            RegistryError::ValidationFailed
        }
        IntegrationError::Unavailable => RegistryError::Unavailable,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryError {
    AuthenticationFailed,
    Forbidden,
    InvalidInput,
    InvalidPackage,
    ReauthenticationRequired,
    NotFound,
    Disabled,
    MustDisable,
    Conflict,
    CredentialUnavailable,
    RouteUnavailable,
    NetworkDenied,
    ValidationFailed,
    UpstreamNotFound { connection_id: Uuid },
    UpstreamAuthentication { connection_id: Uuid },
    UpstreamUnavailable { connection_id: Uuid },
    Unavailable,
}
impl RegistryError {
    const fn with_connection(self, id: Uuid) -> Self {
        match self {
            Self::UpstreamNotFound { .. } => Self::UpstreamNotFound { connection_id: id },
            Self::UpstreamAuthentication { .. } => {
                Self::UpstreamAuthentication { connection_id: id }
            }
            Self::UpstreamUnavailable { .. } => Self::UpstreamUnavailable { connection_id: id },
            other => other,
        }
    }
}
impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::AuthenticationFailed => "authentication failed",
            Self::Forbidden => "administrator access is required",
            Self::InvalidInput => "Registry input is invalid",
            Self::InvalidPackage => "package name is invalid",
            Self::ReauthenticationRequired => "recent administrator authentication is required",
            Self::NotFound => "Registry connection was not found",
            Self::Disabled => "Registry connection is disabled",
            Self::MustDisable => "Registry connection must be disabled first",
            Self::Conflict => "Registry state changed concurrently",
            Self::CredentialUnavailable => "Registry credential is unavailable",
            Self::RouteUnavailable => "Registry route is unavailable",
            Self::NetworkDenied => "Registry network destination is denied",
            Self::ValidationFailed => "Registry validation failed",
            Self::UpstreamNotFound { .. } => "package was not found in the selected Registry",
            Self::UpstreamAuthentication { .. } => "selected Registry rejected authentication",
            Self::UpstreamUnavailable { .. } => "selected Registry is unavailable",
            Self::Unavailable => "Registry Gateway is unavailable",
        })
    }
}
impl std::error::Error for RegistryError {}

#[cfg(test)]
mod tests {
    use std::env;
    use std::ffi::OsString;
    use std::fs;
    use std::io;
    use std::path::Path;
    use std::pin::Pin;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;
    use crate::config::{Environment, FileReader, InstanceSettingBootstrap};
    use crate::database::{
        DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions,
        run_embedded_migrations,
    };
    use crate::identity::{SessionId, UserId};
    use crate::instance_settings::InstanceSettingsRepository;
    use crate::integration::{
        CaCandidatePreflight, CaPreflightProof, IntegrationAdminService, MasterKeyring,
    };
    #[test]
    fn package_and_scope_are_canonical() {
        for ok in ["react", "@company/widget", "a-b"] {
            assert!(validate_package(ok).is_ok(), "{ok}")
        }
        for bad in [
            "React",
            "@Company/widget",
            "@scope/",
            "../react",
            "@scope/a/b",
            "",
        ] {
            assert!(validate_package(bad).is_err(), "{bad}")
        }
    }
    #[test]
    fn endpoint_and_path_are_credential_free() {
        assert!(RegistryConnectionInput::new("npm", "https://registry.example.test/npm/").is_ok());
        for bad in [
            "http://registry.example.test/",
            "https://token@registry.example.test/",
            "https://registry.example.test/npm?token=x",
            "https://registry.example.test/a/../b",
        ] {
            assert!(RegistryConnectionInput::new("bad", bad).is_err(), "{bad}")
        }
    }
    #[test]
    fn metadata_path_encodes_scoped_separator() {
        let input =
            RegistryConnectionInput::new("npm", "https://registry.example.test/npm").unwrap();
        let metadata = RegistryConnectionMetadata {
            id: Uuid::now_v7(),
            display_name: input.display_name,
            base_url: input.base_url,
            canonical_host: input.canonical_host,
            canonical_port: 443,
            base_path: input.base_path,
            state: RegistryState::Active,
            is_default: true,
            config_version: 3,
            credential_version: 1,
            validated_at: None,
        };
        assert_eq!(
            metadata_url(&metadata, "@company/widget").unwrap().as_str(),
            "https://registry.example.test/npm/@company%2Fwidget"
        )
    }
    #[test]
    fn private_networks_are_denied() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "168.63.129.16",
            "::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}")
        }
    }
    #[test]
    fn debug_never_renders_payload_or_token() {
        let payload = RegistryPayload {
            connection_id: Uuid::now_v7(),
            content_type: Some("application/json".into()),
            body: b"secret-body".to_vec(),
        };
        assert!(!format!("{payload:?}").contains("secret-body"));
        let _ = RegistryGatewayService::new as fn(IntegrationRepository) -> RegistryGatewayService;
    }

    #[tokio::test]
    #[ignore = "requires tests/fixtures/postgres-registry-gateway/run.sh"]
    async fn actual_gateway_is_tls_pinned_scope_exact_and_never_falls_back() {
        let pool = fixture_pool().await;
        reset_fixture(&pool).await;
        let report = run_embedded_migrations(
            &pool,
            MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(report.latest_version, Some(40));
        InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
            .unwrap()
            .materialize(&InstanceSettingBootstrap::empty())
            .await
            .unwrap();
        seed_admin(&pool).await;
        let port = env::var("NURITEO_TEST_REGISTRY_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let control = env::var("NURITEO_TEST_REGISTRY_CONTROL_DIR").unwrap();
        let repository = IntegrationRepository::new(pool.clone(), keyring());
        let production = RegistryGatewayService::new(repository.clone());
        let gateway = production.clone().allowing_test_addresses();
        let default = gateway
            .create(
                actor(),
                &RegistryConnectionInput::new(
                    "Default",
                    format!("https://localhost:{port}/default"),
                )
                .unwrap(),
                &SecretValue::new(b"default-token".to_vec()).unwrap(),
                "request:registry-default-create",
            )
            .await
            .unwrap();
        let scoped = gateway
            .create(
                actor(),
                &RegistryConnectionInput::new(
                    "Company",
                    format!("https://localhost:{port}/private"),
                )
                .unwrap(),
                &SecretValue::new(b"scope-token".to_vec()).unwrap(),
                "request:registry-scope-create",
            )
            .await
            .unwrap();
        assert_eq!(
            production
                .validate_and_activate(
                    actor(),
                    default.id,
                    default.config_version,
                    "request:registry-ssrf",
                )
                .await
                .unwrap_err(),
            RegistryError::NetworkDenied
        );
        assert_eq!(
            gateway
                .validate_and_activate(
                    actor(),
                    default.id,
                    default.config_version,
                    "request:registry-wrong-ca",
                )
                .await
                .unwrap_err(),
            RegistryError::UpstreamUnavailable {
                connection_id: default.id
            }
        );
        let ca = ValidatedCaBundle::parse(
            fs::read(env::var("NURITEO_TEST_REGISTRY_CA").unwrap()).unwrap(),
        )
        .unwrap();
        let admin = IntegrationAdminService::new(repository);
        for connection in [&default, &scoped] {
            let binding = endpoint_binding(connection).unwrap();
            let staged = admin
                .stage_ca_candidate(actor(), &binding, ca.clone(), "request:registry-ca-stage")
                .await
                .unwrap();
            admin
                .activate_ca_candidate(
                    actor(),
                    staged.id,
                    &binding,
                    "request:registry-ca-activate",
                    &ExactPreflight,
                )
                .await
                .unwrap();
        }
        fs::write(Path::new(&control).join("mode"), "redirect").unwrap();
        assert_eq!(
            gateway
                .validate_and_activate(
                    actor(),
                    default.id,
                    default.config_version,
                    "request:registry-redirect",
                )
                .await
                .unwrap_err(),
            RegistryError::NetworkDenied
        );
        fs::write(Path::new(&control).join("mode"), "normal").unwrap();
        let default = gateway
            .validate_and_activate(
                actor(),
                default.id,
                default.config_version,
                "request:registry-default-activate",
            )
            .await
            .unwrap();
        let scoped = gateway
            .validate_and_activate(
                actor(),
                scoped.id,
                scoped.config_version,
                "request:registry-scope-activate",
            )
            .await
            .unwrap();
        let default = gateway
            .set_default(
                actor(),
                default.id,
                default.config_version,
                "request:registry-set-default",
            )
            .await
            .unwrap();
        assert!(default.is_default);
        gateway
            .map_scope(actor(), "@company", scoped.id, "request:registry-map-scope")
            .await
            .unwrap();

        let public = gateway.fetch_metadata("react").await.unwrap();
        assert_eq!(public.connection_id, default.id);
        assert!(
            String::from_utf8(public.body)
                .unwrap()
                .contains("sha512-fixture")
        );
        let private = gateway.fetch_metadata("@company/widget").await.unwrap();
        assert_eq!(private.connection_id, scoped.id);

        fs::write(Path::new(&control).join("mode"), "scoped-404").unwrap();
        let before = fs::read_to_string(Path::new(&control).join("requests")).unwrap();
        assert_eq!(
            gateway
                .fetch_metadata("@company/missing")
                .await
                .unwrap_err(),
            RegistryError::UpstreamNotFound {
                connection_id: scoped.id
            }
        );
        let after = fs::read_to_string(Path::new(&control).join("requests")).unwrap();
        let delta = &after[before.len()..];
        assert!(delta.contains("/private/"));
        assert!(
            !delta.contains("/default/"),
            "mapped 404 must not fall back"
        );
        assert!(after.lines().all(|line| !line.contains("token")));

        reset_fixture(&pool).await;
        pool.close(Duration::from_secs(2)).await.unwrap();
    }

    struct ExactPreflight;
    impl CaCandidatePreflight for ExactPreflight {
        fn preflight<'a>(
            &'a self,
            _: &'a ValidatedCaBundle,
            endpoint: &'a CaEndpointBinding,
        ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>>
        {
            Box::pin(async move {
                Ok(CaPreflightProof {
                    endpoint_fingerprint: endpoint.fingerprint(),
                })
            })
        }
    }
    fn actor() -> IntegrationAdminActor {
        IntegrationAdminActor {
            user_id: "0199ee6c-c777-7000-8000-000000010001"
                .parse::<UserId>()
                .unwrap(),
            session_id: "0199ee6c-c777-7000-8000-000000010002"
                .parse::<SessionId>()
                .unwrap(),
        }
    }
    async fn seed_admin(pool: &DatabasePool) {
        sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000010001','registry-admin@example.test','registry-admin@example.test','Registry Admin',TRUE)")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
        sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000010002','0199ee6c-c777-7000-8000-000000010001',decode(repeat('81',32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    }
    fn keyring() -> MasterKeyring {
        MasterKeyring::load(
            &TestEnvironment(vec![
                (
                    "NURITEO_MASTER_KEY".into(),
                    URL_SAFE_NO_PAD.encode([101; 32]).into(),
                ),
                ("NURITEO_MASTER_KEY_VERSION".into(), "1".into()),
            ]),
            &NoFiles,
        )
        .unwrap()
    }
    #[derive(Clone)]
    struct TestEnvironment(Vec<(OsString, OsString)>);
    impl Environment for TestEnvironment {
        fn entries(&self) -> Vec<(OsString, OsString)> {
            self.0.clone()
        }
    }
    struct NoFiles;
    impl FileReader for NoFiles {
        fn read(&self, _: &Path, _: usize) -> io::Result<Vec<u8>> {
            Err(io::ErrorKind::NotFound.into())
        }
    }
    async fn reset_fixture(pool: &DatabasePool) {
        sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    }
    async fn fixture_pool() -> DatabasePool {
        let tls = DatabaseTlsConfig::verify_full(
            None,
            Some(fs::read(env::var("NURITEO_TEST_DATABASE_CA").unwrap()).unwrap()),
            None,
        )
        .unwrap();
        DatabasePool::connect(
            DatabasePoolConfig::new(
                env::var("NURITEO_TEST_DATABASE_URL").unwrap(),
                1,
                4,
                Duration::from_secs(5),
                Duration::from_secs(5),
                tls,
            )
            .unwrap(),
        )
        .await
        .unwrap()
    }
}
