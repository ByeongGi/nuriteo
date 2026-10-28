//! Common, fail-closed persistence for integration credentials and private CAs.

pub mod recovery_kit;

use std::collections::{BTreeMap, HashSet};

use std::fmt;

use std::future::Future;

use std::io::Cursor;

use std::pin::Pin;

use std::str::FromStr;

use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, Payload};

use aes_gcm::{Aes256Gcm, Nonce};

use base64::Engine;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

use hmac::{Hmac, Mac};

use rustls_pemfile::Item;

use serde::Deserialize;

use sha2::{Digest, Sha256};

use sqlx::{Acquire, Postgres, Row, Transaction};

use time::OffsetDateTime;

use url::Url;

use uuid::Uuid;

use x509_parser::prelude::{FromDer, X509Certificate};

use zeroize::{Zeroize, Zeroizing};

use crate::config::{Environment, FileReader, load_secret};

use crate::database::DatabasePool;

use crate::identity::{SessionId, UserId};

use crate::instance_settings::EffectiveInstanceSettings;

use crate::smtp::{SmtpConfig, SmtpPublicSettings, SmtpSecurity};

const ALGORITHM: &str = "aes-256-gcm-v1";

const NONCE_BYTES: usize = 12;

const MAX_SECRET_BYTES: usize = 64 * 1024;

const MAX_PREVIOUS_KEYS: usize = 3;

const MAX_ROTATION_BATCH: u16 = 100;

const MAX_CA_BYTES: usize = 1024 * 1024;

const MAX_CA_CERTIFICATES: usize = 64;

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);

const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

pub const MASTER_KEY: &str = "NURITEO_MASTER_KEY";

pub const MASTER_KEY_FILE: &str = "NURITEO_MASTER_KEY_FILE";

pub const MASTER_KEY_VERSION: &str = "NURITEO_MASTER_KEY_VERSION";

pub const PREVIOUS_MASTER_KEYS: &str = "NURITEO_PREVIOUS_MASTER_KEYS";

pub const PREVIOUS_MASTER_KEYS_FILE: &str = "NURITEO_PREVIOUS_MASTER_KEYS_FILE";

#[derive(Clone, PartialEq, Eq)]
pub struct SecretValue(Zeroizing<Vec<u8>>);

#[derive(Clone)]
pub(crate) struct MasterKey(Zeroizing<[u8; 32]>);

#[derive(Clone)]
pub struct MasterKeyring {
    current_version: u32,
    keys: BTreeMap<u32, MasterKey>,
}

pub(crate) struct EncryptedSecretEnvelope {
    pub(crate) key_version: u32,
    pub(crate) nonce: Vec<u8>,
    pub(crate) ciphertext: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviousKeyInput {
    version: u32,
    key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialIdentity {
    pub instance_id: String,
    pub integration_type: String,
    pub integration_id: String,
    pub credential_kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialMetadata {
    pub id: Uuid,
    pub identity: CredentialIdentity,
    pub credential_version: u64,
    pub key_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotationReport {
    pub rotated: u16,
    pub remaining: bool,
}

#[derive(Clone)]
pub struct IntegrationRepository {
    pool: DatabasePool,
    keyring: MasterKeyring,
    operation_timeout: Duration,
}

pub(crate) struct Sealed {
    key_version: u32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ValidatedCaBundle {
    pem: Vec<u8>,
    fingerprints: Vec<String>,
    earliest_expiry: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaBundleMetadata {
    pub id: Uuid,
    pub integration_type: String,
    pub integration_id: String,
    pub version: u64,
    pub state: String,
    pub fingerprints: Vec<String>,
    pub earliest_expiry: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaEndpointBinding {
    integration_type: String,
    integration_id: String,
    host: String,
    port: u16,
    transport: String,
}

#[derive(Debug, Clone, Copy)]
pub struct IntegrationAdminActor {
    pub user_id: UserId,
    pub session_id: SessionId,
}

/// Supported administrative boundary for integrity-sensitive integration CA
/// changes. It never returns PEM and cannot skip reauthentication or preflight.
#[derive(Clone)]
pub struct IntegrationAdminService {
    repository: IntegrationRepository,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaPreflightProof {
    pub endpoint_fingerprint: [u8; 32],
}

pub trait CaCandidatePreflight: Send + Sync {
    fn preflight<'a>(
        &'a self,
        candidate: &'a ValidatedCaBundle,
        endpoint: &'a CaEndpointBinding,
    ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>>;

    fn activated(&self, _candidate: &ValidatedCaBundle) -> Result<(), IntegrationError> {
        Ok(())
    }
}

pub(crate) struct StoredCa {
    version: u64,
    pem_hash: [u8; 32],
    endpoint_fingerprint: [u8; 32],
    bundle: ValidatedCaBundle,
}

pub(crate) struct IntegrationAudit<'a> {
    action: &'a str,
    kind: &'a str,
    integration_id: &'a str,
    version: i64,
    changed_field: &'a str,
    correlation: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntegrationError {
    InvalidInput,
    KeyConfiguration,
    CredentialUnavailable,
    InvalidCaBundle,
    ReauthenticationRequired,
    PreflightFailed,
    Conflict,
    Unavailable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encryption_is_context_bound_and_tamper_safe() {
        let ring = MasterKeyring::test(2, &[(2, [7; 32])]);
        let identity =
            CredentialIdentity::new("instance-a", "smtp", "default", "password").unwrap();
        let id = Uuid::now_v7();
        let sealed = seal(&ring, &identity, id, 1, b"secret").unwrap();
        let wrong = CredentialIdentity::new("instance-b", "smtp", "default", "password").unwrap();
        let cipher = Aes256Gcm::new_from_slice(ring.keys.get(&2).unwrap().0.as_slice()).unwrap();
        assert!(
            cipher
                .decrypt(
                    Nonce::from_slice(&sealed.nonce),
                    Payload {
                        msg: &sealed.ciphertext,
                        aad: &aad(&wrong, id, 1, 2)
                    }
                )
                .is_err()
        );
        assert_ne!(
            seal(&ring, &identity, id, 1, b"secret").unwrap().nonce,
            sealed.nonce
        );
    }

    #[test]
    fn redacted_secret_debug_never_exposes_value() {
        let value = SecretValue::new(b"do-not-log".to_vec()).unwrap();
        assert_eq!(format!("{value:?}"), "SecretValue([REDACTED])");
    }
}

mod keyring;
pub(crate) use keyring::*;
mod credential_identity;
pub(crate) use credential_identity::*;
mod ca;
pub(crate) use ca::*;
mod error;
pub(crate) use error::*;
