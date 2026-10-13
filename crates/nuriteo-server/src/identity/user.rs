use serde::{Deserialize, Serialize};

use super::{IdentityError, Timestamp, UserId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserStatus {
    Active,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserFields {
    pub id: UserId,
    pub email: String,
    pub normalized_email: String,
    pub display_name: String,
    pub status: UserStatus,
    pub is_instance_admin: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub disabled_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "UserFields")]
pub struct User {
    id: UserId,
    email: String,
    normalized_email: String,
    display_name: String,
    status: UserStatus,
    is_instance_admin: bool,
    created_at: Timestamp,
    updated_at: Timestamp,
    disabled_at: Option<Timestamp>,
}

impl User {
    pub fn new(fields: UserFields) -> Result<Self, IdentityError> {
        validate_email(&fields.email)?;
        if fields.normalized_email != normalize_email(&fields.email)
            || !(3..=320).contains(&fields.normalized_email.chars().count())
        {
            return Err(IdentityError::InvalidNormalizedEmail);
        }
        if !(1..=200).contains(&fields.display_name.trim_matches(' ').chars().count()) {
            return Err(IdentityError::InvalidDisplayName);
        }
        match (fields.status, fields.disabled_at) {
            (UserStatus::Active, None) | (UserStatus::Disabled, Some(_)) => {}
            _ => return Err(IdentityError::InvalidUserLifecycle),
        }
        if fields.updated_at < fields.created_at
            || fields.disabled_at.is_some_and(|disabled_at| {
                disabled_at < fields.created_at || fields.updated_at < disabled_at
            })
        {
            return Err(IdentityError::InvalidUserTimestampOrder);
        }

        Ok(Self {
            id: fields.id,
            email: fields.email,
            normalized_email: fields.normalized_email,
            display_name: fields.display_name,
            status: fields.status,
            is_instance_admin: fields.is_instance_admin,
            created_at: fields.created_at,
            updated_at: fields.updated_at,
            disabled_at: fields.disabled_at,
        })
    }

    #[must_use]
    pub const fn id(&self) -> UserId {
        self.id
    }

    #[must_use]
    pub const fn status(&self) -> UserStatus {
        self.status
    }

    #[must_use]
    pub const fn is_active(&self) -> bool {
        matches!(self.status, UserStatus::Active)
    }

    #[must_use]
    pub fn into_fields(self) -> UserFields {
        UserFields {
            id: self.id,
            email: self.email,
            normalized_email: self.normalized_email,
            display_name: self.display_name,
            status: self.status,
            is_instance_admin: self.is_instance_admin,
            created_at: self.created_at,
            updated_at: self.updated_at,
            disabled_at: self.disabled_at,
        }
    }
}

impl TryFrom<UserFields> for User {
    type Error = IdentityError;

    fn try_from(value: UserFields) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

fn validate_email(email: &str) -> Result<(), IdentityError> {
    let length = email.chars().count();
    if email != email.trim_matches(' ')
        || !(3..=320).contains(&length)
        || email.chars().any(char::is_control)
    {
        return Err(IdentityError::InvalidEmail);
    }
    Ok(())
}

fn normalize_email(email: &str) -> String {
    email.trim_matches(' ').to_lowercase()
}
