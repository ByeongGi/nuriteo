#![allow(unused_imports)]
use super::ca::*;
use super::credential_identity::*;
use super::error::*;
use super::*;

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

use super::{
    ALGORITHM, CaBundleMetadata, CaCandidatePreflight, CaEndpointBinding, CaPreflightProof,
    CredentialIdentity, CredentialMetadata, DEFAULT_OPERATION_TIMEOUT, EncryptedSecretEnvelope,
    IntegrationAdminActor, IntegrationAdminService, IntegrationAudit, IntegrationError,
    IntegrationRepository, MASTER_KEY, MASTER_KEY_FILE, MASTER_KEY_VERSION, MAX_CA_BYTES,
    MAX_CA_CERTIFICATES, MAX_OPERATION_TIMEOUT, MAX_PREVIOUS_KEYS, MAX_ROTATION_BATCH,
    MAX_SECRET_BYTES, MIN_OPERATION_TIMEOUT, MasterKey, MasterKeyring, NONCE_BYTES,
    PREVIOUS_MASTER_KEYS, PREVIOUS_MASTER_KEYS_FILE, PreviousKeyInput, RotationReport, Sealed,
    SecretValue, StoredCa, ValidatedCaBundle,
};
use crate::smtp::{SmtpConfig, SmtpPublicSettings, SmtpSecurity};

impl super::SecretValue {
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

impl fmt::Debug for MasterKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MasterKey([REDACTED])")
    }
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
    pub(crate) fn test(version: u32, entries: &[(u32, [u8; 32])]) -> Self {
        Self {
            current_version: version,
            keys: entries
                .iter()
                .map(|(version, key)| (*version, MasterKey(Zeroizing::new(*key))))
                .collect(),
        }
    }
}

pub(crate) fn scoped_attestation_input(
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

pub(crate) fn scoped_aad(
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

pub(crate) fn decode_key(value: &str) -> Result<MasterKey, IntegrationError> {
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

    pub(crate) async fn put_credential(
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

    pub(crate) async fn put_credential_inner(
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

    pub(crate) async fn put_smtp_credential_pair(
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

    pub(crate) async fn rotate_batch_inner(
        &self,
        limit: u16,
    ) -> Result<RotationReport, IntegrationError> {
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

pub(crate) async fn upsert_credential(
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

pub(crate) fn credential_lock_key(identity: &CredentialIdentity) -> i64 {
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

pub(crate) fn requires_integration_specific_admin(identity: &CredentialIdentity) -> bool {
    (identity.integration_type == "smtp"
        && identity.integration_id == "default"
        && matches!(identity.credential_kind.as_str(), "username" | "password"))
        || (identity.integration_type == "oidc" && identity.credential_kind == "client_secret")
}

pub(crate) fn seal(
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
