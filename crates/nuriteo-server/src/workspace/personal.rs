use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::{Uuid, Variant, Version};

use crate::identity::{Timestamp, UserId};
use crate::organization::OrganizationId;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StorageScopeId(Uuid);

impl StorageScopeId {
    #[allow(
        clippy::new_without_default,
        reason = "identifier generation is side-effectful and must remain explicit"
    )]
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, WorkspaceDomainError> {
        if value.is_nil() {
            return Err(WorkspaceDomainError::NilIdentifier);
        }
        if value.get_version() != Some(Version::SortRand) || value.get_variant() != Variant::RFC4122
        {
            return Err(WorkspaceDomainError::IdentifierMustBeVersion7);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn into_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Debug for StorageScopeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("StorageScopeId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for StorageScopeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for StorageScopeId {
    type Err = WorkspaceDomainError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value)
            .map_err(|_| WorkspaceDomainError::InvalidIdentifier)
            .and_then(Self::from_uuid)
    }
}

impl Serialize for StorageScopeId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for StorageScopeId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonalStorageScope {
    id: StorageScopeId,
    owner_user_id: UserId,
    created_at: Timestamp,
    updated_at: Timestamp,
}

impl PersonalStorageScope {
    pub fn new(
        id: StorageScopeId,
        owner_user_id: UserId,
        created_at: Timestamp,
        updated_at: Timestamp,
    ) -> Result<Self, WorkspaceDomainError> {
        if updated_at < created_at {
            return Err(WorkspaceDomainError::InvalidTimestampOrder);
        }
        Ok(Self {
            id,
            owner_user_id,
            created_at,
            updated_at,
        })
    }

    #[must_use]
    pub const fn id(&self) -> StorageScopeId {
        self.id
    }

    #[must_use]
    pub const fn owner_user_id(&self) -> UserId {
        self.owner_user_id
    }

    #[must_use]
    pub const fn created_at(&self) -> Timestamp {
        self.created_at
    }

    #[must_use]
    pub const fn updated_at(&self) -> Timestamp {
        self.updated_at
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceOwnerType {
    User,
    Organization,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalWorkspace {
    owner_type: WorkspaceOwnerType,
    owner_id: UserId,
    display_label: String,
    storage_scope_id: StorageScopeId,
}

impl PersonalWorkspace {
    pub fn new(
        owner_id: UserId,
        display_label: String,
        storage_scope_id: StorageScopeId,
    ) -> Result<Self, WorkspaceDomainError> {
        validate_display_label(&display_label)?;
        Ok(Self {
            owner_type: WorkspaceOwnerType::User,
            owner_id,
            display_label,
            storage_scope_id,
        })
    }

    #[must_use]
    pub const fn owner_type(&self) -> WorkspaceOwnerType {
        self.owner_type
    }

    #[must_use]
    pub const fn owner_id(&self) -> UserId {
        self.owner_id
    }

    #[must_use]
    pub fn display_label(&self) -> &str {
        &self.display_label
    }

    #[must_use]
    pub const fn storage_scope_id(&self) -> StorageScopeId {
        self.storage_scope_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizationStorageScope {
    id: StorageScopeId,
    owner_organization_id: OrganizationId,
    created_at: Timestamp,
    updated_at: Timestamp,
}

impl OrganizationStorageScope {
    pub fn new(
        id: StorageScopeId,
        owner_organization_id: OrganizationId,
        created_at: Timestamp,
        updated_at: Timestamp,
    ) -> Result<Self, WorkspaceDomainError> {
        if updated_at < created_at {
            return Err(WorkspaceDomainError::InvalidTimestampOrder);
        }
        Ok(Self {
            id,
            owner_organization_id,
            created_at,
            updated_at,
        })
    }

    #[must_use]
    pub const fn id(&self) -> StorageScopeId {
        self.id
    }

    #[must_use]
    pub const fn owner_organization_id(&self) -> OrganizationId {
        self.owner_organization_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationWorkspace {
    owner_type: WorkspaceOwnerType,
    owner_id: OrganizationId,
    display_label: String,
    storage_scope_id: StorageScopeId,
}

impl OrganizationWorkspace {
    pub fn new(
        owner_id: OrganizationId,
        display_label: String,
        storage_scope_id: StorageScopeId,
    ) -> Result<Self, WorkspaceDomainError> {
        validate_display_label(&display_label)?;
        Ok(Self {
            owner_type: WorkspaceOwnerType::Organization,
            owner_id,
            display_label,
            storage_scope_id,
        })
    }

    #[must_use]
    pub const fn owner_type(&self) -> WorkspaceOwnerType {
        self.owner_type
    }

    #[must_use]
    pub const fn owner_id(&self) -> OrganizationId {
        self.owner_id
    }

    #[must_use]
    pub fn display_label(&self) -> &str {
        &self.display_label
    }

    #[must_use]
    pub const fn storage_scope_id(&self) -> StorageScopeId {
        self.storage_scope_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Workspace {
    Personal(PersonalWorkspace),
    Organization(OrganizationWorkspace),
}

fn validate_display_label(display_label: &str) -> Result<(), WorkspaceDomainError> {
    if display_label.trim() != display_label
        || display_label.chars().any(char::is_control)
        || !(1..=200).contains(&display_label.chars().count())
    {
        return Err(WorkspaceDomainError::InvalidDisplayLabel);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceDomainError {
    InvalidIdentifier,
    NilIdentifier,
    IdentifierMustBeVersion7,
    InvalidTimestampOrder,
    InvalidDisplayLabel,
}

impl fmt::Display for WorkspaceDomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "storage scope identifier is invalid",
            Self::NilIdentifier => "storage scope identifier must not be nil",
            Self::IdentifierMustBeVersion7 => "storage scope identifier must be UUID version 7",
            Self::InvalidTimestampOrder => "storage scope timestamps are out of order",
            Self::InvalidDisplayLabel => "personal workspace display label is invalid",
        })
    }
}

impl std::error::Error for WorkspaceDomainError {}
