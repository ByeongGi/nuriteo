use std::fmt;
use std::io::Cursor;
use std::net::IpAddr;
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
use url::Url;
use uuid::Uuid;
use x509_parser::prelude::{FromDer, X509Certificate};

use crate::config::SecretString;
use crate::integration::{CredentialIdentity, IntegrationError, SecretValue};

const PROBE_BODY: &[u8] = b"nuriteo-backup-destination-preflight-v1";
const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CA_BYTES: usize = 1024 * 1024;
const MAX_CA_CERTIFICATES: usize = 64;

#[derive(Clone, PartialEq, Eq)]
pub enum BackupSse {
    S3,
    Kms { key_id: String },
    ProviderDefault,
}

impl fmt::Debug for BackupSse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::S3 => formatter.write_str("S3"),
            Self::Kms { .. } => formatter.write_str("Kms { key_id: [REDACTED] }"),
            Self::ProviderDefault => formatter.write_str("ProviderDefault"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct BackupWriterCredential {
    access_key_id: SecretString,
    secret_access_key: SecretString,
    session_token: Option<SecretString>,
}

impl BackupWriterCredential {
    pub fn new(
        access_key_id: String,
        secret_access_key: String,
        session_token: Option<String>,
    ) -> Result<Self, BackupDestinationConfigError> {
        if access_key_id.is_empty()
            || access_key_id.len() > 512
            || secret_access_key.is_empty()
            || secret_access_key.len() > 4096
            || session_token
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 16 * 1024)
        {
            return Err(BackupDestinationConfigError::InvalidCredential);
        }
        Ok(Self {
            access_key_id: SecretString::new(access_key_id),
            secret_access_key: SecretString::new(secret_access_key),
            session_token: session_token.map(SecretString::new),
        })
    }

    /// Serializes the credential for storage through the INT-001 encrypted
    /// credential repository. The returned value remains redacted on `Debug`.
    pub fn encrypted_repository_value(&self) -> Result<SecretValue, IntegrationError> {
        #[derive(Serialize)]
        struct StoredCredential<'a> {
            version: u8,
            access_key_id: &'a str,
            secret_access_key: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            session_token: Option<&'a str>,
        }
        let value = StoredCredential {
            version: 1,
            access_key_id: self.access_key_id.expose_secret(),
            secret_access_key: self.secret_access_key.expose_secret(),
            session_token: self.session_token.as_ref().map(SecretString::expose_secret),
        };
        let encoded = serde_json::to_vec(&value).map_err(|_| IntegrationError::InvalidInput)?;
        SecretValue::new(encoded)
    }

    /// Reconstructs a credential after the INT-001 repository has authenticated
    /// and decrypted the envelope. Parse failures never expose source bytes.
    pub fn from_repository_value(value: &SecretValue) -> Result<Self, IntegrationError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct StoredCredential {
            version: u8,
            access_key_id: String,
            secret_access_key: String,
            session_token: Option<String>,
        }
        impl Drop for StoredCredential {
            fn drop(&mut self) {
                use zeroize::Zeroize;
                self.access_key_id.zeroize();
                self.secret_access_key.zeroize();
                self.session_token.zeroize();
            }
        }

        let stored: StoredCredential = serde_json::from_slice(value.expose())
            .map_err(|_| IntegrationError::CredentialUnavailable)?;
        if stored.version != 1 {
            return Err(IntegrationError::CredentialUnavailable);
        }
        Self::new(
            stored.access_key_id.clone(),
            stored.secret_access_key.clone(),
            stored.session_token.clone(),
        )
        .map_err(|_| IntegrationError::CredentialUnavailable)
    }

    pub fn repository_identity(
        instance_id: &str,
        destination_id: Uuid,
    ) -> Result<CredentialIdentity, IntegrationError> {
        CredentialIdentity::new(
            instance_id,
            "backup_destination",
            destination_id.to_string(),
            "writer",
        )
    }
}

impl fmt::Debug for BackupWriterCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupWriterCredential")
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .field("session_token_configured", &self.session_token.is_some())
            .finish()
    }
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

