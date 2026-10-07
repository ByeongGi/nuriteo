use serde::{Deserialize, Serialize};

use crate::identity::{Timestamp, UserId};
use crate::organization::OrganizationId;
use crate::project::{ProjectId, ProjectRole};

use super::{
    TeamDisplayName, TeamError, TeamId, TeamMembershipVersion, TeamProjectRoleVersion, TeamRole,
    TeamSlug, TeamVersion,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TeamFields {
    id: TeamId,
    organization_id: OrganizationId,
    slug: TeamSlug,
    display_name: TeamDisplayName,
    created_at: Timestamp,
    updated_at: Timestamp,
    lock_version: TeamVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "TeamFields")]
pub struct Team {
    id: TeamId,
    organization_id: OrganizationId,
    slug: TeamSlug,
    display_name: TeamDisplayName,
    created_at: Timestamp,
    updated_at: Timestamp,
    lock_version: TeamVersion,
}

impl Team {
    #[allow(
        clippy::too_many_arguments,
        reason = "persistence reconstruction validates one complete team row"
    )]
    pub fn reconstruct(
        id: TeamId,
        organization_id: OrganizationId,
        slug: TeamSlug,
        display_name: TeamDisplayName,
        created_at: Timestamp,
        updated_at: Timestamp,
        lock_version: TeamVersion,
    ) -> Result<Self, TeamError> {
        Self::new(TeamFields {
            id,
            organization_id,
            slug,
            display_name,
            created_at,
            updated_at,
            lock_version,
        })
    }

    fn new(fields: TeamFields) -> Result<Self, TeamError> {
        if fields.updated_at < fields.created_at {
            return Err(TeamError::InvalidTimestampOrder);
        }
        Ok(Self {
            id: fields.id,
            organization_id: fields.organization_id,
            slug: fields.slug,
            display_name: fields.display_name,
            created_at: fields.created_at,
            updated_at: fields.updated_at,
            lock_version: fields.lock_version,
        })
    }

    #[must_use]
    pub const fn id(&self) -> TeamId {
        self.id
    }

    #[must_use]
    pub const fn organization_id(&self) -> OrganizationId {
        self.organization_id
    }

    #[must_use]
    pub fn slug(&self) -> &TeamSlug {
        &self.slug
    }

    #[must_use]
    pub fn display_name(&self) -> &TeamDisplayName {
        &self.display_name
    }

    #[must_use]
    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    #[must_use]
    pub const fn updated_at(&self) -> Timestamp {
        self.updated_at
    }

    #[must_use]
    pub const fn lock_version(&self) -> TeamVersion {
        self.lock_version
    }
}

impl TryFrom<TeamFields> for Team {
    type Error = TeamError;

    fn try_from(value: TeamFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TeamMembershipFields {
    team_id: TeamId,
    organization_id: OrganizationId,
    user_id: UserId,
    role: TeamRole,
    created_at: Timestamp,
    updated_at: Timestamp,
    lock_version: TeamMembershipVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "TeamMembershipFields")]
pub struct TeamMembership {
    team_id: TeamId,
    organization_id: OrganizationId,
    user_id: UserId,
    role: TeamRole,
    created_at: Timestamp,
    updated_at: Timestamp,
    lock_version: TeamMembershipVersion,
}

impl TeamMembership {
    #[allow(
        clippy::too_many_arguments,
        reason = "persistence reconstruction validates one complete team membership row"
    )]
    pub fn reconstruct(
        team_id: TeamId,
        organization_id: OrganizationId,
        user_id: UserId,
        role: TeamRole,
        created_at: Timestamp,
        updated_at: Timestamp,
        lock_version: TeamMembershipVersion,
    ) -> Result<Self, TeamError> {
        Self::new(TeamMembershipFields {
            team_id,
            organization_id,
            user_id,
            role,
            created_at,
            updated_at,
            lock_version,
        })
    }

    fn new(fields: TeamMembershipFields) -> Result<Self, TeamError> {
        if fields.updated_at < fields.created_at {
            return Err(TeamError::InvalidTimestampOrder);
        }
        Ok(Self {
            team_id: fields.team_id,
            organization_id: fields.organization_id,
            user_id: fields.user_id,
            role: fields.role,
            created_at: fields.created_at,
            updated_at: fields.updated_at,
            lock_version: fields.lock_version,
        })
    }

    #[must_use]
    pub const fn team_id(&self) -> TeamId {
        self.team_id
    }

    #[must_use]
    pub const fn organization_id(&self) -> OrganizationId {
        self.organization_id
    }

    #[must_use]
    pub const fn user_id(&self) -> UserId {
        self.user_id
    }

    #[must_use]
    pub const fn role(&self) -> TeamRole {
        self.role
    }

    #[must_use]
    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    #[must_use]
    pub const fn updated_at(&self) -> Timestamp {
        self.updated_at
    }

    #[must_use]
    pub const fn lock_version(&self) -> TeamMembershipVersion {
        self.lock_version
    }
}

