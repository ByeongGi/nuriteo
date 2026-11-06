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
mod repository;
mod service;

pub(crate) use repository::{
    MfaRepository, RecoveryConsumeResult, append_audit, insert_recovery_hashes, lock_local_user,
    validate_correlation, verify_recovery_code,
};

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
