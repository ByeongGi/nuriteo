//! Persistence boundary for local-account TOTP enrollment and recovery codes.
//!
//! TOTP calculation, confirmation challenges, lockout and session rotation are
//! deliberately owned by MFA-002. This module accepts only an already-confirmed
//! activation from crate-internal authentication code.

#![allow(dead_code, reason = "sealed storage handoff for MFA-002")]

use std::fmt;
use std::time::Duration;

use sqlx::{Acquire, Postgres, Row, Transaction};
use tokio::time;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::database::DatabasePool;
use crate::identity::{
    PasswordService, PasswordVerification, StoredPasswordHash, UserId, acquire_mfa_population_lock,
};
use crate::integration::{IntegrationError, MasterKeyring};

mod http_routes;
mod http_service;
mod service;

pub(crate) use http_routes::openapi_router;
pub(crate) use http_service::RotatedMfaResponse;
pub use http_service::{
    MfaEnrollmentCompleteView, MfaEnrollmentStartView, MfaHttpService, MfaHttpServiceError,
    MfaPolicyImpactView, MfaPolicyView, MfaResetTargetCollectionView, MfaStatusView,
};
#[allow(unused_imports, reason = "crate-private MFA-003 HTTP adapter handoff")]
pub(crate) use service::{
    EnrollmentComplete, EnrollmentStart, MfaChallengePolicy, MfaIdempotencyKey, MfaService,
    MfaServiceError, TotpCode,
};

const ENVELOPE_DOMAIN: &[u8] = b"nuriteo.mfa-totp-secret.v1";
const ENVELOPE_ALGORITHM: &str = "aes-256-gcm-v1";
const MIN_TOTP_SECRET_BYTES: usize = 20;
const MAX_TOTP_SECRET_BYTES: usize = 128;
const MIN_RECOVERY_CODE_BYTES: usize = 8;
const MAX_RECOVERY_CODE_BYTES: usize = 128;
const MIN_RECOVERY_CODES: usize = 1;
const MAX_RECOVERY_CODES: usize = 20;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(PartialEq, Eq)]
pub struct TotpSecret(Zeroizing<Vec<u8>>);

impl TotpSecret {
    pub fn new(value: Vec<u8>) -> Result<Self, MfaStorageError> {
        if !(MIN_TOTP_SECRET_BYTES..=MAX_TOTP_SECRET_BYTES).contains(&value.len()) {
            return Err(MfaStorageError::InvalidInput);
        }
        Ok(Self(Zeroizing::new(value)))
    }

    fn expose(&self) -> &[u8] {
        &self.0
    }

    pub(crate) fn expose_to_http_adapter(&self) -> &[u8] {
        self.expose()
    }
}

impl fmt::Debug for TotpSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TotpSecret([REDACTED])")
    }
}

#[derive(PartialEq, Eq)]
pub struct RecoveryCode(Zeroizing<Vec<u8>>);

impl RecoveryCode {
    pub fn new(value: Vec<u8>) -> Result<Self, MfaStorageError> {
        let value = Zeroizing::new(value);
        if !(MIN_RECOVERY_CODE_BYTES..=MAX_RECOVERY_CODE_BYTES).contains(&value.len()) {
            return Err(MfaStorageError::InvalidInput);
        }
        Ok(Self(value))
    }

    fn expose(&self) -> &[u8] {
        &self.0
    }

    pub(crate) fn expose_to_http_adapter(&self) -> &[u8] {
        self.expose()
    }
}

