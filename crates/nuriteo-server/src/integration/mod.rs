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

impl SecretValue {
    pub fn new(value: Vec<u8>) -> Result<Self, IntegrationError> {
        if value.is_empty() || value.len() > MAX_SECRET_BYTES {
            return Err(IntegrationError::InvalidInput);
        }
        Ok(Self(Zeroizing::new(value)))
    }

    #[must_use]
    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

#[derive(Clone)]
struct MasterKey(Zeroizing<[u8; 32]>);

impl fmt::Debug for MasterKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MasterKey([REDACTED])")
    }
}

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

impl fmt::Debug for MasterKeyring {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MasterKeyring")
            .field("current_version", &self.current_version)
            .field("key_count", &self.keys.len())
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviousKeyInput {
    version: u32,
    key: String,
}

impl Drop for PreviousKeyInput {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

impl MasterKeyring {
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, IntegrationError> {
        let current = load_secret(environment, files, MASTER_KEY, MASTER_KEY_FILE)
            .map_err(|_| IntegrationError::KeyConfiguration)?
            .ok_or(IntegrationError::KeyConfiguration)?;
        let versions: Vec<_> = environment
            .entries()
            .into_iter()
            .filter_map(|(name, value)| {
                (name == MASTER_KEY_VERSION)
                    .then(|| value.into_string().ok())
                    .flatten()
            })
            .collect();
        if versions.len() != 1 {
            return Err(IntegrationError::KeyConfiguration);
        }
        let version = versions
            .into_iter()
            .next()
            .ok_or(IntegrationError::KeyConfiguration)?
            .parse::<u32>()
            .ok()
            .filter(|value| *value > 0 && *value <= i32::MAX as u32)
            .ok_or(IntegrationError::KeyConfiguration)?;
        let previous = load_secret(
            environment,
            files,
            PREVIOUS_MASTER_KEYS,
            PREVIOUS_MASTER_KEYS_FILE,
        )
        .map_err(|_| IntegrationError::KeyConfiguration)?;
        let previous: Vec<PreviousKeyInput> = previous
            .map(|value| serde_json::from_str(value.expose_secret()))
            .transpose()
            .map_err(|_| IntegrationError::KeyConfiguration)?
            .unwrap_or_default();
        if previous.len() > MAX_PREVIOUS_KEYS {
            return Err(IntegrationError::KeyConfiguration);
        }
        let mut keys = BTreeMap::new();
        keys.insert(version, decode_key(current.expose_secret())?);
        for item in previous {
            if item.version == 0 || item.version >= version || keys.contains_key(&item.version) {
                return Err(IntegrationError::KeyConfiguration);
            }
            let decoded = decode_key(&item.key)?;
            if keys.values().any(|existing| existing.0 == decoded.0) {
                return Err(IntegrationError::KeyConfiguration);
            }
            keys.insert(item.version, decoded);
        }
        Ok(Self {
            current_version: version,
            keys,
        })
    }

    #[must_use]
    pub const fn current_version(&self) -> u32 {
        self.current_version
    }

    pub(crate) fn seal_scoped(
        &self,
        domain: &[u8],
        context: &[&[u8]],
        plaintext: &[u8],
    ) -> Result<EncryptedSecretEnvelope, IntegrationError> {
        if domain.is_empty() || plaintext.is_empty() || plaintext.len() > MAX_SECRET_BYTES {
            return Err(IntegrationError::InvalidInput);
        }
        let key = self
            .keys
            .get(&self.current_version)
            .ok_or(IntegrationError::KeyConfiguration)?;
        let cipher = Aes256Gcm::new_from_slice(key.0.as_slice())
            .map_err(|_| IntegrationError::KeyConfiguration)?;
        let mut nonce = vec![0_u8; NONCE_BYTES];
        getrandom::fill(&mut nonce).map_err(|_| IntegrationError::Unavailable)?;
        let aad = scoped_aad(domain, context, self.current_version)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| IntegrationError::CredentialUnavailable)?;
        Ok(EncryptedSecretEnvelope {
            key_version: self.current_version,
            nonce,
            ciphertext,
        })
    }

    pub(crate) fn open_scoped(
        &self,
        domain: &[u8],
        context: &[&[u8]],
        key_version: u32,
        nonce: &[u8],
        ciphertext: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, IntegrationError> {
        if domain.is_empty() || nonce.len() != NONCE_BYTES {
            return Err(IntegrationError::CredentialUnavailable);
        }
        let key = self
            .keys
            .get(&key_version)
            .ok_or(IntegrationError::CredentialUnavailable)?;
        let cipher = Aes256Gcm::new_from_slice(key.0.as_slice())
            .map_err(|_| IntegrationError::CredentialUnavailable)?;
        let aad = scoped_aad(domain, context, key_version)
            .map_err(|_| IntegrationError::CredentialUnavailable)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(nonce),
                    Payload {
                        msg: ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| IntegrationError::CredentialUnavailable)?,
        );
        if plaintext.is_empty() || plaintext.len() > MAX_SECRET_BYTES {
            return Err(IntegrationError::CredentialUnavailable);
        }
        Ok(plaintext)
    }

    pub(crate) fn attest_scoped(
        &self,
        domain: &[u8],
        context: &[&[u8]],
    ) -> Result<(u32, [u8; 32]), IntegrationError> {
        let key = self
            .keys
            .get(&self.current_version)
            .ok_or(IntegrationError::KeyConfiguration)?;
        let input = scoped_attestation_input(domain, context, self.current_version)?;
        let mut mac = <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(key.0.as_slice())
            .map_err(|_| IntegrationError::KeyConfiguration)?;
        mac.update(&input);
        Ok((self.current_version, mac.finalize().into_bytes().into()))
    }

    pub(crate) fn verify_scoped_attestation(
        &self,
        domain: &[u8],
        context: &[&[u8]],
        key_version: u32,
        attestation: &[u8],
    ) -> Result<(), IntegrationError> {
        if attestation.len() != 32 {
            return Err(IntegrationError::CredentialUnavailable);
        }
        let key = self
            .keys
            .get(&key_version)
            .ok_or(IntegrationError::CredentialUnavailable)?;
        let input = scoped_attestation_input(domain, context, key_version)
            .map_err(|_| IntegrationError::CredentialUnavailable)?;
        let mut mac = <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(key.0.as_slice())
            .map_err(|_| IntegrationError::CredentialUnavailable)?;
        mac.update(&input);
        mac.verify_slice(attestation)
            .map_err(|_| IntegrationError::CredentialUnavailable)
    }

