use serde::{Deserialize, Serialize};

use super::{IdentityError, SessionId, Timestamp, UserId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionFields {
    pub id: SessionId,
    pub user_id: UserId,
    pub created_at: Timestamp,
    pub last_seen_at: Timestamp,
    pub idle_expires_at: Timestamp,
    pub absolute_expires_at: Timestamp,
    pub last_reauthenticated_at: Option<Timestamp>,
    pub rotated_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
    pub revocation_reason: Option<String>,
    pub replaced_by_session_id: Option<SessionId>,
}

/// Safe lifecycle metadata for an authenticated session.
///
/// The opaque token and its hash are deliberately not fields of this serializable
/// aggregate. The session service owns that credential boundary and combines its
/// persistence record with this validated metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SessionFields")]
pub struct Session {
    id: SessionId,
    user_id: UserId,
    created_at: Timestamp,
    last_seen_at: Timestamp,
    idle_expires_at: Timestamp,
    absolute_expires_at: Timestamp,
    last_reauthenticated_at: Option<Timestamp>,
    rotated_at: Option<Timestamp>,
    revoked_at: Option<Timestamp>,
    revocation_reason: Option<String>,
    replaced_by_session_id: Option<SessionId>,
}

impl Session {
    pub fn new(fields: SessionFields) -> Result<Self, IdentityError> {
        validate_timestamps(&fields)?;
        validate_revocation(&fields)?;
        validate_rotation(&fields)?;

        Ok(Self {
            id: fields.id,
            user_id: fields.user_id,
            created_at: fields.created_at,
            last_seen_at: fields.last_seen_at,
            idle_expires_at: fields.idle_expires_at,
            absolute_expires_at: fields.absolute_expires_at,
            last_reauthenticated_at: fields.last_reauthenticated_at,
            rotated_at: fields.rotated_at,
            revoked_at: fields.revoked_at,
            revocation_reason: fields.revocation_reason,
            replaced_by_session_id: fields.replaced_by_session_id,
        })
    }

    #[must_use]
    pub const fn id(&self) -> SessionId {
        self.id
    }

    #[must_use]
    pub const fn user_id(&self) -> UserId {
        self.user_id
    }

    #[must_use]
    pub fn is_active_at(&self, now: Timestamp) -> bool {
        self.created_at <= now
            && self.revoked_at.is_none()
            && now < self.idle_expires_at
            && now < self.absolute_expires_at
    }

    #[must_use]
    pub fn into_fields(self) -> SessionFields {
        SessionFields {
            id: self.id,
            user_id: self.user_id,
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            idle_expires_at: self.idle_expires_at,
            absolute_expires_at: self.absolute_expires_at,
            last_reauthenticated_at: self.last_reauthenticated_at,
            rotated_at: self.rotated_at,
            revoked_at: self.revoked_at,
            revocation_reason: self.revocation_reason,
            replaced_by_session_id: self.replaced_by_session_id,
        }
    }
}

impl TryFrom<SessionFields> for Session {
    type Error = IdentityError;

    fn try_from(value: SessionFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

fn validate_timestamps(fields: &SessionFields) -> Result<(), IdentityError> {
    if fields.last_seen_at < fields.created_at
        || fields.idle_expires_at <= fields.last_seen_at
        || fields.absolute_expires_at <= fields.created_at
        || fields.idle_expires_at > fields.absolute_expires_at
    {
        return Err(IdentityError::InvalidSessionTimestampOrder);
    }
    if fields
        .last_reauthenticated_at
        .is_some_and(|at| at < fields.created_at || at > fields.last_seen_at)
    {
        return Err(IdentityError::InvalidSessionReauthentication);
    }
    Ok(())
}

fn validate_revocation(fields: &SessionFields) -> Result<(), IdentityError> {
    match (fields.revoked_at, fields.revocation_reason.as_deref()) {
        (None, None) => Ok(()),
        (Some(at), Some(reason)) if at >= fields.created_at => validate_revocation_reason(reason),
        _ => Err(IdentityError::InvalidSessionRevocation),
    }
}

fn validate_revocation_reason(reason: &str) -> Result<(), IdentityError> {
    let mut bytes = reason.bytes();
    let valid = matches!(bytes.next(), Some(b'a'..=b'z'))
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_.-".contains(&byte)
        })
        && reason.len() <= 64;
    if valid {
        Ok(())
    } else {
        Err(IdentityError::InvalidSessionRevocationReason)
    }
}

fn validate_rotation(fields: &SessionFields) -> Result<(), IdentityError> {
    match (fields.rotated_at, fields.replaced_by_session_id) {
        (None, None) => Ok(()),
        (Some(rotated_at), Some(replacement))
            if rotated_at >= fields.created_at
                && fields.revoked_at.is_some()
                && replacement != fields.id =>
        {
            Ok(())
        }
        _ => Err(IdentityError::InvalidSessionRotation),
    }
}
