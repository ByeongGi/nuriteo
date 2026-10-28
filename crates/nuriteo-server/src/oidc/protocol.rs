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

pub(crate) struct RuntimeAccess(());

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

struct ZeroizingRequestBody(Zeroizing<Vec<u8>>);

pub(crate) struct AuthorizationRuntime {
    pub url: String,
    pub provider_id: Uuid,
    pub config_version: u64,
    pub secret_version: u64,
    pub redirect_uri: String,
}

pub(crate) struct VerifiedIdToken {
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

#[derive(Debug, Clone)]
pub(crate) struct OidcValidationProof {
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
pub(crate) struct VerificationJwks {
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

pub(crate) struct ValidationMaterial {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    redirect_uri: String,
    jwks_fingerprint: [u8; 32],
    ca_fingerprint: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_non_public_networks_and_ambiguous_redirects() {
        assert_eq!(
            validate_endpoint("https://127.0.0.1/issuer", EndpointMode::Production).unwrap_err(),
            OidcProviderError::NetworkDenied
        );
        assert!(
            validate_endpoint("https://127.0.0.1/issuer", EndpointMode::AllowTestAddresses).is_ok()
        );
        assert_eq!(
            validate_endpoint(
                "https://169.254.169.254/latest/meta-data",
                EndpointMode::Production
            )
            .unwrap_err(),
            OidcProviderError::NetworkDenied
        );
        assert!(
            validate_endpoint(
                "https://169.254.169.254/latest/meta-data",
                EndpointMode::AllowTestAddresses
            )
            .is_ok()
        );
        let overlong = format!("https://{}.example.test/issuer", "a".repeat(2048));
        let padded = " https://app.example.test/callback";
        for mode in [EndpointMode::Production, EndpointMode::AllowTestAddresses] {
            assert_eq!(
                validate_endpoint(&overlong, mode).unwrap_err(),
                OidcProviderError::InvalidInput
            );
            assert_eq!(
                validate_endpoint(padded, mode).unwrap_err(),
                OidcProviderError::InvalidInput
            );
            assert!(
                validate_redirect_uri("https://app.example.test/callback?next=x", mode).is_err()
            );
        }
        assert!(
            validate_redirect_uri(
                "https://app.example.test/callback",
                EndpointMode::Production
            )
            .is_ok()
        );
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

mod exchange;
pub(crate) use exchange::*;
mod verification;
pub(crate) use verification::*;
