mod activation_invitation;
mod browser_security;
mod id;
mod invitation_service;
mod mfa_safety;
mod password;
mod session;
mod session_service;
mod timestamp;
mod user;

use std::fmt;

pub use activation_invitation::{
    ActivationInvitation, ActivationInvitationFields, ActivationInvitationStatus, ActivationToken,
    ActivationTokenDigest, ActivationTokenError, InvitationExpiryPolicy, InvitationPolicyError,
    NormalizedEmail,
};
pub use browser_security::{
    BrowserCookieBoundary, BrowserCookieError, BrowserMethod, BrowserRequestHeaders,
    CookieLifetime, IssuedBrowserCookies, SetCookieHeader, ValidatedBrowserSession,
};
pub use id::{ActivationInvitationId, SessionId, UserId};
pub use invitation_service::{
    InvitationActivationError, InvitationActivationFuture, InvitationActivator,
    InvitationAuditContext, InvitationRevokeResult, InvitationService, InvitationServiceError,
    InvitationServicePolicy, InvitationServicePolicyError, IssuedActivationInvitation,
    PendingInvitationActivation,
};
pub(crate) use mfa_safety::{
    acquire_mfa_population_lock, has_required_active_local_enrolled_admin,
};
pub use password::{
    PasswordHashError, PasswordHashInputError, PasswordPolicy, PasswordService,
    PasswordVerification, PasswordVerifyError, StoredPasswordHash,
};
pub use session::{Session, SessionFields};
pub(crate) use session_service::TransactionRevocation;
pub use session_service::{
    IssuedSession, SessionPolicy, SessionPolicyError, SessionRevokeResult, SessionRotationKind,
    SessionService, SessionServiceError, SessionToken,
};
pub use timestamp::Timestamp;
pub use user::{User, UserFields, UserStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum IdentityError {
    InvalidIdentifier,
    NilIdentifier,
    IdentifierMustBeVersion7,
    TimestampOutOfRange,
    InvalidEmail,
    InvalidNormalizedEmail,
    InvalidDisplayName,
    InvalidUserLifecycle,
    InvalidUserTimestampOrder,
    InvalidSessionTimestampOrder,
    InvalidSessionReauthentication,
    InvalidSessionRevocation,
    InvalidSessionRevocationReason,
    InvalidSessionRotation,
    InvalidInvitationEmail,
    InvalidInvitationExpiry,
    InvalidInvitationLifecycle,
    InvalidInvitationLineage,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "identifier is not a valid UUID",
            Self::NilIdentifier => "identifier must not be nil",
            Self::IdentifierMustBeVersion7 => "identifier must be UUID version 7",
            Self::TimestampOutOfRange => "timestamp must be a serializable UTC instant",
            Self::InvalidEmail => "email does not satisfy the identity contract",
            Self::InvalidNormalizedEmail => "normalized email does not match email",
            Self::InvalidDisplayName => "display name does not satisfy the identity contract",
            Self::InvalidUserLifecycle => "user lifecycle state is invalid",
            Self::InvalidUserTimestampOrder => "user timestamps are out of order",
            Self::InvalidSessionTimestampOrder => "session timestamps are out of order",
            Self::InvalidSessionReauthentication => "session reauthentication time is invalid",
            Self::InvalidSessionRevocation => "session revocation state is invalid",
            Self::InvalidSessionRevocationReason => "session revocation reason is invalid",
            Self::InvalidSessionRotation => "session rotation state is invalid",
            Self::InvalidInvitationEmail => "invitation email is invalid",
            Self::InvalidInvitationExpiry => "invitation expiry is invalid",
            Self::InvalidInvitationLifecycle => "invitation lifecycle state is invalid",
            Self::InvalidInvitationLineage => "invitation replacement lineage is invalid",
        })
    }
}

impl std::error::Error for IdentityError {}

#[cfg(test)]
mod tests;
