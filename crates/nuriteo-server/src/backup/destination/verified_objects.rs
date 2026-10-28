#![allow(unused_imports)]
use super::*;
use super::credential::*;
use super::s3_client::*;
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
use super::{PROBE_BODY, MIN_TIMEOUT, MAX_TIMEOUT, MAX_CA_BYTES, MAX_CA_CERTIFICATES, MAX_BUFFERED_BACKUP_OBJECT_BYTES, BACKUP_ENDPOINT, BACKUP_REGION, BACKUP_BUCKET, BACKUP_PREFIX, BACKUP_ADDRESSING_STYLE, BACKUP_SSE, BACKUP_KMS_KEY_ID, BACKUP_ACCESS_KEY_ID, BACKUP_ACCESS_KEY_ID_FILE, BACKUP_SECRET_ACCESS_KEY, BACKUP_SECRET_ACCESS_KEY_FILE, BACKUP_SESSION_TOKEN, BACKUP_SESSION_TOKEN_FILE, BACKUP_CA_FILE, BACKUP_TIMEOUT_MS, BACKUP_VARIABLES, BackupDestinationRuntime, BackupDestinationRuntimeError, BackupSse, BackupWriterCredential, BackupDestinationConfig, BackupDestinationConfigError, BackupDestination, BackupStoredObject, BackupDestinationPreflight, BackupDestinationError};



impl super::BackupDestination {
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

