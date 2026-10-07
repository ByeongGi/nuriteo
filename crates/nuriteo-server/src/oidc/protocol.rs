//! OIDC discovery and JWKS validation boundary.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::{CACHE_CONTROL, CONTENT_TYPE};
use reqwest::{Certificate, Client, StatusCode};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::net::lookup_host;
use tokio::sync::Mutex;
use tokio::time as tokio_time;
use url::Url;
use uuid::Uuid;

use super::{OidcProviderError, OidcProviderMetadata, OidcProviderService, OidcRuntimeProvider};
use crate::integration::{CaEndpointBinding, IntegrationAdminActor, ValidatedCaBundle};

const DISCOVERY_LIMIT: usize = 64 * 1024;
const JWKS_LIMIT: usize = 256 * 1024;
const MAX_JWKS_KEYS: usize = 128;
const MAX_CACHE_ENTRIES: usize = 64;
const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_CACHE_TTL: Duration = Duration::from_secs(3600);
const MIN_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DNS_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_DNS_ADDRESSES: usize = 16;

pub(super) struct RuntimeAccess(());

const RUNTIME_ACCESS: RuntimeAccess = RuntimeAccess(());

#[cfg(test)]
pub(super) const fn runtime_access_for_test() -> &'static RuntimeAccess {
    &RUNTIME_ACCESS
}

/// Opaque, DNS-pinned OIDC-003 handoff. Protocol consumers must add their
/// operations here so the secret and HTTP client cannot be separated.
#[allow(
    dead_code,
    reason = "OIDC-003 will consume the pinned protocol operations"
)]
pub(crate) struct OidcProtocolRuntime {
    provider: OidcRuntimeProvider,
    client: Client,
    authorization_endpoint: Url,
    token_endpoint: Url,
    jwks_uri: Url,
}

impl fmt::Debug for OidcProtocolRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcProtocolRuntime")
            .field("provider_id", &self.provider.metadata.id)
            .finish_non_exhaustive()
    }
}

impl OidcProtocolRuntime {
    #[cfg(test)]
    pub(super) fn secret_for_test(&self) -> &[u8] {
        self.provider.client_secret.expose()
    }
}

#[derive(Clone)]
pub struct OidcEndpointValidator {
    timeout: Duration,
    allow_test_addresses: bool,
    cache: Arc<Mutex<HashMap<CacheKey, CacheEntry>>>,
}

impl fmt::Debug for OidcEndpointValidator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcEndpointValidator")
            .field("timeout", &self.timeout)
            .field("cache_limit", &MAX_CACHE_ENTRIES)
            .finish()
    }
}

