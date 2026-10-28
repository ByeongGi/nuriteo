#![allow(unused_imports)]
use super::*;
use super::verification::*;

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


use super::super::{OidcProviderError, OidcProviderMetadata, OidcProviderService, OidcRuntimeProvider};

use crate::integration::{CaEndpointBinding, IntegrationAdminActor, ValidatedCaBundle};
use super::{DISCOVERY_LIMIT, JWKS_LIMIT, MAX_JWKS_KEYS, MAX_CACHE_ENTRIES, DEFAULT_CACHE_TTL, MAX_CACHE_TTL, MIN_TIMEOUT, MAX_TIMEOUT, MAX_DNS_TIMEOUT, MAX_DNS_ADDRESSES, TOKEN_RESPONSE_LIMIT, JWT_LIMIT, MAX_TOKEN_AGE_SECONDS, CLOCK_SKEW_SECONDS, RuntimeAccess, RUNTIME_ACCESS, ZeroizingRequestBody, AuthorizationRuntime, VerifiedIdToken, OidcEndpointValidator, OidcValidationProof, DiscoveryDocument, JwksDocument, JwkShape, TokenResponse, VerificationJwks, VerificationJwk, JwtHeader, IdTokenClaims, Audience, CacheKey, CacheEntry, ValidationMaterial};



impl fmt::Debug for super::OidcProtocolRuntime { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OidcProtocolRuntime")
            .field("provider_id", &self.provider.metadata.id)
            .finish_non_exhaustive()
    }
}


impl OidcProtocolRuntime {
    #[cfg(test)]
    pub(crate) fn secret_for_test(&self) -> &[u8] {
        self.provider.client_secret.expose()
    }

    pub(crate) fn authorization_request(
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

    pub(crate) async fn exchange_and_validate(
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


impl AsRef<[u8]> for ZeroizingRequestBody { fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}


impl fmt::Debug for OidcEndpointValidator { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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

    pub(crate) async fn active_runtime_inner(
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

    pub(crate) async fn jwks_fingerprint(
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
    pub(crate) async fn jwks_fingerprint_for_test(
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

    pub(crate) async fn fetch(
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


pub(crate) fn validate_verification_jwks(jwks: &VerificationJwks) -> Result<(), OidcProviderError> {    if jwks.keys.is_empty() || jwks.keys.len() > MAX_JWKS_KEYS {
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


pub(crate) fn validate_redirect_uri(value: &str, allow_test: bool) -> Result<Url, OidcProviderError> {    let url = validate_endpoint(value, allow_test)?;
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(OidcProviderError::InvalidInput);
    }
    Ok(url)
}


pub(crate) fn validate_endpoint(value: &str, allow_test: bool) -> Result<Url, OidcProviderError> {    if value.len() > 2048 || value.trim() != value {
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


pub(crate) fn discovery_url(issuer: &Url) -> Result<Url, OidcProviderError> {    if issuer.query().is_some() || issuer.fragment().is_some() {
        return Err(OidcProviderError::InvalidInput);
    }
    Url::parse(&format!(
        "{}/.well-known/openid-configuration",
        issuer.as_str().trim_end_matches('/')
    ))
    .map_err(|_| OidcProviderError::InvalidInput)
}


pub(crate) async fn resolve_checked(    host: &str,
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


pub(crate) fn validate_resolved_addresses(    addresses: &[SocketAddr],
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


pub(crate) fn same_address_set(left: &[SocketAddr], right: &[SocketAddr]) -> bool {    left == right
}


pub(crate) fn require_same_origin(issuer: &Url, endpoint: &Url) -> Result<(), OidcProviderError> {    if issuer.scheme() != endpoint.scheme()
        || issuer.host_str().map(str::to_ascii_lowercase)
            != endpoint.host_str().map(str::to_ascii_lowercase)
        || issuer.port_or_known_default() != endpoint.port_or_known_default()
    {
        return Err(OidcProviderError::NetworkDenied);
    }
    Ok(())
}