    #[cfg(test)]
    fn test(version: u32, entries: &[(u32, [u8; 32])]) -> Self {
        Self {
            current_version: version,
            keys: entries
                .iter()
                .map(|(version, key)| (*version, MasterKey(Zeroizing::new(*key))))
                .collect(),
        }
    }
}

fn scoped_attestation_input(
    domain: &[u8],
    context: &[&[u8]],
    key_version: u32,
) -> Result<Vec<u8>, IntegrationError> {
    if domain.is_empty() {
        return Err(IntegrationError::InvalidInput);
    }
    let mut out = Vec::new();
    for field in std::iter::once(b"nuriteo.hmac-attestation.v1".as_slice())
        .chain(std::iter::once(domain))
        .chain(context.iter().copied())
        .chain([key_version.to_be_bytes().as_slice()])
    {
        let length = u32::try_from(field.len()).map_err(|_| IntegrationError::InvalidInput)?;
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(field);
    }
    Ok(out)
}

fn scoped_aad(
    domain: &[u8],
    context: &[&[u8]],
    key_version: u32,
) -> Result<Vec<u8>, IntegrationError> {
    let mut out = Vec::new();
    for field in std::iter::once(domain)
        .chain(context.iter().copied())
        .chain([key_version.to_be_bytes().as_slice(), ALGORITHM.as_bytes()])
    {
        let length = u32::try_from(field.len()).map_err(|_| IntegrationError::InvalidInput)?;
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(field);
    }
    Ok(out)
}

fn decode_key(value: &str) -> Result<MasterKey, IntegrationError> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .or_else(|_| STANDARD.decode(value))
            .map_err(|_| IntegrationError::KeyConfiguration)?,
    );
    if decoded.len() != 32 {
        return Err(IntegrationError::KeyConfiguration);
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&decoded);
    let protected = MasterKey(Zeroizing::new(key));
    key.zeroize();
    Ok(protected)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialIdentity {
    pub instance_id: String,
    pub integration_type: String,
    pub integration_id: String,
    pub credential_kind: String,
}

impl CredentialIdentity {
    pub fn new(
        instance_id: impl Into<String>,
        integration_type: impl Into<String>,
        integration_id: impl Into<String>,
        credential_kind: impl Into<String>,
    ) -> Result<Self, IntegrationError> {
        let value = Self {
            instance_id: instance_id.into(),
            integration_type: integration_type.into(),
            integration_id: integration_id.into(),
            credential_kind: credential_kind.into(),
        };
        if !valid_name(&value.instance_id, 128, false)
            || !valid_name(&value.integration_type, 64, true)
            || !valid_name(&value.integration_id, 128, false)
            || !valid_name(&value.credential_kind, 64, true)
        {
            return Err(IntegrationError::InvalidInput);
        }
        Ok(value)
    }
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

impl fmt::Debug for IntegrationRepository {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IntegrationRepository")
            .field("keyring", &self.keyring)
            .finish_non_exhaustive()
    }
}

impl IntegrationRepository {
    #[must_use]
    pub const fn new(pool: DatabasePool, keyring: MasterKeyring) -> Self {
        Self {
            pool,
            keyring,
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Result<Self, IntegrationError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&timeout) {
            return Err(IntegrationError::InvalidInput);
        }
        self.operation_timeout = timeout;
        Ok(self)
    }

    #[must_use]
    pub(crate) const fn pool(&self) -> &DatabasePool {
        &self.pool
    }

    pub(crate) fn attest_scoped(
        &self,
        domain: &[u8],
        context: &[&[u8]],
    ) -> Result<(u32, [u8; 32]), IntegrationError> {
        self.keyring.attest_scoped(domain, context)
    }

    pub(crate) fn verify_scoped_attestation(
        &self,
        domain: &[u8],
        context: &[&[u8]],
        key_version: u32,
        attestation: &[u8],
    ) -> Result<(), IntegrationError> {
        self.keyring
            .verify_scoped_attestation(domain, context, key_version, attestation)
    }

    #[allow(dead_code, reason = "crate-private OIDC login adapter handoff")]
    pub(crate) fn seal_ephemeral(
        &self,
        domain: &[u8],
        context: &[&[u8]],
        plaintext: &[u8],
    ) -> Result<EncryptedSecretEnvelope, IntegrationError> {
        self.keyring.seal_scoped(domain, context, plaintext)
    }

    #[allow(dead_code, reason = "crate-private OIDC login adapter handoff")]
    pub(crate) fn open_ephemeral(
        &self,
        domain: &[u8],
        context: &[&[u8]],
        key_version: u32,
        nonce: &[u8],
        ciphertext: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, IntegrationError> {
        self.keyring
            .open_scoped(domain, context, key_version, nonce, ciphertext)
    }

    pub(crate) async fn upsert_credential_in_transaction(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        identity: &CredentialIdentity,
        secret: &SecretValue,
    ) -> Result<CredentialMetadata, IntegrationError> {
        upsert_credential(transaction, &self.keyring, identity, secret).await
    }

    pub(crate) async fn read_credential_by_id_in_transaction(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        id: Uuid,
    ) -> Result<(CredentialIdentity, u64, SecretValue), IntegrationError> {
        let row = sqlx::query(
            "SELECT id::text,instance_id,integration_type,integration_id,credential_kind,
              credential_version,algorithm,key_version,nonce,ciphertext
             FROM integration_credentials WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|_| IntegrationError::Unavailable)?
        .ok_or(IntegrationError::CredentialUnavailable)?;
        let identity = identity_from_row(&row)?;
        let logical_version = read_logical_version(&row)?;
        let secret = open_row(&self.keyring, &identity, &row)?;
        Ok((identity, logical_version, secret))
    }

    async fn put_credential(
        &self,
        actor: IntegrationAdminActor,
        identity: &CredentialIdentity,
        secret: &SecretValue,
        correlation_id: &str,
    ) -> Result<CredentialMetadata, IntegrationError> {
        if requires_integration_specific_admin(identity) {
            return Err(IntegrationError::InvalidInput);
        }
        if !valid_correlation(correlation_id) {
            return Err(IntegrationError::InvalidInput);
        }
        tokio::time::timeout(
            self.operation_timeout,
            self.put_credential_inner(actor, identity, secret, correlation_id),
        )
        .await
        .map_err(|_| IntegrationError::Unavailable)?
    }

    async fn put_credential_inner(
        &self,
        actor: IntegrationAdminActor,
        identity: &CredentialIdentity,
        secret: &SecretValue,
        correlation_id: &str,
    ) -> Result<CredentialMetadata, IntegrationError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        authorize_recent_admin(&mut transaction, actor).await?;
        let metadata = upsert_credential(&mut transaction, &self.keyring, identity, secret).await?;
        append_audit(
            &mut transaction,
            actor.user_id,
            IntegrationAudit {
                action: "integration.credential_updated",
                kind: &identity.integration_type,
                integration_id: &identity.integration_id,
                version: i64::try_from(metadata.credential_version)
                    .map_err(|_| IntegrationError::Unavailable)?,
                changed_field: "credential",
                correlation: correlation_id,
            },
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        Ok(metadata)
    }

    async fn put_smtp_credential_pair(
        &self,
        actor: IntegrationAdminActor,
        instance_id: &str,
        username: &SecretValue,
        password: &SecretValue,
        correlation_id: &str,
    ) -> Result<(CredentialMetadata, CredentialMetadata), IntegrationError> {
        if !valid_correlation(correlation_id) {
            return Err(IntegrationError::InvalidInput);
        }
        tokio::time::timeout(self.operation_timeout, async {
            let username_identity =
                CredentialIdentity::new(instance_id, "smtp", "default", "username")?;
            let password_identity =
                CredentialIdentity::new(instance_id, "smtp", "default", "password")?;
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
            authorize_recent_admin(&mut transaction, actor).await?;
            let username_metadata = upsert_credential(
                &mut transaction,
                &self.keyring,
                &username_identity,
                username,
            )
            .await?;
            let password_metadata = upsert_credential(
                &mut transaction,
                &self.keyring,
                &password_identity,
                password,
            )
            .await?;
            append_audit(
                &mut transaction,
                actor.user_id,
                IntegrationAudit {
                    action: "integration.credential_updated",
                    kind: "smtp",
                    integration_id: "default",
                    version: i64::try_from(
                        username_metadata
                            .credential_version
                            .max(password_metadata.credential_version),
                    )
                    .map_err(|_| IntegrationError::Unavailable)?,
                    changed_field: "credential_pair",
                    correlation: correlation_id,
                },
            )
            .await?;
            transaction
                .commit()
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
            Ok((username_metadata, password_metadata))
        })
        .await
        .map_err(|_| IntegrationError::Unavailable)?
    }

    pub async fn rotate_batch(&self, limit: u16) -> Result<RotationReport, IntegrationError> {
        tokio::time::timeout(self.operation_timeout, self.rotate_batch_inner(limit))
            .await
            .map_err(|_| IntegrationError::Unavailable)?
    }

    async fn rotate_batch_inner(&self, limit: u16) -> Result<RotationReport, IntegrationError> {
        if limit == 0 || limit > MAX_ROTATION_BATCH {
            return Err(IntegrationError::InvalidInput);
        }
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        let rows = sqlx::query(
            "SELECT id::text,instance_id,integration_type,integration_id,credential_kind,
                    credential_version,algorithm,key_version,nonce,ciphertext
             FROM integration_credentials WHERE key_version <> $1 ORDER BY id
             FOR UPDATE SKIP LOCKED LIMIT $2",
        )
        .bind(
            i32::try_from(self.keyring.current_version)
                .map_err(|_| IntegrationError::KeyConfiguration)?,
        )
        .bind(i64::from(limit))
        .fetch_all(&mut *transaction)
        .await
        .map_err(|_| IntegrationError::Unavailable)?;
        for row in &rows {
            let identity = identity_from_row(row)?;
            let plaintext = open_row(&self.keyring, &identity, row)?;
            let id = parse_id(row)?;
            let logical_version = read_logical_version(row)?;
            let sealed = seal(
                &self.keyring,
                &identity,
                id,
                logical_version,
                plaintext.expose(),
            )?;
            sqlx::query(
                "UPDATE integration_credentials SET key_version=$1,nonce=$2,ciphertext=$3,
                 algorithm=$4,updated_at=CURRENT_TIMESTAMP WHERE id=$5::uuid AND key_version<>$1",
            )
            .bind(
                i32::try_from(sealed.key_version)
                    .map_err(|_| IntegrationError::KeyConfiguration)?,
            )
            .bind(sealed.nonce)
            .bind(sealed.ciphertext)
            .bind(ALGORITHM)
            .bind(id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        }
        let remaining: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM integration_credentials WHERE key_version <> $1)",
        )
        .bind(
            i32::try_from(self.keyring.current_version)
                .map_err(|_| IntegrationError::KeyConfiguration)?,
        )
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| IntegrationError::Unavailable)?;
        transaction
            .commit()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        Ok(RotationReport {
            rotated: u16::try_from(rows.len()).map_err(|_| IntegrationError::Unavailable)?,
            remaining,
        })
    }
}