impl OidcEndpointValidator {
    pub fn new(timeout: Duration) -> Result<Self, OidcProviderError> {
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&timeout) {
            return Err(OidcProviderError::InvalidInput);
        }
        Ok(Self {
            timeout,
            allow_test_addresses: false,
            cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    #[cfg(test)]
    pub(crate) fn allowing_test_addresses(timeout: Duration) -> Result<Self, OidcProviderError> {
        let mut validator = Self::new(timeout)?;
        validator.allow_test_addresses = true;
        Ok(validator)
    }

    pub async fn validate_and_activate(
        &self,
        service: &OidcProviderService,
        actor: IntegrationAdminActor,
        provider_id: Uuid,
        expected_version: u64,
        redirect_uri: &str,
        correlation_id: &str,
    ) -> Result<OidcProviderMetadata, OidcProviderError> {
        let candidate = service
            .precheck_validation_actor(actor, provider_id, expected_version)
            .await?;
        let redirect = validate_redirect_uri(redirect_uri, self.allow_test_addresses)?;
        if candidate.issuer.ends_with('/') {
            return Err(OidcProviderError::InvalidInput);
        }
        let issuer = validate_endpoint(&candidate.issuer, self.allow_test_addresses)?;
        service
            .verify_candidate_secret(provider_id, expected_version, candidate.secret_version)
            .await?;

        let issuer_port = issuer
            .port_or_known_default()
            .ok_or(OidcProviderError::InvalidInput)?;
        let issuer_host = issuer.host_str().ok_or(OidcProviderError::InvalidInput)?;
        let issuer_addresses = resolve_checked(
            issuer_host,
            issuer_port,
            self.allow_test_addresses,
            self.timeout.min(MAX_DNS_TIMEOUT),
        )
        .await?;
        let binding = CaEndpointBinding::new(
            "oidc",
            provider_id.to_string(),
            issuer_host,
            issuer_port,
            "https",
        )
        .map_err(|_| OidcProviderError::Unavailable)?;
        let ca = service
            .integrations
            .active_ca_for_endpoint(&binding)
            .await
            .map_err(|_| OidcProviderError::ValidationFailed)?;

        let discovery_url = discovery_url(&issuer)?;
        let discovery_bytes = self
            .fetch(
                &discovery_url,
                ca.as_ref(),
                DISCOVERY_LIMIT,
                &issuer_addresses,
            )
            .await?
            .0;
        let document: DiscoveryDocument = serde_json::from_slice(&discovery_bytes)
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        if document.issuer != candidate.issuer {
            return Err(OidcProviderError::ValidationFailed);
        }
        let authorization =
            validate_endpoint(&document.authorization_endpoint, self.allow_test_addresses)?;
        let token = validate_endpoint(&document.token_endpoint, self.allow_test_addresses)?;
        let jwks = validate_endpoint(&document.jwks_uri, self.allow_test_addresses)?;
        for endpoint in [&authorization, &token, &jwks] {
            require_same_origin(&issuer, endpoint)?;
            let endpoint_addresses = resolve_checked(
                endpoint
                    .host_str()
                    .ok_or(OidcProviderError::ValidationFailed)?,
                endpoint
                    .port_or_known_default()
                    .ok_or(OidcProviderError::ValidationFailed)?,
                self.allow_test_addresses,
                self.timeout.min(MAX_DNS_TIMEOUT),
            )
            .await?;
            if !same_address_set(&endpoint_addresses, &issuer_addresses) {
                return Err(OidcProviderError::NetworkDenied);
            }
        }

        let jwks_fingerprint = self
            .jwks_fingerprint(
                provider_id,
                expected_version,
                &jwks,
                ca.as_ref(),
                &issuer_addresses,
            )
            .await?;
        let material = ValidationMaterial {
            authorization_endpoint: authorization.to_string(),
            token_endpoint: token.to_string(),
            jwks_uri: jwks.to_string(),
            redirect_uri: redirect.to_string(),
            jwks_fingerprint,
            ca_fingerprint: trust_fingerprint(ca.as_ref()),
        };
        let proof = OidcValidationProof {
            id: Uuid::now_v7(),
            config_version: expected_version,
            secret_version: candidate.secret_version,
            validation_fingerprint: validation_fingerprint(provider_id, &candidate, &material),
            authorization_endpoint: material.authorization_endpoint,
            token_endpoint: material.token_endpoint,
            jwks_uri: material.jwks_uri,
            redirect_uri: material.redirect_uri,
            jwks_fingerprint: material.jwks_fingerprint,
            ca_fingerprint: material.ca_fingerprint,
        };
        service
            .activate_validated(actor, provider_id, expected_version, &proof, correlation_id)
            .await
    }

    /// The sole OIDC-003 runtime handoff. It rechecks the stored endpoint and
    /// DNS pinning contract before releasing the generation-bound secret.
    #[allow(dead_code, reason = "consumed by OIDC-003")]
    pub(crate) async fn active_runtime(
        &self,
        service: &OidcProviderService,
        provider_id: Uuid,
    ) -> Result<OidcProtocolRuntime, OidcProviderError> {
        let runtime = service
            .active_provider(&RUNTIME_ACCESS, provider_id)
            .await?;
        let issuer = validate_endpoint(&runtime.metadata.issuer, self.allow_test_addresses)?;
        let host = issuer
            .host_str()
            .ok_or(OidcProviderError::ValidationFailed)?;
        let port = issuer
            .port_or_known_default()
            .ok_or(OidcProviderError::ValidationFailed)?;
        let pinned = resolve_checked(
            host,
            port,
            self.allow_test_addresses,
            self.timeout.min(MAX_DNS_TIMEOUT),
        )
        .await?;
        let mut endpoints = Vec::with_capacity(3);
        for value in [
            &runtime.authorization_endpoint,
            &runtime.token_endpoint,
            &runtime.jwks_uri,
        ] {
            let endpoint = validate_endpoint(value, self.allow_test_addresses)?;
            require_same_origin(&issuer, &endpoint)?;
            let addresses = resolve_checked(
                endpoint
                    .host_str()
                    .ok_or(OidcProviderError::ValidationFailed)?,
                endpoint
                    .port_or_known_default()
                    .ok_or(OidcProviderError::ValidationFailed)?,
                self.allow_test_addresses,
                self.timeout.min(MAX_DNS_TIMEOUT),
            )
            .await?;
            if !same_address_set(&addresses, &pinned) {
                return Err(OidcProviderError::NetworkDenied);
            }
            endpoints.push(endpoint);
        }
        validate_redirect_uri(&runtime.redirect_uri, self.allow_test_addresses)?;
        let mut builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(self.timeout)
            .timeout(self.timeout)
            .https_only(true)
            .resolve_to_addrs(host, &pinned);
        if let Some(bundle) = runtime.ca.as_ref() {
            let certificates = Certificate::from_pem_bundle(bundle.pem())
                .map_err(|_| OidcProviderError::ValidationFailed)?;
            builder = builder.tls_certs_only(certificates);
        }
        let client = builder
            .build()
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        let [authorization_endpoint, token_endpoint, jwks_uri]: [Url; 3] = endpoints
            .try_into()
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        Ok(OidcProtocolRuntime {
            provider: runtime,
            client,
            authorization_endpoint,
            token_endpoint,
            jwks_uri,
        })
    }

    async fn jwks_fingerprint(
        &self,
        provider_id: Uuid,
        config_version: u64,
        uri: &Url,
        ca: Option<&ValidatedCaBundle>,
        pinned_addresses: &[SocketAddr],
    ) -> Result<[u8; 32], OidcProviderError> {
        let key = CacheKey {
            provider_id,
            config_version,
            uri: uri.as_str().to_owned(),
            trust_fingerprint: trust_fingerprint(ca),
        };
        {
            let cache = self.cache.lock().await;
            if let Some(entry) = cache
                .get(&key)
                .filter(|entry| entry.expires_at > Instant::now())
            {
                return Ok(entry.fingerprint);
            }
        }
        let (bytes, ttl) = self.fetch(uri, ca, JWKS_LIMIT, pinned_addresses).await?;
        let document: JwksDocument =
            serde_json::from_slice(&bytes).map_err(|_| OidcProviderError::ValidationFailed)?;
        if document.keys.is_empty() || document.keys.len() > MAX_JWKS_KEYS {
            return Err(OidcProviderError::ValidationFailed);
        }
        let mut kids = HashSet::new();
        for key in &document.keys {
            if key.kty.is_empty() || key.kty.len() > 32 {
                return Err(OidcProviderError::ValidationFailed);
            }
            if let Some(kid) = &key.kid
                && (kid.is_empty() || kid.len() > 256 || !kids.insert(kid))
            {
                return Err(OidcProviderError::ValidationFailed);
            }
        }
        let fingerprint: [u8; 32] = Sha256::digest(&bytes).into();
        let mut cache = self.cache.lock().await;
        cache.retain(|_, entry| entry.expires_at > Instant::now());
        if cache.len() >= MAX_CACHE_ENTRIES
            && let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
        if !ttl.is_zero() {
            cache.insert(
                key,
                CacheEntry {
                    fingerprint,
                    expires_at: Instant::now() + ttl,
                },
            );
        }
        Ok(fingerprint)
    }

    #[cfg(test)]
    pub(super) async fn jwks_fingerprint_for_test(
        &self,
        provider_id: Uuid,
        config_version: u64,
        uri: &Url,
        ca: &ValidatedCaBundle,
    ) -> Result<[u8; 32], OidcProviderError> {
        let host = uri.host_str().ok_or(OidcProviderError::ValidationFailed)?;
        let port = uri
            .port_or_known_default()
            .ok_or(OidcProviderError::ValidationFailed)?;
        let addresses = resolve_checked(
            host,
            port,
            self.allow_test_addresses,
            self.timeout.min(MAX_DNS_TIMEOUT),
        )
        .await?;
        self.jwks_fingerprint(provider_id, config_version, uri, Some(ca), &addresses)
            .await
    }

    async fn fetch(
        &self,
        url: &Url,
        ca: Option<&ValidatedCaBundle>,
        limit: usize,
        addresses: &[SocketAddr],
    ) -> Result<(Vec<u8>, Duration), OidcProviderError> {
        let host = url.host_str().ok_or(OidcProviderError::ValidationFailed)?;
        let mut builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(self.timeout)
            .timeout(self.timeout)
            .https_only(true)
            .resolve_to_addrs(host, addresses);
        if let Some(bundle) = ca {
            let certificates = Certificate::from_pem_bundle(bundle.pem())
                .map_err(|_| OidcProviderError::ValidationFailed)?;
            builder = builder.tls_certs_only(certificates);
        }
        let client = builder
            .build()
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        if response.status() != StatusCode::OK
            || !response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.split(';').next() == Some("application/json"))
            || response
                .content_length()
                .is_some_and(|length| length > limit as u64)
        {
            return Err(OidcProviderError::ValidationFailed);
        }
        let ttl = cache_ttl(
            response
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
        );
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| OidcProviderError::ValidationFailed)?
        {
            if body
                .len()
                .checked_add(chunk.len())
                .is_none_or(|size| size > limit)
            {
                return Err(OidcProviderError::ValidationFailed);
            }
            body.extend_from_slice(&chunk);
        }
        Ok((body, ttl))
    }
}

