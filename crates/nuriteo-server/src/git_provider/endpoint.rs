#![allow(unused_imports)]
use super::providers::*;
use super::*;

use std::collections::BTreeMap;

use std::fmt;

use std::net::{IpAddr, SocketAddr};

use std::str::FromStr;

use std::time::Duration;

use ::time::OffsetDateTime;

use reqwest::{Certificate, Client};

use sha2::{Digest, Sha256};

use sqlx::{Acquire, Postgres, Row, Transaction};

use tokio::net::lookup_host;

use tokio::time;

use url::Url;

use uuid::Uuid;

use super::{
    DEFAULT_TIMEOUT, DNS_TIMEOUT, GitPreflightProof, GitProviderError, GitProviderInput,
    GitProviderKind, GitProviderMetadata, GitProviderService, GitProviderState, GitProviderUpdate,
    GitProviderValidator, INTEGRATION_TYPE, MAX_DNS_ADDRESSES, MAX_TIMEOUT, MIN_TIMEOUT,
    RESPONSE_LIMIT, map_integration_error,
};
use crate::integration::{
    CaEndpointBinding, IntegrationAdminActor, IntegrationError, IntegrationRepository,
    ValidatedCaBundle, authorize_recent_admin,
};

pub(crate) fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value == value.trim()
        && value == value.to_ascii_lowercase()
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        && !value.contains(['/', ':', '@', '?', '#'])
        && Url::parse(&format!("https://{value}/"))
            .ok()
            .and_then(|url| url.host_str().map(ToOwned::to_owned))
            .is_some_and(|host| host == value)
}

pub(crate) fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

pub(crate) async fn resolve_checked(
    host: &str,
    port: u16,
    allow_test: bool,
    deadline: Duration,
) -> Result<Vec<SocketAddr>, GitProviderError> {
    let resolved = time::timeout(deadline, lookup_host((host, port)))
        .await
        .map_err(|_| GitProviderError::ValidationFailed)?
        .map_err(|_| GitProviderError::ValidationFailed)?
        .take(MAX_DNS_ADDRESSES + 1);
    let mut addresses: Vec<_> = resolved.collect();
    if addresses.is_empty()
        || addresses.len() > MAX_DNS_ADDRESSES
        || (!allow_test && addresses.iter().any(|address| !is_public_ip(address.ip())))
    {
        return Err(GitProviderError::NetworkDenied);
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
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || segments[0] == 0x2002)
        }
    }
}

pub(crate) fn endpoint_fingerprint(
    candidate: &GitProviderMetadata,
    addresses: &BTreeMap<String, Vec<SocketAddr>>,
) -> [u8; 32] {
    let mut digest = Sha256::new();
    for field in [
        "nuriteo.git-provider-preflight.v1",
        candidate.id.to_string().as_str(),
        candidate.kind.as_str(),
        &candidate.canonical_host,
        &candidate.canonical_port.to_string(),
        &candidate.api_base_url,
        candidate.oauth_authorization_url.as_deref().unwrap_or(""),
        candidate.oauth_token_url.as_deref().unwrap_or(""),
    ] {
        digest.update((field.len() as u32).to_be_bytes());
        digest.update(field.as_bytes());
    }
    for (origin, values) in addresses {
        digest.update((origin.len() as u32).to_be_bytes());
        digest.update(origin.as_bytes());
        for value in values {
            let value = value.to_string();
            digest.update((value.len() as u32).to_be_bytes());
            digest.update(value.as_bytes());
        }
    }
    digest.finalize().into()
}

pub(crate) fn trust_fingerprint(ca: Option<&ValidatedCaBundle>) -> [u8; 32] {
    match ca {
        Some(bundle) => Sha256::digest(bundle.pem()).into(),
        None => Sha256::digest(b"nuriteo.git-provider.system-roots.v1").into(),
    }
}

pub(crate) fn endpoint_binding(
    provider: &GitProviderMetadata,
) -> Result<CaEndpointBinding, GitProviderError> {
    CaEndpointBinding::new(
        INTEGRATION_TYPE,
        provider.id.to_string(),
        provider.canonical_host.clone(),
        provider.canonical_port,
        "https",
    )
    .map_err(map_integration_error)
}

pub(crate) async fn active_ca_fingerprint(
    tx: &mut Transaction<'_, Postgres>,
    binding: &CaEndpointBinding,
) -> Result<[u8; 32], GitProviderError> {
    let rows: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT pem FROM integration_ca_bundles WHERE integration_type=$1 AND integration_id=$2
         AND state='active' AND endpoint_fingerprint=$3",
    )
    .bind(binding.integration_type())
    .bind(binding.integration_id())
    .bind(binding.fingerprint().to_vec())
    .fetch_all(&mut **tx)
    .await
    .map_err(|_| GitProviderError::Unavailable)?;
    match rows.as_slice() {
        [] => Ok(trust_fingerprint(None)),
        [pem] => Ok(Sha256::digest(pem).into()),
        _ => Err(GitProviderError::Conflict),
    }
}