    /// Stores one immutable backup payload under its content address. A
    /// repeated upload is safe: the object is read back and must match the
    /// caller's exact size and digest before it is accepted.
    pub async fn put_verified_file(
        &self,
        digest: [u8; 32],
        bytes: u64,
        source: &Path,
    ) -> Result<BackupStoredObject, BackupDestinationError> {
        verify_local_file(source, bytes, digest).await?;
        let key = self.payload_key(digest);
        match self
            .client
            .head_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(head) => {
                self.verify_object(&key, bytes, digest).await?;
                return Ok(BackupStoredObject {
                    key,
                    version_id: head.version_id().map(str::to_owned),
                    bytes,
                    sha256: digest,
                });
            }
            Err(error)
                if missing_object(
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
        }
        let body = ByteStream::from_path(source)
            .await
            .map_err(|_| BackupDestinationError::LocalInput)?;
        let mut put = self
            .client
            .put_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .body(body)
            .if_none_match("*");
        put = apply_sse(put, &self.config.sse);
        let output = match put.send().await {
            Ok(output) => output,
            Err(error)
                if precondition_failed(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                ) =>
            {
                self.verify_object(&key, bytes, digest).await?;
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
                return Ok(BackupStoredObject {
                    key,
                    version_id: head.version_id().map(str::to_owned),
                    bytes,
                    sha256: digest,
                });
            }
            Err(error) => {
                return Err(classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                ));
            }
        };
        self.verify_object(&key, bytes, digest).await?;
        Ok(BackupStoredObject {
            key,
            version_id: output.version_id().map(str::to_owned),
            bytes,
            sha256: digest,
        })
    }

    pub async fn put_verified_bytes(
        &self,
        relative_key: &str,
        body: Vec<u8>,
    ) -> Result<BackupStoredObject, BackupDestinationError> {
        if !safe_relative_key(relative_key) || body.is_empty() {
            return Err(BackupDestinationError::InvalidObject);
        }
        let key = format!("{}/{}", self.config.prefix, relative_key);
        let bytes = body.len() as u64;
        let digest: [u8; 32] = Sha256::digest(&body).into();
        let mut put = self
            .client
            .put_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .body(ByteStream::from(body));
        put = apply_sse(put, &self.config.sse);
        let output = put.send().await.map_err(|error| {
            classify(
                error
                    .as_service_error()
                    .and_then(ProvideErrorMetadata::code),
            )
        })?;
        self.verify_object(&key, bytes, digest).await?;
        Ok(BackupStoredObject {
            key,
            version_id: output.version_id().map(str::to_owned),
            bytes,
            sha256: digest,
        })
    }

    pub async fn read_verified(
        &self,
        key: &str,
        bytes: u64,
        digest: [u8; 32],
    ) -> Result<Vec<u8>, BackupDestinationError> {
        if bytes > MAX_BUFFERED_BACKUP_OBJECT_BYTES {
            return Err(BackupDestinationError::InvalidObject);
        }
        let body = self.read_verified_bounded(key, digest, bytes).await?;
        if body.len() as u64 != bytes {
            return Err(BackupDestinationError::ReadVerification);
        }
        Ok(body)
    }

    /// Reads a small immutable object when its digest is known but its byte
    /// count is not stored separately. This is the restore-point manifest
    /// boundary: the response length is accepted only when it is non-zero and
    /// within the caller's explicit bound, then the complete body is hashed.
    pub async fn read_verified_bounded(
        &self,
        key: &str,
        digest: [u8; 32],
        max_bytes: u64,
    ) -> Result<Vec<u8>, BackupDestinationError> {
        if !self.owns_key(key) || max_bytes == 0 || max_bytes > MAX_BUFFERED_BACKUP_OBJECT_BYTES {
            return Err(BackupDestinationError::InvalidObject);
        }
        let output = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| {
                classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                )
            })?;
        let bytes = output
            .content_length()
            .and_then(|value| u64::try_from(value).ok())
            .filter(|bytes| *bytes > 0 && *bytes <= max_bytes)
            .ok_or(BackupDestinationError::ReadVerification)?;
        if bytes > max_bytes {
            return Err(BackupDestinationError::ReadVerification);
        }
        let mut reader = output.body.into_async_read().take(bytes.saturating_add(1));
        let capacity = usize::try_from(bytes).map_err(|_| BackupDestinationError::InvalidObject)?;
        let mut body = Vec::with_capacity(capacity);
        reader
            .read_to_end(&mut body)
            .await
            .map_err(|_| BackupDestinationError::Transport)?;
        if body.len() as u64 != bytes || <[u8; 32]>::from(Sha256::digest(&body)) != digest {
            return Err(BackupDestinationError::ReadVerification);
        }
        Ok(body)
    }

    /// Streams a large immutable object to a new local file while checking the
    /// exact declared byte count and SHA-256. A partial file is removed on all
    /// failures so an interrupted restore cannot consume unverified bytes.
    pub async fn download_verified(
        &self,
        key: &str,
        bytes: u64,
        digest: [u8; 32],
        target: &Path,
    ) -> Result<(), BackupDestinationError> {
        if !self.owns_key(key) || bytes == 0 || !target.is_absolute() {
            return Err(BackupDestinationError::InvalidObject);
        }
        let result = self
            .download_verified_inner(key, bytes, digest, target)
            .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(target).await;
        }
        result
    }

    pub(crate) async fn download_verified_inner(
        &self,
        key: &str,
        bytes: u64,
        digest: [u8; 32],
        target: &Path,
    ) -> Result<(), BackupDestinationError> {
        let output = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| {
                classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                )
            })?;
        if output
            .content_length()
            .and_then(|value| u64::try_from(value).ok())
            != Some(bytes)
        {
            return Err(BackupDestinationError::ReadVerification);
        }
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .await
            .map_err(|_| BackupDestinationError::LocalInput)?;
        let mut reader = output.body.into_async_read().take(bytes.saturating_add(1));
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .await
                .map_err(|_| BackupDestinationError::Transport)?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(read as u64)
                .ok_or(BackupDestinationError::ReadVerification)?;
            if copied > bytes {
                return Err(BackupDestinationError::ReadVerification);
            }
            file.write_all(&buffer[..read])
                .await
                .map_err(|_| BackupDestinationError::LocalInput)?;
            hasher.update(&buffer[..read]);
        }
        file.sync_all()
            .await
            .map_err(|_| BackupDestinationError::LocalInput)?;
        if copied != bytes || <[u8; 32]>::from(hasher.finalize()) != digest {
            return Err(BackupDestinationError::ReadVerification);
        }
        Ok(())
    }

    /// Returns the canonical immutable payload key for a manifest digest.
    #[must_use]
    pub fn payload_object_key(&self, digest: [u8; 32]) -> String {
        self.payload_key(digest)
    }

    /// Returns the only manifest key accepted for one restore point.
    pub fn manifest_object_key(&self, backup_id: Uuid) -> String {
        format!(
            "{}/restore-points/{backup_id}/manifest.json",
            self.config.prefix
        )
    }

    pub(crate) async fn verify_object(
        &self,
        key: &str,
        bytes: u64,
        digest: [u8; 32],
    ) -> Result<(), BackupDestinationError> {
        let head = self
            .client
            .head_object()
            .bucket(&self.config.bucket)
            .key(key)
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
            != Some(bytes)
        {
            return Err(BackupDestinationError::ReadVerification);
        }
        let output = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| {
                classify(
                    error
                        .as_service_error()
                        .and_then(ProvideErrorMetadata::code),
                )
            })?;
        let mut reader = output.body.into_async_read().take(bytes.saturating_add(1));
        let mut hasher = Sha256::new();
        let mut read_bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .await
                .map_err(|_| BackupDestinationError::Transport)?;
            if read == 0 {
                break;
            }
            read_bytes = read_bytes
                .checked_add(read as u64)
                .ok_or(BackupDestinationError::InvalidObject)?;
            hasher.update(&buffer[..read]);
        }
        if read_bytes != bytes || <[u8; 32]>::from(hasher.finalize()) != digest {
            return Err(BackupDestinationError::ReadVerification);
        }
        Ok(())
    }

    pub(crate) fn payload_key(&self, digest: [u8; 32]) -> String {
        let hex = hex_digest(digest);
        format!(
            "{}/payloads/sha256/{}/{}",
            self.config.prefix,
            &hex[..2],
            hex
        )
    }

    pub(crate) fn owns_key(&self, key: &str) -> bool {
        key.strip_prefix(&self.config.prefix)
            .is_some_and(|suffix| suffix.starts_with('/') && safe_relative_key(&suffix[1..]))
    }

    pub(crate) async fn verify_bucket_default_encryption(&self) -> Result<(), BackupDestinationError> {
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


impl fmt::Debug for BackupStoredObject { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupStoredObject")
            .field("key", &"[REDACTED]")
            .field("version_id_configured", &self.version_id.is_some())
            .field("bytes", &self.bytes)
            .field("sha256", &"[SHA-256]")
            .finish()
    }
}