impl fmt::Debug for RecoveryCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RecoveryCode([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MfaCredentialState {
    Pending,
    Active,
    Disabled,
    Replaced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MfaCredentialMetadata {
    pub id: Uuid,
    pub user_id: UserId,
    pub state: MfaCredentialState,
    pub secret_version: u64,
    pub recovery_codes: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MfaRotationReport {
    pub rotated: u16,
    pub remaining: u64,
}

/// Proof token constructed only by the MFA-002 confirmation service after a
/// successful TOTP challenge. It contains no TOTP value or secret.
pub struct ConfirmedTotpEnrollment {
    credential_id: Uuid,
    user_id: UserId,
}

impl ConfirmedTotpEnrollment {
    #[allow(dead_code, reason = "constructed by the MFA-002 confirmation service")]
    pub(crate) const fn new(credential_id: Uuid, user_id: UserId) -> Self {
        Self {
            credential_id,
            user_id,
        }
    }
}

impl fmt::Debug for ConfirmedTotpEnrollment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfirmedTotpEnrollment")
            .field("credential_id", &self.credential_id)
            .field("user_id", &self.user_id)
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct MfaRepository {
    pool: DatabasePool,
    keyring: MasterKeyring,
    operation_timeout: Duration,
}

impl fmt::Debug for MfaRepository {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MfaRepository")
            .finish_non_exhaustive()
    }
}

impl MfaRepository {
    #[must_use]
    pub(crate) fn new(pool: DatabasePool, keyring: MasterKeyring) -> Self {
        Self {
            pool,
            keyring,
            operation_timeout: DEFAULT_TIMEOUT,
        }
    }

    pub(crate) async fn rotate_batch(
        &self,
        limit: u16,
    ) -> Result<MfaRotationReport, MfaStorageError> {
        if limit == 0 || limit > 100 {
            return Err(MfaStorageError::InvalidInput);
        }
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let rows = sqlx::query(
                "SELECT id::text,user_id::text,secret_version,algorithm,key_version,nonce,ciphertext
                 FROM mfa_totp_credentials WHERE key_version <> $1 ORDER BY id
                 FOR UPDATE SKIP LOCKED LIMIT $2",
            )
            .bind(
                i32::try_from(self.keyring.current_version())
                    .map_err(|_| MfaStorageError::KeyConfiguration)?,
            )
            .bind(i64::from(limit))
            .fetch_all(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?;
            for row in &rows {
                let user_id = row
                    .get::<String, _>("user_id")
                    .parse::<UserId>()
                    .map_err(|_| MfaStorageError::Unavailable)?;
                let id = Uuid::parse_str(&row.get::<String, _>("id"))
                    .map_err(|_| MfaStorageError::Unavailable)?;
                let secret = self.open_secret(user_id, row)?;
                let version = u64::try_from(row.get::<i64, _>("secret_version"))
                    .map_err(|_| MfaStorageError::Unavailable)?;
                let user_text = user_id.to_string();
                let version_bytes = version.to_be_bytes();
                let context = [
                    user_text.as_bytes(),
                    id.as_bytes(),
                    version_bytes.as_slice(),
                ];
                let sealed = self
                    .keyring
                    .seal_scoped(ENVELOPE_DOMAIN, &context, secret.expose())
                    .map_err(map_envelope_error)?;
                sqlx::query(
                    "UPDATE mfa_totp_credentials SET key_version=$1,nonce=$2,ciphertext=$3,
                     updated_at=CURRENT_TIMESTAMP WHERE id=$4::uuid AND key_version=$5",
                )
                .bind(
                    i32::try_from(sealed.key_version)
                        .map_err(|_| MfaStorageError::KeyConfiguration)?,
                )
                .bind(sealed.nonce)
                .bind(sealed.ciphertext)
                .bind(id.to_string())
                .bind(row.get::<i32, _>("key_version"))
                .execute(&mut *tx)
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            }
            let remaining: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM mfa_totp_credentials WHERE key_version <> $1",
            )
            .bind(
                i32::try_from(self.keyring.current_version())
                    .map_err(|_| MfaStorageError::KeyConfiguration)?,
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?;
            tx.commit()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            Ok(MfaRotationReport {
                rotated: u16::try_from(rows.len()).map_err(|_| MfaStorageError::Unavailable)?,
                remaining: u64::try_from(remaining).map_err(|_| MfaStorageError::Unavailable)?,
            })
        })
        .await
        .map_err(|_| MfaStorageError::Unavailable)?
    }

    pub(crate) async fn begin_enrollment(
        &self,
        actor: UserId,
        user_id: UserId,
        secret: &TotpSecret,
        correlation_id: &str,
    ) -> Result<MfaCredentialMetadata, MfaStorageError> {
        require_self_service(actor, user_id)?;
        validate_correlation(correlation_id)?;
        let id = Uuid::now_v7();
        let version = 1_u64;
        let user_text = user_id.to_string();
        let id_bytes = id.as_bytes();
        let version_bytes = version.to_be_bytes();
        let context = [
            user_text.as_bytes(),
            id_bytes.as_slice(),
            version_bytes.as_slice(),
        ];
        let sealed = self
            .keyring
            .seal_scoped(ENVELOPE_DOMAIN, &context, secret.expose())
            .map_err(map_envelope_error)?;
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            acquire_mfa_population_lock(&mut tx)
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            lock_local_user(&mut tx, user_id).await?;
            sqlx::query(
                "UPDATE mfa_totp_credentials SET state='replaced',terminal_at=CURRENT_TIMESTAMP,
                 updated_at=CURRENT_TIMESTAMP WHERE user_id=$1::uuid AND state='pending'",
            )
            .bind(&user_text)
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?;
            sqlx::query(
                "INSERT INTO mfa_totp_credentials
                 (id,user_id,state,secret_version,algorithm,key_version,nonce,ciphertext)
                 VALUES($1::uuid,$2::uuid,'pending',$3,$4,$5,$6,$7)",
            )
            .bind(id.to_string())
            .bind(&user_text)
            .bind(i64::try_from(version).map_err(|_| MfaStorageError::Unavailable)?)
            .bind(ENVELOPE_ALGORITHM)
            .bind(i32::try_from(sealed.key_version).map_err(|_| MfaStorageError::Unavailable)?)
            .bind(sealed.nonce)
            .bind(sealed.ciphertext)
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?;
            append_audit(
                &mut tx,
                actor,
                user_id,
                "mfa.enrollment_started",
                correlation_id,
            )
            .await?;
            tx.commit()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            Ok(MfaCredentialMetadata {
                id,
                user_id,
                state: MfaCredentialState::Pending,
                secret_version: version,
                recovery_codes: 0,
            })
        })
        .await
        .map_err(|_| MfaStorageError::Unavailable)?
    }

    #[allow(dead_code, reason = "called by the MFA-002 confirmation service")]
    pub(crate) async fn activate_confirmed(
        &self,
        actor: UserId,
        confirmation: ConfirmedTotpEnrollment,
        recovery_codes: Vec<RecoveryCode>,
        correlation_id: &str,
    ) -> Result<MfaCredentialMetadata, MfaStorageError> {
        require_self_service(actor, confirmation.user_id)?;
        validate_correlation(correlation_id)?;
        let hashes = hash_recovery_codes(recovery_codes).await?;
        let count = u16::try_from(hashes.len()).map_err(|_| MfaStorageError::InvalidInput)?;
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            acquire_mfa_population_lock(&mut tx)
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            lock_local_user(&mut tx, confirmation.user_id).await?;
            let pending = sqlx::query(
                "SELECT secret_version FROM mfa_totp_credentials
                 WHERE id=$1::uuid AND user_id=$2::uuid AND state='pending' FOR UPDATE",
            )
            .bind(confirmation.credential_id.to_string())
            .bind(confirmation.user_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?
            .ok_or(MfaStorageError::Conflict)?;
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=$1::uuid")
                .bind(confirmation.user_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            sqlx::query(
                "UPDATE mfa_totp_credentials SET state='replaced',terminal_at=CURRENT_TIMESTAMP,
                 updated_at=CURRENT_TIMESTAMP WHERE user_id=$1::uuid AND state='active'",
            )
            .bind(confirmation.user_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?;
            let changed = sqlx::query(
                "UPDATE mfa_totp_credentials SET state='active',activated_at=CURRENT_TIMESTAMP,
                 updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid AND state='pending'",
            )
            .bind(confirmation.credential_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?
            .rows_affected();
            if changed != 1 {
                return Err(MfaStorageError::Conflict);
            }
            insert_recovery_hashes(
                &mut tx,
                confirmation.user_id,
                confirmation.credential_id,
                hashes,
            )
            .await?;
            append_audit(
                &mut tx,
                actor,
                confirmation.user_id,
                "mfa.enabled",
                correlation_id,
            )
            .await?;
            tx.commit()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            Ok(MfaCredentialMetadata {
                id: confirmation.credential_id,
                user_id: confirmation.user_id,
                state: MfaCredentialState::Active,
                secret_version: u64::try_from(pending.get::<i64, _>("secret_version"))
                    .map_err(|_| MfaStorageError::Unavailable)?,
                recovery_codes: count,
            })
        })
        .await
        .map_err(|_| MfaStorageError::Unavailable)?
    }

    pub(crate) async fn replace_recovery_codes(
        &self,
        actor: UserId,
        user_id: UserId,
        recovery_codes: Vec<RecoveryCode>,
        correlation_id: &str,
    ) -> Result<u16, MfaStorageError> {
        require_self_service(actor, user_id)?;
        validate_correlation(correlation_id)?;
        let hashes = hash_recovery_codes(recovery_codes).await?;
        let count = u16::try_from(hashes.len()).map_err(|_| MfaStorageError::InvalidInput)?;
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            acquire_mfa_population_lock(&mut tx)
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            lock_local_user(&mut tx, user_id).await?;
            let credential_id: String = sqlx::query_scalar(
                "SELECT id::text FROM mfa_totp_credentials
                 WHERE user_id=$1::uuid AND state='active' FOR UPDATE",
            )
            .bind(user_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?
            .ok_or(MfaStorageError::NotActive)?;
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=$1::uuid")
                .bind(user_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let credential_id =
                Uuid::parse_str(&credential_id).map_err(|_| MfaStorageError::Unavailable)?;
            insert_recovery_hashes(&mut tx, user_id, credential_id, hashes).await?;
            append_audit(
                &mut tx,
                actor,
                user_id,
                "mfa.recovery_codes_replaced",
                correlation_id,
            )
            .await?;
            tx.commit()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            Ok(count)
        })
        .await
        .map_err(|_| MfaStorageError::Unavailable)?
    }

    #[allow(dead_code, reason = "called by the MFA-002 recovery challenge service")]
    pub(crate) async fn consume_recovery_code(
        &self,
        actor: UserId,
        user_id: UserId,
        code: RecoveryCode,
        correlation_id: &str,
    ) -> Result<RecoveryConsumeResult, MfaStorageError> {
        require_self_service(actor, user_id)?;
        validate_correlation(correlation_id)?;
        let rows = time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            sqlx::query(
                "SELECT recovery.id::text,recovery.credential_id::text,recovery.code_hash
                 FROM mfa_recovery_codes recovery
                 JOIN mfa_totp_credentials credential ON credential.id=recovery.credential_id
                 WHERE recovery.user_id=$1::uuid AND credential.state='active'
                 ORDER BY recovery.id LIMIT $2",
            )
            .bind(user_id.to_string())
            .bind(i64::try_from(MAX_RECOVERY_CODES).map_err(|_| MfaStorageError::Unavailable)?)
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| MfaStorageError::Unavailable)
        })
        .await
        .map_err(|_| MfaStorageError::Unavailable)??;
        let candidates = rows
            .into_iter()
            .map(|row| {
                Ok((
                    Uuid::parse_str(&row.get::<String, _>("id"))
                        .map_err(|_| MfaStorageError::Unavailable)?,
                    Uuid::parse_str(&row.get::<String, _>("credential_id"))
                        .map_err(|_| MfaStorageError::Unavailable)?,
                    StoredPasswordHash::new(row.get("code_hash"))
                        .map_err(|_| MfaStorageError::Unavailable)?,
                ))
            })
            .collect::<Result<Vec<_>, MfaStorageError>>()?;
        let matched = time::timeout(
            self.operation_timeout,
            tokio::task::spawn_blocking(move || verify_recovery_code(&code, &candidates)),
        )
        .await
        .map_err(|_| MfaStorageError::Unavailable)?
        .map_err(|_| MfaStorageError::Unavailable)??;
        let Some((code_id, credential_id)) = matched else {
            return Ok(RecoveryConsumeResult::Mismatch);
        };
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let deleted = sqlx::query(
                "DELETE FROM mfa_recovery_codes recovery USING mfa_totp_credentials credential
                 WHERE recovery.id=$1::uuid AND recovery.credential_id=$2::uuid
                   AND recovery.user_id=$3::uuid AND credential.id=recovery.credential_id
                   AND credential.state='active'",
            )
            .bind(code_id.to_string())
            .bind(credential_id.to_string())
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?
            .rows_affected();
            if deleted != 1 {
                tx.rollback()
                    .await
                    .map_err(|_| MfaStorageError::Unavailable)?;
                return Ok(RecoveryConsumeResult::AlreadyConsumed);
            }
            append_audit(
                &mut tx,
                actor,
                user_id,
                "mfa.recovery_code_consumed",
                correlation_id,
            )
            .await?;
            tx.commit()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            Ok(RecoveryConsumeResult::Consumed)
        })
        .await
        .map_err(|_| MfaStorageError::Unavailable)?
    }

    pub(crate) async fn disable(
        &self,
        actor: UserId,
        user_id: UserId,
        correlation_id: &str,
    ) -> Result<(), MfaStorageError> {
        require_self_service(actor, user_id)?;
        validate_correlation(correlation_id)?;
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let mut tx = connection
                .begin()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            acquire_mfa_population_lock(&mut tx)
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            lock_local_user(&mut tx, user_id).await?;
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=$1::uuid")
                .bind(user_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let changed = sqlx::query(
                "UPDATE mfa_totp_credentials SET state='disabled',terminal_at=CURRENT_TIMESTAMP,
                 updated_at=CURRENT_TIMESTAMP WHERE user_id=$1::uuid AND state='active'",
            )
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?
            .rows_affected();
            if changed != 1 {
                return Err(MfaStorageError::NotActive);
            }
            append_audit(&mut tx, actor, user_id, "mfa.disabled", correlation_id).await?;
            tx.commit()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            Ok(())
        })
        .await
        .map_err(|_| MfaStorageError::Unavailable)?
    }

    #[allow(dead_code, reason = "called by the MFA-002 TOTP challenge service")]
    pub(crate) async fn active_secret(
        &self,
        user_id: UserId,
    ) -> Result<Option<TotpSecret>, MfaStorageError> {
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| MfaStorageError::Unavailable)?;
            let row = sqlx::query(
                "SELECT id::text,secret_version,algorithm,key_version,nonce,ciphertext
                 FROM mfa_totp_credentials WHERE user_id=$1::uuid AND state='active'",
            )
            .bind(user_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?;
            row.map(|row| self.open_secret(user_id, &row)).transpose()
        })
        .await
        .map_err(|_| MfaStorageError::Unavailable)?
    }

    fn open_secret(
        &self,
        user_id: UserId,
        row: &sqlx::postgres::PgRow,
    ) -> Result<TotpSecret, MfaStorageError> {
        if row.get::<String, _>("algorithm") != ENVELOPE_ALGORITHM {
            return Err(MfaStorageError::SecretUnavailable);
        }
        let id = Uuid::parse_str(&row.get::<String, _>("id"))
            .map_err(|_| MfaStorageError::SecretUnavailable)?;
        let version = u64::try_from(row.get::<i64, _>("secret_version"))
            .map_err(|_| MfaStorageError::SecretUnavailable)?;
        let key_version = u32::try_from(row.get::<i32, _>("key_version"))
            .map_err(|_| MfaStorageError::SecretUnavailable)?;
        let user_text = user_id.to_string();
        let version_bytes = version.to_be_bytes();
        let context = [
            user_text.as_bytes(),
            id.as_bytes(),
            version_bytes.as_slice(),
        ];
        let plaintext = self
            .keyring
            .open_scoped(
                ENVELOPE_DOMAIN,
                &context,
                key_version,
                &row.get::<Vec<u8>, _>("nonce"),
                &row.get::<Vec<u8>, _>("ciphertext"),
            )
            .map_err(|_| MfaStorageError::SecretUnavailable)?;
        TotpSecret::new(plaintext.to_vec()).map_err(|_| MfaStorageError::SecretUnavailable)
    }
}

