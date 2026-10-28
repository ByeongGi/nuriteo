use std::collections::BTreeMap;

use std::ffi::OsString;

use std::fmt;

use std::io::Cursor;

use std::net::IpAddr;

use std::path::Path;

use std::str::FromStr;

use std::time::Duration;

use aws_sdk_s3::Client;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};

use aws_sdk_s3::error::ProvideErrorMetadata;

use aws_sdk_s3::primitives::ByteStream;

use aws_sdk_s3::types::ServerSideEncryption;

use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};

use aws_smithy_http_client::tls::rustls_provider::CryptoMode;

use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};

use aws_smithy_types::retry::RetryConfig;

use aws_smithy_types::timeout::TimeoutConfig;

use rustls_pemfile::Item;

use serde::{Deserialize, Serialize};

use sha2::{Digest, Sha256};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use url::Url;

use uuid::Uuid;

use x509_parser::prelude::{FromDer, X509Certificate};

use crate::config::{Environment, FileReader, SecretString, load_secret};

use crate::integration::{CredentialIdentity, IntegrationError, SecretValue};

const PROBE_BODY: &[u8] = b"nuriteo-backup-destination-preflight-v1";

const MIN_TIMEOUT: Duration = Duration::from_millis(100);

const MAX_TIMEOUT: Duration = Duration::from_secs(30);

const MAX_CA_BYTES: usize = 1024 * 1024;

const MAX_CA_CERTIFICATES: usize = 64;

const MAX_BUFFERED_BACKUP_OBJECT_BYTES: u64 = 128 * 1024 * 1024;

const BACKUP_ENDPOINT: &str = "NURITEO_BACKUP_S3_ENDPOINT";

const BACKUP_REGION: &str = "NURITEO_BACKUP_S3_REGION";

const BACKUP_BUCKET: &str = "NURITEO_BACKUP_S3_BUCKET";

const BACKUP_PREFIX: &str = "NURITEO_BACKUP_S3_PREFIX";

const BACKUP_ADDRESSING_STYLE: &str = "NURITEO_BACKUP_S3_ADDRESSING_STYLE";

const BACKUP_SSE: &str = "NURITEO_BACKUP_S3_SSE";

const BACKUP_KMS_KEY_ID: &str = "NURITEO_BACKUP_S3_KMS_KEY_ID";

const BACKUP_ACCESS_KEY_ID: &str = "NURITEO_BACKUP_S3_ACCESS_KEY_ID";

const BACKUP_ACCESS_KEY_ID_FILE: &str = "NURITEO_BACKUP_S3_ACCESS_KEY_ID_FILE";

const BACKUP_SECRET_ACCESS_KEY: &str = "NURITEO_BACKUP_S3_SECRET_ACCESS_KEY";

const BACKUP_SECRET_ACCESS_KEY_FILE: &str = "NURITEO_BACKUP_S3_SECRET_ACCESS_KEY_FILE";

const BACKUP_SESSION_TOKEN: &str = "NURITEO_BACKUP_S3_SESSION_TOKEN";

const BACKUP_SESSION_TOKEN_FILE: &str = "NURITEO_BACKUP_S3_SESSION_TOKEN_FILE";

const BACKUP_CA_FILE: &str = "NURITEO_BACKUP_S3_CA_FILE";

const BACKUP_TIMEOUT_MS: &str = "NURITEO_BACKUP_S3_TIMEOUT_MS";

const BACKUP_VARIABLES: &[&str] = &[
    BACKUP_ENDPOINT,
    BACKUP_REGION,
    BACKUP_BUCKET,
    BACKUP_PREFIX,
    BACKUP_ADDRESSING_STYLE,
    BACKUP_SSE,
    BACKUP_KMS_KEY_ID,
    BACKUP_ACCESS_KEY_ID,
    BACKUP_ACCESS_KEY_ID_FILE,
    BACKUP_SECRET_ACCESS_KEY,
    BACKUP_SECRET_ACCESS_KEY_FILE,
    BACKUP_SESSION_TOKEN,
    BACKUP_SESSION_TOKEN_FILE,
    BACKUP_CA_FILE,
    BACKUP_TIMEOUT_MS,
];

