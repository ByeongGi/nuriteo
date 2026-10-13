use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use utoipa::ToSchema;
use uuid::{Uuid, Variant, Version};

use crate::identity::UserId;
use crate::organization::{OrganizationId, OrganizationRole, OrganizationStatus};
use crate::project::{EffectiveProjectRole, ProjectOwner, ProjectRole};

use super::TeamError;

const MAX_LOCK_VERSION: i64 = i64::MAX - 1;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TeamId(Uuid);

impl TeamId {
    #[allow(
        clippy::new_without_default,
        reason = "identifier generation is side-effectful and must remain explicit"
    )]
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, TeamError> {
        if value.is_nil() {
            return Err(TeamError::NilIdentifier);
        }
        if value.get_version() != Some(Version::SortRand) || value.get_variant() != Variant::RFC4122
        {
            return Err(TeamError::IdentifierMustBeVersion7);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn into_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Debug for TeamId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("TeamId").field(&self.0).finish()
    }
}

impl fmt::Display for TeamId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for TeamId {
    type Err = TeamError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value)
            .map_err(|_| TeamError::InvalidIdentifier)
            .and_then(Self::from_uuid)
    }
}

impl TryFrom<Uuid> for TeamId {
    type Error = TeamError;

    fn try_from(value: Uuid) -> Result<Self, Self::Error> {
        Self::from_uuid(value)
    }
}

impl Serialize for TeamId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for TeamId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TeamSlug(String);

