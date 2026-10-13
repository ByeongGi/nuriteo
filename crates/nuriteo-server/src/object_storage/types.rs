use std::fmt;
use std::num::NonZeroU16;
use std::pin::Pin;
use std::time::Duration;

use bytes::Bytes;
use tokio::io::AsyncRead;

const MAX_OBJECT_KEY_BYTES: usize = 1_024;
const MAX_PREFIX_BYTES: usize = 1_024;
const MAX_CONTENT_TYPE_BYTES: usize = 255;
const MAX_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, PartialEq, Eq)]
pub struct ObjectKey(String);

impl ObjectKey {
    pub fn parse(value: impl Into<String>) -> Result<Self, RequestValidationError> {
        let value = value.into();
        validate_name(&value, MAX_OBJECT_KEY_BYTES, false)?;
        Ok(Self(value))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ObjectKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ObjectKey([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ObjectPrefix(String);

impl ObjectPrefix {
    pub fn parse(value: impl Into<String>) -> Result<Self, RequestValidationError> {
        let value = value.into();
        validate_name(&value, MAX_PREFIX_BYTES, true)?;
        Ok(Self(value))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ObjectPrefix {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ObjectPrefix([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ContinuationToken(String);

impl ContinuationToken {
    pub(crate) fn from_service(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ContinuationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ContinuationToken([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    start: u64,
    end_inclusive: u64,
}

impl ByteRange {
    pub fn new(start: u64, end_inclusive: u64) -> Result<Self, RequestValidationError> {
        if start > end_inclusive
            || end_inclusive
                .checked_sub(start)
                .and_then(|length| length.checked_add(1))
                .is_none()
        {
            return Err(RequestValidationError::InvalidRange);
        }
        Ok(Self {
            start,
            end_inclusive,
        })
    }

    pub const fn len(self) -> u64 {
        self.end_inclusive - self.start + 1
    }

    pub const fn is_empty(self) -> bool {
        false
    }

    pub(crate) fn header_value(self) -> String {
        format!("bytes={}-{}", self.start, self.end_inclusive)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationLimits {
    pub max_body_bytes: u64,
    /// Maximum object size accepted by streaming consumers. This remains
    /// separate from buffered reads and presigned single-PUT capabilities.
    pub max_stream_bytes: u64,
    pub max_range_bytes: u64,
    pub max_list_page: NonZeroU16,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub attempt_timeout: Duration,
    pub max_attempts: u32,
}

impl Default for OperationLimits {
    fn default() -> Self {
        Self {
            max_body_bytes: 128 * 1024 * 1024,
            max_stream_bytes: 2 * 1024 * 1024 * 1024,
            max_range_bytes: 16 * 1024 * 1024,
            max_list_page: NonZeroU16::new(100).unwrap_or(NonZeroU16::MIN),
            connect_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(30),
            attempt_timeout: Duration::from_secs(15),
            max_attempts: 3,
        }
    }
}

impl OperationLimits {
    pub fn validate(&self) -> Result<(), RequestValidationError> {
        if self.max_body_bytes == 0 || self.max_body_bytes > 2 * 1024 * 1024 * 1024 {
            return Err(RequestValidationError::InvalidLimits);
        }
        if self.max_stream_bytes < self.max_body_bytes
            || self.max_stream_bytes > 2 * 1024 * 1024 * 1024
        {
            return Err(RequestValidationError::InvalidLimits);
        }
        if self.max_range_bytes == 0 || self.max_range_bytes > self.max_body_bytes {
            return Err(RequestValidationError::InvalidLimits);
        }
        if self.max_list_page.get() > 1_000
            || self.connect_timeout.is_zero()
            || self.connect_timeout > MAX_CONNECT_TIMEOUT
            || self.request_timeout.is_zero()
            || self.request_timeout > MAX_REQUEST_TIMEOUT
            || self.attempt_timeout.is_zero()
            || self.attempt_timeout > MAX_ATTEMPT_TIMEOUT
            || self.connect_timeout > self.attempt_timeout
            || self.attempt_timeout > self.request_timeout
            || !(1..=5).contains(&self.max_attempts)
        {
            return Err(RequestValidationError::InvalidLimits);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct PutRequest {
    pub key: ObjectKey,
    pub body: Bytes,
    pub content_type: Option<String>,
}

impl fmt::Debug for PutRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PutRequest")
            .field("key", &self.key)
            .field("body_bytes", &self.body.len())
            .field("content_type_configured", &self.content_type.is_some())
            .finish()
    }
}

impl PutRequest {
    pub fn validate(&self, limits: &OperationLimits) -> Result<(), RequestValidationError> {
        if self.body.len() as u64 > limits.max_body_bytes {
            return Err(RequestValidationError::BodyTooLarge);
        }
        if self.content_type.as_ref().is_some_and(|value| {
            value.is_empty()
                || value.len() > MAX_CONTENT_TYPE_BYTES
                || value.chars().any(char::is_control)
        }) {
            return Err(RequestValidationError::InvalidContentType);
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ListRequest {
    pub prefix: ObjectPrefix,
    pub continuation: Option<ContinuationToken>,
    pub page_size: NonZeroU16,
}

impl ListRequest {
    pub fn validate(&self, limits: &OperationLimits) -> Result<(), RequestValidationError> {
        if self.page_size > limits.max_list_page || self.page_size.get() > 1_000 {
            return Err(RequestValidationError::ListPageTooLarge);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectMetadata {
    pub content_length: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct GetResult {
    pub body: Bytes,
    pub metadata: ObjectMetadata,
}

pub(crate) struct ObjectStream {
    pub metadata: ObjectMetadata,
    pub reader: Pin<Box<dyn AsyncRead + Send>>,
}

impl fmt::Debug for ObjectStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ObjectStream")
            .field("metadata", &self.metadata)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for GetResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GetResult")
            .field("body_bytes", &self.body.len())
            .field("metadata", &self.metadata)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectSummary {
    pub key: ObjectKey,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListPage {
    pub objects: Vec<ObjectSummary>,
    pub next: Option<ContinuationToken>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestValidationError {
    InvalidName,
    InvalidRange,
    InvalidLimits,
    InvalidContentType,
    BodyTooLarge,
    ListPageTooLarge,
}

impl fmt::Display for RequestValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidName => "object name is invalid",
            Self::InvalidRange => "byte range is invalid",
            Self::InvalidLimits => "object storage operation limits are invalid",
            Self::InvalidContentType => "content type is invalid",
            Self::BodyTooLarge => "object body exceeds the configured limit",
            Self::ListPageTooLarge => "list page exceeds the configured limit",
        })
    }
}

impl std::error::Error for RequestValidationError {}

fn validate_name(
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<(), RequestValidationError> {
    if (!allow_empty && value.is_empty())
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(RequestValidationError::InvalidName);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_bounds_fail_closed_table() {
        let limits = OperationLimits {
            max_body_bytes: 8,
            max_range_bytes: 4,
            ..OperationLimits::default()
        };
        let oversized_body = PutRequest {
            key: ObjectKey::parse("bounded/object").unwrap(),
            body: Bytes::from(vec![0; usize::try_from(limits.max_body_bytes + 1).unwrap()]),
            content_type: None,
        };
        assert_eq!(
            oversized_body.validate(&limits),
            Err(RequestValidationError::BodyTooLarge)
        );

        for (name, value) in [
            ("empty", String::new()),
            ("control", "object\nname".to_owned()),
            ("too long", "x".repeat(MAX_OBJECT_KEY_BYTES + 1)),
        ] {
            assert_eq!(
                ObjectKey::parse(value),
                Err(RequestValidationError::InvalidName),
                "{name}"
            );
        }

        assert_eq!(
            ByteRange::new(9, 8),
            Err(RequestValidationError::InvalidRange)
        );
        assert_eq!(
            ByteRange::new(0, u64::MAX),
            Err(RequestValidationError::InvalidRange)
        );
    }

    #[test]
    fn sensitive_request_types_are_redacted() {
        let key = ObjectKey::parse("private/customer/object").unwrap();
        let prefix = ObjectPrefix::parse("private/customer").unwrap();
        let token = ContinuationToken::from_service("signed-continuation-material".to_owned());
        let put = PutRequest {
            key: key.clone(),
            body: Bytes::from_static(b"secret payload"),
            content_type: Some("application/octet-stream".to_owned()),
        };
        let rendered = format!("{key:?} {prefix:?} {token:?} {put:?}");
        for prohibited in [
            "private/customer/object",
            "private/customer",
            "signed-continuation-material",
            "secret payload",
        ] {
            assert!(!rendered.contains(prohibited));
        }
    }

    #[test]
    fn operation_limit_validation_is_table_driven() {
        let base = OperationLimits::default();
        let invalid = [
            OperationLimits {
                max_body_bytes: 0,
                ..base.clone()
            },
            OperationLimits {
                max_stream_bytes: base.max_body_bytes - 1,
                ..base.clone()
            },
            OperationLimits {
                max_range_bytes: base.max_body_bytes + 1,
                ..base.clone()
            },
            OperationLimits {
                max_list_page: NonZeroU16::new(1_001).unwrap(),
                ..base.clone()
            },
            OperationLimits {
                max_attempts: 6,
                ..base.clone()
            },
            OperationLimits {
                attempt_timeout: base.request_timeout + Duration::from_secs(1),
                ..base.clone()
            },
            OperationLimits {
                request_timeout: MAX_REQUEST_TIMEOUT + Duration::from_secs(1),
                ..base
            },
        ];
        for limits in invalid {
            assert_eq!(
                limits.validate(),
                Err(RequestValidationError::InvalidLimits)
            );
        }
    }
}
