use serde::{Deserialize, Serialize};

use crate::identity::{Timestamp, UserId};

use super::{
    OrganizationError, OrganizationId, OrganizationRole, OrganizationStatus, OrganizationVersion,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrganizationFields {
    pub id: OrganizationId,
    pub slug: String,
    pub display_name: String,
    pub status: OrganizationStatus,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub archived_at: Option<Timestamp>,
    pub lock_version: OrganizationVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "OrganizationFields")]
pub struct Organization {
    id: OrganizationId,
    slug: String,
    display_name: String,
    status: OrganizationStatus,
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Option<Timestamp>,
    lock_version: OrganizationVersion,
}

impl Organization {
    pub fn new(fields: OrganizationFields) -> Result<Self, OrganizationError> {
        validate_slug(&fields.slug)?;
        validate_display_name(&fields.display_name)?;
        match (fields.status, fields.archived_at) {
            (OrganizationStatus::Active, None) | (OrganizationStatus::Archived, Some(_)) => {}
            _ => return Err(OrganizationError::InvalidLifecycle),
        }
        if fields.updated_at < fields.created_at
            || fields.archived_at.is_some_and(|archived_at| {
                archived_at < fields.created_at || fields.updated_at < archived_at
            })
        {
            return Err(OrganizationError::InvalidTimestampOrder);
        }

        Ok(Self {
            id: fields.id,
            slug: fields.slug,
            display_name: fields.display_name,
            status: fields.status,
            created_at: fields.created_at,
            updated_at: fields.updated_at,
            archived_at: fields.archived_at,
            lock_version: fields.lock_version,
        })
    }

    #[must_use]
    pub const fn id(&self) -> OrganizationId {
        self.id
    }

    #[must_use]
    pub fn slug(&self) -> &str {
        &self.slug
    }

    #[must_use]
    pub const fn status(&self) -> OrganizationStatus {
        self.status
    }

    #[must_use]
    pub const fn lock_version(&self) -> OrganizationVersion {
        self.lock_version
    }

    #[must_use]
    pub fn into_fields(self) -> OrganizationFields {
        OrganizationFields {
            id: self.id,
            slug: self.slug,
            display_name: self.display_name,
            status: self.status,
            created_at: self.created_at,
            updated_at: self.updated_at,
            archived_at: self.archived_at,
            lock_version: self.lock_version,
        }
    }
}

impl TryFrom<OrganizationFields> for Organization {
    type Error = OrganizationError;

    fn try_from(value: OrganizationFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrganizationMembershipFields {
    pub organization_id: OrganizationId,
    pub user_id: UserId,
    pub role: OrganizationRole,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "OrganizationMembershipFields")]
pub struct OrganizationMembership {
    organization_id: OrganizationId,
    user_id: UserId,
    role: OrganizationRole,
    created_at: Timestamp,
    updated_at: Timestamp,
}

impl OrganizationMembership {
    pub fn new(fields: OrganizationMembershipFields) -> Result<Self, OrganizationError> {
        if fields.updated_at < fields.created_at {
            return Err(OrganizationError::InvalidTimestampOrder);
        }
        Ok(Self {
            organization_id: fields.organization_id,
            user_id: fields.user_id,
            role: fields.role,
            created_at: fields.created_at,
            updated_at: fields.updated_at,
        })
    }

    #[must_use]
    pub fn into_fields(self) -> OrganizationMembershipFields {
        OrganizationMembershipFields {
            organization_id: self.organization_id,
            user_id: self.user_id,
            role: self.role,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

impl TryFrom<OrganizationMembershipFields> for OrganizationMembership {
    type Error = OrganizationError;

    fn try_from(value: OrganizationMembershipFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

pub(super) fn validate_slug(slug: &str) -> Result<(), OrganizationError> {
    let bytes = slug.as_bytes();
    if !(1..=63).contains(&bytes.len())
        || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        return Err(OrganizationError::InvalidSlug);
    }
    Ok(())
}

pub(super) fn validate_display_name(display_name: &str) -> Result<(), OrganizationError> {
    if display_name != display_name.trim_matches(' ')
        || !(1..=200).contains(&display_name.chars().count())
        || display_name.chars().any(char::is_control)
    {
        return Err(OrganizationError::InvalidDisplayName);
    }
    Ok(())
}
