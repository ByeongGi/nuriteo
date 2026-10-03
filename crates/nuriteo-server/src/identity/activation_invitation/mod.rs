use std::fmt;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use super::{ActivationInvitationId, IdentityError, Timestamp, UserId};

const TOKEN_PREFIX: &str = "nrt_inv_";
const TOKEN_BYTES: usize = 32;
const TOKEN_ENCODED_BYTES: usize = 43;
const TOKEN_WIRE_BYTES: usize = TOKEN_PREFIX.len() + TOKEN_ENCODED_BYTES;
const TOKEN_DIGEST_BYTES: usize = 32;

const DEFAULT_EXPIRY: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MIN_EXPIRY: Duration = Duration::from_secs(60 * 60);
const MAX_EXPIRY: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct NormalizedEmail(String);

impl NormalizedEmail {
    pub fn from_email(value: &str) -> Result<Self, IdentityError> {
        validate_email(value)?;
        Ok(Self(value.to_lowercase()))
    }

    pub fn parse(value: String) -> Result<Self, IdentityError> {
        validate_email(&value)?;
        if value != value.to_lowercase() {
            return Err(IdentityError::InvalidInvitationEmail);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for NormalizedEmail {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NormalizedEmail([REDACTED])")
    }
}

impl<'de> Deserialize<'de> for NormalizedEmail {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationInvitationStatus {
    Pending,
    Accepted,
    Expired,
    Revoked,
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationInvitationFields {
    pub id: ActivationInvitationId,
    pub normalized_email: NormalizedEmail,
    pub invited_by_user_id: UserId,
    pub status: ActivationInvitationStatus,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    pub accepted_at: Option<Timestamp>,
    pub expired_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
    pub superseded_at: Option<Timestamp>,
    pub replaced_by_invitation_id: Option<ActivationInvitationId>,
}

/// Safe activation invitation metadata. The bearer token and its digest are
/// deliberately owned by a separate credential boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ActivationInvitationFields")]
pub struct ActivationInvitation {
    id: ActivationInvitationId,
    normalized_email: NormalizedEmail,
    invited_by_user_id: UserId,
    status: ActivationInvitationStatus,
    created_at: Timestamp,
    expires_at: Timestamp,
    accepted_at: Option<Timestamp>,
    expired_at: Option<Timestamp>,
    revoked_at: Option<Timestamp>,
    superseded_at: Option<Timestamp>,
    replaced_by_invitation_id: Option<ActivationInvitationId>,
}

impl ActivationInvitation {
    pub fn new(fields: ActivationInvitationFields) -> Result<Self, IdentityError> {
        validate_expiry(fields.created_at, fields.expires_at)?;
        validate_lifecycle(&fields)?;
        Ok(Self {
            id: fields.id,
            normalized_email: fields.normalized_email,
            invited_by_user_id: fields.invited_by_user_id,
            status: fields.status,
            created_at: fields.created_at,
            expires_at: fields.expires_at,
            accepted_at: fields.accepted_at,
            expired_at: fields.expired_at,
            revoked_at: fields.revoked_at,
            superseded_at: fields.superseded_at,
            replaced_by_invitation_id: fields.replaced_by_invitation_id,
        })
    }

    #[must_use]
    pub const fn id(&self) -> ActivationInvitationId {
        self.id
    }

    #[must_use]
    pub const fn status(&self) -> ActivationInvitationStatus {
        self.status
    }

    #[must_use]
    pub const fn expires_at(&self) -> Timestamp {
        self.expires_at
    }

    #[must_use]
    pub fn into_fields(self) -> ActivationInvitationFields {
        ActivationInvitationFields {
            id: self.id,
            normalized_email: self.normalized_email,
            invited_by_user_id: self.invited_by_user_id,
            status: self.status,
            created_at: self.created_at,
            expires_at: self.expires_at,
            accepted_at: self.accepted_at,
            expired_at: self.expired_at,
            revoked_at: self.revoked_at,
            superseded_at: self.superseded_at,
            replaced_by_invitation_id: self.replaced_by_invitation_id,
        }
    }
}

impl TryFrom<ActivationInvitationFields> for ActivationInvitation {
    type Error = IdentityError;

    fn try_from(value: ActivationInvitationFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvitationExpiryPolicy(Duration);

impl InvitationExpiryPolicy {
    pub fn new(expiry: Duration) -> Result<Self, InvitationPolicyError> {
        if !(MIN_EXPIRY..=MAX_EXPIRY).contains(&expiry) {
            return Err(InvitationPolicyError::InvalidExpiry);
        }
        Ok(Self(expiry))
    }

    #[must_use]
    pub const fn duration(self) -> Duration {
        self.0
    }

    pub fn expires_at(self, created_at: Timestamp) -> Result<Timestamp, InvitationPolicyError> {
        let seconds =
            i64::try_from(self.0.as_secs()).map_err(|_| InvitationPolicyError::ExpiryOutOfRange)?;
        created_at
            .into_datetime()
            .checked_add(time::Duration::seconds(seconds))
            .ok_or(InvitationPolicyError::ExpiryOutOfRange)
            .and_then(|value| {
                Timestamp::from_datetime(value).map_err(|_| InvitationPolicyError::ExpiryOutOfRange)
            })
    }
}

impl Default for InvitationExpiryPolicy {
    fn default() -> Self {
        Self(DEFAULT_EXPIRY)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationPolicyError {
    InvalidExpiry,
    ExpiryOutOfRange,
}

impl fmt::Display for InvitationPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidExpiry => "invitation expiry must be between one hour and thirty days",
            Self::ExpiryOutOfRange => "invitation expiry timestamp is out of range",
        })
    }
}

impl std::error::Error for InvitationPolicyError {}

/// One opaque single-use activation credential.
#[derive(PartialEq, Eq)]
pub struct ActivationToken(String);

impl ActivationToken {
    pub fn generate() -> Result<Self, ActivationTokenError> {
        let mut bytes = [0_u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|_| ActivationTokenError::EntropyUnavailable)?;
        Self::parse(format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
    }

    pub fn parse(value: String) -> Result<Self, ActivationTokenError> {
        validate_token(&value)?;
        Ok(Self(value))
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "INV-002 consumes this narrow in-crate persistence boundary"
    )]
    pub(crate) fn digest(&self) -> ActivationTokenDigest {
        ActivationTokenDigest(Sha256::digest(self.0.as_bytes()).into())
    }

    /// Exposes the one-time credential only to the future invitation delivery boundary.
    #[must_use]
    #[allow(
        dead_code,
        reason = "INV-002 and INV-003 consume this narrow in-crate delivery boundary"
    )]
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ActivationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActivationToken([REDACTED])")
    }
}

impl fmt::Display for ActivationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ActivationTokenDigest([u8; TOKEN_DIGEST_BYTES]);

impl ActivationTokenDigest {
    #[must_use]
    #[allow(
        dead_code,
        reason = "INV-002 consumes this narrow in-crate persistence boundary"
    )]
    pub(crate) const fn as_bytes(&self) -> &[u8; TOKEN_DIGEST_BYTES] {
        &self.0
    }
}

