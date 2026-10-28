#![allow(unused_imports)]
use super::challenge::*;
use super::enrollment::*;
use super::secrets::*;
use super::*;

use std::future::Future;

use std::sync::Arc;

use std::time::Duration;

use ::time::OffsetDateTime;

use hmac::{Hmac, KeyInit, Mac};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::DeserializeOwned};

use sha1::Sha1;

use sqlx::{Acquire, Postgres, Row, Transaction};

use subtle::ConstantTimeEq;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use tokio::time as tokio_time;

use uuid::Uuid;

use zeroize::Zeroizing;

use crate::database::DatabasePool;

use crate::identity::{
    IssuedSession, PasswordService, Session, SessionFields, SessionPolicy, SessionRotationKind,
    SessionService, SessionServiceError, SessionToken, StoredPasswordHash, UserId,
    acquire_mfa_population_lock, has_required_active_local_enrolled_admin,
};

use crate::integration::MasterKeyring;

use super::super::{
    DEFAULT_TIMEOUT, ENVELOPE_ALGORITHM, ENVELOPE_DOMAIN, MfaCredentialMetadata,
    MfaCredentialState, MfaRepository, MfaStorageError, RecoveryCode, TotpSecret, append_audit,
    insert_recovery_hashes, lock_local_user, validate_correlation, verify_recovery_code,
};
use super::{
    ARGON2_CONCURRENCY, ChallengeAttempt, ChallengeState, DEFAULT_FAILURE_THRESHOLD,
    DEFAULT_FAILURE_WINDOW, DEFAULT_LOCK_DURATION, EnrollmentComplete, EnrollmentCompleteReceipt,
    EnrollmentStart, EnrollmentStartReceipt, MAX_FAILURE_DURATION, MAX_FAILURE_THRESHOLD,
    MAX_RECEIPTS_PER_USER, MIN_FAILURE_DURATION, MIN_FAILURE_THRESHOLD, MfaChallengePolicy,
    MfaIdempotencyKey, MfaPasswordAdmission, MfaPasswordExecutor, MfaService, MfaServiceError,
    RECEIPT_DOMAIN, RECEIPT_REQUEST_DOMAIN, RECEIPT_TTL_MINUTES, RECOVERY_CODE_BYTES,
    RECOVERY_CODE_COUNT, RECOVERY_CODE_ENCODED_BYTES, ReceiptBindingAuthority, SecretBytes,
    SecretToken, SessionReceipt, TOTP_DIGITS, TOTP_MODULUS, TOTP_STEP_SECONDS, TOTP_WINDOW,
    TotpCode,
};

pub(crate) async fn revoke_other_sessions(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    keep: crate::identity::SessionId,
) -> Result<(), MfaServiceError> {
    sqlx::query(
        "UPDATE sessions SET revoked_at=transaction_timestamp(),
         revocation_reason='mfa_privilege_changed'
         WHERE user_id=$1::uuid AND id<>$2::uuid AND revoked_at IS NULL",
    )
    .bind(user_id.to_string())
    .bind(keep.to_string())
    .execute(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    Ok(())
}

pub(crate) async fn revoke_all_sessions(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    reason: &str,
) -> Result<(), MfaServiceError> {
    sqlx::query(
        "UPDATE sessions SET revoked_at=transaction_timestamp(),revocation_reason=$2
         WHERE user_id=$1::uuid AND revoked_at IS NULL",
    )
    .bind(user_id.to_string())
    .bind(reason)
    .execute(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    Ok(())
}

pub(crate) async fn lock_admin_and_target(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    target: UserId,
) -> Result<(), MfaServiceError> {
    let rows = sqlx::query(
        "SELECT id::text,status,is_instance_admin,
          EXISTS(SELECT 1 FROM local_password_credentials credential
                 WHERE credential.user_id=users.id) AS local
         FROM users WHERE id IN ($1::uuid,$2::uuid) ORDER BY id FOR UPDATE",
    )
    .bind(actor.to_string())
    .bind(target.to_string())
    .fetch_all(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    let actor_valid = rows.iter().any(|row| {
        row.get::<String, _>("id") == actor.to_string()
            && row.get::<String, _>("status") == "active"
            && row.get::<bool, _>("is_instance_admin")
    });
    let target_valid = rows.iter().any(|row| {
        row.get::<String, _>("id") == target.to_string()
            && row.get::<String, _>("status") == "active"
            && row.get::<bool, _>("local")
    });
    if !actor_valid {
        return Err(MfaServiceError::Unauthorized);
    }
    if !target_valid {
        return Err(MfaServiceError::NotActive);
    }
    Ok(())
}

pub(crate) async fn append_attempt_audit(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    action: &str,
    correlation_id: &str,
) -> Result<(), MfaServiceError> {
    sqlx::query(
        "INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,
         target_id,scope_type,scope_id,result,correlation_id,changed_fields,metadata)
         VALUES($1::uuid,'user',$2,$2::uuid,$3,'user',$2,'user',$2,'failed',$4,$5,'{}'::jsonb)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(user_id.to_string())
    .bind(action)
    .bind(correlation_id)
    .bind(Vec::<String>::new())
    .execute(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    Ok(())
}

pub(crate) fn database_unavailable<E>(_: E) -> MfaServiceError {
    MfaServiceError::Unavailable
}

pub(crate) fn map_storage_error(error: MfaStorageError) -> MfaServiceError {
    match error {
        MfaStorageError::InvalidInput => MfaServiceError::InvalidInput,
        MfaStorageError::Unauthorized => MfaServiceError::Unauthorized,
        MfaStorageError::LocalAccountRequired | MfaStorageError::NotActive => {
            MfaServiceError::NotActive
        }
        MfaStorageError::Conflict => MfaServiceError::Conflict,
        MfaStorageError::KeyConfiguration
        | MfaStorageError::SecretUnavailable
        | MfaStorageError::Unavailable => MfaServiceError::Unavailable,
    }
}

pub(crate) fn map_session_error(error: SessionServiceError) -> MfaServiceError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            MfaServiceError::AuthenticationFailed
        }
        SessionServiceError::SessionLimitReached
        | SessionServiceError::EntropyUnavailable
        | SessionServiceError::DatabaseUnavailable
        | SessionServiceError::OperationTimeout
        | SessionServiceError::InvariantViolation => MfaServiceError::Unavailable,
    }
}

impl fmt::Display for MfaServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "MFA request is invalid",
            Self::AuthenticationFailed => "authentication failed",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::ChallengeFailed => "MFA challenge failed",
            Self::Unauthorized => "MFA operation is unauthorized",
            Self::NotActive => "MFA is not active",
            Self::Conflict => "MFA state changed concurrently",
            Self::Unavailable => "MFA service is unavailable",
        })
    }
}

impl std::error::Error for MfaServiceError {}
