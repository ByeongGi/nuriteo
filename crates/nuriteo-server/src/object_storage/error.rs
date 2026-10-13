use std::fmt;

use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectOperation {
    Put,
    Get,
    Head,
    Delete,
    List,
    Presign,
    Checksum,
    MultipartCreate,
    MultipartUpload,
    MultipartComplete,
    MultipartAbort,
    MultipartReconcile,
    Readiness,
    BrowserUploadCors,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectStoreErrorKind {
    NotFound,
    Authentication,
    Authorization,
    InvalidRequest,
    Conflict,
    Throttled,
    Timeout,
    Unavailable,
    ResponseUnknown,
    ResponseTooLarge,
    Unsupported,
    Integrity,
    Internal,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ObjectStoreError {
    operation: ObjectOperation,
    kind: ObjectStoreErrorKind,
    retryable: bool,
}

impl ObjectStoreError {
    pub(crate) const fn new(
        operation: ObjectOperation,
        kind: ObjectStoreErrorKind,
        retryable: bool,
    ) -> Self {
        Self {
            operation,
            kind,
            retryable,
        }
    }

    #[must_use]
    pub const fn operation(self) -> ObjectOperation {
        self.operation
    }

    #[must_use]
    pub const fn kind(self) -> ObjectStoreErrorKind {
        self.kind
    }

    #[must_use]
    pub const fn is_retryable(self) -> bool {
        self.retryable
    }
}

impl fmt::Debug for ObjectStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ObjectStoreError")
            .field("operation", &self.operation)
            .field("kind", &self.kind)
            .field("retryable", &self.retryable)
            .finish()
    }
}

impl fmt::Display for ObjectStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "object storage {:?} failed: {:?}",
            self.operation, self.kind
        )
    }
}

impl std::error::Error for ObjectStoreError {}

pub(crate) fn classify_sdk_error<E, R>(
    operation: ObjectOperation,
    error: &SdkError<E, R>,
) -> ObjectStoreError
where
    E: ProvideErrorMetadata,
{
    match error {
        SdkError::TimeoutError(_) => {
            ObjectStoreError::new(operation, ObjectStoreErrorKind::Timeout, true)
        }
        SdkError::DispatchFailure(failure) if failure.is_timeout() => {
            ObjectStoreError::new(operation, ObjectStoreErrorKind::Timeout, true)
        }
        SdkError::DispatchFailure(_) => {
            ObjectStoreError::new(operation, ObjectStoreErrorKind::Unavailable, true)
        }
        SdkError::ResponseError(_) => {
            ObjectStoreError::new(operation, ObjectStoreErrorKind::ResponseUnknown, true)
        }
        SdkError::ConstructionFailure(_) => {
            ObjectStoreError::new(operation, ObjectStoreErrorKind::Internal, false)
        }
        SdkError::ServiceError(service) => classify_service_code(operation, service.err().code()),
        _ => ObjectStoreError::new(operation, ObjectStoreErrorKind::Internal, false),
    }
}

fn classify_service_code(operation: ObjectOperation, code: Option<&str>) -> ObjectStoreError {
    let (kind, retryable) = match code.unwrap_or_default() {
        "NoSuchKey" | "NoSuchBucket" | "NoSuchUpload" | "NotFound" | "404" => {
            (ObjectStoreErrorKind::NotFound, false)
        }
        "InvalidAccessKeyId" | "InvalidToken" | "ExpiredToken" | "SignatureDoesNotMatch" => {
            (ObjectStoreErrorKind::Authentication, false)
        }
        "AccessDenied" | "AllAccessDisabled" => (ObjectStoreErrorKind::Authorization, false),
        "InvalidArgument" | "InvalidRange" | "MalformedXML" => {
            (ObjectStoreErrorKind::InvalidRequest, false)
        }
        "BucketNotEmpty" | "OperationAborted" => (ObjectStoreErrorKind::Conflict, false),
        "SlowDown" | "Throttling" | "ThrottlingException" | "TooManyRequestsException" => {
            (ObjectStoreErrorKind::Throttled, true)
        }
        "InternalError" | "RequestTimeout" | "ServiceUnavailable" => {
            (ObjectStoreErrorKind::Unavailable, true)
        }
        "NotImplemented" | "NotSupported" | "UnsupportedOperation" => {
            (ObjectStoreErrorKind::Unsupported, false)
        }
        _ => (ObjectStoreErrorKind::Internal, false),
    };
    ObjectStoreError::new(operation, kind, retryable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_errors_never_include_sensitive_context() {
        for error in [
            classify_service_code(ObjectOperation::Get, Some("NoSuchKey")),
            classify_service_code(ObjectOperation::Put, Some("SignatureDoesNotMatch")),
            classify_service_code(ObjectOperation::List, Some("SlowDown")),
            classify_service_code(ObjectOperation::Head, Some("unknown-sensitive-value")),
        ] {
            let rendered = format!("{error:?} {error}");
            for prohibited in [
                "object/private/key",
                "secret-access-key",
                "X-Amz-Signature",
                "unknown-sensitive-value",
            ] {
                assert!(!rendered.contains(prohibited));
            }
        }
    }
}
