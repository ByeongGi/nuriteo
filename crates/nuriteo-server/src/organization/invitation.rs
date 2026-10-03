use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;
use uuid::{Uuid, Variant, Version};

use crate::identity::{InvitationExpiryPolicy, NormalizedEmail, Timestamp, UserId};

use super::{OrganizationId, OrganizationRole};

const TOKEN_PREFIX: &str = "nrt_org_inv_";
const TOKEN_BYTES: usize = 32;
const TOKEN_ENCODED_BYTES: usize = 43;
const TOKEN_WIRE_BYTES: usize = TOKEN_PREFIX.len() + TOKEN_ENCODED_BYTES;
const TOKEN_DIGEST_BYTES: usize = 32;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OrganizationInvitationId(Uuid);

impl OrganizationInvitationId {
    #[allow(
        clippy::new_without_default,
        reason = "identifier generation is side-effectful and must remain explicit"
    )]
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, OrganizationInvitationError> {
        if value.is_nil() {
            return Err(OrganizationInvitationError::InvalidIdentifier);
        }
        if value.get_version() != Some(Version::SortRand) || value.get_variant() != Variant::RFC4122
        {
            return Err(OrganizationInvitationError::InvalidIdentifier);
        }
        Ok(Self(value))
    }
}

impl fmt::Debug for OrganizationInvitationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("OrganizationInvitationId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for OrganizationInvitationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for OrganizationInvitationId {
    type Err = OrganizationInvitationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value)
            .map_err(|_| OrganizationInvitationError::InvalidIdentifier)
            .and_then(Self::from_uuid)
    }
}

impl Serialize for OrganizationInvitationId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for OrganizationInvitationId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrganizationInvitationStatus {
    Pending,
    Accepted,
    Declined,
    Expired,
    Revoked,
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrganizationInvitationFields {
    pub id: OrganizationInvitationId,
    pub organization_id: OrganizationId,
    pub invitee_user_id: UserId,
    pub normalized_email: NormalizedEmail,
    pub invited_by_user_id: UserId,
    pub proposed_role: OrganizationRole,
    pub status: OrganizationInvitationStatus,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    pub accepted_at: Option<Timestamp>,
    pub declined_at: Option<Timestamp>,
    pub expired_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
    pub superseded_at: Option<Timestamp>,
    pub replaced_by_invitation_id: Option<OrganizationInvitationId>,
}

/// Safe metadata for an Organization invitation. The credential and digest are
/// deliberately excluded from serialization and this aggregate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "OrganizationInvitationFields")]
pub struct OrganizationInvitation(OrganizationInvitationFields);

impl OrganizationInvitation {
    pub fn new(fields: OrganizationInvitationFields) -> Result<Self, OrganizationInvitationError> {
        validate_expiry(fields.created_at, fields.expires_at)?;
        validate_lifecycle(&fields)?;
        Ok(Self(fields))
    }

    #[must_use]
    pub const fn id(&self) -> OrganizationInvitationId {
        self.0.id
    }

    #[must_use]
    pub const fn organization_id(&self) -> OrganizationId {
        self.0.organization_id
    }

    #[must_use]
    pub const fn invitee_user_id(&self) -> UserId {
        self.0.invitee_user_id
    }

    #[must_use]
    pub const fn proposed_role(&self) -> OrganizationRole {
        self.0.proposed_role
    }

    #[must_use]
    pub const fn status(&self) -> OrganizationInvitationStatus {
        self.0.status
    }

    #[must_use]
    pub const fn expires_at(&self) -> Timestamp {
        self.0.expires_at
    }

    #[must_use]
    pub fn into_fields(self) -> OrganizationInvitationFields {
        self.0
    }
}

impl TryFrom<OrganizationInvitationFields> for OrganizationInvitation {
    type Error = OrganizationInvitationError;

