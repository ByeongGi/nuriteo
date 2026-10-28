#![allow(unused_imports)]
use super::connections::*;
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

pub(crate) async fn load_runtime_with_ca(
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

pub(crate) fn validate_base_url(value: &str) -> Result<Url, RegistryError> {
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

pub(crate) fn canonical_base_path(value: &str) -> Result<String, RegistryError> {
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

pub(crate) fn normalized_base_url(url: &Url, path: &str) -> String {
    let mut value = url.clone();
    value.set_path(path);
    value.to_string().trim_end_matches('/').to_owned()
}

pub(crate) fn validate_package(value: &str) -> Result<(), RegistryError> {
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

pub(crate) fn validate_scope(value: &str) -> Result<(), RegistryError> {
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

pub(crate) fn valid_package_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value == value.to_ascii_lowercase()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

pub(crate) fn metadata_url(
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

pub(crate) fn same_origin_and_path(connection: &RegistryConnectionMetadata, url: &Url) -> bool {
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

pub(crate) async fn resolve_checked(
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

pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
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

pub(crate) fn credential_identity(id: Uuid) -> Result<CredentialIdentity, RegistryError> {
    CredentialIdentity::new(
        INSTANCE_ID,
        INTEGRATION_TYPE,
        id.to_string(),
        CREDENTIAL_KIND,
    )
    .map_err(map_integration_error)
}

pub(crate) fn trust_fingerprint(ca: Option<&ValidatedCaBundle>) -> [u8; 32] {
    match ca {
        Some(ca) => Sha256::digest(ca.pem()).into(),
        None => Sha256::digest(b"nuriteo.registry.system-roots.v1").into(),
    }
}

pub(crate) async fn active_ca_fingerprint(
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

pub(crate) async fn load_for_update(
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

pub(crate) async fn load_metadata(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<RegistryConnectionMetadata, RegistryError> {
    let row=sqlx::query("SELECT id::text,display_name,base_url,canonical_host,canonical_port,base_path,status,is_default,config_version,credential_version,validated_at FROM registry_connections WHERE id=$1::uuid")
        .bind(id.to_string()).fetch_optional(&mut **tx).await.map_err(|_|RegistryError::Unavailable)?.ok_or(RegistryError::NotFound)?;
    metadata_from_row(&row)
}

pub(crate) fn metadata_from_row(
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

pub(crate) async fn append_audit(
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

pub(crate) fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

pub(crate) fn validate_correlation(value: &str) -> Result<(), RegistryError> {
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

pub(crate) fn map_database_error(error: sqlx::Error) -> RegistryError {
    match error.as_database_error().and_then(|e| e.code()).as_deref() {
        Some("23505") => RegistryError::Conflict,
        Some("23514" | "P0001") => RegistryError::ValidationFailed,
        _ => RegistryError::Unavailable,
    }
}

impl RegistryError {
    pub(crate) const fn with_connection(self, id: Uuid) -> Self {
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