async fn upsert_credential(
    transaction: &mut Transaction<'_, Postgres>,
    keyring: &MasterKeyring,
    identity: &CredentialIdentity,
    secret: &SecretValue,
) -> Result<CredentialMetadata, IntegrationError> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(credential_lock_key(identity))
        .execute(&mut **transaction)
        .await
        .map_err(|_| IntegrationError::Unavailable)?;
    let existing = sqlx::query(
        "SELECT id::text, credential_version FROM integration_credentials
         WHERE instance_id=$1 AND integration_type=$2 AND integration_id=$3
           AND credential_kind=$4 FOR UPDATE",
    )
    .bind(&identity.instance_id)
    .bind(&identity.integration_type)
    .bind(&identity.integration_id)
    .bind(&identity.credential_kind)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| IntegrationError::Unavailable)?;
    let (id, logical_version) = match existing {
        Some(row) => {
            let id = Uuid::from_str(row.get::<String, _>("id").as_str())
                .map_err(|_| IntegrationError::Unavailable)?;
            let version: i64 = row.get("credential_version");
            (
                id,
                version
                    .checked_add(1)
                    .ok_or(IntegrationError::Unavailable)?,
            )
        }
        None => (Uuid::now_v7(), 1),
    };
    let sealed = seal(
        keyring,
        identity,
        id,
        u64::try_from(logical_version).map_err(|_| IntegrationError::Unavailable)?,
        secret.expose(),
    )?;
    sqlx::query(
        "INSERT INTO integration_credentials
         (id,instance_id,integration_type,integration_id,credential_kind,credential_version,
          algorithm,key_version,nonce,ciphertext)
         VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(instance_id,integration_type,integration_id,credential_kind) DO UPDATE SET
          credential_version=EXCLUDED.credential_version, algorithm=EXCLUDED.algorithm,
          key_version=EXCLUDED.key_version, nonce=EXCLUDED.nonce,
          ciphertext=EXCLUDED.ciphertext, updated_at=CURRENT_TIMESTAMP",
    )
    .bind(id.to_string())
    .bind(&identity.instance_id)
    .bind(&identity.integration_type)
    .bind(&identity.integration_id)
    .bind(&identity.credential_kind)
    .bind(logical_version)
    .bind(ALGORITHM)
    .bind(i32::try_from(sealed.key_version).map_err(|_| IntegrationError::KeyConfiguration)?)
    .bind(sealed.nonce)
    .bind(sealed.ciphertext)
    .execute(&mut **transaction)
    .await
    .map_err(|_| IntegrationError::Unavailable)?;
    Ok(CredentialMetadata {
        id,
        identity: identity.clone(),
        credential_version: u64::try_from(logical_version)
            .map_err(|_| IntegrationError::Unavailable)?,
        key_version: sealed.key_version,
    })
}

fn credential_lock_key(identity: &CredentialIdentity) -> i64 {
    let fields = [
        identity.instance_id.as_bytes(),
        identity.integration_type.as_bytes(),
        identity.integration_id.as_bytes(),
        identity.credential_kind.as_bytes(),
    ];
    let mut canonical = Vec::new();
    for field in fields {
        canonical.extend_from_slice(&(field.len() as u32).to_be_bytes());
        canonical.extend_from_slice(field);
    }
    let digest = Sha256::digest(canonical);
    i64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("SHA-256 prefix has fixed length"),
    )
}

fn requires_integration_specific_admin(identity: &CredentialIdentity) -> bool {
    (identity.integration_type == "smtp"
        && identity.integration_id == "default"
        && matches!(identity.credential_kind.as_str(), "username" | "password"))
        || (identity.integration_type == "oidc" && identity.credential_kind == "client_secret")
}

struct Sealed {
    key_version: u32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

fn seal(
    ring: &MasterKeyring,
    identity: &CredentialIdentity,
    id: Uuid,
    logical_version: u64,
    plaintext: &[u8],
) -> Result<Sealed, IntegrationError> {
    let key = ring
        .keys
        .get(&ring.current_version)
        .ok_or(IntegrationError::KeyConfiguration)?;
    let cipher = Aes256Gcm::new_from_slice(key.0.as_slice())
        .map_err(|_| IntegrationError::KeyConfiguration)?;
    let mut nonce = vec![0_u8; NONCE_BYTES];
    getrandom::fill(&mut nonce).map_err(|_| IntegrationError::Unavailable)?;
    let aad = aad(identity, id, logical_version, ring.current_version);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| IntegrationError::CredentialUnavailable)?;
    Ok(Sealed {
        key_version: ring.current_version,
        nonce,
        ciphertext,
    })
}

