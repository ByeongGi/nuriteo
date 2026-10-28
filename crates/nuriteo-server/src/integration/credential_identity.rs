#![allow(unused_imports)]
use super::ca::*;
use super::error::*;
use super::keyring::*;
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

pub(crate) fn open_row(
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

pub(crate) fn aad(
    identity: &CredentialIdentity,
    id: Uuid,
    logical_version: u64,
    key_version: u32,
) -> Vec<u8> {
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

pub(crate) fn identity_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<CredentialIdentity, IntegrationError> {
    CredentialIdentity::new(
        row.get::<String, _>("instance_id"),
        row.get::<String, _>("integration_type"),
        row.get::<String, _>("integration_id"),
        row.get::<String, _>("credential_kind"),
    )
    .map_err(|_| IntegrationError::CredentialUnavailable)
}

pub(crate) fn parse_id(row: &sqlx::postgres::PgRow) -> Result<Uuid, IntegrationError> {
    Uuid::from_str(&row.get::<String, _>("id")).map_err(|_| IntegrationError::CredentialUnavailable)
}

pub(crate) fn read_logical_version(row: &sqlx::postgres::PgRow) -> Result<u64, IntegrationError> {
    u64::try_from(row.get::<i64, _>("credential_version"))
        .map_err(|_| IntegrationError::CredentialUnavailable)
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
