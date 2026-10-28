#![allow(unused_imports)]
use super::*;
use super::exchange::*;

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



pub(crate) fn is_public_ip(ip: IpAddr) -> bool {    match ip {
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


pub(crate) fn trust_fingerprint(ca: Option<&ValidatedCaBundle>) -> [u8; 32] {
    match ca {
        Some(bundle) => Sha256::digest(bundle.pem()).into(),
        None => Sha256::digest(b"nuriteo.oidc.system-roots.v1").into(),
    }
}


pub(crate) fn cache_ttl(value: Option<&str>) -> Duration {    let Some(value) = value else {
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


pub(crate) fn validation_fingerprint(    provider_id: Uuid,
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


pub(crate) fn bounded_protocol_value(value: &str, max: usize) -> bool {    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}


pub(crate) async fn bounded_json_response(    mut response: reqwest::Response,
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


pub(crate) fn verify_id_token(    compact: &str,
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


pub(crate) fn valid_verified_email(value: &str) -> bool {    value == value.trim()
        && (3..=320).contains(&value.len())
        && value.contains('@')
        && !value.chars().any(char::is_control)
}