fn open_row(
    ring: &MasterKeyring,
    identity: &CredentialIdentity,
    row: &sqlx::postgres::PgRow,
) -> Result<SecretValue, IntegrationError> {
    if row.get::<String, _>("algorithm") != ALGORITHM {
        return Err(IntegrationError::CredentialUnavailable);
    }
    let key_version_i32: i32 = row.get("key_version");
    let key_version =
        u32::try_from(key_version_i32).map_err(|_| IntegrationError::CredentialUnavailable)?;
    let key = ring
        .keys
        .get(&key_version)
        .ok_or(IntegrationError::CredentialUnavailable)?;
    let nonce: Vec<u8> = row.get("nonce");
    if nonce.len() != NONCE_BYTES {
        return Err(IntegrationError::CredentialUnavailable);
    }
    let id = parse_id(row)?;
    let logical_version = read_logical_version(row)?;
    let aad = aad(identity, id, logical_version, key_version);
    let cipher = Aes256Gcm::new_from_slice(key.0.as_slice())
        .map_err(|_| IntegrationError::CredentialUnavailable)?;
    let ciphertext: Vec<u8> = row.get("ciphertext");
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| IntegrationError::CredentialUnavailable)?,
    );
    if plaintext.is_empty() || plaintext.len() > MAX_SECRET_BYTES {
        return Err(IntegrationError::CredentialUnavailable);
    }
    Ok(SecretValue(plaintext))
}

fn aad(identity: &CredentialIdentity, id: Uuid, logical_version: u64, key_version: u32) -> Vec<u8> {
    let fields: [&[u8]; 8] = [
        b"nuriteo.integration-credential.v1",
        identity.instance_id.as_bytes(),
        identity.integration_type.as_bytes(),
        identity.integration_id.as_bytes(),
        identity.credential_kind.as_bytes(),
        id.as_bytes(),
        &logical_version.to_be_bytes(),
        &key_version.to_be_bytes(),
    ];
    let mut out = Vec::new();
    for field in fields {
        out.extend_from_slice(&u32::try_from(field.len()).unwrap_or(u32::MAX).to_be_bytes());
        out.extend_from_slice(field);
    }
    out.extend_from_slice(&(ALGORITHM.len() as u32).to_be_bytes());
    out.extend_from_slice(ALGORITHM.as_bytes());
    out
}

fn identity_from_row(row: &sqlx::postgres::PgRow) -> Result<CredentialIdentity, IntegrationError> {
    CredentialIdentity::new(
        row.get::<String, _>("instance_id"),
        row.get::<String, _>("integration_type"),
        row.get::<String, _>("integration_id"),
        row.get::<String, _>("credential_kind"),
    )
    .map_err(|_| IntegrationError::CredentialUnavailable)
}

fn parse_id(row: &sqlx::postgres::PgRow) -> Result<Uuid, IntegrationError> {
    Uuid::from_str(&row.get::<String, _>("id")).map_err(|_| IntegrationError::CredentialUnavailable)
}

fn read_logical_version(row: &sqlx::postgres::PgRow) -> Result<u64, IntegrationError> {
    u64::try_from(row.get::<i64, _>("credential_version"))
        .map_err(|_| IntegrationError::CredentialUnavailable)
}

#[derive(Clone, PartialEq, Eq)]
pub struct ValidatedCaBundle {
    pem: Vec<u8>,
    fingerprints: Vec<String>,
    earliest_expiry: OffsetDateTime,
}

impl fmt::Debug for ValidatedCaBundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedCaBundle")
            .field("certificate_count", &self.fingerprints.len())
            .field("fingerprints", &self.fingerprints)
            .field("earliest_expiry", &self.earliest_expiry)
            .field("pem", &"[HIDDEN]")
            .finish()
    }
}

impl ValidatedCaBundle {
    pub fn parse(pem: Vec<u8>) -> Result<Self, IntegrationError> {
        if pem.is_empty() || pem.len() > MAX_CA_BYTES {
            return Err(IntegrationError::InvalidCaBundle);
        }
        let mut fingerprints = Vec::new();
        let mut seen = HashSet::new();
        let mut earliest_expiry = None;
        for item in rustls_pemfile::read_all(&mut Cursor::new(&pem)) {
            let Item::X509Certificate(certificate) =
                item.map_err(|_| IntegrationError::InvalidCaBundle)?
            else {
                return Err(IntegrationError::InvalidCaBundle);
            };
            let (remainder, parsed) = X509Certificate::from_der(certificate.as_ref())
                .map_err(|_| IntegrationError::InvalidCaBundle)?;
            let is_ca = parsed
                .basic_constraints()
                .map_err(|_| IntegrationError::InvalidCaBundle)?
                .is_some_and(|constraints| constraints.value.ca);
            if !remainder.is_empty() || !is_ca || !parsed.validity().is_valid() {
                return Err(IntegrationError::InvalidCaBundle);
            }
            let expiry = parsed.validity().not_after.to_datetime();
            earliest_expiry =
                Some(earliest_expiry.map_or(expiry, |current: OffsetDateTime| current.min(expiry)));
            let fingerprint = hex_lower(&Sha256::digest(certificate.as_ref()));
            if !seen.insert(fingerprint.clone()) {
                return Err(IntegrationError::InvalidCaBundle);
            }
            fingerprints.push(fingerprint);
            if fingerprints.len() > MAX_CA_CERTIFICATES {
                return Err(IntegrationError::InvalidCaBundle);
            }
        }
        if fingerprints.is_empty() {
            return Err(IntegrationError::InvalidCaBundle);
        }
        Ok(Self {
            pem,
            fingerprints,
            earliest_expiry: earliest_expiry.ok_or(IntegrationError::InvalidCaBundle)?,
        })
    }

    #[must_use]
    pub fn pem(&self) -> &[u8] {
        &self.pem
    }
    #[must_use]
    pub fn fingerprints(&self) -> &[String] {
        &self.fingerprints
    }
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

impl CaEndpointBinding {
    pub fn new(
        integration_type: impl Into<String>,
        integration_id: impl Into<String>,
        host: impl Into<String>,
        port: u16,
        transport: impl Into<String>,
    ) -> Result<Self, IntegrationError> {
        let binding = Self {
            integration_type: integration_type.into(),
            integration_id: integration_id.into(),
            host: host.into().to_ascii_lowercase(),
            port,
            transport: transport.into(),
        };
        if !valid_name(&binding.integration_type, 64, true)
            || !valid_name(&binding.integration_id, 128, false)
            || !valid_endpoint_host(&binding.host)
            || binding.port == 0
            || !valid_name(&binding.transport, 64, true)
        {
            return Err(IntegrationError::InvalidInput);
        }
        Ok(binding)
    }

    #[must_use]
    pub fn integration_type(&self) -> &str {
        &self.integration_type
    }

    #[must_use]
    pub fn integration_id(&self) -> &str {
        &self.integration_id
    }

    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }

    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    #[must_use]
    pub fn transport(&self) -> &str {
        &self.transport
    }

