use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use utoipa::ToSchema;
use uuid::{Uuid, Variant, Version};

use super::OrganizationError;

const MAX_LOCK_VERSION: i64 = i64::MAX - 1;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OrganizationId(Uuid);

impl OrganizationId {
    #[allow(
        clippy::new_without_default,
        reason = "identifier generation is side-effectful and must remain explicit"
    )]
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, OrganizationError> {
        if value.is_nil() {
            return Err(OrganizationError::NilIdentifier);
        }
        if value.get_version() != Some(Version::SortRand) || value.get_variant() != Variant::RFC4122
        {
            return Err(OrganizationError::IdentifierMustBeVersion7);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn into_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Debug for OrganizationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("OrganizationId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for OrganizationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for OrganizationId {
    type Err = OrganizationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value)
            .map_err(|_| OrganizationError::InvalidIdentifier)
            .and_then(Self::from_uuid)
    }
}

impl Serialize for OrganizationId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for OrganizationId {
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
pub enum OrganizationStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrganizationRole {
    Owner,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct OrganizationVersion(i64);

impl OrganizationVersion {
    pub fn new(value: i64) -> Result<Self, OrganizationError> {
        if !(1..=MAX_LOCK_VERSION).contains(&value) {
            return Err(OrganizationError::InvalidLockVersion);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }

    pub fn next(self) -> Result<Self, OrganizationError> {
        self.0
            .checked_add(1)
            .filter(|value| *value <= MAX_LOCK_VERSION)
            .map(Self)
            .ok_or(OrganizationError::LockVersionExhausted)
    }
}

impl TryFrom<i64> for OrganizationVersion {
    type Error = OrganizationError;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<OrganizationVersion> for i64 {
    fn from(value: OrganizationVersion) -> Self {
        value.0
    }
}