impl fmt::Debug for ActivationTokenDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActivationTokenDigest([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationTokenError {
    InvalidToken,
    EntropyUnavailable,
}

impl fmt::Display for ActivationTokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidToken => "activation credential is invalid",
            Self::EntropyUnavailable => "activation credential generation failed",
        })
    }
}

impl std::error::Error for ActivationTokenError {}

fn validate_token(value: &str) -> Result<(), ActivationTokenError> {
    if value.len() != TOKEN_WIRE_BYTES || !value.starts_with(TOKEN_PREFIX) {
        return Err(ActivationTokenError::InvalidToken);
    }
    let encoded = &value[TOKEN_PREFIX.len()..];
    if encoded.len() != TOKEN_ENCODED_BYTES
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ActivationTokenError::InvalidToken);
    }
    let mut decoded = [0_u8; TOKEN_BYTES];
    let written = URL_SAFE_NO_PAD
        .decode_slice(encoded, &mut decoded)
        .map_err(|_| ActivationTokenError::InvalidToken)?;
    if written != TOKEN_BYTES || URL_SAFE_NO_PAD.encode(decoded) != encoded {
        return Err(ActivationTokenError::InvalidToken);
    }
    Ok(())
}

fn validate_email(value: &str) -> Result<(), IdentityError> {
    if value != value.trim_matches(' ')
        || !(3..=320).contains(&value.chars().count())
        || value.chars().any(char::is_control)
    {
        return Err(IdentityError::InvalidInvitationEmail);
    }
    Ok(())
}

fn validate_expiry(created_at: Timestamp, expires_at: Timestamp) -> Result<(), IdentityError> {
    let minimum = add_duration(created_at, MIN_EXPIRY)?;
    let maximum = add_duration(created_at, MAX_EXPIRY)?;
    if !(minimum..=maximum).contains(&expires_at) {
        return Err(IdentityError::InvalidInvitationExpiry);
    }
    Ok(())
}

fn add_duration(timestamp: Timestamp, duration: Duration) -> Result<Timestamp, IdentityError> {
    let seconds =
        i64::try_from(duration.as_secs()).map_err(|_| IdentityError::InvalidInvitationExpiry)?;
    timestamp
        .into_datetime()
        .checked_add(time::Duration::seconds(seconds))
        .ok_or(IdentityError::InvalidInvitationExpiry)
        .and_then(Timestamp::from_datetime)
}

fn validate_lifecycle(fields: &ActivationInvitationFields) -> Result<(), IdentityError> {
    let terminal_count = [
        fields.accepted_at,
        fields.expired_at,
        fields.revoked_at,
        fields.superseded_at,
    ]
    .into_iter()
    .flatten()
    .count();

    let valid = match fields.status {
        ActivationInvitationStatus::Pending => {
            terminal_count == 0 && fields.replaced_by_invitation_id.is_none()
        }
        ActivationInvitationStatus::Accepted => {
            terminal_count == 1
                && fields
                    .accepted_at
                    .is_some_and(|at| at >= fields.created_at && at < fields.expires_at)
                && fields.replaced_by_invitation_id.is_none()
        }
        ActivationInvitationStatus::Expired => {
            terminal_count == 1
                && fields.expired_at.is_some_and(|at| at >= fields.expires_at)
                && fields.replaced_by_invitation_id.is_none()
        }
        ActivationInvitationStatus::Revoked => {
            terminal_count == 1
                && fields
                    .revoked_at
                    .is_some_and(|at| at >= fields.created_at && at < fields.expires_at)
                && fields.replaced_by_invitation_id.is_none()
        }
        ActivationInvitationStatus::Superseded => {
            terminal_count == 1
                && fields
                    .superseded_at
                    .is_some_and(|at| at >= fields.created_at && at < fields.expires_at)
                && fields.replaced_by_invitation_id.is_some()
        }
    };
    if !valid {
        return Err(IdentityError::InvalidInvitationLifecycle);
    }
    if fields.replaced_by_invitation_id == Some(fields.id) {
        return Err(IdentityError::InvalidInvitationLineage);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