    #[must_use]
    pub fn fingerprint(&self) -> [u8; 32] {
        let port = self.port.to_be_bytes();
        let fields = [
            b"nuriteo.integration-endpoint.v1".as_slice(),
            self.integration_type.as_bytes(),
            self.integration_id.as_bytes(),
            self.host.as_bytes(),
            port.as_slice(),
            self.transport.as_bytes(),
        ];
        let mut canonical = Vec::new();
        for field in fields {
            canonical.extend_from_slice(&(field.len() as u32).to_be_bytes());
            canonical.extend_from_slice(field);
        }
        Sha256::digest(canonical).into()
    }
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

impl fmt::Debug for IntegrationAdminService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IntegrationAdminService")
            .finish_non_exhaustive()
    }
}

impl IntegrationAdminService {
    #[must_use]
    pub const fn new(repository: IntegrationRepository) -> Self {
        Self { repository }
    }

    pub async fn put_credential(
        &self,
        actor: IntegrationAdminActor,
        identity: &CredentialIdentity,
        secret: &SecretValue,
        correlation_id: &str,
    ) -> Result<CredentialMetadata, IntegrationError> {
        if requires_integration_specific_admin(identity) {
            return Err(IntegrationError::InvalidInput);
        }
        self.repository
            .put_credential(actor, identity, secret, correlation_id)
            .await
    }

    pub async fn put_smtp_credential_pair(
        &self,
        actor: IntegrationAdminActor,
        instance_id: &str,
        username: &SecretValue,
        password: &SecretValue,
        correlation_id: &str,
    ) -> Result<(CredentialMetadata, CredentialMetadata), IntegrationError> {
        self.repository
            .put_smtp_credential_pair(actor, instance_id, username, password, correlation_id)
            .await
    }

    pub async fn stage_ca_candidate(
        &self,
        actor: IntegrationAdminActor,
        endpoint: &CaEndpointBinding,
        bundle: ValidatedCaBundle,
        correlation_id: &str,
    ) -> Result<CaBundleMetadata, IntegrationError> {
        self.repository
            .stage_ca_candidate(actor, endpoint, bundle, None, correlation_id)
            .await
    }