fn require_self_service(actor: UserId, target: UserId) -> Result<(), MfaStorageError> {
    if actor == target {
        Ok(())
    } else {
        Err(MfaStorageError::Unauthorized)
    }
}

async fn lock_local_user(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(), MfaStorageError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM users WHERE id=$1::uuid FOR UPDATE")
            .bind(user_id.to_string())
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| MfaStorageError::Unavailable)?;
    if status.as_deref() != Some("active") {
        return Err(MfaStorageError::LocalAccountRequired);
    }
    let local: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM local_password_credentials WHERE user_id=$1::uuid)",
    )
    .bind(user_id.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| MfaStorageError::Unavailable)?;
    if !local {
        return Err(MfaStorageError::LocalAccountRequired);
    }
    Ok(())
}

async fn hash_recovery_codes(
    codes: Vec<RecoveryCode>,
) -> Result<Vec<StoredPasswordHash>, MfaStorageError> {
    if !(MIN_RECOVERY_CODES..=MAX_RECOVERY_CODES).contains(&codes.len()) {
        return Err(MfaStorageError::InvalidInput);
    }
    for (index, code) in codes.iter().enumerate() {
        if codes[..index]
            .iter()
            .any(|existing| existing.expose() == code.expose())
        {
            return Err(MfaStorageError::InvalidInput);
        }
    }
    time::timeout(
        DEFAULT_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let service = PasswordService::default();
            codes
                .iter()
                .map(|code| {
                    service
                        .hash(code.expose())
                        .map_err(|_| MfaStorageError::Unavailable)
                })
                .collect()
        }),
    )
    .await
    .map_err(|_| MfaStorageError::Unavailable)?
    .map_err(|_| MfaStorageError::Unavailable)?
}

