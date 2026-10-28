#![allow(unused_imports)]
use super::challenge::*;
use super::secrets::*;
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

impl super::MfaService {
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
    pub(crate) async fn begin_enrollment_once(
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
    pub(crate) async fn confirm_enrollment_once(
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
    pub(crate) async fn verify_totp_once(
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
    pub(crate) async fn recover_once(
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
}
