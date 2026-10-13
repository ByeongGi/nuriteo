use std::{fmt, str::FromStr};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use uuid::{Uuid, Variant, Version};

use crate::{
    identity::{Timestamp, UserId},
    project::ProjectId,
    save::ProjectVersionId,
};

use super::PublishedExampleError;

const PUBLIC_ID_BYTES: usize = 32;
const PUBLIC_ID_LENGTH: usize = 43;

macro_rules! uuid_v7_id {
    ($name:ident) => {
        #[derive(Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name(Uuid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn from_uuid(value: Uuid) -> Result<Self, PublishedExampleError> {
                if value.is_nil()
                    || value.get_version() != Some(Version::SortRand)
                    || value.get_variant() != Variant::RFC4122
                {
                    return Err(PublishedExampleError::InvalidInput);
                }
                Ok(Self(value))
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter
                    .debug_tuple(stringify!($name))
                    .field(&self.0)
                    .finish()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = PublishedExampleError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value)
                    .map_err(|_| PublishedExampleError::InvalidInput)
                    .and_then(Self::from_uuid)
            }
        }
    };
}

uuid_v7_id!(PublishedExampleId);
uuid_v7_id!(PublishedExampleVersionId);

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PublishedExamplePublicId(String);

impl PublishedExamplePublicId {
    pub fn generate() -> Result<Self, PublishedExampleError> {
        let mut bytes = [0_u8; PUBLIC_ID_BYTES];
        getrandom::fill(&mut bytes).map_err(|_| PublishedExampleError::EntropyUnavailable)?;
        Self::new(URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn new(value: String) -> Result<Self, PublishedExampleError> {
        if value.len() != PUBLIC_ID_LENGTH
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || URL_SAFE_NO_PAD
                .decode(value.as_bytes())
                .ok()
                .is_none_or(|decoded| decoded.len() != PUBLIC_ID_BYTES)
        {
            return Err(PublishedExampleError::InvalidInput);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for PublishedExamplePublicId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PublishedExamplePublicId([redacted])")
    }
}

impl fmt::Display for PublishedExamplePublicId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for PublishedExamplePublicId {
    type Err = PublishedExampleError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value.to_owned())
    }
}

impl TryFrom<String> for PublishedExamplePublicId {
    type Error = PublishedExampleError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<PublishedExamplePublicId> for String {
    fn from(value: PublishedExamplePublicId) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PublishedExampleName(String);

impl PublishedExampleName {
    pub fn new(value: String) -> Result<Self, PublishedExampleError> {
        if value != value.trim()
            || !(1..=200).contains(&value.chars().count())
            || value.chars().any(char::is_control)
        {
            return Err(PublishedExampleError::InvalidInput);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for PublishedExampleName {
    type Error = PublishedExampleError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<PublishedExampleName> for String {
    fn from(value: PublishedExampleName) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishedExampleVisibility {
    Unlisted,
    Public,
}

impl PublishedExampleVisibility {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Unlisted => "unlisted",
            Self::Public => "public",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, PublishedExampleError> {
        match value {
            "unlisted" => Ok(Self::Unlisted),
            "public" => Ok(Self::Public),
            _ => Err(PublishedExampleError::InvariantViolation),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishedExampleState {
    Published,
    Unpublished,
}

impl PublishedExampleState {
    pub(crate) fn parse(value: &str) -> Result<Self, PublishedExampleError> {
        match value {
            "published" => Ok(Self::Published),
            "unpublished" => Ok(Self::Unpublished),
            _ => Err(PublishedExampleError::InvariantViolation),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedExample {
    pub(crate) id: PublishedExampleId,
    pub(crate) public_id: PublishedExamplePublicId,
    pub(crate) project_id: ProjectId,
    pub(crate) publisher_user_id: UserId,
    pub(crate) name: PublishedExampleName,
    pub(crate) visibility: PublishedExampleVisibility,
    pub(crate) state: PublishedExampleState,
    pub(crate) active_version_id: PublishedExampleVersionId,
    pub(crate) generation: i64,
    pub(crate) created_at: Timestamp,
    pub(crate) updated_at: Timestamp,
    pub(crate) unpublished_at: Option<Timestamp>,
}

impl PublishedExample {
    #[must_use]
    pub const fn id(&self) -> PublishedExampleId {
        self.id
    }
    #[must_use]
    pub fn public_id(&self) -> &PublishedExamplePublicId {
        &self.public_id
    }
    #[must_use]
    pub const fn project_id(&self) -> ProjectId {
        self.project_id
    }
    #[must_use]
    pub const fn publisher_user_id(&self) -> UserId {
        self.publisher_user_id
    }
    #[must_use]
    pub fn name(&self) -> &PublishedExampleName {
        &self.name
    }
    #[must_use]
    pub const fn visibility(&self) -> PublishedExampleVisibility {
        self.visibility
    }
    #[must_use]
    pub const fn state(&self) -> PublishedExampleState {
        self.state
    }
    #[must_use]
    pub const fn active_version_id(&self) -> PublishedExampleVersionId {
        self.active_version_id
    }
    #[must_use]
    pub const fn generation(&self) -> i64 {
        self.generation
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
    pub const fn unpublished_at(&self) -> Option<Timestamp> {
        self.unpublished_at
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedExampleVersion {
    pub(crate) id: PublishedExampleVersionId,
    pub(crate) project_version_id: ProjectVersionId,
    pub(crate) version_number: i64,
    pub(crate) created_by_user_id: UserId,
    pub(crate) created_at: Timestamp,
}

impl PublishedExampleVersion {
    #[must_use]
    pub const fn id(&self) -> PublishedExampleVersionId {
        self.id
    }
    #[must_use]
    pub const fn project_version_id(&self) -> ProjectVersionId {
        self.project_version_id
    }
    #[must_use]
    pub const fn version_number(&self) -> i64 {
        self.version_number
    }
    #[must_use]
    pub const fn created_by_user_id(&self) -> UserId {
        self.created_by_user_id
    }
    #[must_use]
    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }
}

/// Resolved public metadata plus crate-internal immutable content locators.
///
/// This type intentionally does not implement `Serialize`. HTTP projections
/// may use the public metadata accessors, while the Project Version and Bundle
/// locators remain crate-private so internal storage identifiers cannot be
/// copied into a public response by accident.
#[derive(Clone, PartialEq, Eq)]
pub struct PublicPublishedExample {
    pub(crate) public_id: PublishedExamplePublicId,
    pub(crate) name: PublishedExampleName,
    pub(crate) visibility: PublishedExampleVisibility,
    pub(crate) version_number: i64,
    pub(crate) project_version_id: ProjectVersionId,
    pub(crate) bundle_id: Uuid,
    pub(crate) published_at: Timestamp,
}

impl PublicPublishedExample {
    #[must_use]
    pub fn public_id(&self) -> &PublishedExamplePublicId {
        &self.public_id
    }
    #[must_use]
    pub fn name(&self) -> &PublishedExampleName {
        &self.name
    }
    #[must_use]
    pub const fn visibility(&self) -> PublishedExampleVisibility {
        self.visibility
    }
    #[must_use]
    pub const fn version_number(&self) -> i64 {
        self.version_number
    }
    #[allow(
        dead_code,
        reason = "PUB-002 consumes this crate-private locator when starting the read-only runtime"
    )]
    #[must_use]
    pub(crate) const fn content_locator(&self) -> (ProjectVersionId, Uuid) {
        (self.project_version_id, self.bundle_id)
    }
    #[must_use]
    pub const fn published_at(&self) -> Timestamp {
        self.published_at
    }
}

impl fmt::Debug for PublicPublishedExample {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublicPublishedExample")
            .field("public_id", &self.public_id)
            .field("name", &self.name)
            .field("visibility", &self.visibility)
            .field("version_number", &self.version_number)
            .field("published_at", &self.published_at)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatePublishedExample {
    pub actor_user_id: UserId,
    pub project_id: ProjectId,
    pub project_version_id: ProjectVersionId,
    pub name: PublishedExampleName,
    pub visibility: PublishedExampleVisibility,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedExampleDeleteConfirmation {
    pub name: PublishedExampleName,
    pub recently_reauthenticated: bool,
}