impl TeamSlug {
    pub fn new(value: String) -> Result<Self, TeamError> {
        let bytes = value.as_bytes();
        if !(1..=63).contains(&bytes.len())
            || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        {
            return Err(TeamError::InvalidSlug);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for TeamSlug {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for TeamSlug {
    type Err = TeamError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value.to_owned())
    }
}

impl TryFrom<String> for TeamSlug {
    type Error = TeamError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl Serialize for TeamSlug {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for TeamSlug {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TeamDisplayName(String);

impl TeamDisplayName {
    pub fn new(value: String) -> Result<Self, TeamError> {
        if value != value.trim_matches(' ')
            || !(1..=200).contains(&value.chars().count())
            || value.chars().any(char::is_control)
        {
            return Err(TeamError::InvalidName);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl TryFrom<String> for TeamDisplayName {
    type Error = TeamError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl Serialize for TeamDisplayName {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for TeamDisplayName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TeamRole {
    Maintainer,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamAction {
    Create,
    View,
    Rename,
    ManageMembers,
    ManageProjectRoles,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamOrganizationMembership {
    None,
    Active {
        organization_id: OrganizationId,
        role: OrganizationRole,
    },
    Inactive {
        organization_id: OrganizationId,
        role: OrganizationRole,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamAuthorizationPrincipal {
    InstanceAdministrator,
    User {
        organization_membership: TeamOrganizationMembership,
        team_role: Option<TeamRole>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeamAuthorization {
    organization_id: OrganizationId,
    organization_status: OrganizationStatus,
    principal: TeamAuthorizationPrincipal,
}

impl TeamAuthorization {
    #[must_use]
    pub const fn new(
        organization_id: OrganizationId,
        organization_status: OrganizationStatus,
        principal: TeamAuthorizationPrincipal,
    ) -> Self {
        Self {
            organization_id,
            organization_status,
            principal,
        }
    }

    #[must_use]
    pub fn allows(self, action: TeamAction) -> bool {
        match self.principal {
            TeamAuthorizationPrincipal::InstanceAdministrator => {
                self.organization_status == OrganizationStatus::Active
                    || matches!(action, TeamAction::View)
            }
            TeamAuthorizationPrincipal::User {
                organization_membership:
                    TeamOrganizationMembership::Active {
                        organization_id,
                        role: OrganizationRole::Owner,
                    },
                ..
            } => {
                self.organization_status == OrganizationStatus::Active
                    && organization_id == self.organization_id
            }
            TeamAuthorizationPrincipal::User {
                organization_membership:
                    TeamOrganizationMembership::Active {
                        organization_id,
                        role: OrganizationRole::Member,
                    },
                team_role: Some(TeamRole::Maintainer),
            } => {
                self.organization_status == OrganizationStatus::Active
                    && organization_id == self.organization_id
                    && matches!(
                        action,
                        TeamAction::View | TeamAction::Rename | TeamAction::ManageMembers
                    )
            }
            TeamAuthorizationPrincipal::User {
                organization_membership:
                    TeamOrganizationMembership::Active {
                        organization_id,
                        role: OrganizationRole::Member,
                    },
                team_role: Some(TeamRole::Member),
            } => {
                self.organization_status == OrganizationStatus::Active
                    && organization_id == self.organization_id
                    && matches!(action, TeamAction::View)
            }
            TeamAuthorizationPrincipal::User { .. } => false,
        }
    }
}

/// Resolves Project authority after the caller has selected only active Team
/// memberships and their Project bindings. Instance-administrator state is
/// intentionally absent: operational authority never becomes a Project role.
#[must_use]
pub fn effective_project_role(
    project_owner: ProjectOwner,
    user_id: UserId,
    user_active: bool,
    organization_status: Option<OrganizationStatus>,
    organization_membership: TeamOrganizationMembership,
    direct_role: Option<ProjectRole>,
    active_team_roles: &[ProjectRole],
) -> EffectiveProjectRole {
    if !user_active {
        return EffectiveProjectRole::None;
    }
    match project_owner {
        ProjectOwner::User(owner_id) => {
            if owner_id == user_id {
                EffectiveProjectRole::Admin
            } else {
                EffectiveProjectRole::None
            }
        }
        ProjectOwner::Organization(owner_id) => {
            if organization_status != Some(OrganizationStatus::Active) {
                return EffectiveProjectRole::None;
            }
            match organization_membership {
                TeamOrganizationMembership::Active {
                    organization_id,
                    role: OrganizationRole::Owner,
                } if organization_id == owner_id => EffectiveProjectRole::Admin,
                TeamOrganizationMembership::Active {
                    organization_id,
                    role: OrganizationRole::Member,
                } if organization_id == owner_id => direct_role
                    .into_iter()
                    .chain(active_team_roles.iter().copied())
                    .map(EffectiveProjectRole::from)
                    .max()
                    .unwrap_or(EffectiveProjectRole::None),
                TeamOrganizationMembership::None
                | TeamOrganizationMembership::Active { .. }
                | TeamOrganizationMembership::Inactive { .. } => EffectiveProjectRole::None,
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct TeamVersion(i64);

impl TeamVersion {
    pub fn new(value: i64) -> Result<Self, TeamError> {
        if !(1..=MAX_LOCK_VERSION).contains(&value) {
            return Err(TeamError::InvalidLockVersion);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }

    pub fn next(self) -> Result<Self, TeamError> {
        self.0
            .checked_add(1)
            .filter(|value| *value <= MAX_LOCK_VERSION)
            .map(Self)
            .ok_or(TeamError::LockVersionExhausted)
    }
}

impl TryFrom<i64> for TeamVersion {
    type Error = TeamError;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<TeamVersion> for i64 {
    fn from(value: TeamVersion) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct TeamMembershipVersion(i64);

impl TeamMembershipVersion {
    pub fn new(value: i64) -> Result<Self, TeamError> {
        if !(1..=MAX_LOCK_VERSION).contains(&value) {
            return Err(TeamError::InvalidLockVersion);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }

    pub fn next(self) -> Result<Self, TeamError> {
        self.0
            .checked_add(1)
            .filter(|value| *value <= MAX_LOCK_VERSION)
            .map(Self)
            .ok_or(TeamError::LockVersionExhausted)
    }
}

impl TryFrom<i64> for TeamMembershipVersion {
    type Error = TeamError;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<TeamMembershipVersion> for i64 {
    fn from(value: TeamMembershipVersion) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct TeamProjectRoleVersion(i64);

impl TeamProjectRoleVersion {
    pub fn new(value: i64) -> Result<Self, TeamError> {
        if !(1..=MAX_LOCK_VERSION).contains(&value) {
            return Err(TeamError::InvalidLockVersion);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }

    pub fn next(self) -> Result<Self, TeamError> {
        self.0
            .checked_add(1)
            .filter(|value| *value <= MAX_LOCK_VERSION)
            .map(Self)
            .ok_or(TeamError::LockVersionExhausted)
    }
}

impl TryFrom<i64> for TeamProjectRoleVersion {
    type Error = TeamError;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<TeamProjectRoleVersion> for i64 {
    fn from(value: TeamProjectRoleVersion) -> Self {
        value.0
    }
}
