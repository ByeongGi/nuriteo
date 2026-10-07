mod http_routes;
mod http_service;
mod model;
mod repository;
mod service;
mod types;

use std::fmt;

pub(crate) use http_routes::openapi_router;
pub use http_service::{TeamHttpError, TeamHttpPolicy, TeamHttpService};

pub use model::{Team, TeamMembership, TeamProjectRoleGrant};
pub use repository::{
    DEFAULT_TEAM_PAGE_SIZE, MAX_TEAM_PAGE_SIZE, NewTeam, TeamConflict, TeamMemberPageKey,
    TeamMemberPageLimit, TeamMembershipPage, TeamPage, TeamPageKey, TeamPageLimit,
    TeamProjectRolePage, TeamProjectRolePageKey, TeamProjectRolePageLimit, TeamRepository,
    TeamRepositoryError,
};
pub use service::{
    TeamAuditContext, TeamMutationResult, TeamPrincipal, TeamService, TeamServiceError,
    TeamServicePolicy,
};
pub use types::{
    TeamAction, TeamAuthorization, TeamAuthorizationPrincipal, TeamDisplayName, TeamId,
    TeamMembershipVersion, TeamOrganizationMembership, TeamProjectRoleVersion, TeamRole, TeamSlug,
    TeamVersion, effective_project_role,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TeamError {
    InvalidIdentifier,
    NilIdentifier,
    IdentifierMustBeVersion7,
    InvalidSlug,
    InvalidName,
    InvalidTimestampOrder,
    InvalidLockVersion,
    LockVersionExhausted,
}

impl fmt::Display for TeamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "team identifier is invalid",
            Self::NilIdentifier => "team identifier must not be nil",
            Self::IdentifierMustBeVersion7 => "team identifier must be UUID version 7",
            Self::InvalidSlug => "team slug is not canonical",
            Self::InvalidName => "team name is invalid",
            Self::InvalidTimestampOrder => "team timestamps are out of order",
            Self::InvalidLockVersion => "team lock version is invalid",
            Self::LockVersionExhausted => "team lock version is exhausted",
        })
    }
}

impl std::error::Error for TeamError {}

#[cfg(test)]
mod tests;
