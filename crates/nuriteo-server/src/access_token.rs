//! Secret-safe primitives for Personal and Project Automation Tokens.
//!
//! Persistence receives only [`AccessTokenHash`]. The copy-once plaintext is
//! deliberately non-cloneable, redacted from `Debug`, and zeroized on drop.

#![allow(dead_code, reason = "TOK-002 will expose the authentication adapter")]

use std::collections::BTreeSet;
use std::fmt;
use std::str::FromStr;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroizing;

mod http_routes;
mod management;
mod service;

pub(crate) use http_routes::openapi_router;
#[allow(unused_imports, reason = "TOK-003 HTTP adapter handoff")]
pub(crate) use management::{
    AccessTokenManagementError, AccessTokenManagementService, AccessTokenTarget, AccessTokenView,
    IssuedAccessTokenView,
};
#[allow(unused_imports, reason = "TOK-002 HTTP adapter handoff")]
pub(crate) use service::{
    AccessTokenAuthenticator, AccessTokenPrincipal, AccessTokenRequest, AccessTokenServiceError,
    ApiCategory, ApiIdempotencyRepository, IdempotencyReservation,
};

const SECRET_BYTES: usize = 32;
const ENCODED_SECRET_BYTES: usize = 43;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccessTokenKind {
    Personal,
    Project,
}

impl AccessTokenKind {
    const fn marker(self) -> &'static str {
        match self {
            Self::Personal => "nur_pat_",
            Self::Project => "nur_prj_",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "personal" => Some(Self::Personal),
            "project" => Some(Self::Project),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum AccessTokenScope {
    GitRead,
    GitWrite,
    ProjectManage,
    ProjectPublish,
    ProjectRead,
    ProjectWrite,
}

impl AccessTokenScope {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::GitRead => "git:read",
            Self::GitWrite => "git:write",
            Self::ProjectManage => "project:manage",
            Self::ProjectPublish => "project:publish",
            Self::ProjectRead => "project:read",
            Self::ProjectWrite => "project:write",
        }
    }

    fn allowed_for(self, kind: AccessTokenKind) -> bool {
        kind == AccessTokenKind::Personal
            || matches!(
                self,
                Self::ProjectRead | Self::ProjectWrite | Self::ProjectPublish
            )
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct AccessTokenHash([u8; 32]);

impl AccessTokenHash {
    pub(crate) const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    fn from_slice(value: &[u8]) -> Option<Self> {
        Some(Self(value.try_into().ok()?))
    }
}

impl fmt::Debug for AccessTokenHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AccessTokenHash([REDACTED])")
    }
}

pub(crate) struct PlaintextAccessToken(Zeroizing<String>);

impl PlaintextAccessToken {
    pub(crate) fn expose_once(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for PlaintextAccessToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PlaintextAccessToken([REDACTED])")
    }
}

pub(crate) struct GeneratedAccessToken {
    pub(crate) id: Uuid,
    pub(crate) kind: AccessTokenKind,
    pub(crate) token_prefix: String,
    pub(crate) scopes: Vec<AccessTokenScope>,
    pub(crate) secret_hash: AccessTokenHash,
    pub(crate) plaintext: PlaintextAccessToken,
}

impl fmt::Debug for GeneratedAccessToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedAccessToken")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("token_prefix", &self.token_prefix)
            .field("scopes", &self.scopes)
            .field("secret_hash", &self.secret_hash)
            .field("plaintext", &"[REDACTED]")
            .finish()
    }
}

pub(crate) fn generate_access_token(
    kind: AccessTokenKind,
    scopes: impl IntoIterator<Item = AccessTokenScope>,
) -> Result<GeneratedAccessToken, AccessTokenError> {
    let scopes = normalize_scopes(kind, scopes)?;
    let id = Uuid::now_v7();
    let token_prefix = format!("{}{id}_", kind.marker());
    let mut random = Zeroizing::new([0_u8; SECRET_BYTES]);
    getrandom::fill(random.as_mut()).map_err(|_| AccessTokenError::EntropyUnavailable)?;
    let secret = Zeroizing::new(URL_SAFE_NO_PAD.encode(random.as_slice()));
    let secret_hash = hash_secret(secret.as_bytes());
    let plaintext =
        PlaintextAccessToken(Zeroizing::new(format!("{token_prefix}{}", secret.as_str())));

    Ok(GeneratedAccessToken {
        id,
        kind,
        token_prefix,
        scopes,
        secret_hash,
        plaintext,
    })
}

pub(crate) fn verify_access_token(
    presented: &str,
    expected_id: Uuid,
    expected_kind: AccessTokenKind,
    expected_hash: &AccessTokenHash,
) -> bool {
    let Some(secret) = parse_secret(presented, expected_id, expected_kind) else {
        return false;
    };
    hash_secret(secret.as_bytes())
        .0
        .ct_eq(&expected_hash.0)
        .into()
}

