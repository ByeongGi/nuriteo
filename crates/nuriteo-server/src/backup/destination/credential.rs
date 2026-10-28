#![allow(unused_imports)]
use super::*;
use super::verified_objects::*;
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



impl super::BackupDestinationRuntime {
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


impl From<BackupDestinationConfigError> for BackupDestinationRuntimeError { fn from(value: BackupDestinationConfigError) -> Self {
        Self::Config(value)
    }
}


impl fmt::Display for BackupDestinationRuntimeError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("backup destination runtime configuration is invalid")
    }
}


impl std::error::Error for BackupDestinationRuntimeError {}


pub(crate) fn backup_values(    environment: &impl Environment,
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


pub(crate) fn backup_name(value: &OsString) -> Option<&'static str> {    BACKUP_VARIABLES
        .iter()
        .copied()
        .find(|name| value == &OsString::from(name))
}


impl fmt::Debug for BackupSse { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::S3 => formatter.write_str("S3"),
            Self::Kms { .. } => formatter.write_str("Kms { key_id: [REDACTED] }"),
            Self::ProviderDefault => formatter.write_str("ProviderDefault"),
        }
    }
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
        impl Drop for StoredCredential { fn drop(&mut self) {
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


impl fmt::Debug for BackupWriterCredential { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupWriterCredential")
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .field("session_token_configured", &self.session_token.is_some())
            .finish()
    }
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


impl fmt::Debug for BackupDestinationConfig { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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


impl fmt::Display for BackupDestinationConfigError { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
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


impl fmt::Debug for BackupDestination { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupDestination")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}
