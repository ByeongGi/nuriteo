use std::fmt;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{ObjectKey, RequestValidationError, SensitiveUrl};

pub const MIN_MULTIPART_PART_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_MULTIPART_PART_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_MULTIPART_PARTS: u16 = 128;
const MIN_PRESIGN_MINUTES: u16 = 5;
const MAX_PRESIGN_MINUTES: u16 = 60;
const PROBE_ROOT: &str = "__nuriteo_probe__/";

#[derive(Clone, PartialEq, Eq)]
pub struct Sha256Checksum([u8; 32]);

impl Sha256Checksum {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn calculate(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    pub(crate) fn from_base64(value: &str) -> Result<Self, CapabilityValidationError> {
        let bytes = BASE64
            .decode(value)
            .map_err(|_| CapabilityValidationError::InvalidChecksum)?;
        let digest = bytes
            .try_into()
            .map_err(|_| CapabilityValidationError::InvalidChecksum)?;
        Ok(Self(digest))
    }

    pub(crate) fn base64(&self) -> String {
        BASE64.encode(self.0)
    }

    pub(crate) const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for Sha256Checksum {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Sha256Checksum([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PresignExpiry(Duration);

impl PresignExpiry {
    pub fn minutes(minutes: u16) -> Result<Self, CapabilityValidationError> {
        if !(MIN_PRESIGN_MINUTES..=MAX_PRESIGN_MINUTES).contains(&minutes) {
            return Err(CapabilityValidationError::InvalidExpiry);
        }
        Ok(Self(Duration::from_secs(u64::from(minutes) * 60)))
    }

    pub(crate) const fn duration(self) -> Duration {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresignedOperation {
    Get,
    Put,
}

#[derive(Clone)]
pub struct BoundedPresignedRequest {
    pub(crate) operation: PresignedOperation,
    pub(crate) url: SensitiveUrl,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) expected_body_bytes: Option<u64>,
    pub(crate) maximum_response_bytes: u64,
}

impl fmt::Debug for BoundedPresignedRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoundedPresignedRequest")
            .field("operation", &self.operation)
            .field("url", &self.url)
            .field("signed_header_count", &self.headers.len())
            .field("expected_body_bytes", &self.expected_body_bytes)
            .field("maximum_response_bytes", &self.maximum_response_bytes)
            .finish()
    }
}

impl BoundedPresignedRequest {
    #[must_use]
    pub const fn operation(&self) -> PresignedOperation {
        self.operation
    }

    /// Returns the bearer URL for delivery to the already-authorized caller.
    /// Callers must keep it out of logs, metrics, errors, analytics, and snapshots.
    #[must_use]
    pub fn expose_bearer_url(&self) -> &str {
        self.url.expose_bearer_url().as_str()
    }

    pub fn signed_headers(&self) -> impl Iterator<Item = (&str, &str)> {
        self.headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}

#[derive(Clone)]
pub struct PresignedPutRequest {
    pub key: ObjectKey,
    pub content_length: u64,
    pub content_type: String,
    pub checksum: Sha256Checksum,
    pub expiry: PresignExpiry,
}

impl fmt::Debug for PresignedPutRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PresignedPutRequest")
            .field("key", &self.key)
            .field("content_length", &self.content_length)
            .field("content_type_configured", &true)
            .field("checksum", &self.checksum)
            .field("expiry", &self.expiry)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MultipartLimits {
    part_size_bytes: usize,
}

impl MultipartLimits {
    pub fn new(part_size_bytes: usize) -> Result<Self, CapabilityValidationError> {
        if !(MIN_MULTIPART_PART_BYTES..=MAX_MULTIPART_PART_BYTES).contains(&part_size_bytes) {
            return Err(CapabilityValidationError::InvalidPartSize);
        }
        Ok(Self { part_size_bytes })
    }

    #[must_use]
    pub const fn part_size_bytes(&self) -> usize {
        self.part_size_bytes
    }

    pub fn validate_payload(&self, payload_bytes: u64) -> Result<u16, CapabilityValidationError> {
        if payload_bytes == 0 {
            return Err(CapabilityValidationError::InvalidPayloadSize);
        }
        let part_size = self.part_size_bytes as u64;
        let parts = payload_bytes
            .checked_add(part_size - 1)
            .ok_or(CapabilityValidationError::InvalidPayloadSize)?
            / part_size;
        u16::try_from(parts)
            .ok()
            .filter(|count| *count <= MAX_MULTIPART_PARTS)
            .ok_or(CapabilityValidationError::TooManyParts)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct MultipartUpload {
    pub(crate) key: ObjectKey,
    pub(crate) upload_id: String,
}

impl MultipartUpload {
    pub(crate) fn upload_id(&self) -> &str {
        &self.upload_id
    }
}

impl fmt::Debug for MultipartUpload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultipartUpload")
            .field("key", &self.key)
            .field("upload_id", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone)]
pub struct MultipartPartRequest {
    pub upload: MultipartUpload,
    pub part_number: u16,
    pub body: Bytes,
    pub final_part: bool,
    pub checksum: Sha256Checksum,
}

#[derive(Clone)]
pub struct PresignedMultipartPartRequest {
    pub(crate) upload: MultipartUpload,
    pub(crate) part_number: u16,
    pub(crate) content_length: u64,
    pub(crate) checksum: Sha256Checksum,
    pub(crate) expiry: PresignExpiry,
}

impl PresignedMultipartPartRequest {
    pub(crate) fn new(
        upload: MultipartUpload,
        part_number: u16,
        content_length: u64,
        checksum: Sha256Checksum,
        expiry: PresignExpiry,
    ) -> Result<Self, CapabilityValidationError> {
        if part_number == 0
            || part_number > MAX_MULTIPART_PARTS
            || content_length == 0
            || content_length > MAX_MULTIPART_PART_BYTES as u64
        {
            return Err(CapabilityValidationError::InvalidPartSize);
        }
        Ok(Self {
            upload,
            part_number,
            content_length,
            checksum,
            expiry,
        })
    }
}

impl fmt::Debug for PresignedMultipartPartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PresignedMultipartPartRequest")
            .field("upload", &self.upload)
            .field("part_number", &self.part_number)
            .field("content_length", &self.content_length)
            .field("checksum", &self.checksum)
            .field("expiry", &self.expiry)
            .finish()
    }
}

impl fmt::Debug for MultipartPartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MultipartPartRequest")
            .field("upload", &self.upload)
            .field("part_number", &self.part_number)
            .field("body_bytes", &self.body.len())
            .field("final_part", &self.final_part)
            .field("checksum", &self.checksum)
            .finish()
    }
}

impl MultipartPartRequest {
    pub(crate) fn validate(
        &self,
        limits: &MultipartLimits,
    ) -> Result<(), CapabilityValidationError> {
        if self.part_number == 0 || self.part_number > MAX_MULTIPART_PARTS {
            return Err(CapabilityValidationError::InvalidPartNumber);
        }
        let length = self.body.len();
        if length == 0
            || length > limits.part_size_bytes
            || (!self.final_part && length != limits.part_size_bytes)
            || self.checksum != Sha256Checksum::calculate(&self.body)
        {
            return Err(CapabilityValidationError::InvalidPartSize);
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct UploadedPart {
    pub(crate) part_number: u16,
    pub(crate) e_tag: String,
    pub(crate) checksum: Sha256Checksum,
}

impl fmt::Debug for UploadedPart {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadedPart")
            .field("part_number", &self.part_number)
            .field("e_tag", &"[OPAQUE]")
            .field("checksum", &self.checksum)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProbePrefix(String);

impl ProbePrefix {
    #[must_use]
    pub fn new(run_id: Uuid) -> Self {
        Self(format!("{PROBE_ROOT}{run_id}/"))
    }

    pub(crate) fn object(&self, suffix: &str) -> Result<ObjectKey, RequestValidationError> {
        ObjectKey::parse(format!("{}{suffix}", self.0))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProbePrefix {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProbePrefix([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct BackendIdentifier(String);

impl BackendIdentifier {
    pub(crate) fn from_endpoint(endpoint: &str) -> Self {
        let digest = Sha256::digest(endpoint.as_bytes());
        let mut value = String::with_capacity(19);
        value.push_str("s3-");
        for byte in &digest[..8] {
            use std::fmt::Write as _;
            let _ = write!(value, "{byte:02x}");
        }
        Self(value)
    }
}

impl fmt::Debug for BackendIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BackendIdentifier")
            .field(&self.0)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityState {
    Supported,
    Unsupported,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CapabilityReport {
    pub backend: BackendIdentifier,
    pub checked_at_unix_seconds: u64,
    pub server_release: String,
    pub checksum: CapabilityState,
    pub presigned_get: CapabilityState,
    pub presigned_put: CapabilityState,
    pub multipart_complete: CapabilityState,
    pub multipart_abort: CapabilityState,
    pub cleanup: CapabilityState,
    pub orphan_warning: bool,
}

impl CapabilityReport {
    #[must_use]
    pub const fn is_compatible(&self) -> bool {
        matches!(self.checksum, CapabilityState::Supported)
            && matches!(self.presigned_get, CapabilityState::Supported)
            && matches!(self.presigned_put, CapabilityState::Supported)
            && matches!(self.multipart_complete, CapabilityState::Supported)
            && matches!(self.multipart_abort, CapabilityState::Supported)
            && matches!(self.cleanup, CapabilityState::Supported)
            && !self.orphan_warning
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityValidationError {
    InvalidExpiry,
    InvalidChecksum,
    InvalidPartSize,
    InvalidPartNumber,
    InvalidPayloadSize,
    TooManyParts,
    InvalidPartSequence,
}

impl fmt::Display for CapabilityValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidExpiry => "presigned expiry must be between 5 and 60 minutes",
            Self::InvalidChecksum => "SHA-256 checksum is invalid",
            Self::InvalidPartSize => "multipart part size is invalid",
            Self::InvalidPartNumber => "multipart part number is invalid",
            Self::InvalidPayloadSize => "multipart payload size is invalid",
            Self::TooManyParts => "multipart payload exceeds 128 parts",
            Self::InvalidPartSequence => "multipart parts must be consecutive from one",
        })
    }
}

impl std::error::Error for CapabilityValidationError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_expiry_and_multipart_bounds_table() {
        for value in [0, 4, 61, u16::MAX] {
            assert_eq!(
                PresignExpiry::minutes(value),
                Err(CapabilityValidationError::InvalidExpiry)
            );
        }
        assert!(PresignExpiry::minutes(5).is_ok());
        assert!(PresignExpiry::minutes(60).is_ok());

        for value in [
            0,
            MIN_MULTIPART_PART_BYTES - 1,
            MAX_MULTIPART_PART_BYTES + 1,
        ] {
            assert_eq!(
                MultipartLimits::new(value),
                Err(CapabilityValidationError::InvalidPartSize)
            );
        }
        let limits = MultipartLimits::new(MIN_MULTIPART_PART_BYTES).unwrap();
        assert_eq!(
            limits.validate_payload((MIN_MULTIPART_PART_BYTES as u64) * 129),
            Err(CapabilityValidationError::TooManyParts)
        );

        let body = Bytes::from_static(b"final");
        for part_number in [0, MAX_MULTIPART_PARTS + 1] {
            let request = MultipartPartRequest {
                upload: MultipartUpload {
                    key: ObjectKey::parse("__nuriteo_probe__/test/part").unwrap(),
                    upload_id: "opaque".to_owned(),
                },
                part_number,
                checksum: Sha256Checksum::calculate(&body),
                body: body.clone(),
                final_part: true,
            };
            assert_eq!(
                request.validate(&limits),
                Err(CapabilityValidationError::InvalidPartNumber)
            );
        }
    }

    #[test]
    fn sensitive_capability_types_are_redacted() {
        let upload = MultipartUpload {
            key: ObjectKey::parse("__nuriteo_probe__/private/object").unwrap(),
            upload_id: "private-upload-id".to_owned(),
        };
        let checksum = Sha256Checksum::calculate(b"private-payload");
        let part = UploadedPart {
            part_number: 1,
            e_tag: "private-etag".to_owned(),
            checksum,
        };
        let rendered = format!("{upload:?} {part:?}");
        for prohibited in [
            "private/object",
            "private-upload-id",
            "private-etag",
            "private-payload",
        ] {
            assert!(!rendered.contains(prohibited));
        }
    }

    #[test]
    fn report_serialization_has_only_safe_fields() {
        let report = CapabilityReport {
            backend: BackendIdentifier::from_endpoint("https://secret.example.test"),
            checked_at_unix_seconds: 1,
            server_release: "test".to_owned(),
            checksum: CapabilityState::Supported,
            presigned_get: CapabilityState::Failed,
            presigned_put: CapabilityState::Unsupported,
            multipart_complete: CapabilityState::Supported,
            multipart_abort: CapabilityState::Supported,
            cleanup: CapabilityState::Supported,
            orphan_warning: false,
        };
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("secret.example.test"));
        assert!(!serialized.contains("X-Amz-Signature"));
        assert!(!serialized.contains("object"));
    }

    #[test]
    fn cleanup_failure_or_orphan_always_fails_compatibility() {
        let compatible = CapabilityReport {
            backend: BackendIdentifier::from_endpoint("https://safe.example.test"),
            checked_at_unix_seconds: 1,
            server_release: "test".to_owned(),
            checksum: CapabilityState::Supported,
            presigned_get: CapabilityState::Supported,
            presigned_put: CapabilityState::Supported,
            multipart_complete: CapabilityState::Supported,
            multipart_abort: CapabilityState::Supported,
            cleanup: CapabilityState::Supported,
            orphan_warning: false,
        };
        assert!(compatible.is_compatible());

        for (cleanup, orphan_warning) in [
            (CapabilityState::Failed, false),
            (CapabilityState::Supported, true),
        ] {
            let mut report = compatible.clone();
            report.cleanup = cleanup;
            report.orphan_warning = orphan_warning;
            assert!(!report.is_compatible());
        }
    }
}
