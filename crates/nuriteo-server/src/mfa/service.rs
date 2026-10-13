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

impl MfaIdempotencyKey {
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

    fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for MfaIdempotencyKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MfaIdempotencyKey([REDACTED])")
    }
}

struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    fn new(value: Vec<u8>) -> Self {
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

struct SecretToken(Zeroizing<String>);

impl SecretToken {
    fn new(value: String) -> Self {
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

    fn expose(&self) -> &[u8; 6] {
        &self.0
    }
}

impl fmt::Debug for TotpCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TotpCode([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MfaChallengePolicy {
    failure_threshold: u16,
    failure_window: Duration,
    lock_duration: Duration,
    operation_timeout: Duration,
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

pub(crate) struct EnrollmentStart {
    pub(crate) metadata: MfaCredentialMetadata,
    pub(crate) secret: TotpSecret,
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

pub(crate) struct EnrollmentComplete {
    pub(crate) session: IssuedSession,
    pub(crate) recovery_codes: Vec<RecoveryCode>,
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

#[derive(Clone)]
pub(crate) struct MfaService {
    pool: DatabasePool,
    repository: MfaRepository,
    sessions: SessionService,
    passwords: MfaPasswordExecutor,
    policy: MfaChallengePolicy,
    keyring: MasterKeyring,
}

impl fmt::Debug for MfaService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MfaService")
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl MfaService {
    pub(crate) fn new(
        pool: DatabasePool,
        keyring: MasterKeyring,
        session_policy: SessionPolicy,
        policy: MfaChallengePolicy,
    ) -> Self {
        Self {
            repository: MfaRepository::new(pool.clone(), keyring.clone()),
            sessions: SessionService::new(pool.clone(), session_policy),
            passwords: MfaPasswordExecutor::new(ARGON2_CONCURRENCY),
            pool,
            policy,
            keyring,
        }
    }

    pub(crate) async fn begin_enrollment(
        &self,
        token: &SessionToken,
        correlation_id: &str,
    ) -> Result<EnrollmentStart, MfaServiceError> {
        self.begin_enrollment_once(token, None, correlation_id)
            .await
    }

    pub(crate) async fn begin_enrollment_idempotent(
        &self,
        token: &SessionToken,
        key: &MfaIdempotencyKey,
        correlation_id: &str,
    ) -> Result<EnrollmentStart, MfaServiceError> {
        if let Some(receipt) = self
            .load_receipt::<EnrollmentStartReceipt>(token, "begin", key, &[])
            .await?
        {
            return receipt.into_result();
        }
        self.begin_enrollment_once(token, Some(key), correlation_id)
            .await
    }

    async fn begin_enrollment_once(
        &self,
        token: &SessionToken,
        receipt_key: Option<&MfaIdempotencyKey>,
        correlation_id: &str,
    ) -> Result<EnrollmentStart, MfaServiceError> {
        validate_correlation(correlation_id).map_err(map_storage_error)?;
        let operation = async {
            let expected_user = self
                .sessions
                .authenticate(token)
                .await
                .map_err(map_session_error)?
                .user_id();
            let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
            let mut tx = connection.begin().await.map_err(database_unavailable)?;
            acquire_mfa_population_lock(&mut tx)
                .await
                .map_err(database_unavailable)?;
            lock_local_user(&mut tx, expected_user)
                .await
                .map_err(map_storage_error)?;
            let principal = self.authenticate(&mut tx, token, true).await?;
            if principal.user_id() != expected_user {
                return Err(MfaServiceError::AuthenticationFailed);
            }
            let mut secret_bytes = vec![0_u8; 20];
            getrandom::fill(&mut secret_bytes).map_err(|_| MfaServiceError::Unavailable)?;
            let secret = TotpSecret::new(secret_bytes).map_err(map_storage_error)?;
            let id = Uuid::now_v7();
            let version = 1_u64;
            let user_text = principal.user_id().to_string();
            let version_bytes = version.to_be_bytes();
            let context = [
                user_text.as_bytes(),
                id.as_bytes(),
                version_bytes.as_slice(),
            ];
            let sealed = self
                .repository
                .keyring
                .seal_scoped(ENVELOPE_DOMAIN, &context, secret.expose())
                .map_err(|_| MfaServiceError::Unavailable)?;
            sqlx::query(
                "UPDATE mfa_totp_credentials SET state='replaced',terminal_at=transaction_timestamp(),
                 updated_at=transaction_timestamp() WHERE user_id=$1::uuid AND state='pending'",
            )
            .bind(&user_text)
            .execute(&mut *tx)
            .await
            .map_err(database_unavailable)?;
            sqlx::query(
                "INSERT INTO mfa_totp_credentials
                 (id,user_id,state,secret_version,algorithm,key_version,nonce,ciphertext)
                 VALUES($1::uuid,$2::uuid,'pending',$3,$4,$5,$6,$7)",
            )
            .bind(id.to_string())
            .bind(&user_text)
            .bind(i64::try_from(version).map_err(|_| MfaServiceError::Unavailable)?)
            .bind(ENVELOPE_ALGORITHM)
            .bind(i32::try_from(sealed.key_version).map_err(|_| MfaServiceError::Unavailable)?)
            .bind(sealed.nonce)
            .bind(sealed.ciphertext)
            .execute(&mut *tx)
            .await
            .map_err(database_unavailable)?;
            append_audit(
                &mut tx,
                principal.user_id(),
                principal.user_id(),
                "mfa.enrollment_started",
                correlation_id,
            )
            .await
            .map_err(map_storage_error)?;
            if let Some(key) = receipt_key {
                let receipt = EnrollmentStartReceipt {
                    credential_id: id.to_string(),
                    user_id: principal.user_id(),
                    secret_version: version,
                    secret: SecretBytes::new(secret.expose().to_vec()),
                };
                self.store_receipt(
                    &mut tx,
                    token,
                    None,
                    principal.user_id(),
                    "begin",
                    key,
                    &[],
                    &receipt,
                )
                .await?;
            }
            tx.commit().await.map_err(database_unavailable)?;
            Ok(EnrollmentStart {
                metadata: MfaCredentialMetadata {
                    id,
                    user_id: principal.user_id(),
                    state: MfaCredentialState::Pending,
                    secret_version: version,
                    recovery_codes: 0,
                },
                secret,
            })
        };
        self.bounded(operation).await
    }

    pub(crate) async fn confirm_enrollment(
        &self,
        token: &SessionToken,
        credential_id: Uuid,
        code: &TotpCode,
        correlation_id: &str,
    ) -> Result<EnrollmentComplete, MfaServiceError> {
        self.confirm_enrollment_once(token, credential_id, code, None, correlation_id)
            .await
    }

    pub(crate) async fn confirm_enrollment_idempotent(
        &self,
        token: &SessionToken,
        credential_id: Uuid,
        code: &TotpCode,
        key: &MfaIdempotencyKey,
        correlation_id: &str,
    ) -> Result<EnrollmentComplete, MfaServiceError> {
        let request = [
            credential_id.as_bytes().as_slice(),
            code.expose().as_slice(),
        ];
        if let Some(receipt) = self
            .load_receipt::<EnrollmentCompleteReceipt>(token, "confirm", key, &request)
            .await?
        {
            return receipt.into_result();
        }
        self.confirm_enrollment_once(token, credential_id, code, Some(key), correlation_id)
            .await
    }

    async fn confirm_enrollment_once(
        &self,
        token: &SessionToken,
        credential_id: Uuid,
        code: &TotpCode,
        receipt_key: Option<&MfaIdempotencyKey>,
        correlation_id: &str,
    ) -> Result<EnrollmentComplete, MfaServiceError> {
        validate_correlation(correlation_id).map_err(map_storage_error)?;
        self.bounded(async {
            // Reserve expensive-work capacity before touching the database. A
            // saturated Argon2 pool therefore cannot consume a connection or
            // hold User/Session/credential locks while it waits.
            let password_admission = self.passwords.try_admit()?;
            let expected_user = self
                .sessions
                .authenticate(token)
                .await
                .map_err(map_session_error)?
                .user_id();
            let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
            let mut tx = connection.begin().await.map_err(database_unavailable)?;
            // User first, then Session, then credential/challenge. Every path
            // that revokes sibling Sessions uses this order to avoid a
            // cross-session deadlock during concurrent privilege changes.
            lock_local_user(&mut tx, expected_user)
                .await
                .map_err(map_storage_error)?;
            let principal = self.authenticate(&mut tx, token, true).await?;
            if principal.user_id() != expected_user {
                return Err(MfaServiceError::AuthenticationFailed);
            }
            let row = load_credential(
                &mut tx,
                principal.user_id(),
                credential_id,
                "pending",
            )
            .await?;
            let secret = self
                .repository
                .open_secret(principal.user_id(), &row)
                .map_err(map_storage_error)?;
            let now = transaction_time(&mut tx).await?;
            lock_challenge_state(&mut tx, principal.user_id(), credential_id).await?;
            let Some(counter) = self
                .verify_locked_challenge(
                    &mut tx,
                    ChallengeAttempt {
                        user_id: principal.user_id(),
                        credential_id,
                        secret: &secret,
                        code,
                        now,
                        correlation_id,
                    },
                )
                .await?
            else {
                tx.commit().await.map_err(database_unavailable)?;
                return Err(MfaServiceError::ChallengeFailed);
            };
            let secret_version = u64::try_from(row.get::<i64, _>("secret_version"))
                .map_err(|_| MfaServiceError::Unavailable)?;
            let user_id = principal.user_id();
            tx.commit().await.map_err(database_unavailable)?;
            drop(connection);

            let (recovery_codes, hashing_codes) = generate_recovery_codes()?;
            let hashes = self
                .passwords
                .hash_recovery_codes(password_admission, hashing_codes)
                .await?;

            // Re-enter with the canonical privilege-mutation lock order and
            // revalidate every generation/challenge fence after CPU work.
            let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
            let mut tx = connection.begin().await.map_err(database_unavailable)?;
            acquire_mfa_population_lock(&mut tx)
                .await
                .map_err(database_unavailable)?;
            lock_local_user(&mut tx, user_id)
                .await
                .map_err(map_storage_error)?;
            let principal = self.authenticate(&mut tx, token, true).await?;
            if principal.user_id() != user_id {
                return Err(MfaServiceError::AuthenticationFailed);
            }
            let row = load_credential(&mut tx, user_id, credential_id, "pending").await?;
            let observed_secret_version = u64::try_from(row.get::<i64, _>("secret_version"))
                .map_err(|_| MfaServiceError::Unavailable)?;
            if observed_secret_version != secret_version {
                return Err(MfaServiceError::Conflict);
            }
            lock_challenge_state(&mut tx, user_id, credential_id).await?;
            assert_challenge_counter_available(&mut tx, credential_id, counter).await?;
            assert_pending_generation(
                &mut tx,
                user_id,
                credential_id,
                secret_version,
            )
            .await?;
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=$1::uuid")
                .bind(principal.user_id().to_string())
                .execute(&mut *tx)
                .await
                .map_err(database_unavailable)?;
            sqlx::query(
                "UPDATE mfa_totp_credentials SET state='replaced',terminal_at=transaction_timestamp(),
                 updated_at=transaction_timestamp() WHERE user_id=$1::uuid AND state='active'",
            )
            .bind(principal.user_id().to_string())
            .execute(&mut *tx)
            .await
            .map_err(database_unavailable)?;
            let changed = sqlx::query(
                "UPDATE mfa_totp_credentials SET state='active',activated_at=transaction_timestamp(),
                 updated_at=transaction_timestamp() WHERE id=$1::uuid AND user_id=$2::uuid
                 AND state='pending'",
            )
            .bind(credential_id.to_string())
            .bind(principal.user_id().to_string())
            .execute(&mut *tx)
            .await
            .map_err(database_unavailable)?
            .rows_affected();
            if changed != 1 {
                return Err(MfaServiceError::Conflict);
            }
            insert_recovery_hashes(&mut tx, principal.user_id(), credential_id, hashes)
                .await
                .map_err(map_storage_error)?;
            mark_challenge_success(&mut tx, credential_id, counter).await?;
            let issued = self
                .sessions
                .rotate_in_transaction(&mut tx, token, SessionRotationKind::Reauthentication)
                .await
                .map_err(map_session_error)?;
            revoke_other_sessions(&mut tx, principal.user_id(), issued.session().id()).await?;
            append_audit(
                &mut tx,
                principal.user_id(),
                principal.user_id(),
                "mfa.enabled",
                correlation_id,
            )
            .await
            .map_err(map_storage_error)?;
            if let Some(key) = receipt_key {
                let receipt = EnrollmentCompleteReceipt::from_result(&issued, &recovery_codes);
                let request = [credential_id.as_bytes().as_slice(), code.expose().as_slice()];
                self.store_receipt(
                    &mut tx,
                    token,
                    Some(issued.token()),
                    principal.user_id(),
                    "confirm",
                    key,
                    &request,
                    &receipt,
                )
                .await?;
            }
            tx.commit().await.map_err(database_unavailable)?;
            Ok(EnrollmentComplete {
                session: issued,
                recovery_codes,
            })
        })
        .await
    }

    pub(crate) async fn verify_totp(
        &self,
        token: &SessionToken,
        code: &TotpCode,
        correlation_id: &str,
    ) -> Result<IssuedSession, MfaServiceError> {
        self.verify_totp_once(token, code, None, correlation_id)
            .await
    }

    pub(crate) async fn verify_totp_idempotent(
        &self,
        token: &SessionToken,
        code: &TotpCode,
        key: &MfaIdempotencyKey,
        correlation_id: &str,
    ) -> Result<IssuedSession, MfaServiceError> {
        let request = [code.expose().as_slice()];
        if let Some(receipt) = self
            .load_receipt::<SessionReceipt>(token, "challenge", key, &request)
            .await?
        {
            return receipt.into_result();
        }
        self.verify_totp_once(token, code, Some(key), correlation_id)
            .await
    }

    async fn verify_totp_once(
        &self,
        token: &SessionToken,
        code: &TotpCode,
        receipt_key: Option<&MfaIdempotencyKey>,
        correlation_id: &str,
    ) -> Result<IssuedSession, MfaServiceError> {
        validate_correlation(correlation_id).map_err(map_storage_error)?;
        self.bounded(async {
            let expected_user = self
                .sessions
                .authenticate(token)
                .await
                .map_err(map_session_error)?
                .user_id();
            let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
            let mut tx = connection.begin().await.map_err(database_unavailable)?;
            lock_local_user(&mut tx, expected_user)
                .await
                .map_err(map_storage_error)?;
            let principal = self.authenticate(&mut tx, token, false).await?;
            if principal.user_id() != expected_user {
                return Err(MfaServiceError::AuthenticationFailed);
            }
            let row = load_active_credential(&mut tx, principal.user_id()).await?;
            let credential_id = parse_credential_id(&row)?;
            let secret = self
                .repository
                .open_secret(principal.user_id(), &row)
                .map_err(map_storage_error)?;
            let now = transaction_time(&mut tx).await?;
            lock_challenge_state(&mut tx, principal.user_id(), credential_id).await?;
            let Some(counter) = self
                .verify_locked_challenge(
                    &mut tx,
                    ChallengeAttempt {
                        user_id: principal.user_id(),
                        credential_id,
                        secret: &secret,
                        code,
                        now,
                        correlation_id,
                    },
                )
                .await?
            else {
                tx.commit().await.map_err(database_unavailable)?;
                return Err(MfaServiceError::ChallengeFailed);
            };
            mark_challenge_success(&mut tx, credential_id, counter).await?;
            let issued = self
                .sessions
                .rotate_in_transaction(&mut tx, token, SessionRotationKind::Reauthentication)
                .await
                .map_err(map_session_error)?;
            append_audit(
                &mut tx,
                principal.user_id(),
                principal.user_id(),
                "mfa.challenge_succeeded",
                correlation_id,
            )
            .await
            .map_err(map_storage_error)?;
            if let Some(key) = receipt_key {
                let receipt = SessionReceipt::from_result(&issued);
                let request = [code.expose().as_slice()];
                self.store_receipt(
                    &mut tx,
                    token,
                    Some(issued.token()),
                    principal.user_id(),
                    "challenge",
                    key,
                    &request,
                    &receipt,
                )
                .await?;
            }
            tx.commit().await.map_err(database_unavailable)?;
            Ok(issued)
        })
        .await
    }

    pub(crate) async fn recover(
        &self,
        token: &SessionToken,
        code: RecoveryCode,
        correlation_id: &str,
    ) -> Result<IssuedSession, MfaServiceError> {
        self.recover_once(token, code, None, correlation_id).await
    }

    pub(crate) async fn recover_idempotent(
        &self,
        token: &SessionToken,
        code: RecoveryCode,
        key: &MfaIdempotencyKey,
        correlation_id: &str,
    ) -> Result<IssuedSession, MfaServiceError> {
        let request_copy = Zeroizing::new(code.expose().to_vec());
        let request = [request_copy.as_slice()];
        if let Some(receipt) = self
            .load_receipt::<SessionReceipt>(token, "recovery", key, &request)
            .await?
        {
            return receipt.into_result();
        }
        self.recover_once(token, code, Some((key, request_copy)), correlation_id)
            .await
    }

    async fn recover_once(
        &self,
        token: &SessionToken,
        code: RecoveryCode,
        receipt: Option<(&MfaIdempotencyKey, Zeroizing<Vec<u8>>)>,
        correlation_id: &str,
    ) -> Result<IssuedSession, MfaServiceError> {
        validate_correlation(correlation_id).map_err(map_storage_error)?;
        self.bounded(async {
            let expected_user = self
                .sessions
                .authenticate(token)
                .await
                .map_err(map_session_error)?
                .user_id();
            let (user_id, candidates) = self.load_recovery_candidates(token, expected_user).await?;
            let matched = self
                .passwords
                .verify_recovery_code(code, candidates)
                .await?;
            let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
            let mut tx = connection.begin().await.map_err(database_unavailable)?;
            lock_local_user(&mut tx, user_id)
                .await
                .map_err(map_storage_error)?;
            let principal = self.authenticate(&mut tx, token, false).await?;
            if principal.user_id() != user_id {
                return Err(MfaServiceError::AuthenticationFailed);
            }
            let row = load_active_credential(&mut tx, user_id).await?;
            let credential_id = parse_credential_id(&row)?;
            lock_challenge_state(&mut tx, user_id, credential_id).await?;
            if challenge_is_locked(&mut tx, credential_id).await? {
                tx.commit().await.map_err(database_unavailable)?;
                return Err(MfaServiceError::ChallengeFailed);
            }
            let Some((code_id, matched_credential)) = matched else {
                let now = transaction_time(&mut tx).await?;
                record_challenge_failure(&mut tx, credential_id, self.policy, now).await?;
                append_attempt_audit(&mut tx, user_id, "mfa.recovery_failed", correlation_id)
                    .await?;
                tx.commit().await.map_err(database_unavailable)?;
                return Err(MfaServiceError::ChallengeFailed);
            };
            if matched_credential != credential_id {
                return Err(MfaServiceError::ChallengeFailed);
            }
            let deleted = sqlx::query(
                "DELETE FROM mfa_recovery_codes WHERE id=$1::uuid AND credential_id=$2::uuid
                 AND user_id=$3::uuid",
            )
            .bind(code_id.to_string())
            .bind(credential_id.to_string())
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(database_unavailable)?
            .rows_affected();
            if deleted != 1 {
                return Err(MfaServiceError::ChallengeFailed);
            }
            clear_challenge_failures(&mut tx, credential_id).await?;
            let issued = self
                .sessions
                .rotate_in_transaction(&mut tx, token, SessionRotationKind::Login)
                .await
                .map_err(map_session_error)?;
            revoke_other_sessions(&mut tx, user_id, issued.session().id()).await?;
            append_audit(
                &mut tx,
                user_id,
                user_id,
                "mfa.recovery_succeeded",
                correlation_id,
            )
            .await
            .map_err(map_storage_error)?;
            if let Some((key, request_copy)) = receipt.as_ref() {
                let response = SessionReceipt::from_result(&issued);
                let request = [request_copy.as_slice()];
                self.store_receipt(
                    &mut tx,
                    token,
                    Some(issued.token()),
                    user_id,
                    "recovery",
                    key,
                    &request,
                    &response,
                )
                .await?;
            }
            tx.commit().await.map_err(database_unavailable)?;
            Ok(issued)
        })
        .await
    }

    pub(crate) async fn admin_reset(
        &self,
        token: &SessionToken,
        target: UserId,
        credential_generation: Uuid,
        confirmation: &str,
        correlation_id: &str,
    ) -> Result<(), MfaServiceError> {
        validate_correlation(correlation_id).map_err(map_storage_error)?;
        if confirmation.len() > 320 || confirmation.chars().any(char::is_control) {
            return Err(MfaServiceError::InvalidInput);
        }
        self.bounded(async {
            let expected_actor = self
                .sessions
                .authenticate(token)
                .await
                .map_err(map_session_error)?
                .user_id();
            if expected_actor == target {
                return Err(MfaServiceError::Unauthorized);
            }
            let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
            let mut tx = connection.begin().await.map_err(database_unavailable)?;
            acquire_mfa_population_lock(&mut tx)
                .await
                .map_err(database_unavailable)?;
            lock_admin_and_target(&mut tx, expected_actor, target).await?;
            let principal = self.authenticate(&mut tx, token, true).await?;
            if principal.user_id() != expected_actor {
                return Err(MfaServiceError::Unauthorized);
            }
            let target_email: String = sqlx::query_scalar(
                "SELECT email FROM users WHERE id=$1::uuid AND status='active' FOR UPDATE",
            )
            .bind(target.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(database_unavailable)?
            .ok_or(MfaServiceError::NotActive)?;
            if confirmation != target_email {
                return Err(MfaServiceError::InvalidInput);
            }
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=$1::uuid")
                .bind(target.to_string())
                .execute(&mut *tx)
                .await
                .map_err(database_unavailable)?;
            let active = sqlx::query(
                "UPDATE mfa_totp_credentials SET state='disabled',terminal_at=transaction_timestamp(),
                 updated_at=transaction_timestamp() WHERE id=$2::uuid AND user_id=$1::uuid AND state='active'",
            )
            .bind(target.to_string())
            .bind(credential_generation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(database_unavailable)?
            .rows_affected();
            sqlx::query(
                "UPDATE mfa_totp_credentials SET state='replaced',terminal_at=transaction_timestamp(),
                 updated_at=transaction_timestamp() WHERE user_id=$1::uuid AND state='pending'",
            )
            .bind(target.to_string())
            .execute(&mut *tx)
            .await
            .map_err(database_unavailable)?;
            if active != 1 {
                return Err(MfaServiceError::Conflict);
            }
            if !has_required_active_local_enrolled_admin(&mut tx)
                .await
                .map_err(database_unavailable)?
            {
                return Err(MfaServiceError::Unauthorized);
            }
            revoke_all_sessions(&mut tx, target, "mfa_admin_reset").await?;
            append_audit(
                &mut tx,
                principal.user_id(),
                target,
                "mfa.admin_reset",
                correlation_id,
            )
            .await
            .map_err(map_storage_error)?;
            tx.commit().await.map_err(database_unavailable)?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn disable_self(
        &self,
        token: &SessionToken,
        correlation_id: &str,
    ) -> Result<IssuedSession, MfaServiceError> {
        validate_correlation(correlation_id).map_err(map_storage_error)?;
        self.bounded(async {
            let expected_user = self
                .sessions
                .authenticate(token)
                .await
                .map_err(map_session_error)?
                .user_id();
            let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
            let mut tx = connection.begin().await.map_err(database_unavailable)?;
            acquire_mfa_population_lock(&mut tx)
                .await
                .map_err(database_unavailable)?;
            lock_local_user(&mut tx, expected_user)
                .await
                .map_err(map_storage_error)?;
            let principal = self.authenticate(&mut tx, token, true).await?;
            if principal.user_id() != expected_user {
                return Err(MfaServiceError::AuthenticationFailed);
            }
            let required: bool = sqlx::query_scalar(
                "SELECT CASE policy.value #>> '{}' \
                   WHEN 'all_local_users' THEN TRUE \
                   WHEN 'administrators' THEN account.is_instance_admin \
                   ELSE FALSE END \
                 FROM users account CROSS JOIN instance_settings policy \
                 WHERE account.id=$1::uuid AND policy.key='security.mfa_enforcement'",
            )
            .bind(expected_user.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(database_unavailable)?;
            if required {
                return Err(MfaServiceError::Unauthorized);
            }
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=$1::uuid")
                .bind(expected_user.to_string())
                .execute(&mut *tx)
                .await
                .map_err(database_unavailable)?;
            let changed = sqlx::query(
                "UPDATE mfa_totp_credentials SET state='disabled',terminal_at=transaction_timestamp(), \
                 updated_at=transaction_timestamp() WHERE user_id=$1::uuid AND state='active'",
            )
            .bind(expected_user.to_string())
            .execute(&mut *tx)
            .await
            .map_err(database_unavailable)?
            .rows_affected();
            if changed != 1 {
                return Err(MfaServiceError::NotActive);
            }
            if !has_required_active_local_enrolled_admin(&mut tx)
                .await
                .map_err(database_unavailable)?
            {
                return Err(MfaServiceError::Unauthorized);
            }
            let issued = self
                .sessions
                .rotate_in_transaction(&mut tx, token, SessionRotationKind::Login)
                .await
                .map_err(map_session_error)?;
            revoke_other_sessions(&mut tx, expected_user, issued.session().id()).await?;
            append_audit(
                &mut tx,
                expected_user,
                expected_user,
                "mfa.disabled",
                correlation_id,
            )
            .await
            .map_err(map_storage_error)?;
            tx.commit().await.map_err(database_unavailable)?;
            Ok(issued)
        })
        .await
    }

    async fn load_receipt<T: DeserializeOwned>(
        &self,
        token: &SessionToken,
        operation: &'static str,
        key: &MfaIdempotencyKey,
        request_parts: &[&[u8]],
    ) -> Result<Option<T>, MfaServiceError> {
        let presented_binding = token.binding_digest();
        let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
        let mut rows = sqlx::query(
            "SELECT session_binding,rotated_session_binding,request_key_version,request_attestation,response_key_version,response_nonce,response_ciphertext \
             FROM mfa_operation_receipts WHERE (session_binding=$1 OR rotated_session_binding=$1) AND operation=$2 \
             AND idempotency_key=$3 AND expires_at>transaction_timestamp() LIMIT 2",
        )
        .bind(presented_binding.as_slice())
        .bind(operation)
        .bind(key.expose())
        .fetch_all(&mut *connection)
        .await
        .map_err(database_unavailable)?;
        if rows.len() > 1 {
            return Err(MfaServiceError::Conflict);
        }
        let Some(row) = rows.pop() else {
            return Ok(None);
        };
        let binding: [u8; 32] = row
            .get::<Vec<u8>, _>("session_binding")
            .try_into()
            .map_err(|_| MfaServiceError::Unavailable)?;
        let rotated_binding = row
            .get::<Option<Vec<u8>>, _>("rotated_session_binding")
            .map(|binding| binding.try_into().map_err(|_| MfaServiceError::Unavailable))
            .transpose()?;
        let _authority =
            receipt_binding_authority(&presented_binding, &binding, rotated_binding.as_ref())?;
        let request_version = u32::try_from(row.get::<i32, _>("request_key_version"))
            .map_err(|_| MfaServiceError::Unavailable)?;
        let request_attestation: Vec<u8> = row.get("request_attestation");
        let request_context = receipt_context(
            &binding,
            rotated_binding.as_ref(),
            operation,
            key,
            request_parts,
        );
        self.keyring
            .verify_scoped_attestation(
                RECEIPT_REQUEST_DOMAIN,
                &request_context,
                request_version,
                &request_attestation,
            )
            .map_err(|_| MfaServiceError::Conflict)?;
        let response_version = u32::try_from(row.get::<i32, _>("response_key_version"))
            .map_err(|_| MfaServiceError::Unavailable)?;
        let nonce: Vec<u8> = row.get("response_nonce");
        let ciphertext: Vec<u8> = row.get("response_ciphertext");
        let envelope_context =
            receipt_context(&binding, rotated_binding.as_ref(), operation, key, &[]);
        let plaintext = self
            .keyring
            .open_scoped(
                RECEIPT_DOMAIN,
                &envelope_context,
                response_version,
                &nonce,
                &ciphertext,
            )
            .map_err(|_| MfaServiceError::Unavailable)?;
        serde_json::from_slice(&plaintext)
            .map(Some)
            .map_err(|_| MfaServiceError::Unavailable)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "receipt security context is explicit"
    )]
    async fn store_receipt<T: Serialize>(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        token: &SessionToken,
        rotated_token: Option<&SessionToken>,
        user_id: UserId,
        operation: &'static str,
        key: &MfaIdempotencyKey,
        request_parts: &[&[u8]],
        response: &T,
    ) -> Result<(), MfaServiceError> {
        let binding = token.binding_digest();
        let rotated_binding = rotated_token.map(SessionToken::binding_digest);
        let request_context = receipt_context(
            &binding,
            rotated_binding.as_ref(),
            operation,
            key,
            request_parts,
        );
        let (request_key_version, request_attestation) = self
            .keyring
            .attest_scoped(RECEIPT_REQUEST_DOMAIN, &request_context)
            .map_err(|_| MfaServiceError::Unavailable)?;
        let plaintext =
            Zeroizing::new(serde_json::to_vec(response).map_err(|_| MfaServiceError::Unavailable)?);
        let envelope_context =
            receipt_context(&binding, rotated_binding.as_ref(), operation, key, &[]);
        let envelope = self
            .keyring
            .seal_scoped(RECEIPT_DOMAIN, &envelope_context, &plaintext)
            .map_err(|_| MfaServiceError::Unavailable)?;
        sqlx::query("DELETE FROM mfa_operation_receipts WHERE expires_at<=transaction_timestamp()")
            .execute(&mut **tx)
            .await
            .map_err(database_unavailable)?;
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mfa_operation_receipts WHERE user_id=$1::uuid",
        )
        .bind(user_id.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(database_unavailable)?;
        if count >= MAX_RECEIPTS_PER_USER {
            return Err(MfaServiceError::Unavailable);
        }
        sqlx::query(
            "INSERT INTO mfa_operation_receipts(id,user_id,session_binding,rotated_session_binding,operation,idempotency_key, \
             request_key_version,request_attestation,response_key_version,response_nonce,response_ciphertext,expires_at) \
             VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11, \
                    transaction_timestamp()+make_interval(mins=>$12))",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(user_id.to_string())
        .bind(binding.as_slice())
        .bind(rotated_binding.as_ref().map(<[u8; 32]>::as_slice))
        .bind(operation)
        .bind(key.expose())
        .bind(i32::try_from(request_key_version).map_err(|_| MfaServiceError::Unavailable)?)
        .bind(request_attestation.as_slice())
        .bind(i32::try_from(envelope.key_version).map_err(|_| MfaServiceError::Unavailable)?)
        .bind(envelope.nonce)
        .bind(envelope.ciphertext)
        .bind(RECEIPT_TTL_MINUTES)
        .execute(&mut **tx)
        .await
        .map_err(|error| {
            if error
                .as_database_error()
                .and_then(|database| database.constraint())
                .is_some_and(|constraint| {
                    matches!(
                        constraint,
                        "mfa_operation_receipts_unique"
                            | "mfa_operation_receipts_rotated_unique_idx"
                    )
                })
            {
                MfaServiceError::Conflict
            } else {
                database_unavailable(error)
            }
        })?;
        Ok(())
    }

    async fn authenticate(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        token: &SessionToken,
        require_recent: bool,
    ) -> Result<Session, MfaServiceError> {
        let session = self
            .sessions
            .authenticate_in_transaction(tx, token)
            .await
            .map_err(map_session_error)?;
        if require_recent {
            require_recent_reauthentication(tx, &session).await?;
        }
        Ok(session)
    }

    async fn verify_locked_challenge(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        attempt: ChallengeAttempt<'_>,
    ) -> Result<Option<u64>, MfaServiceError> {
        let state = load_challenge_state(tx, attempt.credential_id).await?;
        if state.locked_until.is_some_and(|until| until > attempt.now) {
            return Ok(None);
        }
        let matched = matching_counter(attempt.secret, attempt.code, attempt.now)?;
        let accepted = matched.filter(|counter| {
            state
                .last_accepted_counter
                .is_none_or(|last| *counter > last)
        });
        if accepted.is_none() {
            record_challenge_failure(tx, attempt.credential_id, self.policy, attempt.now).await?;
            append_attempt_audit(
                tx,
                attempt.user_id,
                "mfa.challenge_failed",
                attempt.correlation_id,
            )
            .await?;
        }
        Ok(accepted)
    }

    async fn load_recovery_candidates(
        &self,
        token: &SessionToken,
        expected_user: UserId,
    ) -> Result<(UserId, Vec<(Uuid, Uuid, StoredPasswordHash)>), MfaServiceError> {
        let mut connection = self.pool.acquire().await.map_err(database_unavailable)?;
        let mut tx = connection.begin().await.map_err(database_unavailable)?;
        lock_local_user(&mut tx, expected_user)
            .await
            .map_err(map_storage_error)?;
        let principal = self.authenticate(&mut tx, token, false).await?;
        if principal.user_id() != expected_user {
            return Err(MfaServiceError::AuthenticationFailed);
        }
        let row = load_active_credential(&mut tx, principal.user_id()).await?;
        let credential_id = parse_credential_id(&row)?;
        lock_challenge_state(&mut tx, principal.user_id(), credential_id).await?;
        if challenge_is_locked(&mut tx, credential_id).await? {
            return Err(MfaServiceError::ChallengeFailed);
        }
        let rows = sqlx::query(
            "SELECT id::text,credential_id::text,code_hash FROM mfa_recovery_codes
                 WHERE user_id=$1::uuid AND credential_id=$2::uuid ORDER BY slot LIMIT 20",
        )
        .bind(principal.user_id().to_string())
        .bind(credential_id.to_string())
        .fetch_all(&mut *tx)
        .await
        .map_err(database_unavailable)?;
        let candidates = rows
            .into_iter()
            .map(|row| {
                Ok((
                    Uuid::parse_str(&row.get::<String, _>("id"))
                        .map_err(|_| MfaServiceError::Unavailable)?,
                    Uuid::parse_str(&row.get::<String, _>("credential_id"))
                        .map_err(|_| MfaServiceError::Unavailable)?,
                    StoredPasswordHash::new(row.get("code_hash"))
                        .map_err(|_| MfaServiceError::Unavailable)?,
                ))
            })
            .collect::<Result<Vec<_>, MfaServiceError>>()?;
        tx.commit().await.map_err(database_unavailable)?;
        Ok((principal.user_id(), candidates))
    }

    async fn bounded<T>(
        &self,
        operation: impl Future<Output = Result<T, MfaServiceError>>,
    ) -> Result<T, MfaServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| MfaServiceError::Unavailable)?
    }
}

impl EnrollmentStartReceipt {
    fn into_result(self) -> Result<EnrollmentStart, MfaServiceError> {
        Ok(EnrollmentStart {
            metadata: MfaCredentialMetadata {
                id: Uuid::parse_str(&self.credential_id)
                    .map_err(|_| MfaServiceError::Unavailable)?,
                user_id: self.user_id,
                state: MfaCredentialState::Pending,
                secret_version: self.secret_version,
                recovery_codes: 0,
            },
            secret: TotpSecret::new(self.secret.0.to_vec()).map_err(map_storage_error)?,
        })
    }
}

impl SessionReceipt {
    fn from_result(issued: &IssuedSession) -> Self {
        Self {
            token: SecretToken::new(issued.token().expose().to_owned()),
            session: issued.session().clone().into_fields(),
        }
    }

    fn into_result(self) -> Result<IssuedSession, MfaServiceError> {
        let token = SessionToken::parse(self.token.0.to_string()).map_err(map_session_error)?;
        let session = Session::new(self.session).map_err(|_| MfaServiceError::Unavailable)?;
        Ok(IssuedSession::from_parts(token, session))
    }
}

impl EnrollmentCompleteReceipt {
    fn from_result(issued: &IssuedSession, recovery_codes: &[RecoveryCode]) -> Self {
        Self {
            issued: SessionReceipt::from_result(issued),
            recovery_codes: recovery_codes
                .iter()
                .map(|code| SecretBytes::new(code.expose().to_vec()))
                .collect(),
        }
    }

    fn into_result(self) -> Result<EnrollmentComplete, MfaServiceError> {
        Ok(EnrollmentComplete {
            session: self.issued.into_result()?,
            recovery_codes: self
                .recovery_codes
                .into_iter()
                .map(|code| RecoveryCode::new(code.0.to_vec()).map_err(map_storage_error))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReceiptBindingAuthority {
    Original,
    Rotated,
}

fn receipt_binding_authority(
    presented: &[u8; 32],
    original: &[u8; 32],
    rotated: Option<&[u8; 32]>,
) -> Result<ReceiptBindingAuthority, MfaServiceError> {
    let original_matches = bool::from(presented.ct_eq(original));
    let rotated_matches = rotated.is_some_and(|binding| bool::from(presented.ct_eq(binding)));
    match (original_matches, rotated_matches) {
        (true, false) => Ok(ReceiptBindingAuthority::Original),
        (false, true) => Ok(ReceiptBindingAuthority::Rotated),
        _ => Err(MfaServiceError::Conflict),
    }
}

fn receipt_context<'a>(
    binding: &'a [u8; 32],
    rotated_binding: Option<&'a [u8; 32]>,
    operation: &'a str,
    key: &'a MfaIdempotencyKey,
    request_parts: &'a [&'a [u8]],
) -> Vec<&'a [u8]> {
    const ORIGINAL_BINDING_FIELD: &[u8] = b"original-session-binding";
    const ROTATED_BINDING_PRESENT_FIELD: &[u8] = b"rotated-session-binding:present";
    const ROTATED_BINDING_ABSENT_FIELD: &[u8] = b"rotated-session-binding:absent";
    const OPERATION_FIELD: &[u8] = b"operation";
    const IDEMPOTENCY_KEY_FIELD: &[u8] = b"idempotency-key";

    let mut context = Vec::with_capacity(8 + request_parts.len());
    context.push(ORIGINAL_BINDING_FIELD);
    context.push(binding.as_slice());
    match rotated_binding {
        Some(rotated) => {
            context.push(ROTATED_BINDING_PRESENT_FIELD);
            context.push(rotated.as_slice());
        }
        None => context.push(ROTATED_BINDING_ABSENT_FIELD),
    }
    context.push(OPERATION_FIELD);
    context.push(operation.as_bytes());
    context.push(IDEMPOTENCY_KEY_FIELD);
    context.push(key.expose().as_bytes());
    context.extend_from_slice(request_parts);
    context
}

struct ChallengeState {
    last_accepted_counter: Option<u64>,
    locked_until: Option<OffsetDateTime>,
}

struct ChallengeAttempt<'a> {
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

impl MfaPasswordExecutor {
    fn new(concurrency: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(concurrency)),
        }
    }

    fn try_admit(&self) -> Result<MfaPasswordAdmission, MfaServiceError> {
        self.permits
            .clone()
            .try_acquire_owned()
            .map(MfaPasswordAdmission)
            .map_err(|_| MfaServiceError::Unavailable)
    }

    async fn hash_recovery_codes(
        &self,
        admission: MfaPasswordAdmission,
        codes: Vec<RecoveryCode>,
    ) -> Result<Vec<StoredPasswordHash>, MfaServiceError> {
        if codes.len() != RECOVERY_CODE_COUNT
            || codes.iter().enumerate().any(|(index, code)| {
                codes[..index]
                    .iter()
                    .any(|existing| existing.expose() == code.expose())
            })
        {
            return Err(MfaServiceError::Unavailable);
        }
        tokio::task::spawn_blocking(move || {
            let _permit = admission.0;
            let service = PasswordService::default();
            codes
                .iter()
                .map(|code| {
                    service
                        .hash(code.expose())
                        .map_err(|_| MfaServiceError::Unavailable)
                })
                .collect()
        })
        .await
        .map_err(|_| MfaServiceError::Unavailable)?
    }

    #[cfg(test)]
    async fn saturate_for_test(&self) -> OwnedSemaphorePermit {
        self.permits
            .clone()
            .acquire_many_owned(u32::try_from(ARGON2_CONCURRENCY).unwrap())
            .await
            .unwrap()
    }

    async fn verify_recovery_code(
        &self,
        code: RecoveryCode,
        candidates: Vec<(Uuid, Uuid, StoredPasswordHash)>,
    ) -> Result<Option<(Uuid, Uuid)>, MfaServiceError> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| MfaServiceError::Unavailable)?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            verify_recovery_code(&code, &candidates).map_err(map_storage_error)
        })
        .await
        .map_err(|_| MfaServiceError::Unavailable)?
    }
}

async fn load_credential(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    credential_id: Uuid,
    state: &str,
) -> Result<sqlx::postgres::PgRow, MfaServiceError> {
    sqlx::query(
        "SELECT id::text,secret_version,algorithm,key_version,nonce,ciphertext
         FROM mfa_totp_credentials WHERE id=$1::uuid AND user_id=$2::uuid AND state=$3
         FOR UPDATE",
    )
    .bind(credential_id.to_string())
    .bind(user_id.to_string())
    .bind(state)
    .fetch_optional(&mut **tx)
    .await
    .map_err(database_unavailable)?
    .ok_or(MfaServiceError::Conflict)
}

async fn load_active_credential(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<sqlx::postgres::PgRow, MfaServiceError> {
    sqlx::query(
        "SELECT id::text,secret_version,algorithm,key_version,nonce,ciphertext
         FROM mfa_totp_credentials WHERE user_id=$1::uuid AND state='active' FOR UPDATE",
    )
    .bind(user_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(database_unavailable)?
    .ok_or(MfaServiceError::NotActive)
}

async fn assert_pending_generation(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    credential_id: Uuid,
    secret_version: u64,
) -> Result<(), MfaServiceError> {
    let matches: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM mfa_totp_credentials
           WHERE id=$1::uuid AND user_id=$2::uuid AND state='pending'
             AND secret_version=$3
         )",
    )
    .bind(credential_id.to_string())
    .bind(user_id.to_string())
    .bind(i64::try_from(secret_version).map_err(|_| MfaServiceError::Unavailable)?)
    .fetch_one(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    if matches {
        Ok(())
    } else {
        Err(MfaServiceError::Conflict)
    }
}

fn parse_credential_id(row: &sqlx::postgres::PgRow) -> Result<Uuid, MfaServiceError> {
    Uuid::parse_str(&row.get::<String, _>("id")).map_err(|_| MfaServiceError::Unavailable)
}

async fn lock_challenge_state(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    credential_id: Uuid,
) -> Result<(), MfaServiceError> {
    sqlx::query(
        "INSERT INTO mfa_challenge_states(credential_id,user_id)
         VALUES($1::uuid,$2::uuid) ON CONFLICT(credential_id) DO NOTHING",
    )
    .bind(credential_id.to_string())
    .bind(user_id.to_string())
    .execute(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    sqlx::query(
        "SELECT credential_id FROM mfa_challenge_states WHERE credential_id=$1::uuid FOR UPDATE",
    )
    .bind(credential_id.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    Ok(())
}

async fn load_challenge_state(
    tx: &mut Transaction<'_, Postgres>,
    credential_id: Uuid,
) -> Result<ChallengeState, MfaServiceError> {
    let row = sqlx::query(
        "SELECT last_accepted_counter,locked_until FROM mfa_challenge_states
         WHERE credential_id=$1::uuid FOR UPDATE",
    )
    .bind(credential_id.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    Ok(ChallengeState {
        last_accepted_counter: row
            .get::<Option<i64>, _>("last_accepted_counter")
            .map(|value| u64::try_from(value).map_err(|_| MfaServiceError::Unavailable))
            .transpose()?,
        locked_until: row.get("locked_until"),
    })
}

async fn challenge_is_locked(
    tx: &mut Transaction<'_, Postgres>,
    credential_id: Uuid,
) -> Result<bool, MfaServiceError> {
    sqlx::query_scalar(
        "SELECT COALESCE(locked_until > transaction_timestamp(),FALSE)
         FROM mfa_challenge_states WHERE credential_id=$1::uuid FOR UPDATE",
    )
    .bind(credential_id.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(database_unavailable)
}

async fn record_challenge_failure(
    tx: &mut Transaction<'_, Postgres>,
    credential_id: Uuid,
    policy: MfaChallengePolicy,
    now: OffsetDateTime,
) -> Result<(), MfaServiceError> {
    let row = sqlx::query(
        "SELECT failure_count,failure_window_started_at,locked_until
         FROM mfa_challenge_states WHERE credential_id=$1::uuid FOR UPDATE",
    )
    .bind(credential_id.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    let count: i16 = row.get("failure_count");
    let started: Option<OffsetDateTime> = row.get("failure_window_started_at");
    let locked: Option<OffsetDateTime> = row.get("locked_until");
    let window_seconds =
        i64::try_from(policy.failure_window.as_secs()).map_err(|_| MfaServiceError::Unavailable)?;
    let lock_seconds =
        i64::try_from(policy.lock_duration.as_secs()).map_err(|_| MfaServiceError::Unavailable)?;
    let expired = started
        .is_none_or(|value| value + ::time::Duration::seconds(window_seconds) <= now)
        || locked.is_some_and(|value| value <= now);
    let next = if expired { 1 } else { count.saturating_add(1) };
    let threshold =
        i16::try_from(policy.failure_threshold).map_err(|_| MfaServiceError::Unavailable)?;
    let next = next.min(threshold);
    let window_start = if expired { now } else { started.unwrap_or(now) };
    let locked_until = (next >= threshold).then_some(now + ::time::Duration::seconds(lock_seconds));
    sqlx::query(
        "UPDATE mfa_challenge_states SET failure_count=$2,failure_window_started_at=$3,
         locked_until=$4,updated_at=transaction_timestamp() WHERE credential_id=$1::uuid",
    )
    .bind(credential_id.to_string())
    .bind(next)
    .bind(window_start)
    .bind(locked_until)
    .execute(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    Ok(())
}

async fn mark_challenge_success(
    tx: &mut Transaction<'_, Postgres>,
    credential_id: Uuid,
    counter: u64,
) -> Result<(), MfaServiceError> {
    let changed = sqlx::query(
        "UPDATE mfa_challenge_states SET last_accepted_counter=$2,failure_count=0,
         failure_window_started_at=NULL,locked_until=NULL,updated_at=transaction_timestamp()
         WHERE credential_id=$1::uuid
           AND (last_accepted_counter IS NULL OR last_accepted_counter < $2)",
    )
    .bind(credential_id.to_string())
    .bind(i64::try_from(counter).map_err(|_| MfaServiceError::Unavailable)?)
    .execute(&mut **tx)
    .await
    .map_err(database_unavailable)?
    .rows_affected();
    if changed == 1 {
        Ok(())
    } else {
        Err(MfaServiceError::ChallengeFailed)
    }
}

async fn assert_challenge_counter_available(
    tx: &mut Transaction<'_, Postgres>,
    credential_id: Uuid,
    counter: u64,
) -> Result<(), MfaServiceError> {
    let state = load_challenge_state(tx, credential_id).await?;
    let now = transaction_time(tx).await?;
    if state.locked_until.is_some_and(|until| until > now)
        || state
            .last_accepted_counter
            .is_some_and(|last| counter <= last)
    {
        return Err(MfaServiceError::ChallengeFailed);
    }
    Ok(())
}

async fn clear_challenge_failures(
    tx: &mut Transaction<'_, Postgres>,
    credential_id: Uuid,
) -> Result<(), MfaServiceError> {
    sqlx::query(
        "UPDATE mfa_challenge_states SET failure_count=0,failure_window_started_at=NULL,
         locked_until=NULL,updated_at=transaction_timestamp() WHERE credential_id=$1::uuid",
    )
    .bind(credential_id.to_string())
    .execute(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    Ok(())
}

fn matching_counter(
    secret: &TotpSecret,
    code: &TotpCode,
    now: OffsetDateTime,
) -> Result<Option<u64>, MfaServiceError> {
    let unix = now.unix_timestamp();
    if unix < TOTP_STEP_SECONDS {
        return Err(MfaServiceError::Unavailable);
    }
    let current = unix / TOTP_STEP_SECONDS;
    let mut matched = None;
    for offset in -TOTP_WINDOW..=TOTP_WINDOW {
        let counter = current
            .checked_add(offset)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(MfaServiceError::Unavailable)?;
        let expected = hotp(secret.expose(), counter)?;
        if bool::from(expected.ct_eq(code.expose())) {
            matched = Some(counter);
        }
    }
    Ok(matched)
}

fn hotp(secret: &[u8], counter: u64) -> Result<[u8; 6], MfaServiceError> {
    let mut mac = <Hmac<Sha1> as KeyInit>::new_from_slice(secret)
        .map_err(|_| MfaServiceError::Unavailable)?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[19] & 0x0f);
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    let value = binary % TOTP_MODULUS;
    let text = format!("{value:06}");
    text.as_bytes()
        .try_into()
        .map_err(|_| MfaServiceError::Unavailable)
}

fn generate_recovery_codes() -> Result<(Vec<RecoveryCode>, Vec<RecoveryCode>), MfaServiceError> {
    let mut returned = Vec::with_capacity(RECOVERY_CODE_COUNT);
    let mut hashing = Vec::with_capacity(RECOVERY_CODE_COUNT);
    for _ in 0..RECOVERY_CODE_COUNT {
        let mut bytes = Zeroizing::new([0_u8; RECOVERY_CODE_BYTES]);
        getrandom::fill(bytes.as_mut()).map_err(|_| MfaServiceError::Unavailable)?;
        let mut encoded = Zeroizing::new([0_u8; RECOVERY_CODE_ENCODED_BYTES]);
        let length = base64::Engine::encode_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            bytes.as_slice(),
            encoded.as_mut_slice(),
        )
        .map_err(|_| MfaServiceError::Unavailable)?;
        let code = RecoveryCode::new(encoded[..length].to_vec()).map_err(map_storage_error)?;
        hashing.push(RecoveryCode::new(code.expose().to_vec()).map_err(map_storage_error)?);
        returned.push(code);
    }
    Ok((returned, hashing))
}

async fn require_recent_reauthentication(
    tx: &mut Transaction<'_, Postgres>,
    session: &Session,
) -> Result<(), MfaServiceError> {
    let fields = session.clone().into_fields();
    let row = sqlx::query(
        "SELECT transaction_timestamp() AS now,
          (SELECT value::text FROM instance_settings
           WHERE key='security.reauthentication_window_minutes') AS policy",
    )
    .fetch_one(&mut **tx)
    .await
    .map_err(database_unavailable)?;
    let now: OffsetDateTime = row.get("now");
    let policy: String = row.get("policy");
    let minutes = serde_json::from_str::<serde_json::Value>(&policy)
        .ok()
        .and_then(|value| value.as_i64())
        .filter(|value| (15..=120).contains(value))
        .ok_or(MfaServiceError::Unavailable)?;
    if !fields.last_reauthenticated_at.is_some_and(|last| {
        let last = last.into_datetime();
        last <= now && last >= now - ::time::Duration::minutes(minutes)
    }) {
        return Err(MfaServiceError::ReauthenticationRequired);
    }
    Ok(())
}

async fn transaction_time(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<OffsetDateTime, MfaServiceError> {
    sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **tx)
        .await
        .map_err(database_unavailable)
}

async fn revoke_other_sessions(
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

async fn revoke_all_sessions(
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

async fn lock_admin_and_target(
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

async fn append_attempt_audit(
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

fn database_unavailable<E>(_: E) -> MfaServiceError {
    MfaServiceError::Unavailable
}

fn map_storage_error(error: MfaStorageError) -> MfaServiceError {
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

fn map_session_error(error: SessionServiceError) -> MfaServiceError {
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

#[cfg(test)]
mod tests;
