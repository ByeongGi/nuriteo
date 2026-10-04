use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::{Uuid, Variant, Version};

use crate::identity::UserId;
use crate::organization::OrganizationId;

use super::ProjectError;

const MAX_LOCK_VERSION: i64 = i64::MAX - 1;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectId(Uuid);

impl ProjectId {
    #[allow(
        clippy::new_without_default,
        reason = "identifier generation is side-effectful and must remain explicit"
    )]
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, ProjectError> {
        if value.is_nil() {
            return Err(ProjectError::NilIdentifier);
        }
        if value.get_version() != Some(Version::SortRand) || value.get_variant() != Variant::RFC4122
        {
            return Err(ProjectError::IdentifierMustBeVersion7);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn into_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Debug for ProjectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ProjectId").field(&self.0).finish()
    }
}

impl fmt::Display for ProjectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for ProjectId {
    type Err = ProjectError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value)
            .map_err(|_| ProjectError::InvalidIdentifier)
            .and_then(Self::from_uuid)
    }
}

impl TryFrom<Uuid> for ProjectId {
    type Error = ProjectError;

    fn try_from(value: Uuid) -> Result<Self, Self::Error> {
        Self::from_uuid(value)
    }
}

impl Serialize for ProjectId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ProjectId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectOwner {
    User(UserId),
    Organization(OrganizationId),
}

impl ProjectOwner {
    pub fn from_nullable_ids(
        owner_user_id: Option<UserId>,
        owner_organization_id: Option<OrganizationId>,
    ) -> Result<Self, ProjectError> {
        match (owner_user_id, owner_organization_id) {
            (Some(user_id), None) => Ok(Self::User(user_id)),
            (None, Some(organization_id)) => Ok(Self::Organization(organization_id)),
            (None, None) | (Some(_), Some(_)) => Err(ProjectError::InvalidOwner),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectSlug(String);

impl ProjectSlug {
    pub fn new(value: String) -> Result<Self, ProjectError> {
        let bytes = value.as_bytes();
        if !(1..=63).contains(&bytes.len())
            || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        {
            return Err(ProjectError::InvalidSlug);
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

impl fmt::Display for ProjectSlug {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for ProjectSlug {
    type Err = ProjectError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value.to_owned())
    }
}

impl TryFrom<String> for ProjectSlug {
    type Error = ProjectError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl Serialize for ProjectSlug {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ProjectSlug {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectName(String);

impl ProjectName {
    pub fn new(value: String) -> Result<Self, ProjectError> {
        if value != value.trim_matches(' ')
            || !(1..=200).contains(&value.chars().count())
            || value.chars().any(char::is_control)
        {
            return Err(ProjectError::InvalidName);
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

impl TryFrom<String> for ProjectName {
    type Error = ProjectError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl Serialize for ProjectName {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ProjectName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectState {
    Active,
    Archived,
}

impl ProjectState {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct ProjectVersion(i64);

impl ProjectVersion {
    pub fn new(value: i64) -> Result<Self, ProjectError> {
        if !(1..=MAX_LOCK_VERSION).contains(&value) {
            return Err(ProjectError::InvalidLockVersion);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }

    pub fn next(self) -> Result<Self, ProjectError> {
        self.0
            .checked_add(1)
            .filter(|value| *value <= MAX_LOCK_VERSION)
            .map(Self)
            .ok_or(ProjectError::LockVersionExhausted)
    }
}

impl TryFrom<i64> for ProjectVersion {
    type Error = ProjectError;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<ProjectVersion> for i64 {
    fn from(value: ProjectVersion) -> Self {
        value.0
    }
}