#[derive(Debug, Clone)]
pub(super) struct OidcValidationProof {
    pub id: Uuid,
    pub config_version: u64,
    pub secret_version: u64,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    pub redirect_uri: String,
    pub validation_fingerprint: [u8; 32],
    pub jwks_fingerprint: [u8; 32],
    pub ca_fingerprint: [u8; 32],
}

#[derive(Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

#[derive(Deserialize)]
struct JwksDocument {
    keys: Vec<JwkShape>,
}

#[derive(Deserialize)]
struct JwkShape {
    kty: String,
    kid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    provider_id: Uuid,
    config_version: u64,
    uri: String,
    trust_fingerprint: [u8; 32],
}

struct CacheEntry {
    fingerprint: [u8; 32],
    expires_at: Instant,
}

struct ValidationMaterial {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    redirect_uri: String,
    jwks_fingerprint: [u8; 32],
    ca_fingerprint: [u8; 32],
}

fn validate_redirect_uri(value: &str, allow_test: bool) -> Result<Url, OidcProviderError> {
    let url = validate_endpoint(value, allow_test)?;
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(OidcProviderError::InvalidInput);
    }
    Ok(url)
}

fn validate_endpoint(value: &str, allow_test: bool) -> Result<Url, OidcProviderError> {
    if value.len() > 2048 || value.trim() != value {
        return Err(OidcProviderError::InvalidInput);
    }
    let url = Url::parse(value).map_err(|_| OidcProviderError::InvalidInput)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(OidcProviderError::InvalidInput);
    }
    if let Some(ip) = url.host().and_then(|host| match host {
        url::Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
        url::Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
        url::Host::Domain(_) => None,
    }) && !allow_test
        && !is_public_ip(ip)
    {
        return Err(OidcProviderError::NetworkDenied);
    }
    Ok(url)
}