pub(crate) async fn load_metadata_for_update(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    expected_version: u64,
) -> Result<GitProviderMetadata, GitProviderError> {
    let row = sqlx::query(
        "SELECT id::text,display_name,provider_kind,canonical_host,canonical_port,
         api_base_url,oauth_authorization_url,oauth_token_url,oauth_client_id,status,
         allows_read,allows_write,config_version,validated_at,created_at,updated_at
         FROM git_providers WHERE id=$1::uuid FOR UPDATE",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitProviderError::Unavailable)?
    .ok_or(GitProviderError::NotFound)?;
    let metadata = metadata_from_row(&row)?;
    if metadata.config_version != expected_version {
        return Err(GitProviderError::Conflict);
    }
    Ok(metadata)
}

pub(crate) async fn load_metadata(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<GitProviderMetadata, GitProviderError> {
    let row = sqlx::query(
        "SELECT id::text,display_name,provider_kind,canonical_host,canonical_port,
         api_base_url,oauth_authorization_url,oauth_token_url,oauth_client_id,status,
         allows_read,allows_write,config_version,validated_at,created_at,updated_at
         FROM git_providers WHERE id=$1::uuid",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| GitProviderError::Unavailable)?
    .ok_or(GitProviderError::NotFound)?;
    metadata_from_row(&row)
}

pub(crate) fn metadata_from_database_row(
    row: &sqlx::postgres::PgRow,
) -> Result<GitProviderMetadata, GitProviderError> {
    Ok(GitProviderMetadata {
        id: Uuid::from_str(row.get::<String, _>("id").as_str())
            .map_err(|_| GitProviderError::Unavailable)?,
        display_name: row.get("display_name"),
        kind: GitProviderKind::parse(row.get("provider_kind"))?,
        canonical_host: row.get("canonical_host"),
        canonical_port: u16::try_from(row.get::<i32, _>("canonical_port"))
            .map_err(|_| GitProviderError::Unavailable)?,
        api_base_url: row.get("api_base_url"),
        oauth_authorization_url: row.get("oauth_authorization_url"),
        oauth_token_url: row.get("oauth_token_url"),
        oauth_client_id: row.get("oauth_client_id"),
        state: GitProviderState::parse(row.get("status"))?,
        allows_read: row.get("allows_read"),
        allows_write: row.get("allows_write"),
        config_version: u64::try_from(row.get::<i64, _>("config_version"))
            .map_err(|_| GitProviderError::Unavailable)?,
        validated_at: row.get("validated_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

pub(crate) fn metadata_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<GitProviderMetadata, GitProviderError> {
    metadata_from_database_row(row)
}

pub(crate) async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: IntegrationAdminActor,
    action: &str,
    id: Uuid,
    version: u64,
    correlation_id: &str,
) -> Result<(), GitProviderError> {
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,target_id,
         scope_type,scope_id,result,correlation_id,changed_fields,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,$3,'git_provider',$4,'instance','instance','succeeded',$5,$6,$7::jsonb)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(actor.user_id.to_string())
    .bind(action)
    .bind(id.to_string())
    .bind(correlation_id)
    .bind(vec!["provider_config".to_owned()])
    .bind(serde_json::json!({"configVersion": version}).to_string())
    .execute(&mut **tx)
    .await
    .map_err(|_| GitProviderError::Unavailable)?;
    Ok(())
}

pub(crate) fn validate_correlation(value: &str) -> Result<(), GitProviderError> {
    if (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(GitProviderError::InvalidInput)
    }
}

pub(crate) fn map_database_error(error: sqlx::Error) -> GitProviderError {
    match error
        .as_database_error()
        .and_then(|database| database.code())
        .as_deref()
    {
        Some("23505") => GitProviderError::HostAlreadyRegistered,
        Some("23514" | "P0001") => GitProviderError::ValidationFailed,
        _ => GitProviderError::Unavailable,
    }
}

impl fmt::Display for GitProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Git provider input is invalid",
            Self::ReauthenticationRequired => "recent administrator authentication is required",
            Self::NotFound => "Git provider was not found",
            Self::MustDisable => "Git provider must be disabled first",
            Self::HostAlreadyRegistered => "Git provider host is already registered",
            Self::Conflict => "Git provider changed concurrently",
            Self::NetworkDenied => "Git provider network destination is denied",
            Self::ValidationFailed => "Git provider validation failed",
            Self::Unavailable => "Git provider service is unavailable",
        })
    }
}

impl std::error::Error for GitProviderError {}
