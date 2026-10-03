mod adapter;
mod config;
mod error;
mod redaction;
mod types;

pub use adapter::{ObjectStoreBuildError, S3ObjectStore};
pub use config::{
    AddressingStyle, CaBundle, CredentialProvider, ObjectStorageConfig, ObjectStorageConfigError,
    ObjectStorageConfigSnapshot, StaticCredentials, TlsTrust,
};
pub use error::{ObjectOperation, ObjectStoreError, ObjectStoreErrorKind};
pub use redaction::SensitiveUrl;
pub use types::{
    ByteRange, ContinuationToken, GetResult, ListPage, ListRequest, ObjectKey, ObjectMetadata,
    ObjectPrefix, ObjectSummary, OperationLimits, PutRequest, RequestValidationError,
};

#[cfg(test)]
mod tests;
