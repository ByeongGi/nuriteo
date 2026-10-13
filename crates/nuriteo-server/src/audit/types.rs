use std::collections::BTreeSet;
use std::fmt;
use std::net::IpAddr;
use std::str::FromStr;

use serde_json::Value;
use uuid::{Uuid, Variant, Version};

use crate::identity::{Timestamp, UserId};

const MAX_METADATA_BYTES: usize = 16_384;
const MAX_METADATA_DEPTH: usize = 8;
const MAX_METADATA_NODES: usize = 256;
const MAX_CHANGED_FIELDS: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AuditEventId(Uuid);

impl AuditEventId {
    #[allow(
        clippy::new_without_default,
        reason = "identifier generation is side-effectful and must remain explicit"
    )]
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, AuditValidationError> {
        if value.is_nil() {
            return Err(AuditValidationError::InvalidIdentifier);
        }
        if value.get_version() != Some(Version::SortRand) || value.get_variant() != Variant::RFC4122
        {
            return Err(AuditValidationError::InvalidIdentifier);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn into_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Debug for AuditEventId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AuditEventId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for AuditEventId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for AuditEventId {
    type Err = AuditValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value)
            .map_err(|_| AuditValidationError::InvalidIdentifier)
            .and_then(Self::from_uuid)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorType {
    User,
    System,
    Bootstrap,
    BackgroundJob,
    Cli,
}

impl ActorType {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::System => "system",
            Self::Bootstrap => "bootstrap",
            Self::BackgroundJob => "background_job",
            Self::Cli => "cli",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditActor {
    pub kind: ActorType,
    pub id: String,
    pub user_id: Option<UserId>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditTarget {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeType {
    Instance,
    Workspace,
    Organization,
    Project,
    User,
}

impl ScopeType {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Instance => "instance",
            Self::Workspace => "workspace",
            Self::Organization => "organization",
            Self::Project => "project",
            Self::User => "user",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditScope {
    pub kind: ScopeType,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditResult {
    Succeeded,
    Denied,
    Failed,
}

impl AuditResult {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Denied => "denied",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct AuditMetadata(Value);

impl AuditMetadata {
    pub fn new(value: Value) -> Result<Self, AuditValidationError> {
        if !value.is_object() {
            return Err(AuditValidationError::InvalidMetadata);
        }

        let mut nodes = 0;
        validate_metadata_value(&value, 0, &mut nodes)?;
        let encoded =
            serde_json::to_vec(&value).map_err(|_| AuditValidationError::InvalidMetadata)?;
        if encoded.len() > MAX_METADATA_BYTES {
            return Err(AuditValidationError::MetadataTooLarge);
        }
        Ok(Self(value))
    }

    pub(super) const fn value(&self) -> &Value {
        &self.0
    }
}

impl fmt::Debug for AuditMetadata {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuditMetadata([REDACTED])")
    }
}

#[derive(Clone, PartialEq)]
pub struct AuditEventFields {
    pub id: AuditEventId,
    pub occurred_at: Timestamp,
    pub actor: AuditActor,
    pub action_code: String,
    pub target: AuditTarget,
    pub scope: AuditScope,
    pub result: AuditResult,
    pub reason_code: Option<String>,
    pub correlation_id: String,
    pub source_ip: Option<IpAddr>,
    pub schema_version: i32,
    pub changed_fields: Vec<String>,
    pub metadata: AuditMetadata,
}

impl fmt::Debug for AuditEventFields {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuditEventFields")
            .field("id", &self.id)
            .field("occurred_at", &self.occurred_at)
            .field("actor_type", &self.actor.kind)
            .field("action_code", &self.action_code)
            .field("target_type", &self.target.kind)
            .field("scope_type", &self.scope.kind)
            .field("result", &self.result)
            .field("schema_version", &self.schema_version)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq)]
pub struct AuditEvent(AuditEventFields);

impl AuditEvent {
    pub fn new(fields: AuditEventFields) -> Result<Self, AuditValidationError> {
        validate_actor(&fields.actor)?;
        validate_code(
            &fields.action_code,
            128,
            AuditValidationError::InvalidAction,
        )?;
        validate_code(&fields.target.kind, 64, AuditValidationError::InvalidTarget)?;
        validate_bounded_text(&fields.target.id, 200, AuditValidationError::InvalidTarget)?;
        validate_bounded_text(&fields.scope.id, 200, AuditValidationError::InvalidScope)?;
        if let Some(reason) = fields.reason_code.as_deref() {
            validate_reason(reason)?;
        }
        validate_correlation(&fields.correlation_id)?;
        if fields.schema_version < 1 {
            return Err(AuditValidationError::InvalidSchemaVersion);
        }
        validate_changed_fields(&fields.changed_fields)?;
        Ok(Self(fields))
    }

    pub(super) const fn fields(&self) -> &AuditEventFields {
        &self.0
    }
}

impl fmt::Debug for AuditEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuditEvent")
            .field("id", &self.0.id)
            .field("actor_type", &self.0.actor.kind)
            .field("action_code", &self.0.action_code)
            .field("target_type", &self.0.target.kind)
            .field("scope_type", &self.0.scope.kind)
            .field("result", &self.0.result)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AuditValidationError {
    InvalidIdentifier,
    InvalidActor,
    InvalidAction,
    InvalidTarget,
    InvalidScope,
    InvalidReason,
    InvalidCorrelation,
    InvalidSchemaVersion,
    InvalidChangedFields,
    InvalidMetadata,
    SensitiveMetadata,
    MetadataTooLarge,
}

impl fmt::Display for AuditValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "invalid audit identifier",
            Self::InvalidActor => "invalid audit actor",
            Self::InvalidAction => "invalid audit action",
            Self::InvalidTarget => "invalid audit target",
            Self::InvalidScope => "invalid audit scope",
            Self::InvalidReason => "invalid audit reason",
            Self::InvalidCorrelation => "invalid audit correlation",
            Self::InvalidSchemaVersion => "invalid audit schema version",
            Self::InvalidChangedFields => "invalid audit changed fields",
            Self::InvalidMetadata => "invalid audit metadata",
            Self::SensitiveMetadata => "audit metadata contains disallowed sensitive input",
            Self::MetadataTooLarge => "audit metadata exceeds the size limit",
        })
    }
}

impl std::error::Error for AuditValidationError {}

fn validate_actor(actor: &AuditActor) -> Result<(), AuditValidationError> {
    validate_bounded_text(&actor.id, 200, AuditValidationError::InvalidActor)?;
    if let Some(display_name) = actor.display_name.as_deref() {
        validate_bounded_text(display_name, 200, AuditValidationError::InvalidActor)?;
    }
    match (actor.kind, actor.user_id) {
        (ActorType::User, Some(user_id)) if actor.id == user_id.to_string() => Ok(()),
        (ActorType::User, _) | (_, Some(_)) => Err(AuditValidationError::InvalidActor),
        (_, None) => Ok(()),
    }
}

fn validate_bounded_text(
    value: &str,
    maximum: usize,
    error: AuditValidationError,
) -> Result<(), AuditValidationError> {
    let length = value.trim_matches(' ').chars().count();
    if value != value.trim_matches(' ')
        || !(1..=maximum).contains(&length)
        || value.chars().any(char::is_control)
    {
        return Err(error);
    }
    Ok(())
}

fn validate_code(
    value: &str,
    maximum: usize,
    error: AuditValidationError,
) -> Result<(), AuditValidationError> {
    let mut bytes = value.bytes();
    let valid = matches!(bytes.next(), Some(b'a'..=b'z'))
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
        && value.len() <= maximum;
    if valid { Ok(()) } else { Err(error) }
}

fn validate_reason(reason: &str) -> Result<(), AuditValidationError> {
    let mut bytes = reason.bytes();
    let valid = matches!(bytes.next(), Some(b'A'..=b'Z'))
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && reason.len() <= 64;
    if valid {
        Ok(())
    } else {
        Err(AuditValidationError::InvalidReason)
    }
}

fn validate_correlation(value: &str) -> Result<(), AuditValidationError> {
    let valid = (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(AuditValidationError::InvalidCorrelation)
    }
}

fn validate_changed_fields(fields: &[String]) -> Result<(), AuditValidationError> {
    if fields.len() > MAX_CHANGED_FIELDS {
        return Err(AuditValidationError::InvalidChangedFields);
    }
    let mut unique = BTreeSet::new();
    for field in fields {
        validate_code(field, 128, AuditValidationError::InvalidChangedFields)?;
        if !unique.insert(field) {
            return Err(AuditValidationError::InvalidChangedFields);
        }
    }
    Ok(())
}

fn validate_metadata_value(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), AuditValidationError> {
    if depth > MAX_METADATA_DEPTH || *nodes >= MAX_METADATA_NODES {
        return Err(AuditValidationError::InvalidMetadata);
    }
    *nodes += 1;

    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
                    return Err(AuditValidationError::InvalidMetadata);
                }
                if is_sensitive_text(key) {
                    return Err(AuditValidationError::SensitiveMetadata);
                }
                validate_metadata_value(child, depth + 1, nodes)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                validate_metadata_value(child, depth + 1, nodes)?;
            }
        }
        Value::String(text) if text.chars().any(char::is_control) => {
            return Err(AuditValidationError::InvalidMetadata);
        }
        Value::String(text) if is_sensitive_text(text) => {
            return Err(AuditValidationError::SensitiveMetadata);
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn is_sensitive_text(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    [
        "password",
        "passwd",
        "token",
        "secret",
        "credential",
        "authorization",
        "set-cookie",
        "cookie",
        "dsn",
        "private_key",
        "private-key",
        "api_key",
        "apikey",
        ".env",
        "bearer ",
        "basic ",
        "postgres://",
        "postgresql://",
        "mysql://",
        "mongodb://",
        "redis://",
        "x-amz-signature",
        "x-amz-credential",
        "x-goog-signature",
        "signature=",
        "awsaccesskeyid",
        "sig=",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}