impl BackupDestinationConfig {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        endpoint: &str,
        region: String,
        bucket: String,
        prefix: String,
        force_path_style: bool,
        sse: BackupSse,
        ca_pem: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Self, BackupDestinationConfigError> {
        let endpoint = Url::parse(endpoint).map_err(|_| BackupDestinationConfigError::Endpoint)?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(BackupDestinationConfigError::Endpoint);
        }
        if region.is_empty()
            || region.len() > 63
            || !region
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(BackupDestinationConfigError::Region);
        }
        if !valid_bucket(&bucket) {
            return Err(BackupDestinationConfigError::Bucket);
        }
        let prefix = prefix.trim_matches('/').to_owned();
        if prefix.is_empty()
            || prefix.len() > 768
            || prefix
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
            || prefix.chars().any(char::is_control)
        {
            return Err(BackupDestinationConfigError::Prefix);
        }
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&timeout) {
            return Err(BackupDestinationConfigError::Timeout);
        }
        if matches!(&sse, BackupSse::Kms { key_id } if key_id.is_empty() || key_id.len() > 2048 || key_id.chars().any(char::is_control))
        {
            return Err(BackupDestinationConfigError::Sse);
        }
        if let Some(pem) = &ca_pem {
            validate_ca_bundle(pem)?;
        }
        Ok(Self {
            endpoint,
            region,
            bucket,
            prefix,
            force_path_style,
            sse,
            ca_pem,
            timeout,
        })
    }
}

impl fmt::Debug for BackupDestinationConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupDestinationConfig")
            .field("endpoint_configured", &true)
            .field("region", &self.region)
            .field("bucket_configured", &true)
            .field("prefix_configured", &true)
            .field("force_path_style", &self.force_path_style)
            .field("sse", &self.sse)
            .field("custom_ca_configured", &self.ca_pem.is_some())
            .field("timeout", &self.timeout)
            .finish()
    }
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

impl fmt::Display for BackupDestinationConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Endpoint => "backup endpoint must be an HTTPS origin",
            Self::Region => "backup region is invalid",
            Self::Bucket => "backup bucket is invalid",
            Self::Prefix => "backup prefix is invalid",
            Self::Sse => "backup server-side encryption configuration is invalid",
            Self::InvalidCredential => "backup writer credential is invalid",
            Self::InvalidCa => "backup endpoint CA bundle is invalid",
            Self::Timeout => "backup preflight timeout is invalid",
        })
    }
}

impl std::error::Error for BackupDestinationConfigError {}

#[derive(Clone)]
pub struct BackupDestination {
    client: Client,
    config: BackupDestinationConfig,
}

