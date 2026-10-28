#![allow(unused_imports)]
use super::credential_identity::*;
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

impl super::IntegrationRepository {
    pub(crate) async fn stage_ca_candidate(
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

    pub(crate) async fn stage_ca_candidate_inner(
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

    pub(crate) async fn activate_ca_candidate(
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

    pub(crate) async fn replay_ca_activation(
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

    pub(crate) async fn activate_ca_candidate_inner(
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

    pub(crate) async fn list_ca_metadata(
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

    pub(crate) async fn read_smtp_credential_pair(
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

    pub(crate) async fn load_ca(
        &self,
        id: Uuid,
        state: &str,
    ) -> Result<Option<StoredCa>, IntegrationError> {
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

pub(crate) async fn lock_and_validate_endpoint(
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

pub(crate) fn validate_stored_ca(
    row: &sqlx::postgres::PgRow,
) -> Result<ValidatedCaBundle, IntegrationError> {
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

pub(crate) async fn append_audit(
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

pub(crate) fn valid_name(value: &str, max: usize, lower_only: bool) -> bool {
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

pub(crate) fn valid_endpoint_host(value: &str) -> bool {
    (1..=253).contains(&value.len())
        && value.is_ascii()
        && value.trim() == value
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':'))
}

pub(crate) fn valid_correlation(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

pub(crate) fn map_ca_stage_error(error: sqlx::Error) -> IntegrationError {
    if error
        .as_database_error()
        .is_some_and(|database| database.code().as_deref() == Some("23505"))
    {
        IntegrationError::Conflict
    } else {
        IntegrationError::Unavailable
    }
}

pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
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