fn discovery_url(issuer: &Url) -> Result<Url, OidcProviderError> {
    if issuer.query().is_some() || issuer.fragment().is_some() {
        return Err(OidcProviderError::InvalidInput);
    }
    Url::parse(&format!(
        "{}/.well-known/openid-configuration",
        issuer.as_str().trim_end_matches('/')
    ))
    .map_err(|_| OidcProviderError::InvalidInput)
}

async fn resolve_checked(
    host: &str,
    port: u16,
    allow_test: bool,
    deadline: Duration,
) -> Result<Vec<SocketAddr>, OidcProviderError> {
    let resolved = tokio_time::timeout(deadline, lookup_host((host, port)))
        .await
        .map_err(|_| OidcProviderError::ValidationFailed)?
        .map_err(|_| OidcProviderError::ValidationFailed)?
        .take(MAX_DNS_ADDRESSES + 1);
    let mut addresses: Vec<_> = resolved.collect();
    validate_resolved_addresses(&addresses, allow_test)?;
    addresses.sort_unstable();
    addresses.dedup();
    Ok(addresses)
}

fn validate_resolved_addresses(
    addresses: &[SocketAddr],
    allow_test: bool,
) -> Result<(), OidcProviderError> {
    if addresses.is_empty() || addresses.len() > MAX_DNS_ADDRESSES {
        return Err(OidcProviderError::NetworkDenied);
    }
    if !allow_test && addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(OidcProviderError::NetworkDenied);
    }
    Ok(())
}

fn same_address_set(left: &[SocketAddr], right: &[SocketAddr]) -> bool {
    left == right
}

fn require_same_origin(issuer: &Url, endpoint: &Url) -> Result<(), OidcProviderError> {
    if issuer.scheme() != endpoint.scheme()
        || issuer.host_str().map(str::to_ascii_lowercase)
            != endpoint.host_str().map(str::to_ascii_lowercase)
        || issuer.port_or_known_default() != endpoint.port_or_known_default()
    {
        return Err(OidcProviderError::NetworkDenied);
    }
    Ok(())
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
            let octets = ip.octets();
            if octets[..12] == [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0] {
                return is_public_ip(IpAddr::V4(std::net::Ipv4Addr::new(
                    octets[12], octets[13], octets[14], octets[15],
                )));
            }
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 1)
                || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0])
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020)
                || segments[0] == 0x2002)
        }
    }
}

