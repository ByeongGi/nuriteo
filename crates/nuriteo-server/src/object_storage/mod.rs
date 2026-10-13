mod adapter;
mod capability;
mod capability_types;
mod config;
mod cors;
mod error;
mod redaction;
mod streaming;
mod types;

pub use adapter::{ObjectStoreBuildError, S3ObjectStore};
pub(crate) use capability::MultipartReconcileOutcome;
pub use capability_types::{
    BackendIdentifier, BoundedPresignedRequest, CapabilityReport, CapabilityState,
    CapabilityValidationError, MAX_MULTIPART_PART_BYTES, MAX_MULTIPART_PARTS,
    MIN_MULTIPART_PART_BYTES, MultipartLimits, MultipartPartRequest, MultipartUpload,
    PresignExpiry, PresignedMultipartPartRequest, PresignedOperation, PresignedPutRequest,
    ProbePrefix, Sha256Checksum, UploadedPart,
};
pub use config::{
    AddressingStyle, CaBundle, CredentialProvider, ObjectStorageConfig, ObjectStorageConfigError,
    ObjectStorageConfigSnapshot, StaticCredentials, TlsTrust,
};
pub use cors::{BrowserUploadCorsCheck, BrowserUploadCorsError};
pub use error::{ObjectOperation, ObjectStoreError, ObjectStoreErrorKind};
pub use redaction::SensitiveUrl;
pub use streaming::{
    MAX_STREAMING_SINGLE_PUT_BYTES, StreamingMultipartPartRequest, StreamingPutRequest,
    UploadAbortHandle, UploadAbortSignal, UploadBody, UploadDeadlines, upload_abort_pair,
};
pub use types::{
    ByteRange, ContinuationToken, GetResult, ListPage, ListRequest, ObjectKey, ObjectMetadata,
    ObjectPrefix, ObjectSummary, OperationLimits, PutRequest, RequestValidationError,
};

#[cfg(test)]
mod tests;
