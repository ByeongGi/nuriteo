mod invitation;
mod invitation_service;
mod model;
mod service;
mod types;

use std::fmt;

pub use model::{
    Organization, OrganizationFields, OrganizationMembership, OrganizationMembershipFields,
};
pub use service::{
    MembershipAddResult, MembershipChangeResult, MembershipRemoveResult, OrganizationAuditContext,
    OrganizationPrincipal, OrganizationService, OrganizationServiceError,
    OrganizationServicePolicy,
};
pub use types::{OrganizationId, OrganizationRole, OrganizationStatus, OrganizationVersion};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OrganizationError {
    InvalidIdentifier,
    NilIdentifier,
    IdentifierMustBeVersion7,
    InvalidSlug,
    InvalidDisplayName,
    InvalidLifecycle,
    InvalidTimestampOrder,
    InvalidLockVersion,
    LockVersionExhausted,
}

impl fmt::Display for OrganizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "identifier is not a valid UUID",
            Self::NilIdentifier => "identifier must not be nil",
            Self::IdentifierMustBeVersion7 => "identifier must be UUID version 7",
            Self::InvalidSlug => "organization slug is not canonical",
            Self::InvalidDisplayName => "organization display name is invalid",
            Self::InvalidLifecycle => "organization lifecycle state is invalid",
            Self::InvalidTimestampOrder => "organization timestamps are out of order",
            Self::InvalidLockVersion => "organization lock version is invalid",
            Self::LockVersionExhausted => "organization lock version is exhausted",
        })
    }
}

impl std::error::Error for OrganizationError {}

#[cfg(test)]
mod tests;
pub use invitation::{
    OrganizationInvitation, OrganizationInvitationError, OrganizationInvitationFields,
    OrganizationInvitationId, OrganizationInvitationStatus, OrganizationInvitationToken,
};
pub use invitation_service::{
    IssuedOrganizationInvitation, OrganizationInvitationActor, OrganizationInvitationAuditContext,
    OrganizationInvitationInvitee, OrganizationInvitationPolicy,
    OrganizationInvitationRevokeResult, OrganizationInvitationService,
    OrganizationInvitationServiceError,
};