pub(super) fn trust_fingerprint(ca: Option<&ValidatedCaBundle>) -> [u8; 32] {
    match ca {
        Some(bundle) => Sha256::digest(bundle.pem()).into(),
        None => Sha256::digest(b"nuriteo.oidc.system-roots.v1").into(),
    }
}

fn cache_ttl(value: Option<&str>) -> Duration {
    let Some(value) = value else {
        return DEFAULT_CACHE_TTL;
    };
    for directive in value.split(',').map(str::trim) {
        if directive.eq_ignore_ascii_case("no-store") {
            return Duration::ZERO;
        }
        if let Some(seconds) = directive
            .strip_prefix("max-age=")
            .and_then(|value| value.parse::<u64>().ok())
        {
            return Duration::from_secs(seconds).min(MAX_CACHE_TTL);
        }
    }
    DEFAULT_CACHE_TTL
}

fn validation_fingerprint(
    provider_id: Uuid,
    candidate: &OidcProviderMetadata,
    material: &ValidationMaterial,
) -> [u8; 32] {
    let config = candidate.config_version.to_be_bytes();
    let secret = candidate.secret_version.to_be_bytes();
    let fields = [
        b"nuriteo.oidc-validation.v1".as_slice(),
        provider_id.as_bytes(),
        config.as_slice(),
        secret.as_slice(),
        candidate.issuer.as_bytes(),
        candidate.client_id.as_bytes(),
        material.authorization_endpoint.as_bytes(),
        material.token_endpoint.as_bytes(),
        material.jwks_uri.as_bytes(),
        material.redirect_uri.as_bytes(),
        &material.jwks_fingerprint,
        &material.ca_fingerprint,
    ];
    let mut canonical = Vec::new();
    for field in fields {
        canonical.extend_from_slice(&(field.len() as u32).to_be_bytes());
        canonical.extend_from_slice(field);
    }
    Sha256::digest(canonical).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_non_public_networks_and_ambiguous_redirects() {
        assert_eq!(
            validate_endpoint("https://127.0.0.1/issuer", false).unwrap_err(),
            OidcProviderError::NetworkDenied
        );
        assert_eq!(
            validate_endpoint("https://169.254.169.254/latest/meta-data", false).unwrap_err(),
            OidcProviderError::NetworkDenied
        );
        assert!(validate_redirect_uri("https://app.example.test/callback?next=x", false).is_err());
        assert!(validate_redirect_uri("https://app.example.test/callback", false).is_ok());
        assert!(!is_public_ip("64:ff9b::7f00:1".parse().unwrap()));
        assert!(!is_public_ip("64:ff9b:1::1".parse().unwrap()));
        assert!(!is_public_ip("2002:7f00:1::".parse().unwrap()));
        assert!(!is_public_ip("100::1".parse().unwrap()));
        assert!(!is_public_ip("168.63.129.16".parse().unwrap()));
    }

    #[test]
    fn same_origin_and_rebinding_contract_is_exact() {
        let issuer = Url::parse("https://id.example.test:8443/issuer").unwrap();
        assert!(
            require_same_origin(
                &issuer,
                &Url::parse("https://id.example.test:8443/jwks").unwrap()
            )
            .is_ok()
        );
        assert!(
            require_same_origin(
                &issuer,
                &Url::parse("https://keys.example.test:8443/jwks").unwrap()
            )
            .is_err()
        );
        let public: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let private: SocketAddr = "169.254.169.254:443".parse().unwrap();
        assert_eq!(
            validate_resolved_addresses(&[public, private], false).unwrap_err(),
            OidcProviderError::NetworkDenied
        );
        assert!(!same_address_set(&[public], &[private]));
        assert_eq!(
            validate_resolved_addresses(&vec![public; MAX_DNS_ADDRESSES + 1], false).unwrap_err(),
            OidcProviderError::NetworkDenied
        );
    }

    #[test]
    fn bounds_cache_control() {
        assert_eq!(cache_ttl(Some("no-store")), Duration::ZERO);
        assert_eq!(cache_ttl(Some("max-age=99999")), MAX_CACHE_TTL);
        assert_eq!(
            cache_ttl(Some("public, max-age=12")),
            Duration::from_secs(12)
        );
    }
}
