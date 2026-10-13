//! OIDC discovery and JWKS validation boundary.
#![allow(dead_code, reason = "crate-private OIDC protocol adapter handoff")]

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use reqwest::header::{CACHE_CONTROL, CONTENT_TYPE};
use reqwest::{Certificate, Client, StatusCode};
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::net::lookup_host;
use tokio::sync::Mutex;
use tokio::time as tokio_time;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

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
const TOKEN_RESPONSE_LIMIT: usize = 64 * 1024;
const JWT_LIMIT: usize = 16 * 1024;
const MAX_TOKEN_AGE_SECONDS: i64 = 10 * 60;
const CLOCK_SKEW_SECONDS: i64 = 60;

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

    pub(super) fn authorization_request(
        &self,
        state: &str,
        nonce: &str,
        code_challenge: &str,
    ) -> Result<AuthorizationRuntime, OidcProviderError> {
        if !bounded_protocol_value(state, 128)
            || !bounded_protocol_value(nonce, 128)
            || !bounded_protocol_value(code_challenge, 128)
        {
            return Err(OidcProviderError::InvalidInput);
        }
        let mut url = self.authorization_endpoint.clone();
        const RESERVED: &[&str] = &[
            "response_type",
            "scope",
            "client_id",
            "redirect_uri",
            "state",
            "nonce",
            "code_challenge",
            "code_challenge_method",
        ];
        if url
            .query_pairs()
            .any(|(key, _)| RESERVED.contains(&key.as_ref()))
        {
            return Err(OidcProviderError::ValidationFailed);
        }
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("scope", "openid")
            .append_pair("client_id", &self.provider.metadata.client_id)
            .append_pair("redirect_uri", &self.provider.redirect_uri)
            .append_pair("state", state)
            .append_pair("nonce", nonce)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(AuthorizationRuntime {
            url: url.to_string(),
            provider_id: self.provider.metadata.id,
            config_version: self.provider.metadata.config_version,
            secret_version: self.provider.metadata.secret_version,
            redirect_uri: self.provider.redirect_uri.clone(),
        })
    }

    pub(super) async fn exchange_and_validate(
        &self,
        code: &str,
        verifier: &[u8],
        expected_nonce_hash: &[u8; 32],
        now: ::time::OffsetDateTime,
    ) -> Result<VerifiedIdToken, OidcProviderError> {
        if !bounded_protocol_value(code, 4096)
            || !(43..=128).contains(&verifier.len())
            || !verifier.iter().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
            })
        {
            return Err(OidcProviderError::ValidationFailed);
        }
        let code = Zeroizing::new(code.to_owned());
        let verifier = Zeroizing::new(
            std::str::from_utf8(verifier)
                .map_err(|_| OidcProviderError::ValidationFailed)?
                .to_owned(),
        );
        let body = Zeroizing::new({
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            form.append_pair("grant_type", "authorization_code")
                .append_pair("code", &code)
                .append_pair("redirect_uri", &self.provider.redirect_uri)
                .append_pair("client_id", &self.provider.metadata.client_id)
                .append_pair(
                    "client_secret",
                    std::str::from_utf8(self.provider.client_secret.expose())
                        .map_err(|_| OidcProviderError::CredentialUnavailable)?,
                )
                .append_pair("code_verifier", &verifier);
            form.finish().into_bytes()
        });
        let request_body = Bytes::from_owner(ZeroizingRequestBody(body));
        let response = self
            .client
            .post(self.token_endpoint.clone())
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(request_body)
            .send()
            .await
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        let token_bytes =
            Zeroizing::new(bounded_json_response(response, TOKEN_RESPONSE_LIMIT).await?);
        let token: TokenResponse = serde_json::from_slice(&token_bytes)
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        let id_token = Zeroizing::new(token.id_token);
        let jwks_response = self
            .client
            .get(self.jwks_uri.clone())
            .send()
            .await
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        let jwks_bytes = Zeroizing::new(bounded_json_response(jwks_response, JWKS_LIMIT).await?);
        let jwks: VerificationJwks =
            serde_json::from_slice(&jwks_bytes).map_err(|_| OidcProviderError::ValidationFailed)?;
        validate_verification_jwks(&jwks)?;
        verify_id_token(
            &id_token,
            &jwks,
            &self.provider.metadata.issuer,
            &self.provider.metadata.client_id,
            expected_nonce_hash,
            now,
        )
    }
}