struct ParsedAccessToken {
    id: Uuid,
    kind: AccessTokenKind,
    secret: Zeroizing<String>,
}

fn parse_presented_token(presented: &str) -> Option<ParsedAccessToken> {
    let (kind, remainder) = if let Some(value) = presented.strip_prefix("nur_pat_") {
        (AccessTokenKind::Personal, value)
    } else {
        (
            AccessTokenKind::Project,
            presented.strip_prefix("nur_prj_")?,
        )
    };
    let (id_text, secret) = remainder.split_once('_')?;
    let id = Uuid::from_str(id_text).ok()?;
    if id_text != id.to_string() {
        return None;
    }
    if secret.len() != ENCODED_SECRET_BYTES
        || URL_SAFE_NO_PAD.decode(secret).ok()?.len() != SECRET_BYTES
    {
        return None;
    }
    Some(ParsedAccessToken {
        id,
        kind,
        secret: Zeroizing::new(secret.to_owned()),
    })
}

fn verify_parsed_secret(parsed: &ParsedAccessToken, expected_hash: &AccessTokenHash) -> bool {
    hash_secret(parsed.secret.as_bytes())
        .0
        .ct_eq(&expected_hash.0)
        .into()
}

fn normalize_scopes(
    kind: AccessTokenKind,
    scopes: impl IntoIterator<Item = AccessTokenScope>,
) -> Result<Vec<AccessTokenScope>, AccessTokenError> {
    let scopes: BTreeSet<_> = scopes.into_iter().collect();
    if scopes.is_empty() || scopes.iter().any(|scope| !scope.allowed_for(kind)) {
        return Err(AccessTokenError::InvalidScopes);
    }
    Ok(scopes.into_iter().collect())
}

fn parse_secret(
    presented: &str,
    expected_id: Uuid,
    expected_kind: AccessTokenKind,
) -> Option<Zeroizing<String>> {
    let remainder = presented.strip_prefix(expected_kind.marker())?;
    let (id, secret) = remainder.split_once('_')?;
    if Uuid::from_str(id).ok()? != expected_id
        || id != expected_id.to_string()
        || secret.len() != ENCODED_SECRET_BYTES
        || URL_SAFE_NO_PAD.decode(secret).ok()?.len() != SECRET_BYTES
    {
        return None;
    }
    Some(Zeroizing::new(secret.to_owned()))
}

fn hash_secret(secret: &[u8]) -> AccessTokenHash {
    AccessTokenHash(Sha256::digest(secret).into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccessTokenError {
    EntropyUnavailable,
    InvalidScopes,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_fixed_prefix_and_copy_once_secret_without_debug_disclosure() {
        let token = generate_access_token(
            AccessTokenKind::Personal,
            [
                AccessTokenScope::ProjectWrite,
                AccessTokenScope::ProjectRead,
            ],
        )
        .expect("token generation");

        assert_eq!(token.token_prefix, format!("nur_pat_{}_", token.id));
        assert!(
            token
                .plaintext
                .expose_once()
                .starts_with(&token.token_prefix)
        );
        assert_eq!(token.secret_hash.as_bytes().len(), 32);
        assert_eq!(
            token.scopes,
            vec![
                AccessTokenScope::ProjectRead,
                AccessTokenScope::ProjectWrite
            ]
        );
        assert!(!format!("{token:?}").contains(token.plaintext.expose_once()));
        assert!(verify_access_token(
            token.plaintext.expose_once(),
            token.id,
            token.kind,
            &token.secret_hash
        ));
    }

    #[test]
    fn rejects_wrong_id_kind_and_secret() {
        let token =
            generate_access_token(AccessTokenKind::Project, [AccessTokenScope::ProjectPublish])
                .expect("token generation");
        let wrong_secret = format!("{}{}", token.token_prefix, "A".repeat(43));

        assert!(!verify_access_token(
            token.plaintext.expose_once(),
            Uuid::now_v7(),
            token.kind,
            &token.secret_hash
        ));
        assert!(!verify_access_token(
            token.plaintext.expose_once(),
            token.id,
            AccessTokenKind::Personal,
            &token.secret_hash
        ));
        assert!(!verify_access_token(
            &wrong_secret,
            token.id,
            token.kind,
            &token.secret_hash
        ));
    }

    #[test]
    fn rejects_empty_and_overprivileged_project_scopes() {
        assert_eq!(
            generate_access_token(AccessTokenKind::Personal, []).unwrap_err(),
            AccessTokenError::InvalidScopes
        );
        assert_eq!(
            generate_access_token(
                AccessTokenKind::Project,
                [AccessTokenScope::ProjectRead, AccessTokenScope::GitRead]
            )
            .unwrap_err(),
            AccessTokenError::InvalidScopes
        );
    }
}