    fn try_from(value: OrganizationInvitationFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

/// A single-use Organization invitation credential with a namespace distinct
/// from account-activation credentials.
#[derive(PartialEq, Eq)]
pub struct OrganizationInvitationToken(String);

impl OrganizationInvitationToken {
    pub fn generate() -> Result<Self, OrganizationInvitationError> {
        let mut bytes = [0_u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|_| OrganizationInvitationError::EntropyUnavailable)?;
        Self::parse(format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
    }

    pub fn parse(value: String) -> Result<Self, OrganizationInvitationError> {
        validate_token(&value)?;
        Ok(Self(value))
    }

    #[must_use]
    pub(crate) fn digest(&self) -> OrganizationInvitationTokenDigest {
        OrganizationInvitationTokenDigest(Sha256::digest(self.0.as_bytes()).into())
    }

    /// Exposes the credential only to the one-time delivery boundary.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for OrganizationInvitationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OrganizationInvitationToken([REDACTED])")
    }
}

impl fmt::Display for OrganizationInvitationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct OrganizationInvitationTokenDigest([u8; TOKEN_DIGEST_BYTES]);

impl OrganizationInvitationTokenDigest {
    #[must_use]
    pub(crate) const fn as_bytes(&self) -> &[u8; TOKEN_DIGEST_BYTES] {
        &self.0
    }
}

impl fmt::Debug for OrganizationInvitationTokenDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OrganizationInvitationTokenDigest([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OrganizationInvitationError {
    InvalidIdentifier,
    InvalidExpiry,
    InvalidLifecycle,
    InvalidLineage,
    InvalidToken,
    EntropyUnavailable,
}

impl fmt::Display for OrganizationInvitationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "organization invitation identifier is invalid",
            Self::InvalidExpiry => "organization invitation expiry is invalid",
            Self::InvalidLifecycle => "organization invitation lifecycle is invalid",
            Self::InvalidLineage => "organization invitation lineage is invalid",
            Self::InvalidToken => "organization invitation credential is invalid",
            Self::EntropyUnavailable => "organization invitation credential generation failed",
        })
    }
}

impl std::error::Error for OrganizationInvitationError {}

fn validate_token(value: &str) -> Result<(), OrganizationInvitationError> {
    if value.len() != TOKEN_WIRE_BYTES || !value.starts_with(TOKEN_PREFIX) {
        return Err(OrganizationInvitationError::InvalidToken);
    }
    let encoded = &value[TOKEN_PREFIX.len()..];
    if encoded.len() != TOKEN_ENCODED_BYTES
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(OrganizationInvitationError::InvalidToken);
    }
    let mut decoded = [0_u8; TOKEN_BYTES];
    let written = URL_SAFE_NO_PAD
        .decode_slice(encoded, &mut decoded)
        .map_err(|_| OrganizationInvitationError::InvalidToken)?;
    if written != TOKEN_BYTES || URL_SAFE_NO_PAD.encode(decoded) != encoded {
        return Err(OrganizationInvitationError::InvalidToken);
    }
    Ok(())
}

fn validate_expiry(
    created_at: Timestamp,
    expires_at: Timestamp,
) -> Result<(), OrganizationInvitationError> {
    let seconds = (expires_at.into_datetime() - created_at.into_datetime()).whole_seconds();
    let seconds = u64::try_from(seconds).map_err(|_| OrganizationInvitationError::InvalidExpiry)?;
    InvitationExpiryPolicy::new(Duration::from_secs(seconds))
        .map(|_| ())
        .map_err(|_| OrganizationInvitationError::InvalidExpiry)
}

fn validate_lifecycle(
    fields: &OrganizationInvitationFields,
) -> Result<(), OrganizationInvitationError> {
    let terminal = [
        fields.accepted_at,
        fields.declined_at,
        fields.expired_at,
        fields.revoked_at,
        fields.superseded_at,
    ];
    let count = terminal.into_iter().flatten().count();
    let valid = match fields.status {
        OrganizationInvitationStatus::Pending => count == 0,
        OrganizationInvitationStatus::Accepted => {
            count == 1 && valid_before_expiry(fields.accepted_at, fields)
        }
        OrganizationInvitationStatus::Declined => {
            count == 1 && valid_before_expiry(fields.declined_at, fields)
        }
        OrganizationInvitationStatus::Expired => {
            count == 1 && fields.expired_at.is_some_and(|at| at >= fields.expires_at)
        }
        OrganizationInvitationStatus::Revoked => {
            count == 1 && valid_before_expiry(fields.revoked_at, fields)
        }
        OrganizationInvitationStatus::Superseded => {
            count == 1 && valid_before_expiry(fields.superseded_at, fields)
        }
    };
    if !valid {
        return Err(OrganizationInvitationError::InvalidLifecycle);
    }
    match (fields.status, fields.replaced_by_invitation_id) {
        (OrganizationInvitationStatus::Superseded, Some(replacement))
            if replacement != fields.id =>
        {
            Ok(())
        }
        (OrganizationInvitationStatus::Superseded, _) => {
            Err(OrganizationInvitationError::InvalidLineage)
        }
        (_, None) => Ok(()),
        _ => Err(OrganizationInvitationError::InvalidLineage),
    }
}

fn valid_before_expiry(terminal: Option<Timestamp>, fields: &OrganizationInvitationFields) -> bool {
    terminal.is_some_and(|at| at >= fields.created_at && at < fields.expires_at)
}

#[cfg(test)]
mod tests;
