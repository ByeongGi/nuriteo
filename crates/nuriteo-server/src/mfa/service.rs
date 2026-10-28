#![allow(dead_code, reason = "crate-private MFA-003 HTTP adapter handoff")]

use std::fmt;

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

use super::{
    DEFAULT_TIMEOUT, ENVELOPE_ALGORITHM, ENVELOPE_DOMAIN, MfaCredentialMetadata,
    MfaCredentialState, MfaRepository, MfaStorageError, RecoveryCode, TotpSecret, append_audit,
    insert_recovery_hashes, lock_local_user, validate_correlation, verify_recovery_code,
};

const TOTP_DIGITS: u32 = 6;

const TOTP_MODULUS: u32 = 10_u32.pow(TOTP_DIGITS);

const TOTP_STEP_SECONDS: i64 = 30;

const TOTP_WINDOW: i64 = 1;

const DEFAULT_FAILURE_THRESHOLD: u16 = 5;

const DEFAULT_FAILURE_WINDOW: Duration = Duration::from_secs(5 * 60);

const DEFAULT_LOCK_DURATION: Duration = Duration::from_secs(15 * 60);

const MIN_FAILURE_THRESHOLD: u16 = 3;

const MAX_FAILURE_THRESHOLD: u16 = 5;

const MIN_FAILURE_DURATION: Duration = Duration::from_secs(60);

const MAX_FAILURE_DURATION: Duration = Duration::from_secs(24 * 60 * 60);

const RECOVERY_CODE_COUNT: usize = 10;

const RECOVERY_CODE_BYTES: usize = 16;

const RECOVERY_CODE_ENCODED_BYTES: usize = 22;

const ARGON2_CONCURRENCY: usize = 4;

const RECEIPT_DOMAIN: &[u8] = b"nuriteo.mfa-operation-receipt.v1";

const RECEIPT_REQUEST_DOMAIN: &[u8] = b"nuriteo.mfa-operation-request.v1";

const RECEIPT_TTL_MINUTES: i32 = 15;

const MAX_RECEIPTS_PER_USER: i64 = 32;

#[derive(PartialEq, Eq)]
pub(crate) struct MfaIdempotencyKey(String);

struct SecretBytes(Zeroizing<Vec<u8>>);

struct SecretToken(Zeroizing<String>);

#[derive(Serialize, Deserialize)]
struct EnrollmentStartReceipt {
    credential_id: String,
    user_id: UserId,
    secret_version: u64,
    secret: SecretBytes,
}

#[derive(Serialize, Deserialize)]
struct SessionReceipt {
    token: SecretToken,
    session: SessionFields,
}

#[derive(Serialize, Deserialize)]
struct EnrollmentCompleteReceipt {
    issued: SessionReceipt,
    recovery_codes: Vec<SecretBytes>,
}

#[derive(PartialEq, Eq)]
pub(crate) struct TotpCode(Zeroizing<[u8; 6]>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MfaChallengePolicy {
    failure_threshold: u16,
    failure_window: Duration,
    lock_duration: Duration,
    operation_timeout: Duration,
}

pub(crate) struct EnrollmentStart {
    pub(crate) metadata: MfaCredentialMetadata,
    pub(crate) secret: TotpSecret,
}

pub(crate) struct EnrollmentComplete {
    pub(crate) session: IssuedSession,
    pub(crate) recovery_codes: Vec<RecoveryCode>,
}

#[derive(Clone)]
pub(crate) struct MfaService {
    pool: DatabasePool,
    repository: MfaRepository,
    sessions: SessionService,
    passwords: MfaPasswordExecutor,
    policy: MfaChallengePolicy,
    keyring: MasterKeyring,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReceiptBindingAuthority {
    Original,
    Rotated,
}

pub(crate) struct ChallengeState {
    last_accepted_counter: Option<u64>,
    locked_until: Option<OffsetDateTime>,
}

pub(crate) struct ChallengeAttempt<'a> {
    user_id: UserId,
    credential_id: Uuid,
    secret: &'a TotpSecret,
    code: &'a TotpCode,
    now: OffsetDateTime,
    correlation_id: &'a str,
}

#[derive(Clone)]
struct MfaPasswordExecutor {
    permits: Arc<Semaphore>,
}

struct MfaPasswordAdmission(OwnedSemaphorePermit);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MfaServiceError {
    InvalidInput,
    AuthenticationFailed,
    ReauthenticationRequired,
    ChallengeFailed,
    Unauthorized,
    NotActive,
    Conflict,
    Unavailable,
}

#[cfg(test)]
mod tests;

mod secrets;
pub(crate) use secrets::*;
mod enrollment;
pub(crate) use enrollment::*;
mod challenge;
pub(crate) use challenge::*;
mod sessions;
pub(crate) use sessions::*;
