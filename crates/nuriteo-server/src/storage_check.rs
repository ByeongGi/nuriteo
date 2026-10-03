use crate::config::{Config, Environment, FileReader};
use crate::object_storage::{
    CapabilityReport, ObjectStorageConfig, ObjectStoreErrorKind, OperationLimits, ProbePrefix,
    S3ObjectStore,
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StorageCheckError {
    Configuration,
    StorageConfiguration,
    StorageInitialization,
    BucketMissing,
    Authentication,
    Authorization,
    Timeout,
    Unavailable,
    Storage,
}

impl StorageCheckError {
    pub(crate) const fn category(self) -> &'static str {
        match self {
            Self::Configuration => "configuration",
            Self::StorageConfiguration => "storage-configuration",
            Self::StorageInitialization => "storage-initialization",
            Self::BucketMissing => "bucket-missing",
            Self::Authentication => "authentication",
            Self::Authorization => "authorization",
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
            Self::Storage => "storage",
        }
    }
}

pub(crate) async fn execute(
    environment: &impl Environment,
    files: &impl FileReader,
) -> Result<CapabilityReport, StorageCheckError> {
    Config::load(environment, files).map_err(|_| StorageCheckError::Configuration)?;
    let config = ObjectStorageConfig::load(environment, files)
        .map_err(|_| StorageCheckError::StorageConfiguration)?;
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .map_err(|_| StorageCheckError::StorageInitialization)?;
    store
        .check_readiness()
        .await
        .map_err(|error| readiness_error(error.kind()))?;

    Ok(store
        .probe_capabilities(&ProbePrefix::new(Uuid::new_v4()))
        .await)
}

const fn readiness_error(kind: ObjectStoreErrorKind) -> StorageCheckError {
    match kind {
        ObjectStoreErrorKind::NotFound => StorageCheckError::BucketMissing,
        ObjectStoreErrorKind::Authentication => StorageCheckError::Authentication,
        ObjectStoreErrorKind::Authorization => StorageCheckError::Authorization,
        ObjectStoreErrorKind::Timeout => StorageCheckError::Timeout,
        ObjectStoreErrorKind::Unavailable | ObjectStoreErrorKind::Throttled => {
            StorageCheckError::Unavailable
        }
        ObjectStoreErrorKind::InvalidRequest
        | ObjectStoreErrorKind::Conflict
        | ObjectStoreErrorKind::ResponseTooLarge
        | ObjectStoreErrorKind::Unsupported
        | ObjectStoreErrorKind::Integrity
        | ObjectStoreErrorKind::Internal => StorageCheckError::Storage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_failures_map_to_allowlisted_categories() {
        let cases = [
            (ObjectStoreErrorKind::NotFound, "bucket-missing"),
            (ObjectStoreErrorKind::Authentication, "authentication"),
            (ObjectStoreErrorKind::Authorization, "authorization"),
            (ObjectStoreErrorKind::Timeout, "timeout"),
            (ObjectStoreErrorKind::Throttled, "unavailable"),
            (ObjectStoreErrorKind::Unavailable, "unavailable"),
            (ObjectStoreErrorKind::Internal, "storage"),
        ];

        for (kind, expected) in cases {
            assert_eq!(readiness_error(kind).category(), expected);
        }
    }
}