impl TryFrom<TeamMembershipFields> for TeamMembership {
    type Error = TeamError;

    fn try_from(value: TeamMembershipFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TeamProjectRoleFields {
    team_id: TeamId,
    organization_id: OrganizationId,
    project_id: ProjectId,
    role: ProjectRole,
    created_at: Timestamp,
    updated_at: Timestamp,
    lock_version: TeamProjectRoleVersion,
}

/// A Team's access grant to an Organization-owned Project.
///
/// This is deliberately a role binding rather than an ownership relationship:
/// Team has no Project-owner variant in the domain model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "TeamProjectRoleFields")]
pub struct TeamProjectRoleGrant {
    team_id: TeamId,
    organization_id: OrganizationId,
    project_id: ProjectId,
    role: ProjectRole,
    created_at: Timestamp,
    updated_at: Timestamp,
    lock_version: TeamProjectRoleVersion,
}

impl TeamProjectRoleGrant {
    #[allow(
        clippy::too_many_arguments,
        reason = "persistence reconstruction validates one complete team project role row"
    )]
    pub fn reconstruct(
        team_id: TeamId,
        organization_id: OrganizationId,
        project_id: ProjectId,
        role: ProjectRole,
        created_at: Timestamp,
        updated_at: Timestamp,
        lock_version: TeamProjectRoleVersion,
    ) -> Result<Self, TeamError> {
        Self::new(TeamProjectRoleFields {
            team_id,
            organization_id,
            project_id,
            role,
            created_at,
            updated_at,
            lock_version,
        })
    }

    fn new(fields: TeamProjectRoleFields) -> Result<Self, TeamError> {
        if fields.updated_at < fields.created_at {
            return Err(TeamError::InvalidTimestampOrder);
        }
        Ok(Self {
            team_id: fields.team_id,
            organization_id: fields.organization_id,
            project_id: fields.project_id,
            role: fields.role,
            created_at: fields.created_at,
            updated_at: fields.updated_at,
            lock_version: fields.lock_version,
        })
    }

    #[must_use]
    pub const fn team_id(&self) -> TeamId {
        self.team_id
    }

    #[must_use]
    pub const fn organization_id(&self) -> OrganizationId {
        self.organization_id
    }

    #[must_use]
    pub const fn project_id(&self) -> ProjectId {
        self.project_id
    }

    #[must_use]
    pub const fn role(&self) -> ProjectRole {
        self.role
    }

    #[must_use]
    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    #[must_use]
    pub const fn updated_at(&self) -> Timestamp {
        self.updated_at
    }

    #[must_use]
    pub const fn lock_version(&self) -> TeamProjectRoleVersion {
        self.lock_version
    }
}

impl TryFrom<TeamProjectRoleFields> for TeamProjectRoleGrant {
    type Error = TeamError;

    fn try_from(value: TeamProjectRoleFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
