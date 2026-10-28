#![allow(unused_imports)]
use super::challenge::*;
use super::enrollment::*;
use super::sessions::*;
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

impl super::MfaIdempotencyKey {
    pub(crate) fn new(value: String) -> Result<Self, MfaServiceError> {
        if !(16..=128).contains(&value.len())
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err(MfaServiceError::InvalidInput);
        }
        Ok(Self(value))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for MfaIdempotencyKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MfaIdempotencyKey([REDACTED])")
    }
}

impl SecretBytes {
    pub(crate) fn new(value: Vec<u8>) -> Self {
        Self(Zeroizing::new(value))
    }
}

impl Serialize for SecretBytes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretBytes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Vec::<u8>::deserialize(deserializer).map(Self::new)
    }
}

impl SecretToken {
    pub(crate) fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
}

impl Serialize for SecretToken {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretToken {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self::new)
    }
}

impl TotpCode {
    pub(crate) fn parse(value: &[u8]) -> Result<Self, MfaServiceError> {
        let code: [u8; 6] = value
            .try_into()
            .map_err(|_| MfaServiceError::InvalidInput)?;
        if !code.iter().all(u8::is_ascii_digit) {
            return Err(MfaServiceError::InvalidInput);
        }
        Ok(Self(Zeroizing::new(code)))
    }

    pub(crate) fn expose(&self) -> &[u8; 6] {
        &self.0
    }
}

impl fmt::Debug for TotpCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TotpCode([REDACTED])")
    }
}

impl MfaChallengePolicy {
    pub(crate) fn new(
        failure_threshold: u16,
        failure_window: Duration,
        lock_duration: Duration,
        operation_timeout: Duration,
    ) -> Result<Self, MfaServiceError> {
        if !(MIN_FAILURE_THRESHOLD..=MAX_FAILURE_THRESHOLD).contains(&failure_threshold)
            || !(MIN_FAILURE_DURATION..=MAX_FAILURE_DURATION).contains(&failure_window)
            || !(MIN_FAILURE_DURATION..=MAX_FAILURE_DURATION).contains(&lock_duration)
            || !(Duration::from_millis(100)..=Duration::from_secs(30)).contains(&operation_timeout)
        {
            return Err(MfaServiceError::InvalidInput);
        }
        Ok(Self {
            failure_threshold,
            failure_window,
            lock_duration,
            operation_timeout,
        })
    }
}

impl Default for MfaChallengePolicy {
    fn default() -> Self {
        Self {
            failure_threshold: DEFAULT_FAILURE_THRESHOLD,
            failure_window: DEFAULT_FAILURE_WINDOW,
            lock_duration: DEFAULT_LOCK_DURATION,
            operation_timeout: DEFAULT_TIMEOUT,
        }
    }
}

impl fmt::Debug for EnrollmentStart {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EnrollmentStart")
            .field("metadata", &self.metadata)
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

impl fmt::Debug for EnrollmentComplete {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EnrollmentComplete")
            .field("session", &self.session)
            .field("recovery_codes", &"[REDACTED]")
            .finish()
    }
}

impl fmt::Debug for MfaService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MfaService")
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}