impl fmt::Debug for BackupDestination {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupDestination")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl BackupDestination {
    pub fn new(
        config: BackupDestinationConfig,
        credential: &BackupWriterCredential,
    ) -> Result<Self, BackupDestinationError> {
        let http_client = build_http_client(config.ca_pem.as_deref())?;
        let credentials = Credentials::new(
            credential.access_key_id.expose_secret(),
            credential.secret_access_key.expose_secret(),
            credential
                .session_token
                .as_ref()
                .map(|value| value.expose_secret().to_owned()),
            None,
            "nuriteo-backup-writer",
        );
        let sdk_config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(config.endpoint.as_str())
            .region(Region::new(config.region.clone()))
            .force_path_style(config.force_path_style)
            .credentials_provider(credentials)
            .http_client(http_client)
            .retry_config(RetryConfig::standard().with_max_attempts(1))
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(config.timeout)
                    .operation_attempt_timeout(config.timeout)
                    .operation_timeout(config.timeout)
                    .build(),
            )
            .build();
        Ok(Self {
            client: Client::from_conf(sdk_config),
            config,
        })
    }

    /// Verifies the exact writer credential and configured destination. No
    /// ambient credential provider or alternate endpoint is ever attempted.
    pub async fn preflight(&self) -> Result<BackupDestinationPreflight, BackupDestinationError> {
        self.client
            .head_bucket()
            .bucket(&self.config.bucket)
            .send()
            .await
            .map_err(|error| {
                classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                )
            })?;

        if matches!(self.config.sse, BackupSse::ProviderDefault) {
            self.verify_bucket_default_encryption().await?;
        }

        let probe_id = Uuid::now_v7();
        // The writer is deliberately unable to delete. Reuse one reserved key
        // per destination prefix so repeated preflights remain bounded to one
        // lifecycle-managed probe object rather than leaking one object/run.
        let key = format!(
            "{}/__nuriteo_preflight__/writer-capability-v1",
            self.config.prefix
        );
        let checksum: [u8; 32] = Sha256::digest(PROBE_BODY).into();
        let mut put = self
            .client
            .put_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .body(ByteStream::from_static(PROBE_BODY));
        put = apply_sse(put, &self.config.sse);
        put.send().await.map_err(|error| {
            classify(
                error
                    .as_service_error()
                    .and_then(ProvideErrorMetadata::code),
            )
        })?;

        let head = self
            .client
            .head_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .send()
            .await
            .map_err(|error| {
                classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                )
            })?;
        verify_sse(
            head.server_side_encryption(),
            head.ssekms_key_id(),
            &self.config.sse,
        )?;
        if head
            .content_length()
            .and_then(|value| u64::try_from(value).ok())
            != Some(PROBE_BODY.len() as u64)
        {
            return Err(BackupDestinationError::ReadVerification);
        }

        let get = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .send()
            .await
            .map_err(|error| {
                classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                )
            })?;
        let body = get
            .body
            .collect()
            .await
            .map_err(|_| BackupDestinationError::Transport)?
            .into_bytes();
        if body.as_ref() != PROBE_BODY
            || <[u8; 32]>::from(Sha256::digest(body.as_ref())) != checksum
        {
            return Err(BackupDestinationError::ReadVerification);
        }

        let listed = self
            .client
            .list_objects_v2()
            .bucket(&self.config.bucket)
            .prefix(&key)
            .max_keys(2)
            .send()
            .await
            .map_err(|error| {
                classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                )
            })?;
        if !listed
            .contents()
            .iter()
            .any(|object| object.key() == Some(key.as_str()))
        {
            return Err(BackupDestinationError::ListVerification);
        }

        match self
            .client
            .delete_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .send()
            .await
        {
            Err(error)
                if permission_denied(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                ) => {}
            Err(error) => {
                return Err(classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                ));
            }
            Ok(_) => return Err(BackupDestinationError::DeletePermissionAllowed),
        }

        Ok(BackupDestinationPreflight {
            probe_id,
            probe_object_key: key,
            sse: self.config.sse.clone(),
            write: true,
            read: true,
            list: true,
            delete_denied: true,
            external_lifecycle_cleanup_required: true,
        })
    }

    async fn verify_bucket_default_encryption(&self) -> Result<(), BackupDestinationError> {
        let output = self
            .client
            .get_bucket_encryption()
            .bucket(&self.config.bucket)
            .send()
            .await
            .map_err(|error| {
                classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                )
            })?;
        let encrypted =
            output
                .server_side_encryption_configuration()
                .is_some_and(|configuration| {
                    configuration.rules().iter().any(|rule| {
                        rule.apply_server_side_encryption_by_default()
                            .is_some_and(|default| {
                                matches!(
                                    default.sse_algorithm(),
                                    ServerSideEncryption::Aes256
                                        | ServerSideEncryption::AwsKms
                                        | ServerSideEncryption::AwsKmsDsse
                                )
                            })
                    })
                });
        encrypted
            .then_some(())
            .ok_or(BackupDestinationError::SseVerification)
    }
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

impl fmt::Debug for BackupDestinationPreflight {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupDestinationPreflight")
            .field("probe_id", &self.probe_id)
            .field("probe_object_key", &"[REDACTED]")
            .field("sse", &self.sse)
            .field("write", &self.write)
            .field("read", &self.read)
            .field("list", &self.list)
            .field("delete_denied", &self.delete_denied)
            .field(
                "external_lifecycle_cleanup_required",
                &self.external_lifecycle_cleanup_required,
            )
            .finish()
    }
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
}

impl fmt::Display for BackupDestinationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::TlsClient => "backup TLS client could not be configured",
            Self::Authentication => "backup credential was rejected",
            Self::Authorization => "backup writer permission preflight failed",
            Self::BucketUnavailable => "backup bucket is unavailable",
            Self::Transport => "backup destination connection failed",
            Self::ReadVerification => "backup destination read verification failed",
            Self::ListVerification => "backup destination list verification failed",
            Self::SseVerification => {
                "backup destination server-side encryption verification failed"
            }
            Self::DeletePermissionAllowed => {
                "backup writer credential must not allow object deletion"
            }
        })
    }
}