    pub async fn stage_ca_candidate_versioned(
        &self,
        actor: IntegrationAdminActor,
        endpoint: &CaEndpointBinding,
        bundle: ValidatedCaBundle,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<CaBundleMetadata, IntegrationError> {
        self.repository
            .stage_ca_candidate(
                actor,
                endpoint,
                bundle,
                Some(expected_version),
                correlation_id,
            )
            .await
    }

    pub async fn activate_ca_candidate(
        &self,
        actor: IntegrationAdminActor,
        candidate_id: Uuid,
        endpoint: &CaEndpointBinding,
        correlation_id: &str,
        preflight: &impl CaCandidatePreflight,
    ) -> Result<CaBundleMetadata, IntegrationError> {
        self.repository
            .activate_ca_candidate(actor, candidate_id, endpoint, correlation_id, preflight)
            .await
    }

    pub async fn list_ca_metadata(
        &self,
        actor: IntegrationAdminActor,
        integration_type: &str,
        integration_id: &str,
    ) -> Result<Vec<CaBundleMetadata>, IntegrationError> {
        self.repository
            .list_ca_metadata(actor, integration_type, integration_id)
            .await
    }
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

impl IntegrationRepository {
    async fn stage_ca_candidate(
        &self,
        actor: IntegrationAdminActor,
        endpoint: &CaEndpointBinding,
        bundle: ValidatedCaBundle,
        expected_version: Option<u64>,
        correlation_id: &str,
    ) -> Result<CaBundleMetadata, IntegrationError> {
        tokio::time::timeout(
            self.operation_timeout,
            self.stage_ca_candidate_inner(
                actor,
                endpoint,
                bundle,
                expected_version,
                correlation_id,
            ),
        )
        .await
        .map_err(|_| IntegrationError::Unavailable)?
    }

    async fn stage_ca_candidate_inner(
        &self,
        actor: IntegrationAdminActor,
        endpoint: &CaEndpointBinding,
        bundle: ValidatedCaBundle,
        expected_version: Option<u64>,
        correlation_id: &str,
    ) -> Result<CaBundleMetadata, IntegrationError> {
        if !valid_correlation(correlation_id) {
            return Err(IntegrationError::InvalidInput);
        }
        let integration_type = endpoint.integration_type();
        let integration_id = endpoint.integration_id();
        let endpoint_fingerprint = endpoint.fingerprint();
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        sqlx::query("SELECT pg_advisory_xact_lock(1229870147, hashtext($1))")
            .bind(format!(
                "{}:{}",
                endpoint.integration_type(),
                endpoint.integration_id()
            ))
            .execute(&mut *tx)
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor).await?;
        let current_version: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(version),0) FROM integration_ca_bundles WHERE integration_type=$1 AND integration_id=$2",
        )
        .bind(integration_type)
        .bind(integration_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| IntegrationError::Unavailable)?;
        if let Some(expected) = expected_version
            && i64::try_from(expected).map_err(|_| IntegrationError::InvalidInput)?
                != current_version
        {
            let replay = sqlx::query(
                "SELECT bundle.id::text,bundle.version,bundle.state,bundle.pem,bundle.certificate_count,
                        bundle.fingerprints,bundle.earliest_expiry,bundle.endpoint_fingerprint
                 FROM integration_ca_bundles bundle
                 WHERE bundle.integration_type=$1 AND bundle.integration_id=$2 AND bundle.state='candidate'
                   AND EXISTS(SELECT 1 FROM audit_events audit WHERE audit.action_code='integration.ca_staged'
                     AND audit.target_type='integration' AND audit.target_id=$3 AND audit.correlation_id=$4)",
            )
            .bind(integration_type)
            .bind(integration_id)
            .bind(format!("{integration_type}:{integration_id}"))
            .bind(correlation_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
            if let Some(row) = replay {
                let stored = validate_stored_ca(&row)?;
                let stored_endpoint: Vec<u8> = row.get("endpoint_fingerprint");
                if stored_endpoint == endpoint_fingerprint && stored.pem() == bundle.pem() {
                    tx.commit()
                        .await
                        .map_err(|_| IntegrationError::Unavailable)?;
                    return Ok(CaBundleMetadata {
                        id: Uuid::from_str(&row.get::<String, _>("id"))
                            .map_err(|_| IntegrationError::Unavailable)?,
                        integration_type: integration_type.into(),
                        integration_id: integration_id.into(),
                        version: u64::try_from(row.get::<i64, _>("version"))
                            .map_err(|_| IntegrationError::Unavailable)?,
                        state: row.get("state"),
                        fingerprints: row.get("fingerprints"),
                        earliest_expiry: row.get("earliest_expiry"),
                    });
                }
            }
            return Err(IntegrationError::Conflict);
        }
        sqlx::query("DELETE FROM integration_ca_bundles WHERE integration_type=$1 AND integration_id=$2 AND state='candidate'")
            .bind(integration_type).bind(integration_id).execute(&mut *tx).await.map_err(|_| IntegrationError::Unavailable)?;
        let version: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(version),0)+1 FROM integration_ca_bundles WHERE integration_type=$1 AND integration_id=$2",
        ).bind(integration_type).bind(integration_id).fetch_one(&mut *tx).await.map_err(|_| IntegrationError::Unavailable)?;
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO integration_ca_bundles(id,integration_type,integration_id,version,state,pem,
             certificate_count,fingerprints,earliest_expiry,endpoint_fingerprint)
             VALUES($1::uuid,$2,$3,$4,'candidate',$5,$6,$7,$8,$9)",
        )
        .bind(id.to_string()).bind(integration_type).bind(integration_id).bind(version)
        .bind(bundle.pem).bind(i16::try_from(bundle.fingerprints.len()).map_err(|_| IntegrationError::InvalidCaBundle)?)
        .bind(&bundle.fingerprints).bind(bundle.earliest_expiry).bind(endpoint_fingerprint.to_vec())
        .execute(&mut *tx).await.map_err(map_ca_stage_error)?;
        append_audit(
            &mut tx,
            actor.user_id,
            IntegrationAudit {
                action: "integration.ca_staged",
                kind: integration_type,
                integration_id,
                version,
                changed_field: "ca_bundle",
                correlation: correlation_id,
            },
        )
        .await?;
        tx.commit()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        Ok(CaBundleMetadata {
            id,
            integration_type: integration_type.into(),
            integration_id: integration_id.into(),
            version: version as u64,
            state: "candidate".into(),
            fingerprints: bundle.fingerprints,
            earliest_expiry: bundle.earliest_expiry,
        })
    }

    async fn activate_ca_candidate(
        &self,
        actor: IntegrationAdminActor,
        candidate_id: Uuid,
        endpoint: &CaEndpointBinding,
        correlation_id: &str,
        preflight: &impl CaCandidatePreflight,
    ) -> Result<CaBundleMetadata, IntegrationError> {
        if !valid_correlation(correlation_id) {
            return Err(IntegrationError::InvalidInput);
        }
        let candidate = match tokio::time::timeout(
            self.operation_timeout,
            self.load_ca(candidate_id, "candidate"),
        )
        .await
        .map_err(|_| IntegrationError::Unavailable)??
        {
            Some(candidate) => candidate,
            None => {
                return tokio::time::timeout(
                    self.operation_timeout,
                    self.replay_ca_activation(candidate_id, endpoint, correlation_id, preflight),
                )
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
            }
        };
        let expected_endpoint = endpoint.fingerprint();
        if candidate.endpoint_fingerprint != expected_endpoint {
            return Err(IntegrationError::PreflightFailed);
        }
        let proof = preflight
            .preflight(&candidate.bundle, endpoint)
            .await
            .map_err(|_| IntegrationError::PreflightFailed)?;
        let activated = tokio::time::timeout(
            self.operation_timeout,
            self.activate_ca_candidate_inner(
                actor,
                candidate_id,
                endpoint,
                correlation_id,
                &candidate,
                proof,
            ),
        )
        .await
        .map_err(|_| IntegrationError::Unavailable)??;
        preflight.activated(&candidate.bundle)?;
        Ok(activated)
    }

    async fn replay_ca_activation(
        &self,
        candidate_id: Uuid,
        endpoint: &CaEndpointBinding,
        correlation_id: &str,
        preflight: &impl CaCandidatePreflight,
    ) -> Result<CaBundleMetadata, IntegrationError> {
        let active = self
            .load_ca(candidate_id, "active")
            .await?
            .ok_or(IntegrationError::PreflightFailed)?;
        let replay: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM audit_events WHERE action_code='integration.ca_activated'
             AND target_type='integration' AND target_id=$1 AND correlation_id=$2)",
        )
        .bind(format!(
            "{}:{}",
            endpoint.integration_type(),
            endpoint.integration_id()
        ))
        .bind(correlation_id)
        .fetch_one(
            &mut *self
                .pool
                .acquire()
                .await
                .map_err(|_| IntegrationError::Unavailable)?,
        )
        .await
        .map_err(|_| IntegrationError::Unavailable)?;
        if !replay || active.endpoint_fingerprint != endpoint.fingerprint() {
            return Err(IntegrationError::PreflightFailed);
        }
        preflight.activated(&active.bundle)?;
        Ok(CaBundleMetadata {
            id: candidate_id,
            integration_type: endpoint.integration_type().into(),
            integration_id: endpoint.integration_id().into(),
            version: active.version,
            state: "active".into(),
            fingerprints: active.bundle.fingerprints.clone(),
            earliest_expiry: active.bundle.earliest_expiry,
        })
    }

    async fn activate_ca_candidate_inner(
        &self,
        actor: IntegrationAdminActor,
        candidate_id: Uuid,
        endpoint: &CaEndpointBinding,
        correlation_id: &str,
        candidate: &StoredCa,
        proof: CaPreflightProof,
    ) -> Result<CaBundleMetadata, IntegrationError> {
        let expected_endpoint = endpoint.fingerprint();
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        sqlx::query("SELECT pg_advisory_xact_lock(1229870147, hashtext($1))")
            .bind(format!(
                "{}:{}",
                endpoint.integration_type(),
                endpoint.integration_id()
            ))
            .execute(&mut *tx)
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        authorize_recent_admin(&mut tx, actor).await?;
        lock_and_validate_endpoint(&mut tx, endpoint).await?;
        let row = sqlx::query(
            "SELECT integration_type,integration_id,version,pem,certificate_count,fingerprints,earliest_expiry,endpoint_fingerprint
             FROM integration_ca_bundles WHERE id=$1::uuid AND state='candidate' FOR UPDATE",
        ).bind(candidate_id.to_string()).fetch_optional(&mut *tx).await.map_err(|_| IntegrationError::Unavailable)?
            .ok_or(IntegrationError::PreflightFailed)?;
        let stored_endpoint: Vec<u8> = row.get("endpoint_fingerprint");
        let reparsed = validate_stored_ca(&row)?;
        if stored_endpoint != expected_endpoint
            || proof.endpoint_fingerprint != expected_endpoint
            || candidate.pem_hash != Sha256::digest(reparsed.pem()).as_slice()
            || candidate.version
                != u64::try_from(row.get::<i64, _>("version"))
                    .map_err(|_| IntegrationError::PreflightFailed)?
        {
            return Err(IntegrationError::PreflightFailed);
        }
        let integration_type: String = row.get("integration_type");
        let integration_id: String = row.get("integration_id");
        let version: i64 = row.get("version");
        sqlx::query(
            "UPDATE integration_ca_bundles SET state='retired',retired_at=CURRENT_TIMESTAMP
             WHERE integration_type=$1 AND integration_id=$2 AND state='active'",
        )
        .bind(&integration_type)
        .bind(&integration_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| IntegrationError::Unavailable)?;
        let changed = sqlx::query(
            "UPDATE integration_ca_bundles SET state='active',activated_at=CURRENT_TIMESTAMP
             WHERE id=$1::uuid AND state='candidate'",
        )
        .bind(candidate_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(|_| IntegrationError::Unavailable)?
        .rows_affected();
        if changed != 1 {
            return Err(IntegrationError::PreflightFailed);
        }
        append_audit(
            &mut tx,
            actor.user_id,
            IntegrationAudit {
                action: "integration.ca_activated",
                kind: &integration_type,
                integration_id: &integration_id,
                version,
                changed_field: "ca_bundle",
                correlation: correlation_id,
            },
        )
        .await?;
        tx.commit()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
        Ok(CaBundleMetadata {
            id: candidate_id,
            integration_type,
            integration_id,
            version: version as u64,
            state: "active".into(),
            fingerprints: row.get("fingerprints"),
            earliest_expiry: row.get("earliest_expiry"),
        })
    }

    async fn list_ca_metadata(
        &self,
        actor: IntegrationAdminActor,
        integration_type: &str,
        integration_id: &str,
    ) -> Result<Vec<CaBundleMetadata>, IntegrationError> {
        if !valid_name(integration_type, 64, true) || !valid_name(integration_id, 128, false) {
            return Err(IntegrationError::InvalidInput);
        }
        tokio::time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
            authorize_recent_admin(&mut tx, actor).await?;
            let rows = sqlx::query(
                "SELECT id::text,version,state,pem,certificate_count,fingerprints,earliest_expiry
                 FROM integration_ca_bundles WHERE integration_type=$1 AND integration_id=$2
                 ORDER BY version DESC LIMIT 100",
            )
            .bind(integration_type)
            .bind(integration_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
            tx.commit()
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
            rows.into_iter()
                .map(|row| {
                    let bundle = validate_stored_ca(&row)?;
                    Ok(CaBundleMetadata {
                        id: Uuid::from_str(&row.get::<String, _>("id"))
                            .map_err(|_| IntegrationError::Unavailable)?,
                        integration_type: integration_type.into(),
                        integration_id: integration_id.into(),
                        version: u64::try_from(row.get::<i64, _>("version"))
                            .map_err(|_| IntegrationError::Unavailable)?,
                        state: row.get("state"),
                        fingerprints: bundle.fingerprints,
                        earliest_expiry: bundle.earliest_expiry,
                    })
                })
                .collect()
        })
        .await
        .map_err(|_| IntegrationError::Unavailable)?
    }

    pub(crate) async fn active_ca_for_endpoint(
        &self,
        endpoint: &CaEndpointBinding,
    ) -> Result<Option<ValidatedCaBundle>, IntegrationError> {
        tokio::time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
            let row = sqlx::query(
                "SELECT pem,certificate_count,fingerprints,earliest_expiry,endpoint_fingerprint
                 FROM integration_ca_bundles WHERE integration_type=$1 AND integration_id=$2
                  AND state='active'",
            )
            .bind(endpoint.integration_type())
            .bind(endpoint.integration_id())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
            if row.is_none() {
                let adopted: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM integration_ca_bundles
                     WHERE integration_type=$1 AND integration_id=$2)",
                )
                .bind(endpoint.integration_type())
                .bind(endpoint.integration_id())
                .fetch_one(&mut *connection)
                .await
                .map_err(|_| IntegrationError::Unavailable)?;
                if adopted {
                    return Err(IntegrationError::PreflightFailed);
                }
            }
            row.map(|row| {
                let stored: Vec<u8> = row.get("endpoint_fingerprint");
                if stored != endpoint.fingerprint() {
                    return Err(IntegrationError::PreflightFailed);
                }
                validate_stored_ca(&row)
            })
            .transpose()
        })
        .await
        .map_err(|_| IntegrationError::Unavailable)?
    }

    /// Builds the effective SMTP runtime configuration. An active database CA
    /// is authoritative; the Beta file source is consulted only before the
    /// first successful database activation.
    pub async fn smtp_config(
        &self,
        instance_id: &str,
        settings: &EffectiveInstanceSettings,
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Option<SmtpConfig>, IntegrationError> {
        let Some(public) = SmtpPublicSettings::from_effective(settings)
            .map_err(|_| IntegrationError::Unavailable)?
        else {
            return Ok(None);
        };
        let transport = match public.security() {
            SmtpSecurity::ImplicitTls => "implicit-tls",
            SmtpSecurity::StartTls => "starttls",
        };
        let endpoint =
            CaEndpointBinding::new("smtp", "default", public.host(), public.port(), transport)?;
        let database_ca = self.active_ca_for_endpoint(&endpoint).await?;
        let database_pair = self.read_smtp_credential_pair(instance_id).await?;
        let database_credentials = database_pair
            .as_ref()
            .map(|(username, password)| {
                Ok((
                    std::str::from_utf8(username.expose())
                        .map_err(|_| IntegrationError::CredentialUnavailable)?,
                    std::str::from_utf8(password.expose())
                        .map_err(|_| IntegrationError::CredentialUnavailable)?,
                ))
            })
            .transpose()?;
        SmtpConfig::from_effective_settings_with_database_sources(
            settings,
            environment,
            files,
            database_ca.as_ref(),
            database_credentials,
        )
        .map_err(|_| IntegrationError::Unavailable)
    }

    async fn read_smtp_credential_pair(
        &self,
        instance_id: &str,
    ) -> Result<Option<(SecretValue, SecretValue)>, IntegrationError> {
        let username_identity =
            CredentialIdentity::new(instance_id, "smtp", "default", "username")?;
        let password_identity =
            CredentialIdentity::new(instance_id, "smtp", "default", "password")?;
        tokio::time::timeout(self.operation_timeout, async {
            let rows = sqlx::query(
                "SELECT id::text,credential_kind,credential_version,algorithm,key_version,nonce,ciphertext
                 FROM integration_credentials WHERE instance_id=$1 AND integration_type=$2
                  AND integration_id=$3 AND credential_kind IN ('username','password')
                 ORDER BY credential_kind",
            )
            .bind(instance_id)
            .bind("smtp")
            .bind("default")
            .fetch_all(
                &mut *self
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| IntegrationError::Unavailable)?,
            )
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
            if rows.is_empty() {
                return Ok(None);
            }
            if rows.len() != 2 {
                return Err(IntegrationError::CredentialUnavailable);
            }
            let mut username = None;
            let mut password = None;
            for row in rows {
                match row.get::<String, _>("credential_kind").as_str() {
                    "username" => username = Some(open_row(&self.keyring, &username_identity, &row)?),
                    "password" => password = Some(open_row(&self.keyring, &password_identity, &row)?),
                    _ => return Err(IntegrationError::CredentialUnavailable),
                }
            }
            match (username, password) {
                (Some(username), Some(password)) => Ok(Some((username, password))),
                _ => Err(IntegrationError::CredentialUnavailable),
            }
        })
        .await
        .map_err(|_| IntegrationError::Unavailable)?
    }

    async fn load_ca(&self, id: Uuid, state: &str) -> Result<Option<StoredCa>, IntegrationError> {
        let row = sqlx::query("SELECT version,pem,certificate_count,fingerprints,earliest_expiry,endpoint_fingerprint FROM integration_ca_bundles WHERE id=$1::uuid AND state=$2")
            .bind(id.to_string()).bind(state)
            .fetch_optional(&mut *self.pool.acquire().await.map_err(|_| IntegrationError::Unavailable)?)
            .await.map_err(|_| IntegrationError::Unavailable)?;
        row.map(|row| {
            let bundle = validate_stored_ca(&row)?;
            Ok(StoredCa {
                version: u64::try_from(row.get::<i64, _>("version"))
                    .map_err(|_| IntegrationError::PreflightFailed)?,
                pem_hash: Sha256::digest(bundle.pem()).into(),
                endpoint_fingerprint: row
                    .get::<Vec<u8>, _>("endpoint_fingerprint")
                    .try_into()
                    .map_err(|_| IntegrationError::PreflightFailed)?,
                bundle,
            })
        })
        .transpose()
    }
}

