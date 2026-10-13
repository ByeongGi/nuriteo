use crate::config::{Config, Environment, FileReader};
use crate::object_storage::{
    CapabilityReport, ObjectStorageConfig, ObjectStoreErrorKind, OperationLimits, ProbePrefix,
    S3ObjectStore,
};
use uuid::Uuid;

const SAVE_UPLOAD_TRANSPORT: &str = "NURITEO_SAVE_UPLOAD_TRANSPORT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StorageCheckTransport {
    Relay,
    Direct,
}

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
    CorsMismatch,
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
            Self::CorsMismatch => "browser-upload-cors-mismatch",
        }
    }
}

pub(crate) async fn execute(
    environment: &impl Environment,
    files: &impl FileReader,
) -> Result<CapabilityReport, StorageCheckError> {
    let transport = storage_check_transport(environment)?;
    let config = ObjectStorageConfig::load(environment, files)
        .map_err(|_| StorageCheckError::StorageConfiguration)?;
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .map_err(|_| StorageCheckError::StorageInitialization)?;
    store
        .check_readiness()
        .await
        .map_err(|error| readiness_error(error.kind()))?;
    let prefix = ProbePrefix::new(Uuid::new_v4());
    if transport == StorageCheckTransport::Direct {
        let global = Config::load(environment, files)
            .map_err(|_| StorageCheckError::Configuration)?
            .config;
        store
            .check_browser_upload_cors(&global.public.external_url)
            .await
            .map_err(|_| StorageCheckError::CorsMismatch)?;
        store
            .probe_browser_upload_cors(&global.public.external_url, &prefix)
            .await
            .map_err(|_| StorageCheckError::CorsMismatch)?;
    }

    Ok(store.probe_capabilities(&prefix).await)
}

fn storage_check_transport(
    environment: &impl Environment,
) -> Result<StorageCheckTransport, StorageCheckError> {
    let value = environment
        .entries()
        .into_iter()
        .find(|(name, _)| name == SAVE_UPLOAD_TRANSPORT)
        .ok_or(StorageCheckError::Configuration)?
        .1
        .into_string()
        .map_err(|_| StorageCheckError::Configuration)?;
    match value.as_str() {
        "relay" => Ok(StorageCheckTransport::Relay),
        "direct" => Ok(StorageCheckTransport::Direct),
        _ => Err(StorageCheckError::Configuration),
    }
}

pub(crate) async fn configure_browser_upload_cors(
    environment: &impl Environment,
    files: &impl FileReader,
) -> Result<(), StorageCheckError> {
    let global = Config::load(environment, files)
        .map_err(|_| StorageCheckError::Configuration)?
        .config;
    let config = ObjectStorageConfig::load(environment, files)
        .map_err(|_| StorageCheckError::StorageConfiguration)?;
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .map_err(|_| StorageCheckError::StorageInitialization)?;
    store
        .check_readiness()
        .await
        .map_err(|error| readiness_error(error.kind()))?;
    store
        .configure_browser_upload_cors(&global.public.external_url)
        .await
        .map_err(|_| StorageCheckError::CorsMismatch)?;
    Ok(())
}

const fn readiness_error(kind: ObjectStoreErrorKind) -> StorageCheckError {
    match kind {
        ObjectStoreErrorKind::NotFound => StorageCheckError::BucketMissing,
        ObjectStoreErrorKind::Authentication => StorageCheckError::Authentication,
        ObjectStoreErrorKind::Authorization => StorageCheckError::Authorization,
        ObjectStoreErrorKind::Timeout => StorageCheckError::Timeout,
        ObjectStoreErrorKind::Unavailable
        | ObjectStoreErrorKind::ResponseUnknown
        | ObjectStoreErrorKind::Throttled => StorageCheckError::Unavailable,
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
    use std::ffi::OsString;

    use super::*;

    struct TestEnvironment(Vec<(OsString, OsString)>);

    impl Environment for TestEnvironment {
        fn entries(&self) -> Vec<(OsString, OsString)> {
            self.0.clone()
        }
    }

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

    #[test]
    fn upload_transport_is_required_and_exact() {
        for (value, expected) in [
            ("relay", StorageCheckTransport::Relay),
            ("direct", StorageCheckTransport::Direct),
        ] {
            let environment = TestEnvironment(vec![(SAVE_UPLOAD_TRANSPORT.into(), value.into())]);
            assert_eq!(storage_check_transport(&environment), Ok(expected));
        }

        for entries in [
            vec![],
            vec![(SAVE_UPLOAD_TRANSPORT.into(), OsString::new())],
            vec![(SAVE_UPLOAD_TRANSPORT.into(), "Relay".into())],
            vec![(SAVE_UPLOAD_TRANSPORT.into(), "unknown".into())],
        ] {
            assert_eq!(
                storage_check_transport(&TestEnvironment(entries)),
                Err(StorageCheckError::Configuration)
            );
        }
    }
}
