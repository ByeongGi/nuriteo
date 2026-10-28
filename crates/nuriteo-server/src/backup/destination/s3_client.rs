#![allow(unused_imports)]
use super::*;
use super::credential::*;
use super::verified_objects::*;
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



pub(crate) fn permission_denied(code: Option<&str>) -> bool {    matches!(code, Some("AccessDenied" | "Unauthorized" | "Forbidden"))
}


pub(crate) fn missing_object(code: Option<&str>) -> bool {    matches!(code, Some("NoSuchKey" | "NotFound" | "404"))
}


pub(crate) fn precondition_failed(code: Option<&str>) -> bool {    matches!(
        code,
        Some("PreconditionFailed" | "ConditionalRequestConflict" | "412" | "409")
    )
}


pub(crate) fn build_http_client(ca_pem: Option<&[u8]>) -> Result<PoolClient, BackupDestinationError> {    let mut trust_store = TrustStore::default();
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


pub(crate) fn validate_ca_bundle(pem: &[u8]) -> Result<(), BackupDestinationConfigError> {    if pem.is_empty() || pem.len() > MAX_CA_BYTES {
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


pub(crate) fn valid_bucket(value: &str) -> bool {    (3..=63).contains(&value.len())
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
