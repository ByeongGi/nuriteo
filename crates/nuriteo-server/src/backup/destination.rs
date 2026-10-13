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

impl BackupDestinationRuntime {
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, BackupDestinationRuntimeError> {
        let values = backup_values(environment)?;
        let required = |name| {
            values
                .get(name)
                .map(String::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(BackupDestinationRuntimeError::Missing(name))
        };
        let force_path_style = match required(BACKUP_ADDRESSING_STYLE)? {
            "path" => true,
            "virtual-hosted" => false,
            _ => return Err(BackupDestinationRuntimeError::Value),
        };
        let sse = match required(BACKUP_SSE)? {
            "s3" => BackupSse::S3,
            "provider-default" => BackupSse::ProviderDefault,
            "kms" => BackupSse::Kms {
                key_id: required(BACKUP_KMS_KEY_ID)?.to_owned(),
            },
            _ => return Err(BackupDestinationRuntimeError::Value),
        };
        if !matches!(sse, BackupSse::Kms { .. }) && values.contains_key(BACKUP_KMS_KEY_ID) {
            return Err(BackupDestinationRuntimeError::Value);
        }
        let timeout_ms = values
            .get(BACKUP_TIMEOUT_MS)
            .map_or(Ok(5_000_u64), |value| value.parse().map_err(|_| ()))
            .map_err(|_| BackupDestinationRuntimeError::Value)?;
        let ca_pem = values
            .get(BACKUP_CA_FILE)
            .map(|path| files.read(Path::new(path), MAX_CA_BYTES))
            .transpose()
            .map_err(|_| BackupDestinationRuntimeError::File)?;
        let access_key_id = load_secret(
            environment,
            files,
            BACKUP_ACCESS_KEY_ID,
            BACKUP_ACCESS_KEY_ID_FILE,
        )
        .map_err(|_| BackupDestinationRuntimeError::Secret)?
        .ok_or(BackupDestinationRuntimeError::Missing(BACKUP_ACCESS_KEY_ID))?;
        let secret_access_key = load_secret(
            environment,
            files,
            BACKUP_SECRET_ACCESS_KEY,
            BACKUP_SECRET_ACCESS_KEY_FILE,
        )
        .map_err(|_| BackupDestinationRuntimeError::Secret)?
        .ok_or(BackupDestinationRuntimeError::Missing(
            BACKUP_SECRET_ACCESS_KEY,
        ))?;
        let session_token = load_secret(
            environment,
            files,
            BACKUP_SESSION_TOKEN,
            BACKUP_SESSION_TOKEN_FILE,
        )
        .map_err(|_| BackupDestinationRuntimeError::Secret)?;
        let config = BackupDestinationConfig::new(
            required(BACKUP_ENDPOINT)?,
            required(BACKUP_REGION)?.to_owned(),
            required(BACKUP_BUCKET)?.to_owned(),
            required(BACKUP_PREFIX)?.to_owned(),
            force_path_style,
            sse,
            ca_pem,
            Duration::from_millis(timeout_ms),
        )?;
        let credential = BackupWriterCredential::new(
            access_key_id.expose_secret().to_owned(),
            secret_access_key.expose_secret().to_owned(),
            session_token.map(|value| value.expose_secret().to_owned()),
        )?;
        Ok(Self { config, credential })
    }
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

impl From<BackupDestinationConfigError> for BackupDestinationRuntimeError {
    fn from(value: BackupDestinationConfigError) -> Self {
        Self::Config(value)
    }
}

impl fmt::Display for BackupDestinationRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("backup destination runtime configuration is invalid")
    }
}

impl std::error::Error for BackupDestinationRuntimeError {}

fn backup_values(
    environment: &impl Environment,
) -> Result<BTreeMap<&'static str, String>, BackupDestinationRuntimeError> {
    let mut values = BTreeMap::new();
    for (name, value) in environment.entries() {
        let Some(name) = name.to_str() else {
            if backup_name(&name).is_some() {
                return Err(BackupDestinationRuntimeError::NonUnicode);
            }
            continue;
        };
        let Some(canonical) = BACKUP_VARIABLES.iter().copied().find(|item| *item == name) else {
            continue;
        };
        let value = value
            .into_string()
            .map_err(|_| BackupDestinationRuntimeError::NonUnicode)?;
        if values.insert(canonical, value).is_some() {
            return Err(BackupDestinationRuntimeError::Duplicate);
        }
    }
    Ok(values)
}

fn backup_name(value: &OsString) -> Option<&'static str> {
    BACKUP_VARIABLES
        .iter()
        .copied()
        .find(|name| value == &OsString::from(name))
}

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

    async fn download_verified_inner(
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

    async fn verify_object(
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

    fn payload_key(&self, digest: [u8; 32]) -> String {
        let hex = hex_digest(digest);
        format!(
            "{}/payloads/sha256/{}/{}",
            self.config.prefix,
            &hex[..2],
            hex
        )
    }

    fn owns_key(&self, key: &str) -> bool {
        key.strip_prefix(&self.config.prefix)
            .is_some_and(|suffix| suffix.starts_with('/') && safe_relative_key(&suffix[1..]))
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
pub struct BackupStoredObject {
    pub key: String,
    pub version_id: Option<String>,
    pub bytes: u64,
    pub sha256: [u8; 32],
}

impl fmt::Debug for BackupStoredObject {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupStoredObject")
            .field("key", &"[REDACTED]")
            .field("version_id_configured", &self.version_id.is_some())
            .field("bytes", &self.bytes)
            .field("sha256", &"[SHA-256]")
            .finish()
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
    LocalInput,
    InvalidObject,
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
            Self::LocalInput => "backup source could not be read",
            Self::InvalidObject => "backup object contract is invalid",
        })
    }
}

fn safe_relative_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 768
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}

fn hex_digest(value: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in value {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

async fn verify_local_file(
    source: &Path,
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

fn missing_object(code: Option<&str>) -> bool {
    matches!(code, Some("NoSuchKey" | "NotFound" | "404"))
}

fn precondition_failed(code: Option<&str>) -> bool {
    matches!(
        code,
        Some("PreconditionFailed" | "ConditionalRequestConflict" | "412" | "409")
    )
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
