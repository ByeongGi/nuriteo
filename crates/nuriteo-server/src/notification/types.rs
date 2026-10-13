use std::fmt;
use std::str::FromStr;

use serde_json::Value;
use uuid::{Uuid, Variant, Version};

use crate::identity::{NormalizedEmail, Timestamp, UserId};

const MAX_PAYLOAD_BYTES: usize = 16_384;
const MAX_PAYLOAD_DEPTH: usize = 8;
const MAX_PAYLOAD_NODES: usize = 256;

macro_rules! notification_id {
    ($name:ident) => {
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(Uuid);

        impl $name {
            #[allow(
                clippy::new_without_default,
                reason = "identifier generation is side-effectful and must remain explicit"
            )]
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn from_uuid(value: Uuid) -> Result<Self, NotificationValidationError> {
                if value.is_nil()
                    || value.get_version() != Some(Version::SortRand)
                    || value.get_variant() != Variant::RFC4122
                {
                    return Err(NotificationValidationError::InvalidIdentifier);
                }
                Ok(Self(value))
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
            type Err = NotificationValidationError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value)
                    .map_err(|_| NotificationValidationError::InvalidIdentifier)
                    .and_then(Self::from_uuid)
            }
        }
    };
}

notification_id!(NotificationId);
notification_id!(EmailOutboxId);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationClassification {
    CriticalSecurity,
    AccountAccess,
    Collaboration,
    Operations,
}

impl NotificationClassification {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::CriticalSecurity => "critical_security",
            Self::AccountAccess => "account_access",
            Self::Collaboration => "collaboration",
            Self::Operations => "operations",
        }
    }

    #[must_use]
    pub const fn email_required_when_smtp_configured(self) -> bool {
        matches!(self, Self::CriticalSecurity)
    }

    #[must_use]
    pub const fn email_enabled_by_default(self) -> bool {
        matches!(self, Self::CriticalSecurity | Self::AccountAccess)
    }

    #[must_use]
    pub const fn is_delete_protected(self) -> bool {
        !matches!(self, Self::Collaboration)
    }

    #[must_use]
    pub const fn should_enqueue_email(
        self,
        smtp_configured: bool,
        preference: EmailChannelPreference,
    ) -> bool {
        if !smtp_configured {
            return false;
        }
        if self.email_required_when_smtp_configured() {
            return true;
        }
        match preference {
            EmailChannelPreference::Default => self.email_enabled_by_default(),
            EmailChannelPreference::Enabled => true,
            EmailChannelPreference::Disabled => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailChannelPreference {
    Default,
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationActionState {
    None,
    Pending,
    Resolved,
    Canceled,
}

impl NotificationActionState {
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        self as u8 == next as u8
            || matches!(
                (self, next),
                (Self::None, Self::Pending) | (Self::Pending, Self::Resolved | Self::Canceled)
            )
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Resolved | Self::Canceled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailOutboxState {
    Pending,
    Sending,
    RetryWait,
    Sent,
    DeadLetter,
    Canceled,
}

impl EmailOutboxState {
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        self as u8 == next as u8
            || matches!(
                (self, next),
                (
                    Self::Pending | Self::RetryWait,
                    Self::Sending | Self::Canceled
                ) | (Self::RetryWait, Self::DeadLetter)
                    | (
                        Self::Sending,
                        Self::Sent | Self::RetryWait | Self::DeadLetter | Self::Canceled
                    )
            )
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Sent | Self::DeadLetter | Self::Canceled)
    }

    #[must_use]
    pub const fn permits_notification_retention(self) -> bool {
        self.is_terminal()
    }
}

#[derive(Clone, PartialEq)]
pub struct NotificationPayload(Value);

impl NotificationPayload {
    pub fn new(value: Value) -> Result<Self, NotificationValidationError> {
        if !value.is_object() {
            return Err(NotificationValidationError::InvalidPayload);
        }
        let mut nodes = 0;
        validate_payload_value(&value, 0, &mut nodes)?;
        let encoded =
            serde_json::to_vec(&value).map_err(|_| NotificationValidationError::InvalidPayload)?;
        if encoded.len() > MAX_PAYLOAD_BYTES {
            return Err(NotificationValidationError::PayloadTooLarge);
        }
        Ok(Self(value))
    }

    pub(super) const fn value(&self) -> &Value {
        &self.0
    }
}

impl fmt::Debug for NotificationPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NotificationPayload([REDACTED])")
    }
}

#[derive(Clone, PartialEq)]
pub struct NotificationFields {
    pub id: NotificationId,
    pub recipient_user_id: UserId,
    pub classification: NotificationClassification,
    pub event_code: String,
    pub template_id: String,
    pub locale: String,
    pub resource_type: String,
    pub resource_id: String,
    pub rendering_data: NotificationPayload,
    pub requires_action: bool,
    pub occurred_at: Timestamp,
}

#[derive(Clone, PartialEq)]
pub struct Notification(NotificationFields);

impl Notification {
    pub fn new(fields: NotificationFields) -> Result<Self, NotificationValidationError> {
        validate_code(&fields.event_code, 128)?;
        validate_code(&fields.template_id, 128)?;
        validate_locale(&fields.locale)?;
        validate_code(&fields.resource_type, 64)?;
        validate_resource_id(&fields.resource_id)?;
        Ok(Self(fields))
    }

    #[must_use]
    pub const fn id(&self) -> NotificationId {
        self.0.id
    }

    #[must_use]
    pub const fn classification(&self) -> NotificationClassification {
        self.0.classification
    }