struct StoredCa {
    version: u64,
    pem_hash: [u8; 32],
    endpoint_fingerprint: [u8; 32],
    bundle: ValidatedCaBundle,
}

async fn lock_and_validate_endpoint(
    tx: &mut Transaction<'_, Postgres>,
    expected: &CaEndpointBinding,
) -> Result<(), IntegrationError> {
    let current = match expected.integration_type() {
        "oidc" => {
            let id = Uuid::parse_str(expected.integration_id())
                .map_err(|_| IntegrationError::PreflightFailed)?;
            let issuer: String =
                sqlx::query_scalar("SELECT issuer FROM oidc_providers WHERE id=$1::uuid FOR SHARE")
                    .bind(id.to_string())
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(|_| IntegrationError::Unavailable)?
                    .ok_or(IntegrationError::PreflightFailed)?;
            let issuer = Url::parse(&issuer).map_err(|_| IntegrationError::PreflightFailed)?;
            CaEndpointBinding::new(
                "oidc",
                expected.integration_id(),
                issuer.host_str().ok_or(IntegrationError::PreflightFailed)?,
                issuer
                    .port_or_known_default()
                    .ok_or(IntegrationError::PreflightFailed)?,
                "https",
            )?
        }
        "git" => {
            let id = Uuid::parse_str(expected.integration_id())
                .map_err(|_| IntegrationError::PreflightFailed)?;
            let row = sqlx::query(
                "SELECT canonical_host,canonical_port FROM git_providers
                 WHERE id=$1::uuid FOR SHARE",
            )
            .bind(id.to_string())
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| IntegrationError::Unavailable)?
            .ok_or(IntegrationError::PreflightFailed)?;
            CaEndpointBinding::new(
                "git",
                expected.integration_id(),
                row.get::<String, _>("canonical_host"),
                u16::try_from(row.get::<i32, _>("canonical_port"))
                    .map_err(|_| IntegrationError::PreflightFailed)?,
                "https",
            )?
        }
        "registry" => {
            let id = Uuid::parse_str(expected.integration_id())
                .map_err(|_| IntegrationError::PreflightFailed)?;
            let row = sqlx::query(
                "SELECT canonical_host,canonical_port FROM registry_connections
                 WHERE id=$1::uuid FOR SHARE",
            )
            .bind(id.to_string())
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| IntegrationError::Unavailable)?
            .ok_or(IntegrationError::PreflightFailed)?;
            CaEndpointBinding::new(
                "registry",
                expected.integration_id(),
                row.get::<String, _>("canonical_host"),
                u16::try_from(row.get::<i32, _>("canonical_port"))
                    .map_err(|_| IntegrationError::PreflightFailed)?,
                "https",
            )?
        }
        "smtp" if expected.integration_id() == "default" => expected.clone(),
        _ => return Err(IntegrationError::PreflightFailed),
    };
    if current.fingerprint() != expected.fingerprint() {
        return Err(IntegrationError::PreflightFailed);
    }
    Ok(())
}