impl fmt::Debug for BackupDestinationPreflight { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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


impl fmt::Display for BackupDestinationError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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
            Self::LocalInput => "backup source could not be read",
            Self::InvalidObject => "backup object contract is invalid",
        })
    }
}


pub(crate) fn safe_relative_key(value: &str) -> bool {    !value.is_empty()
        && value.len() <= 768
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}


pub(crate) fn hex_digest(value: [u8; 32]) -> String {    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in value {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}


pub(crate) async fn verify_local_file(    source: &Path,
    bytes: u64,
    digest: [u8; 32],
) -> Result<(), BackupDestinationError> {
    let mut file = tokio::fs::File::open(source)
        .await
        .map_err(|_| BackupDestinationError::LocalInput)?;
    let metadata = file
        .metadata()
        .await
        .map_err(|_| BackupDestinationError::LocalInput)?;
    if !metadata.is_file() || metadata.len() != bytes {
        return Err(BackupDestinationError::LocalInput);
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|_| BackupDestinationError::LocalInput)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if <[u8; 32]>::from(hasher.finalize()) != digest {
        return Err(BackupDestinationError::LocalInput);
    }
    Ok(())
}


impl std::error::Error for BackupDestinationError {}


pub(crate) fn apply_sse(    operation: aws_sdk_s3::operation::put_object::builders::PutObjectFluentBuilder,
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


pub(crate) fn verify_sse(    actual: Option<&ServerSideEncryption>,
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


pub(crate) fn classify(code: Option<&str>) -> BackupDestinationError {    match code {
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