    pub(super) const fn fields(&self) -> &NotificationFields {
        &self.0
    }
}

impl fmt::Debug for Notification {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Notification")
            .field("id", &self.0.id)
            .field("recipient_user_id", &self.0.recipient_user_id)
            .field("classification", &self.0.classification)
            .field("event_code", &self.0.event_code)
            .field("template_id", &self.0.template_id)
            .field("resource_type", &self.0.resource_type)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq)]
pub struct NotificationDelivery {
    notification: Notification,
    email_outbox_id: Option<EmailOutboxId>,
    recipient_email: Option<NormalizedEmail>,
}

impl NotificationDelivery {
    pub fn new(
        notification: Notification,
        smtp_configured: bool,
        preference: EmailChannelPreference,
        email_outbox_id: Option<EmailOutboxId>,
        recipient_email: Option<NormalizedEmail>,
    ) -> Result<Self, NotificationValidationError> {
        let enqueue_email = notification
            .classification()
            .should_enqueue_email(smtp_configured, preference);
        if enqueue_email != email_outbox_id.is_some() || enqueue_email != recipient_email.is_some()
        {
            return Err(NotificationValidationError::EmailChannelMismatch);
        }
        Ok(Self {
            notification,
            email_outbox_id,
            recipient_email,
        })
    }

    #[must_use]
    pub const fn notification(&self) -> &Notification {
        &self.notification
    }

    #[must_use]
    pub const fn has_email(&self) -> bool {
        self.email_outbox_id.is_some()
    }

    pub(super) const fn email(&self) -> Option<(EmailOutboxId, &NormalizedEmail)> {
        match (self.email_outbox_id, self.recipient_email.as_ref()) {
            (Some(id), Some(email)) => Some((id, email)),
            _ => None,
        }
    }
}

impl fmt::Debug for NotificationDelivery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationDelivery")
            .field("notification", &self.notification)
            .field("email_outbox_id", &self.email_outbox_id)
            .field(
                "recipient_email",
                &self.recipient_email.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum NotificationValidationError {
    InvalidIdentifier,
    InvalidCode,
    InvalidLocale,
    InvalidResource,
    InvalidPayload,
    SensitivePayload,
    PayloadTooLarge,
    EmailChannelMismatch,
}

impl fmt::Display for NotificationValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "invalid notification identifier",
            Self::InvalidCode => "invalid notification code",
            Self::InvalidLocale => "invalid notification locale",
            Self::InvalidResource => "invalid notification resource",
            Self::InvalidPayload => "invalid notification rendering data",
            Self::SensitivePayload => "notification rendering data contains a sensitive field",
            Self::PayloadTooLarge => "notification rendering data exceeds its bound",
            Self::EmailChannelMismatch => "notification email channel does not match policy",
        })
    }
}

impl std::error::Error for NotificationValidationError {}

fn validate_code(value: &str, max: usize) -> Result<(), NotificationValidationError> {
    let mut characters = value.chars();
    if !(1..=max).contains(&value.len())
        || !characters
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        || !characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
    {
        return Err(NotificationValidationError::InvalidCode);
    }
    Ok(())
}

fn validate_locale(value: &str) -> Result<(), NotificationValidationError> {
    let parts: Vec<_> = value.split('-').collect();
    let valid_language = parts.first().is_some_and(|part| {
        (2..=3).contains(&part.len())
            && part
                .chars()
                .all(|character| character.is_ascii_alphabetic())
    });
    let valid_suffixes = (1..=3).contains(&parts.len())
        && parts.iter().skip(1).all(|part| {
            (2..=8).contains(&part.len())
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        });
    if !valid_language || !valid_suffixes {
        return Err(NotificationValidationError::InvalidLocale);
    }
    Ok(())
}

fn validate_resource_id(value: &str) -> Result<(), NotificationValidationError> {
    if value != value.trim()
        || !(1..=200).contains(&value.chars().count())
        || value.chars().any(char::is_control)
    {
        return Err(NotificationValidationError::InvalidResource);
    }
    Ok(())
}

fn validate_payload_value(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), NotificationValidationError> {
    if depth > MAX_PAYLOAD_DEPTH {
        return Err(NotificationValidationError::InvalidPayload);
    }
    *nodes = nodes
        .checked_add(1)
        .ok_or(NotificationValidationError::InvalidPayload)?;
    if *nodes > MAX_PAYLOAD_NODES {
        return Err(NotificationValidationError::InvalidPayload);
    }
    match value {
        Value::Object(entries) => {
            for (key, child) in entries {
                if is_sensitive_key(key) {
                    return Err(NotificationValidationError::SensitivePayload);
                }
                validate_payload_value(child, depth + 1, nodes)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                validate_payload_value(child, depth + 1, nodes)?;
            }
        }
        Value::String(value) if value.len() > 4_096 => {
            return Err(NotificationValidationError::PayloadTooLarge);
        }
        _ => {}
    }
    Ok(())
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['.', '-'], "_");
    let compact: String = normalized
        .chars()
        .filter(|character| *character != '_')
        .collect();
    normalized.split('_').any(|part| {
        matches!(
            part,
            "authorization"
                | "cookie"
                | "credential"
                | "password"
                | "secret"
                | "session"
                | "token"
                | "totp"
        )
    }) || [
        "authorization",
        "cookie",
        "credential",
        "password",
        "secret",
        "session",
        "token",
        "totp",
        "recoverycode",
        "activationurl",
        "fallbackurl",
    ]
    .iter()
    .any(|sensitive| compact.contains(sensitive))
}