pub struct BackupDestinationRuntime {
    pub config: BackupDestinationConfig,
    pub credential: BackupWriterCredential,
}

#[derive(Debug)]
pub enum BackupDestinationRuntimeError {
    Duplicate,
    NonUnicode,
    Missing(&'static str),
    Value,
    File,
    Secret,
    Config(BackupDestinationConfigError),
}

#[derive(Clone, PartialEq, Eq)]
pub enum BackupSse {
    S3,
    Kms { key_id: String },
    ProviderDefault,
}

#[derive(Clone, PartialEq, Eq)]
pub struct BackupWriterCredential {
    access_key_id: SecretString,
    secret_access_key: SecretString,
    session_token: Option<SecretString>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct BackupDestinationConfig {
    endpoint: Url,
    region: String,
    bucket: String,
    prefix: String,
    force_path_style: bool,
    sse: BackupSse,
    ca_pem: Option<Vec<u8>>,
    timeout: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupDestinationConfigError {
    Endpoint,
    Region,
    Bucket,
    Prefix,
    Sse,
    InvalidCredential,
    InvalidCa,
    Timeout,
}

#[derive(Clone)]
pub struct BackupDestination {
    client: Client,
    config: BackupDestinationConfig,
}

#[derive(Clone, PartialEq, Eq)]
pub struct BackupStoredObject {
    pub key: String,
    pub version_id: Option<String>,
    pub bytes: u64,
    pub sha256: [u8; 32],
}

#[derive(Clone, PartialEq, Eq)]
pub struct BackupDestinationPreflight {
    pub probe_id: Uuid,
    pub probe_object_key: String,
    pub sse: BackupSse,
    pub write: bool,
    pub read: bool,
    pub list: bool,
    pub delete_denied: bool,
    pub external_lifecycle_cleanup_required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupDestinationError {
    TlsClient,
    Authentication,
    Authorization,
    BucketUnavailable,
    Transport,
    ReadVerification,
    ListVerification,
    SseVerification,
    DeletePermissionAllowed,
    LocalInput,
    InvalidObject,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn object_sse_verification_requires_exact_mode_and_kms_key() {
        assert_eq!(
            verify_sse(Some(&ServerSideEncryption::Aes256), None, &BackupSse::S3),
            Ok(())
        );
        assert_eq!(
            verify_sse(
                Some(&ServerSideEncryption::AwsKms),
                Some("key-a"),
                &BackupSse::Kms {
                    key_id: "key-a".to_owned(),
                },
            ),
            Ok(())
        );
        assert_eq!(
            verify_sse(
                Some(&ServerSideEncryption::AwsKms),
                Some("key-b"),
                &BackupSse::Kms {
                    key_id: "key-a".to_owned(),
                },
            ),
            Err(BackupDestinationError::SseVerification)
        );
        assert_eq!(
            verify_sse(Some(&ServerSideEncryption::AwsKms), None, &BackupSse::S3),
            Err(BackupDestinationError::SseVerification)
        );
        // Provider-default is admitted here only after preflight has already
        // verified GetBucketEncryption. Compatible providers may omit HEAD's
        // SSE response header.
        assert_eq!(verify_sse(None, None, &BackupSse::ProviderDefault), Ok(()));
    }

    #[test]
    fn configuration_rejects_ip_literal_bucket_names() {
        let error = BackupDestinationConfig::new(
            "https://backup.invalid",
            "us-east-1".to_owned(),
            "127.0.0.1".to_owned(),
            "instance/backups".to_owned(),
            true,
            BackupSse::S3,
            None,
            Duration::from_secs(2),
        )
        .expect_err("an IP literal is not a DNS-compatible bucket name");
        assert_eq!(error, BackupDestinationConfigError::Bucket);
    }

    #[test]
    fn repository_value_rejects_unknown_version_and_fields() {
        let unknown_version = SecretValue::new(
            br#"{"version":2,"access_key_id":"access","secret_access_key":"secret"}"#.to_vec(),
        )
        .expect("fixture secret is bounded");
        assert!(matches!(
            BackupWriterCredential::from_repository_value(&unknown_version),
            Err(IntegrationError::CredentialUnavailable)
        ));

        let unknown_field = SecretValue::new(
            br#"{"version":1,"access_key_id":"access","secret_access_key":"secret","fallback_endpoint":"https://unsafe.invalid"}"#.to_vec(),
        )
        .expect("fixture secret is bounded");
        assert!(matches!(
            BackupWriterCredential::from_repository_value(&unknown_field),
            Err(IntegrationError::CredentialUnavailable)
        ));
    }

    #[test]
    fn backup_object_keys_are_relative_and_content_addressed() {
        assert!(safe_relative_key("restore-points/id/manifest.json"));
        for invalid in ["", "/absolute", "../escape", "a//b", "a/./b", "a\\b"] {
            assert!(!safe_relative_key(invalid));
        }
        assert_eq!(
            hex_digest([0xab; 32]),
            "abababababababababababababababababababababababababababababababab"
        );
    }

    #[tokio::test]
    async fn local_source_is_verified_before_any_destination_write() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("payload");
        std::fs::write(&source, b"payload").unwrap();
        let digest: [u8; 32] = Sha256::digest(b"payload").into();
        assert_eq!(verify_local_file(&source, 7, digest).await, Ok(()));
        assert_eq!(
            verify_local_file(&source, 8, digest).await,
            Err(BackupDestinationError::LocalInput)
        );
        assert_eq!(
            verify_local_file(&source, 7, [0; 32]).await,
            Err(BackupDestinationError::LocalInput)
        );
    }

    #[test]
    fn runtime_configuration_is_explicit_and_has_no_primary_storage_fallback() {
        let environment = TestEnvironment(vec![
            (BACKUP_ENDPOINT.into(), "https://backup.example.test".into()),
            (BACKUP_REGION.into(), "us-east-1".into()),
            (BACKUP_BUCKET.into(), "nuriteo-backups".into()),
            (BACKUP_PREFIX.into(), "instance-a".into()),
            (BACKUP_ADDRESSING_STYLE.into(), "path".into()),
            (BACKUP_SSE.into(), "s3".into()),
            (BACKUP_ACCESS_KEY_ID.into(), "backup-writer".into()),
            (BACKUP_SECRET_ACCESS_KEY.into(), "not-a-real-secret".into()),
        ]);
        let runtime = BackupDestinationRuntime::load(&environment, &NoFiles).unwrap();
        assert_eq!(runtime.config.bucket, "nuriteo-backups");
        assert_eq!(runtime.config.prefix, "instance-a");

        let primary_only = TestEnvironment(vec![
            (
                "NURITEO_S3_ENDPOINT".into(),
                "https://primary.example.test".into(),
            ),
            ("NURITEO_S3_REGION".into(), "us-east-1".into()),
            ("NURITEO_S3_BUCKET".into(), "primary".into()),
        ]);
        assert!(matches!(
            BackupDestinationRuntime::load(&primary_only, &NoFiles),
            Err(BackupDestinationRuntimeError::Missing(_))
        ));
    }

    #[derive(Clone)]
    struct TestEnvironment(Vec<(OsString, OsString)>);

    impl Environment for TestEnvironment {
        fn entries(&self) -> Vec<(OsString, OsString)> {
            self.0.clone()
        }
    }

    struct NoFiles;

    impl FileReader for NoFiles {
        fn read(&self, _: &Path, _: usize) -> io::Result<Vec<u8>> {
            Err(io::ErrorKind::NotFound.into())
        }
    }
}

mod credential;
pub(crate) use credential::*;
mod verified_objects;
pub(crate) use verified_objects::*;
mod s3_client;
pub(crate) use s3_client::*;
