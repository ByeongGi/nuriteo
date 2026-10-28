#![allow(unused_imports)]
use super::enrollment::*;
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
    pub(crate) async fn load_receipt<T: DeserializeOwned>(
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
    pub(crate) async fn store_receipt<T: Serialize>(
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
    pub(crate) async fn authenticate(
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
    pub(crate) async fn verify_locked_challenge(
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
    pub(crate) async fn load_recovery_candidates(
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
    pub(crate) async fn bounded<T>(
        &self,
        operation: impl Future<Output = Result<T, MfaServiceError>>,
    ) -> Result<T, MfaServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| MfaServiceError::Unavailable)?
    }
}

impl EnrollmentStartReceipt {
    pub(crate) fn into_result(self) -> Result<EnrollmentStart, MfaServiceError> {
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
    pub(crate) fn from_result(issued: &IssuedSession) -> Self {
        Self {
            token: SecretToken::new(issued.token().expose().to_owned()),
            session: issued.session().clone().into_fields(),
        }
    }

    pub(crate) fn into_result(self) -> Result<IssuedSession, MfaServiceError> {
        let token = SessionToken::parse(self.token.0.to_string()).map_err(map_session_error)?;
        let session = Session::new(self.session).map_err(|_| MfaServiceError::Unavailable)?;
        Ok(IssuedSession::from_parts(token, session))
    }
}

impl EnrollmentCompleteReceipt {
    pub(crate) fn from_result(issued: &IssuedSession, recovery_codes: &[RecoveryCode]) -> Self {
        Self {
            issued: SessionReceipt::from_result(issued),
            recovery_codes: recovery_codes
                .iter()
                .map(|code| SecretBytes::new(code.expose().to_vec()))
                .collect(),
        }
    }

    pub(crate) fn into_result(self) -> Result<EnrollmentComplete, MfaServiceError> {
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

pub(crate) fn receipt_binding_authority(
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

pub(crate) fn receipt_context<'a>(
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

impl MfaPasswordExecutor {
    pub(crate) fn new(concurrency: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(concurrency)),
        }
    }

    pub(crate) fn try_admit(&self) -> Result<MfaPasswordAdmission, MfaServiceError> {
        self.permits
            .clone()
            .try_acquire_owned()
            .map(MfaPasswordAdmission)
            .map_err(|_| MfaServiceError::Unavailable)
    }

    pub(crate) async fn hash_recovery_codes(
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
    pub(crate) async fn saturate_for_test(&self) -> OwnedSemaphorePermit {
        self.permits
            .clone()
            .acquire_many_owned(u32::try_from(ARGON2_CONCURRENCY).unwrap())
            .await
            .unwrap()
    }

    pub(crate) async fn verify_recovery_code(
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

pub(crate) async fn load_credential(
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

pub(crate) async fn load_active_credential(
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

pub(crate) async fn assert_pending_generation(
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

pub(crate) fn parse_credential_id(row: &sqlx::postgres::PgRow) -> Result<Uuid, MfaServiceError> {
    Uuid::parse_str(&row.get::<String, _>("id")).map_err(|_| MfaServiceError::Unavailable)
}

pub(crate) async fn lock_challenge_state(
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

pub(crate) async fn load_challenge_state(
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

pub(crate) async fn challenge_is_locked(
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

pub(crate) async fn record_challenge_failure(
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

pub(crate) async fn mark_challenge_success(
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

pub(crate) async fn assert_challenge_counter_available(
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

pub(crate) async fn clear_challenge_failures(
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

pub(crate) fn matching_counter(
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

pub(crate) fn hotp(secret: &[u8], counter: u64) -> Result<[u8; 6], MfaServiceError> {
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

pub(crate) fn generate_recovery_codes()
-> Result<(Vec<RecoveryCode>, Vec<RecoveryCode>), MfaServiceError> {
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

pub(crate) async fn require_recent_reauthentication(
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

pub(crate) async fn transaction_time(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<OffsetDateTime, MfaServiceError> {
    sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **tx)
        .await
        .map_err(database_unavailable)
}