#[allow(
    dead_code,
    reason = "called by the MFA-002 recovery challenge boundary"
)]
fn verify_recovery_code(
    code: &RecoveryCode,
    candidates: &[(Uuid, Uuid, StoredPasswordHash)],
) -> Result<Option<(Uuid, Uuid)>, MfaStorageError> {
    let service = PasswordService::default();
    let mut matched = None;
    for (id, credential_id, hash) in candidates {
        let result = service
            .verify(code.expose(), hash)
            .map_err(|_| MfaStorageError::Unavailable)?;
        if result == PasswordVerification::Match {
            matched = Some((*id, *credential_id));
        }
    }
    Ok(matched)
}

async fn insert_recovery_hashes(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    credential_id: Uuid,
    hashes: Vec<StoredPasswordHash>,
) -> Result<(), MfaStorageError> {
    for (index, hash) in hashes.into_iter().enumerate() {
        let slot = i16::try_from(index + 1).map_err(|_| MfaStorageError::InvalidInput)?;
        sqlx::query(
            "INSERT INTO mfa_recovery_codes(id,credential_id,user_id,slot,code_hash)
             VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(credential_id.to_string())
        .bind(user_id.to_string())
        .bind(slot)
        .bind(hash.expose())
        .execute(&mut **tx)
        .await
        .map_err(|_| MfaStorageError::Unavailable)?;
    }
    Ok(())
}

async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    target: UserId,
    action: &str,
    correlation_id: &str,
) -> Result<(), MfaStorageError> {
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,
         target_id,scope_type,scope_id,result,correlation_id,changed_fields,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,$3,'user',$4,'user',$4,'succeeded',$5,$6,'{}'::jsonb)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(actor.to_string())
    .bind(action)
    .bind(target.to_string())
    .bind(correlation_id)
    .bind(vec!["mfa".to_owned()])
    .execute(&mut **tx)
    .await
    .map_err(|_| MfaStorageError::Unavailable)?;
    Ok(())
}