fn validate_stored_ca(row: &sqlx::postgres::PgRow) -> Result<ValidatedCaBundle, IntegrationError> {
    let parsed =
        ValidatedCaBundle::parse(row.get("pem")).map_err(|_| IntegrationError::InvalidCaBundle)?;
    let count: i16 = row.get("certificate_count");
    let fingerprints: Vec<String> = row.get("fingerprints");
    let expiry: OffsetDateTime = row.get("earliest_expiry");
    if usize::try_from(count).ok() != Some(parsed.fingerprints.len())
        || fingerprints != parsed.fingerprints
        || expiry != parsed.earliest_expiry
    {
        return Err(IntegrationError::InvalidCaBundle);
    }
    Ok(parsed)
}

pub(crate) async fn authorize_recent_admin(
    tx: &mut Transaction<'_, Postgres>,
    actor: IntegrationAdminActor,
) -> Result<(), IntegrationError> {
    let row = sqlx::query(
        "SELECT s.last_reauthenticated_at,transaction_timestamp() AS now,
          (SELECT value::text FROM instance_settings WHERE key='security.reauthentication_window_minutes') AS policy
         FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1::uuid AND s.id=$2::uuid
          AND u.status='active' AND u.is_instance_admin AND s.revoked_at IS NULL
          AND s.idle_expires_at>transaction_timestamp() AND s.absolute_expires_at>transaction_timestamp()
         FOR UPDATE OF u,s",
    ).bind(actor.user_id.to_string()).bind(actor.session_id.to_string())
        .fetch_optional(&mut **tx).await.map_err(|_| IntegrationError::Unavailable)?
        .ok_or(IntegrationError::ReauthenticationRequired)?;
    let now: OffsetDateTime = row.get("now");
    let last: Option<OffsetDateTime> = row.get("last_reauthenticated_at");
    let policy: String = row.get("policy");
    let minutes = serde_json::from_str::<serde_json::Value>(&policy)
        .ok()
        .and_then(|v| v.as_i64())
        .ok_or(IntegrationError::Unavailable)?;
    if !last.is_some_and(|last| last <= now && last >= now - time::Duration::minutes(minutes)) {
        return Err(IntegrationError::ReauthenticationRequired);
    }
    Ok(())
}

struct IntegrationAudit<'a> {
    action: &'a str,
    kind: &'a str,
    integration_id: &'a str,
    version: i64,
    changed_field: &'a str,
    correlation: &'a str,
}

async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    event: IntegrationAudit<'_>,
) -> Result<(), IntegrationError> {
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,target_id,
         scope_type,scope_id,result,correlation_id,changed_fields,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,$3,'integration',$4,'instance','instance','succeeded',$5,$6,$7::jsonb)",
    ).bind(Uuid::now_v7().to_string()).bind(user_id.to_string()).bind(event.action)
      .bind(format!("{}:{}", event.kind, event.integration_id)).bind(event.correlation).bind(vec![event.changed_field.to_string()])
      .bind(serde_json::json!({"integrationType": event.kind, "version": event.version}).to_string())
      .execute(&mut **tx).await.map_err(|_| IntegrationError::Unavailable)?;
    Ok(())
}

fn valid_name(value: &str, max: usize, lower_only: bool) -> bool {
    if value.is_empty() || value.len() > max {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| {
        let first = if lower_only {
            byte.is_ascii_lowercase()
        } else {
            byte.is_ascii_alphanumeric()
        };
        if index == 0 {
            return first;
        }
        let alphanumeric = if lower_only {
            byte.is_ascii_lowercase() || byte.is_ascii_digit()
        } else {
            byte.is_ascii_alphanumeric()
        };
        alphanumeric || matches!(byte, b'_' | b'-') || (!lower_only && matches!(byte, b'.' | b':'))
    })
}

fn valid_endpoint_host(value: &str) -> bool {
    (1..=253).contains(&value.len())
        && value.is_ascii()
        && value.trim() == value
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':'))
}

fn valid_correlation(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn map_ca_stage_error(error: sqlx::Error) -> IntegrationError {
    if error
        .as_database_error()
        .is_some_and(|database| database.code().as_deref() == Some("23505"))
    {
        IntegrationError::Conflict
    } else {
        IntegrationError::Unavailable
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
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

impl fmt::Display for IntegrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "integration input is invalid",
            Self::KeyConfiguration => "integration key configuration is invalid",
            Self::CredentialUnavailable => "integration credential is unavailable",
            Self::InvalidCaBundle => "integration CA bundle is invalid",
            Self::ReauthenticationRequired => "recent administrator reauthentication is required",
            Self::PreflightFailed => "integration preflight failed",
            Self::Conflict => "integration state changed concurrently",
            Self::Unavailable => "integration persistence is unavailable",
        })
    }
}

impl std::error::Error for IntegrationError {}

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