impl std::error::Error for BackupDestinationError {}

fn apply_sse(
    operation: aws_sdk_s3::operation::put_object::builders::PutObjectFluentBuilder,
    sse: &BackupSse,
) -> aws_sdk_s3::operation::put_object::builders::PutObjectFluentBuilder {
    match sse {
        BackupSse::S3 => operation.server_side_encryption(ServerSideEncryption::Aes256),
        BackupSse::Kms { key_id } => operation
            .server_side_encryption(ServerSideEncryption::AwsKms)
            .ssekms_key_id(key_id),
        BackupSse::ProviderDefault => operation,
    }
}

fn verify_sse(
    actual: Option<&ServerSideEncryption>,
    actual_key: Option<&str>,
    expected: &BackupSse,
) -> Result<(), BackupDestinationError> {
    let valid = match expected {
        BackupSse::S3 => actual == Some(&ServerSideEncryption::Aes256),
        BackupSse::Kms { key_id } => {
            actual == Some(&ServerSideEncryption::AwsKms) && actual_key == Some(key_id.as_str())
        }
        // Provider-default was already verified through GetBucketEncryption.
        // Some compatible providers omit an SSE response header on HEAD.
        BackupSse::ProviderDefault => true,
    };
    valid
        .then_some(())
        .ok_or(BackupDestinationError::SseVerification)
}

fn classify(code: Option<&str>) -> BackupDestinationError {
    match code {
        Some("InvalidAccessKeyId" | "SignatureDoesNotMatch" | "InvalidToken" | "ExpiredToken") => {
            BackupDestinationError::Authentication
        }
        Some("AccessDenied" | "Unauthorized" | "Forbidden") => {
            BackupDestinationError::Authorization
        }
        Some("NoSuchBucket" | "NotFound") => BackupDestinationError::BucketUnavailable,
        _ => BackupDestinationError::Transport,
    }
}

fn permission_denied(code: Option<&str>) -> bool {
    matches!(code, Some("AccessDenied" | "Unauthorized" | "Forbidden"))
}

fn build_http_client(ca_pem: Option<&[u8]>) -> Result<PoolClient, BackupDestinationError> {
    let mut trust_store = TrustStore::default();
    if let Some(pem) = ca_pem {
        trust_store.add_pem_certificate(pem.to_vec());
    }
    let context = TlsContext::builder()
        .with_trust_store(trust_store)
        .build()
        .map_err(|_| BackupDestinationError::TlsClient)?;
    let pool = ConnectionPool::builder()
        .max_connections_per_host(4)
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .map_err(|_| BackupDestinationError::TlsClient)?;
    PoolClient::new(&pool).map_err(|_| BackupDestinationError::TlsClient)
}

fn validate_ca_bundle(pem: &[u8]) -> Result<(), BackupDestinationConfigError> {
    if pem.is_empty() || pem.len() > MAX_CA_BYTES {
        return Err(BackupDestinationConfigError::InvalidCa);
    }
    let mut reader = Cursor::new(pem);
    let mut count = 0_usize;
    for item in rustls_pemfile::read_all(&mut reader) {
        match item.map_err(|_| BackupDestinationConfigError::InvalidCa)? {
            Item::X509Certificate(certificate) if !certificate.is_empty() => {
                let (remainder, parsed) = X509Certificate::from_der(certificate.as_ref())
                    .map_err(|_| BackupDestinationConfigError::InvalidCa)?;
                if !remainder.is_empty() || !parsed.tbs_certificate.is_ca() {
                    return Err(BackupDestinationConfigError::InvalidCa);
                }
                count = count
                    .checked_add(1)
                    .ok_or(BackupDestinationConfigError::InvalidCa)?;
                if count > MAX_CA_CERTIFICATES {
                    return Err(BackupDestinationConfigError::InvalidCa);
                }
            }
            _ => return Err(BackupDestinationConfigError::InvalidCa),
        }
    }
    (count > 0)
        .then_some(())
        .ok_or(BackupDestinationConfigError::InvalidCa)
}

fn valid_bucket(value: &str) -> bool {
    (3..=63).contains(&value.len())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !value.contains("..")
        && IpAddr::from_str(value).is_err()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