fn validate_correlation(value: &str) -> Result<(), MfaStorageError> {
    if (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(MfaStorageError::InvalidInput)
    }
}

fn map_envelope_error(error: IntegrationError) -> MfaStorageError {
    match error {
        IntegrationError::InvalidInput => MfaStorageError::InvalidInput,
        IntegrationError::KeyConfiguration => MfaStorageError::KeyConfiguration,
        _ => MfaStorageError::Unavailable,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryConsumeResult {
    Consumed,
    Mismatch,
    AlreadyConsumed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MfaStorageError {
    InvalidInput,
    Unauthorized,
    LocalAccountRequired,
    KeyConfiguration,
    SecretUnavailable,
    NotActive,
    Conflict,
    Unavailable,
}

impl fmt::Display for MfaStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "MFA storage input is invalid",
            Self::Unauthorized => "MFA storage mutation is unauthorized",
            Self::LocalAccountRequired => "local account is required",
            Self::KeyConfiguration => "MFA key configuration is invalid",
            Self::SecretUnavailable => "MFA secret is unavailable",
            Self::NotActive => "MFA is not active",
            Self::Conflict => "MFA state changed concurrently",
            Self::Unavailable => "MFA persistence is unavailable",
        })
    }
}

impl std::error::Error for MfaStorageError {}

#[cfg(test)]
mod tests;
