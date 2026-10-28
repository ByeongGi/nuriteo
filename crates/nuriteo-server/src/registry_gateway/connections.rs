#![allow(unused_imports)]
use super::endpoint::*;
use super::*;

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

pub(crate) use http_routes::openapi_router;

pub use http_service::RegistryHttpService;

use super::{
    BoundedResponse, CREDENTIAL_KIND, DEFAULT_TIMEOUT, DNS_TIMEOUT, INSTANCE_ID, INTEGRATION_TYPE,
    MAX_DNS_ADDRESSES, METADATA_LIMIT, PACKAGE_SEGMENT, PREFLIGHT_LIMIT, RegistryConnectionInput,
    RegistryConnectionMetadata, RegistryError, RegistryGatewayService, RegistryPayload,
    RegistryRuntime, RegistryState, map_integration_error,
};
pub(crate) use http_service::{RegistryAdminView, RegistryCollectionView};

impl super::RegistryState {
    pub(crate) fn parse(value: &str) -> Result<Self, RegistryError> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            _ => Err(RegistryError::Unavailable),
        }
    }
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
    pub(crate) fn allowing_test_addresses(mut self) -> Self {
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

    pub(crate) async fn runtime_candidate(
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

    pub(crate) async fn runtime_for_package(
        &self,
        package: &str,
    ) -> Result<RegistryRuntime, RegistryError> {
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

    pub(crate) async fn preflight(
        &self,
        runtime: &RegistryRuntime,
    ) -> Result<[u8; 32], RegistryError> {
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

    pub(crate) async fn send(
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

    pub(crate) async fn acquire(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<Postgres>, RegistryError> {
        self.integrations
            .pool()
            .acquire()
            .await
            .map_err(|_| RegistryError::Unavailable)
    }
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

pub(crate) async fn load_runtime(
    integrations: &IntegrationRepository,
    tx: &mut Transaction<'_, Postgres>,
    metadata: RegistryConnectionMetadata,
) -> Result<RegistryRuntime, RegistryError> {
    load_runtime_with_ca(integrations, tx, metadata, None).await
}