struct ZeroizingRequestBody(Zeroizing<Vec<u8>>);

impl AsRef<[u8]> for ZeroizingRequestBody {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}

pub(super) struct AuthorizationRuntime {
    pub url: String,
    pub provider_id: Uuid,
    pub config_version: u64,
    pub secret_version: u64,
    pub redirect_uri: String,
}

pub(super) struct VerifiedIdToken {
    pub issuer: String,
    pub subject: String,
    pub verified_email: Option<String>,
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

    /// Validates OIDC discovery and JWKS with a staged CA candidate without
    /// changing Provider state. The canonical endpoint is always derived from
    /// persisted issuer metadata; callers cannot substitute a host or port.
    pub(crate) async fn preflight_ca_candidate(
        &self,
        service: &OidcProviderService,
        provider_id: Uuid,
        candidate_ca: &ValidatedCaBundle,
        endpoint: &CaEndpointBinding,
    ) -> Result<(), OidcProviderError> {
        let candidate = service
            .list_providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == provider_id)
            .ok_or(OidcProviderError::NotFound)?;
        let issuer = validate_endpoint(&candidate.issuer, self.allow_test_addresses)?;
        let host = issuer.host_str().ok_or(OidcProviderError::InvalidInput)?;
        let port = issuer
            .port_or_known_default()
            .ok_or(OidcProviderError::InvalidInput)?;
        let canonical =
            CaEndpointBinding::new("oidc", provider_id.to_string(), host, port, "https")
                .map_err(|_| OidcProviderError::InvalidInput)?;
        if canonical.fingerprint() != endpoint.fingerprint() {
            return Err(OidcProviderError::ValidationFailed);
        }
        let pinned = resolve_checked(
            host,
            port,
            self.allow_test_addresses,
            self.timeout.min(MAX_DNS_TIMEOUT),
        )
        .await?;
        let discovery = discovery_url(&issuer)?;
        let discovery_bytes = self
            .fetch(&discovery, Some(candidate_ca), DISCOVERY_LIMIT, &pinned)
            .await?
            .0;
        let document: DiscoveryDocument = serde_json::from_slice(&discovery_bytes)
            .map_err(|_| OidcProviderError::ValidationFailed)?;
        if document.issuer != candidate.issuer {
            return Err(OidcProviderError::ValidationFailed);
        }
        for value in [
            &document.authorization_endpoint,
            &document.token_endpoint,
            &document.jwks_uri,
        ] {
            let parsed = validate_endpoint(value, self.allow_test_addresses)?;
            require_same_origin(&issuer, &parsed)?;
        }
        let jwks = validate_endpoint(&document.jwks_uri, self.allow_test_addresses)?;
        self.jwks_fingerprint(
            provider_id,
            candidate.config_version,
            &jwks,
            Some(candidate_ca),
            &pinned,
        )
        .await?;
        let observed = resolve_checked(
            host,
            port,
            self.allow_test_addresses,
            self.timeout.min(MAX_DNS_TIMEOUT),
        )
        .await?;
        if !same_address_set(&observed, &pinned) {
            return Err(OidcProviderError::NetworkDenied);
        }
        Ok(())
    }

    /// The sole OIDC-003 runtime handoff. It rechecks the stored endpoint and
    /// DNS pinning contract before releasing the generation-bound secret.
    #[allow(dead_code, reason = "consumed by OIDC-003")]
    pub(crate) async fn active_runtime(
        &self,
        service: &OidcProviderService,
        provider_id: Uuid,
    ) -> Result<OidcProtocolRuntime, OidcProviderError> {
        self.active_runtime_inner(service, provider_id, None).await
    }

    pub(crate) async fn active_runtime_for_generation(
        &self,
        service: &OidcProviderService,
        provider_id: Uuid,
        expected_config_version: u64,
        expected_secret_version: u64,
    ) -> Result<OidcProtocolRuntime, OidcProviderError> {
        self.active_runtime_inner(
            service,
            provider_id,
            Some((expected_config_version, expected_secret_version)),
        )
        .await
    }

    async fn active_runtime_inner(
        &self,
        service: &OidcProviderService,
        provider_id: Uuid,
        expected_generation: Option<(u64, u64)>,
    ) -> Result<OidcProtocolRuntime, OidcProviderError> {
        let runtime = service
            .active_provider(&RUNTIME_ACCESS, provider_id)
            .await?;
        if expected_generation.is_some_and(|expected| {
            expected
                != (
                    runtime.metadata.config_version,
                    runtime.metadata.secret_version,
                )
        }) {
            return Err(OidcProviderError::Conflict);
        }
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

#[derive(Deserialize)]
struct TokenResponse {
    id_token: String,
}

#[derive(Deserialize)]
struct VerificationJwks {
    keys: Vec<VerificationJwk>,
}

#[derive(Deserialize)]
struct VerificationJwk {
    kty: String,
    kid: String,
    #[serde(rename = "use")]
    usage: Option<String>,
    alg: Option<String>,
    n: String,
    e: String,
}

fn validate_verification_jwks(jwks: &VerificationJwks) -> Result<(), OidcProviderError> {
    if jwks.keys.is_empty() || jwks.keys.len() > MAX_JWKS_KEYS {
        return Err(OidcProviderError::ValidationFailed);
    }
    let mut kids = HashSet::new();
    for key in &jwks.keys {
        if !bounded_protocol_value(&key.kty, 32)
            || !bounded_protocol_value(&key.kid, 256)
            || !kids.insert(key.kid.as_str())
            || key
                .usage
                .as_deref()
                .is_some_and(|value| !bounded_protocol_value(value, 32))
            || key
                .alg
                .as_deref()
                .is_some_and(|value| !bounded_protocol_value(value, 32))
            || !bounded_protocol_value(&key.n, 1_400)
            || !bounded_protocol_value(&key.e, 16)
        {
            return Err(OidcProviderError::ValidationFailed);
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct JwtHeader {
    alg: String,
    kid: String,
}

#[derive(Deserialize)]
struct IdTokenClaims {
    iss: String,
    sub: String,
    aud: Audience,
    azp: Option<String>,
    nonce: String,
    iat: i64,
    exp: i64,
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
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

fn bounded_protocol_value(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

async fn bounded_json_response(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, OidcProviderError> {
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
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| OidcProviderError::ValidationFailed)?
    {
        if body
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > limit)
        {
            return Err(OidcProviderError::ValidationFailed);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn verify_id_token(
    compact: &str,
    jwks: &VerificationJwks,
    expected_issuer: &str,
    expected_client_id: &str,
    expected_nonce_hash: &[u8; 32],
    now: ::time::OffsetDateTime,
) -> Result<VerifiedIdToken, OidcProviderError> {
    if compact.len() > JWT_LIMIT {
        return Err(OidcProviderError::ValidationFailed);
    }
    let parts = compact.split('.').collect::<Vec<_>>();
    let [encoded_header, encoded_claims, encoded_signature] = parts.as_slice() else {
        return Err(OidcProviderError::ValidationFailed);
    };
    let header_bytes = URL_SAFE_NO_PAD
        .decode(encoded_header)
        .map_err(|_| OidcProviderError::ValidationFailed)?;
    let header: JwtHeader =
        serde_json::from_slice(&header_bytes).map_err(|_| OidcProviderError::ValidationFailed)?;
    if header.alg != "RS256" || !bounded_protocol_value(&header.kid, 256) {
        return Err(OidcProviderError::ValidationFailed);
    }
    let matching = jwks
        .keys
        .iter()
        .filter(|key| {
            key.kid == header.kid
                && key.kty == "RSA"
                && key.usage.as_deref().is_none_or(|value| value == "sig")
                && key.alg.as_deref().is_none_or(|value| value == "RS256")
        })
        .collect::<Vec<_>>();
    let [key] = matching.as_slice() else {
        return Err(OidcProviderError::ValidationFailed);
    };
    let modulus = URL_SAFE_NO_PAD
        .decode(&key.n)
        .map_err(|_| OidcProviderError::ValidationFailed)?;
    let exponent = URL_SAFE_NO_PAD
        .decode(&key.e)
        .map_err(|_| OidcProviderError::ValidationFailed)?;
    let signature = URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .map_err(|_| OidcProviderError::ValidationFailed)?;
    if !(256..=1024).contains(&modulus.len()) || !(1..=8).contains(&exponent.len()) {
        return Err(OidcProviderError::ValidationFailed);
    }
    let signed = format!("{encoded_header}.{encoded_claims}");
    RsaPublicKeyComponents {
        n: &modulus,
        e: &exponent,
    }
    .verify(&RSA_PKCS1_2048_8192_SHA256, signed.as_bytes(), &signature)
    .map_err(|_| OidcProviderError::ValidationFailed)?;

    let claims_bytes = URL_SAFE_NO_PAD
        .decode(encoded_claims)
        .map_err(|_| OidcProviderError::ValidationFailed)?;
    let claims: IdTokenClaims =
        serde_json::from_slice(&claims_bytes).map_err(|_| OidcProviderError::ValidationFailed)?;
    if claims.iss != expected_issuer || !bounded_protocol_value(&claims.sub, 1024) {
        return Err(OidcProviderError::ValidationFailed);
    }
    let (audience_matches, multiple_audiences) = match &claims.aud {
        Audience::One(value) => (value == expected_client_id, false),
        Audience::Many(values) => (
            !values.is_empty()
                && values.len() <= 16
                && values.iter().any(|value| value == expected_client_id),
            values.len() > 1,
        ),
    };
    if !audience_matches
        || claims
            .azp
            .as_deref()
            .is_some_and(|value| value != expected_client_id)
        || (multiple_audiences && claims.azp.as_deref() != Some(expected_client_id))
    {
        return Err(OidcProviderError::ValidationFailed);
    }
    let nonce_hash: [u8; 32] = Sha256::digest(claims.nonce.as_bytes()).into();
    if !bool::from(nonce_hash.ct_eq(expected_nonce_hash)) {
        return Err(OidcProviderError::ValidationFailed);
    }
    let now = now.unix_timestamp();
    let latest_iat = now
        .checked_add(CLOCK_SKEW_SECONDS)
        .ok_or(OidcProviderError::ValidationFailed)?;
    let earliest_iat = now
        .checked_sub(MAX_TOKEN_AGE_SECONDS)
        .ok_or(OidcProviderError::ValidationFailed)?;
    let earliest_exp = now
        .checked_sub(CLOCK_SKEW_SECONDS)
        .ok_or(OidcProviderError::ValidationFailed)?;
    let latest_exp = claims
        .iat
        .checked_add(MAX_TOKEN_AGE_SECONDS)
        .ok_or(OidcProviderError::ValidationFailed)?;
    if claims.iat > latest_iat
        || claims.iat < earliest_iat
        || claims.exp < earliest_exp
        || claims.exp <= claims.iat
        || claims.exp > latest_exp
    {
        return Err(OidcProviderError::ValidationFailed);
    }
    let verified_email = match (claims.email, claims.email_verified) {
        (Some(email), true) if valid_verified_email(&email) => Some(email),
        (None, false) | (Some(_), false) => None,
        _ => return Err(OidcProviderError::ValidationFailed),
    };
    Ok(VerifiedIdToken {
        issuer: claims.iss,
        subject: claims.sub,
        verified_email,
    })
}

fn valid_verified_email(value: &str) -> bool {
    value == value.trim()
        && (3..=320).contains(&value.len())
        && value.contains('@')
        && !value.chars().any(char::is_control)
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
    fn runtime_jwks_requires_bounded_unique_key_shapes() {
        assert_eq!(
            validate_verification_jwks(&VerificationJwks { keys: vec![] }).unwrap_err(),
            OidcProviderError::ValidationFailed
        );
        let key = || VerificationJwk {
            kty: "RSA".into(),
            kid: "fixture".into(),
            usage: Some("sig".into()),
            alg: Some("RS256".into()),
            n: "bounded-modulus".into(),
            e: "AQAB".into(),
        };
        let mut duplicate = key();
        duplicate.kid = "fixture".into();
        assert_eq!(
            validate_verification_jwks(&VerificationJwks {
                keys: vec![key(), duplicate],
            })
            .unwrap_err(),
            OidcProviderError::ValidationFailed
        );
        let mut oversized = key();
        oversized.n = "n".repeat(1_401);
        assert_eq!(
            validate_verification_jwks(&VerificationJwks {
                keys: vec![oversized],
            })
            .unwrap_err(),
            OidcProviderError::ValidationFailed
        );
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
