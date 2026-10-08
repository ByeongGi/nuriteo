use std::fmt;
use std::future::Future;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Postgres, Row, Transaction};
use time::OffsetDateTime;
use tokio::time as tokio_time;

use crate::database::DatabasePool;
use crate::policy::EffectivePolicyEngine;

use super::{Session, SessionFields, SessionId, Timestamp, UserId};

const TOKEN_PREFIX: &str = "nrt_sess_";
const TOKEN_BYTES: usize = 32;
const TOKEN_ENCODED_BYTES: usize = 43;
const TOKEN_WIRE_BYTES: usize = TOKEN_PREFIX.len() + TOKEN_ENCODED_BYTES;
const TOKEN_DIGEST_BYTES: usize = 32;

const DEFAULT_IDLE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const DEFAULT_ABSOLUTE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MIN_IDLE: Duration = Duration::from_secs(15 * 60);
const MAX_IDLE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MIN_ABSOLUTE: Duration = Duration::from_secs(60 * 60);
const MAX_ABSOLUTE: Duration = Duration::from_secs(90 * 24 * 60 * 60);
const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ACTIVE_SESSIONS_PER_USER: i64 = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionPolicy {
    idle_timeout: Duration,
    absolute_timeout: Duration,
    operation_timeout: Duration,
}

impl SessionPolicy {
    pub fn new(
        idle_timeout: Duration,
        absolute_timeout: Duration,
        operation_timeout: Duration,
    ) -> Result<Self, SessionPolicyError> {
        if !(MIN_IDLE..=MAX_IDLE).contains(&idle_timeout) {
            return Err(SessionPolicyError::InvalidIdleTimeout);
        }
        if !(MIN_ABSOLUTE..=MAX_ABSOLUTE).contains(&absolute_timeout)
            || absolute_timeout <= idle_timeout
        {
            return Err(SessionPolicyError::InvalidAbsoluteTimeout);
        }
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(SessionPolicyError::InvalidOperationTimeout);
        }
        Ok(Self {
            idle_timeout,
            absolute_timeout,
            operation_timeout,
        })
    }

    #[must_use]
    pub const fn idle_timeout(self) -> Duration {
        self.idle_timeout
    }

    #[must_use]
    pub const fn absolute_timeout(self) -> Duration {
        self.absolute_timeout
    }

    #[must_use]
    pub const fn operation_timeout(self) -> Duration {
        self.operation_timeout
    }
}

impl Default for SessionPolicy {
    fn default() -> Self {
        Self {
            idle_timeout: DEFAULT_IDLE,
            absolute_timeout: DEFAULT_ABSOLUTE,
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPolicyError {
    InvalidIdleTimeout,
    InvalidAbsoluteTimeout,
    InvalidOperationTimeout,
}

impl fmt::Display for SessionPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdleTimeout => "session idle timeout is invalid",
            Self::InvalidAbsoluteTimeout => "session absolute timeout is invalid",
            Self::InvalidOperationTimeout => "session operation timeout is invalid",
        })
    }
}

impl std::error::Error for SessionPolicyError {}

/// One opaque bearer credential. Formatting never reveals its wire value.
#[derive(PartialEq, Eq)]
pub struct SessionToken(String);

impl SessionToken {
    pub fn parse(value: String) -> Result<Self, SessionServiceError> {
        validate_wire_token(&value)?;
        Ok(Self(value))
    }

    fn generate() -> Result<Self, SessionServiceError> {
        let mut bytes = [0_u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|_| SessionServiceError::EntropyUnavailable)?;
        let value = format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes));
        Self::parse(value)
    }

    fn digest(&self) -> [u8; TOKEN_DIGEST_BYTES] {
        Sha256::digest(self.0.as_bytes()).into()
    }

    #[must_use]
    pub(crate) fn binding_digest(&self) -> [u8; TOKEN_DIGEST_BYTES] {
        self.digest()
    }

    /// Exposes the credential only to the in-crate HTTP cookie adapter.
    #[allow(
        dead_code,
        reason = "ID-006 consumes this narrow in-crate cookie adapter boundary"
    )]
    #[must_use]
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SessionToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionToken([REDACTED])")
    }
}

impl fmt::Display for SessionToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

pub struct IssuedSession {
    token: SessionToken,
    session: Session,
}

impl IssuedSession {
    pub(crate) const fn from_parts(token: SessionToken, session: Session) -> Self {
        Self { token, session }
    }
    #[must_use]
    pub const fn token(&self) -> &SessionToken {
        &self.token
    }

    #[must_use]
    pub const fn session(&self) -> &Session {
        &self.session
    }

    #[must_use]
    pub fn into_parts(self) -> (SessionToken, Session) {
        (self.token, self.session)
    }
}

impl fmt::Debug for IssuedSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedSession")
            .field("token", &"[REDACTED]")
            .field("session", &self.session)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRotationKind {
    Login,
    Reauthentication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRevokeResult {
    Revoked,
    AlreadyInactive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionAuditIdentity {
    pub(crate) session_id: SessionId,
    pub(crate) user_id: UserId,
    pub(crate) display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TransactionRevocation {
    pub(crate) result: SessionRevokeResult,
    pub(crate) identity: Option<SessionAuditIdentity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionServiceError {
    InvalidToken,
    UserUnavailable,
    SessionLimitReached,
    EntropyUnavailable,
    DatabaseUnavailable,
    OperationTimeout,
    InvariantViolation,
}

impl fmt::Display for SessionServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidToken => "session credential is invalid",
            Self::UserUnavailable => "session user is unavailable",
            Self::SessionLimitReached => "active session limit was reached",
            Self::EntropyUnavailable => "session credential generation failed",
            Self::DatabaseUnavailable => "session persistence is unavailable",
            Self::OperationTimeout => "session operation timed out",
            Self::InvariantViolation => "session state is invalid",
        })
    }
}

impl std::error::Error for SessionServiceError {}

#[derive(Clone)]
pub struct SessionService {
    pool: DatabasePool,
    policy: SessionPolicy,
}

impl SessionService {
    #[must_use]
    pub const fn new(pool: DatabasePool, policy: SessionPolicy) -> Self {
        Self { pool, policy }
    }

    #[must_use]
    pub const fn policy(&self) -> SessionPolicy {
        self.policy
    }

    pub async fn issue(&self, user_id: UserId) -> Result<IssuedSession, SessionServiceError> {
        let token = SessionToken::generate()?;
        let session_id = SessionId::new();
        self.within_deadline(self.issue_inner(user_id, session_id, token))
            .await
    }

    pub async fn authenticate(&self, token: &SessionToken) -> Result<Session, SessionServiceError> {
        let digest = token.digest();
        self.within_deadline(self.authenticate_inner(&digest)).await
    }

    /// Locks and validates an authenticated principal in a caller-owned
    /// transaction. Security-sensitive services use this instead of carrying a
    /// stale `Session` snapshot across their mutation transaction.
    pub(crate) async fn authenticate_in_transaction(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        token: &SessionToken,
    ) -> Result<Session, SessionServiceError> {
        let (row, now) = load_active_session(transaction, &token.digest()).await?;
        let policy = self.effective_policy(transaction).await?;
        ensure_within_effective_policy(&row, now, policy)?;
        session_from_row(&row)
    }

    pub async fn rotate(
        &self,
        token: &SessionToken,
        kind: SessionRotationKind,
    ) -> Result<IssuedSession, SessionServiceError> {
        let old_digest = token.digest();
        let replacement_token = SessionToken::generate()?;
        let replacement_id = SessionId::new();
        self.within_deadline(self.rotate_inner(
            &old_digest,
            replacement_id,
            replacement_token,
            kind,
        ))
        .await
    }

    /// Rotates one authenticated Session in a caller-owned transaction.
    /// The caller owns the deadline and commits this alongside the privilege
    /// change that required rotation.
    pub(crate) async fn rotate_in_transaction(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        token: &SessionToken,
        kind: SessionRotationKind,
    ) -> Result<IssuedSession, SessionServiceError> {
        self.rotate_in_transaction_with_values(
            transaction,
            &token.digest(),
            SessionId::new(),
            SessionToken::generate()?,
            kind,
        )
        .await
    }

    pub async fn revoke(
        &self,
        token: &SessionToken,
    ) -> Result<SessionRevokeResult, SessionServiceError> {
        let digest = token.digest();
        self.within_deadline(self.revoke_inner(&digest)).await
    }

    pub async fn revoke_all_for_user(&self, user_id: UserId) -> Result<u64, SessionServiceError> {
        self.within_deadline(self.revoke_all_inner(user_id)).await
    }

    async fn within_deadline<T>(
        &self,
        operation: impl Future<Output = Result<T, SessionServiceError>>,
    ) -> Result<T, SessionServiceError> {
        tokio_time::timeout(self.policy.operation_timeout, operation)
            .await
            .map_err(|_| SessionServiceError::OperationTimeout)?
    }

    async fn issue_inner(
        &self,
        user_id: UserId,
        session_id: SessionId,
        token: SessionToken,
    ) -> Result<IssuedSession, SessionServiceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let issued = self
            .issue_in_transaction_with_values(&mut transaction, user_id, session_id, token, false)
            .await?;
        transaction
            .commit()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        Ok(issued)
    }

    /// Inserts a new Session in a caller-owned transaction.
    ///
    /// Authentication flows use this narrow adapter to commit a freshly
    /// verified Session and their audit event atomically. A successful fresh
    /// login is also the initial recent-reauthentication proof for the new
    /// Session. The caller owns the operation deadline and must commit or roll
    /// back the transaction.
    pub(crate) async fn issue_in_transaction(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        user_id: UserId,
    ) -> Result<IssuedSession, SessionServiceError> {
        self.issue_in_transaction_with_values(
            transaction,
            user_id,
            SessionId::new(),
            SessionToken::generate()?,
            true,
        )
        .await
    }

    async fn issue_in_transaction_with_values(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        user_id: UserId,
        session_id: SessionId,
        token: SessionToken,
        recently_reauthenticated: bool,
    ) -> Result<IssuedSession, SessionServiceError> {
        let policy = self.effective_policy(transaction).await?;
        lock_active_user(transaction, user_id).await?;
        enforce_session_limit(transaction, user_id).await?;

        let row = sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, token_hash, idle_expires_at, absolute_expires_at, \
              last_reauthenticated_at) \
             VALUES ($1::uuid, $2::uuid, $3, \
                     transaction_timestamp() + make_interval(secs => $4), \
                     transaction_timestamp() + make_interval(secs => $5), \
                     CASE WHEN $6 THEN transaction_timestamp() END) \
             RETURNING id::text, user_id::text, created_at, last_seen_at, \
                       idle_expires_at, absolute_expires_at, last_reauthenticated_at, \
                       rotated_at, revoked_at, revocation_reason, \
                       replaced_by_session_id::text",
        )
        .bind(session_id.to_string())
        .bind(user_id.to_string())
        .bind(token.digest().as_slice())
        .bind(duration_seconds(policy.idle_timeout)?)
        .bind(duration_seconds(policy.absolute_timeout)?)
        .bind(recently_reauthenticated)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let session = session_from_row(&row)?;
        Ok(IssuedSession { token, session })
    }

    async fn authenticate_inner(
        &self,
        digest: &[u8; TOKEN_DIGEST_BYTES],
    ) -> Result<Session, SessionServiceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let (row, now) = load_active_session(&mut transaction, digest).await?;
        let policy = self.effective_policy(&mut transaction).await?;
        let absolute_expires_at = effective_absolute_expiry(&row, policy)?;
        let idle_timeout = effective_idle_timeout(&row, policy)?;
        ensure_within_effective_policy(&row, now, policy)?;
        let next_idle = std::cmp::min(now + idle_timeout, absolute_expires_at);
        let updated = sqlx::query(
            "UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3, absolute_expires_at = $4 \
             WHERE id = $1::uuid \
             RETURNING id::text, user_id::text, created_at, last_seen_at, \
                       idle_expires_at, absolute_expires_at, last_reauthenticated_at, \
                       rotated_at, revoked_at, revocation_reason, \
                       replaced_by_session_id::text",
        )
        .bind(
            row.try_get::<String, _>("id")
                .map_err(|_| SessionServiceError::InvariantViolation)?,
        )
        .bind(now)
        .bind(next_idle)
        .bind(absolute_expires_at)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let session = session_from_row(&updated)?;
        transaction
            .commit()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        Ok(session)
    }

    async fn rotate_inner(
        &self,
        old_digest: &[u8; TOKEN_DIGEST_BYTES],
        replacement_id: SessionId,
        replacement_token: SessionToken,
        kind: SessionRotationKind,
    ) -> Result<IssuedSession, SessionServiceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let issued = self
            .rotate_in_transaction_with_values(
                &mut transaction,
                old_digest,
                replacement_id,
                replacement_token,
                kind,
            )
            .await?;
        transaction
            .commit()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        Ok(issued)
    }

    async fn rotate_in_transaction_with_values(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        old_digest: &[u8; TOKEN_DIGEST_BYTES],
        replacement_id: SessionId,
        replacement_token: SessionToken,
        kind: SessionRotationKind,
    ) -> Result<IssuedSession, SessionServiceError> {
        let (old, now) = load_active_session(transaction, old_digest).await?;
        let policy = self.effective_policy(transaction).await?;
        ensure_within_effective_policy(&old, now, policy)?;
        let old_id: String = old
            .try_get("id")
            .map_err(|_| SessionServiceError::InvariantViolation)?;
        let user_id: String = old
            .try_get("user_id")
            .map_err(|_| SessionServiceError::InvariantViolation)?;
        let reauthenticated_at = match kind {
            SessionRotationKind::Login => None,
            SessionRotationKind::Reauthentication => Some(now),
        };
        let replacement = sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, token_hash, created_at, last_seen_at, idle_expires_at, \
              absolute_expires_at, last_reauthenticated_at) \
             VALUES ($1::uuid, $2::uuid, $3, $4, $4, \
                     $4 + make_interval(secs => $5), \
                     $4 + make_interval(secs => $6), $7) \
             RETURNING id::text, user_id::text, created_at, last_seen_at, \
                       idle_expires_at, absolute_expires_at, last_reauthenticated_at, \
                       rotated_at, revoked_at, revocation_reason, \
                       replaced_by_session_id::text",
        )
        .bind(replacement_id.to_string())
        .bind(&user_id)
        .bind(replacement_token.digest().as_slice())
        .bind(now)
        .bind(duration_seconds(policy.idle_timeout)?)
        .bind(duration_seconds(policy.absolute_timeout)?)
        .bind(reauthenticated_at)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let changed = sqlx::query(
            "UPDATE sessions SET rotated_at = $2, revoked_at = $2, \
                     revocation_reason = 'rotated', replaced_by_session_id = $3::uuid \
             WHERE id = $1::uuid AND revoked_at IS NULL AND rotated_at IS NULL",
        )
        .bind(old_id)
        .bind(now)
        .bind(replacement_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        if changed.rows_affected() != 1 {
            return Err(SessionServiceError::InvalidToken);
        }
        let session = session_from_row(&replacement)?;
        Ok(IssuedSession {
            token: replacement_token,
            session,
        })
    }

    async fn effective_policy(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
    ) -> Result<SessionPolicy, SessionServiceError> {
        EffectivePolicyEngine::load_optional_in_transaction(transaction)
            .await
            .and_then(|snapshot| {
                snapshot.map_or(Ok(self.policy), |snapshot| {
                    snapshot.session_policy(self.policy.operation_timeout)
                })
            })
            .map_err(|_| SessionServiceError::InvariantViolation)
    }

    async fn revoke_inner(
        &self,
        digest: &[u8; TOKEN_DIGEST_BYTES],
    ) -> Result<SessionRevokeResult, SessionServiceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let revocation = self
            .revoke_in_transaction_by_digest(&mut transaction, digest)
            .await?;
        transaction
            .commit()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        Ok(revocation.result)
    }

    /// Revokes one Session in a caller-owned transaction and returns safe
    /// identity metadata for an audit event. Unknown tokens remain
    /// indistinguishable from already inactive Sessions.
    pub(crate) async fn revoke_in_transaction(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        token: &SessionToken,
    ) -> Result<TransactionRevocation, SessionServiceError> {
        self.revoke_in_transaction_by_digest(transaction, &token.digest())
            .await
    }

    async fn revoke_in_transaction_by_digest(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        digest: &[u8; TOKEN_DIGEST_BYTES],
    ) -> Result<TransactionRevocation, SessionServiceError> {
        let row = sqlx::query(
            "SELECT s.id::text AS session_id, s.user_id::text AS user_id, \
                    u.display_name, s.revoked_at \
             FROM sessions s JOIN users u ON u.id = s.user_id \
             WHERE s.token_hash = $1 FOR UPDATE OF s",
        )
        .bind(digest.as_slice())
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let Some(row) = row else {
            return Ok(TransactionRevocation {
                result: SessionRevokeResult::AlreadyInactive,
                identity: None,
            });
        };
        let session_id: SessionId = parse_id(&row, "session_id")?;
        let user_id: UserId = parse_id(&row, "user_id")?;
        let display_name = row
            .try_get("display_name")
            .map_err(|_| SessionServiceError::InvariantViolation)?;
        let revoked_at: Option<OffsetDateTime> = row
            .try_get("revoked_at")
            .map_err(|_| SessionServiceError::InvariantViolation)?;
        let result = if revoked_at.is_some() {
            SessionRevokeResult::AlreadyInactive
        } else {
            let changed = sqlx::query(
                "UPDATE sessions SET revoked_at = transaction_timestamp(), \
                         revocation_reason = 'user_revoked' \
                 WHERE id = $1::uuid AND revoked_at IS NULL",
            )
            .bind(session_id.to_string())
            .execute(&mut **transaction)
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
            if changed.rows_affected() != 1 {
                return Err(SessionServiceError::InvariantViolation);
            }
            SessionRevokeResult::Revoked
        };
        Ok(TransactionRevocation {
            result,
            identity: Some(SessionAuditIdentity {
                session_id,
                user_id,
                display_name,
            }),
        })
    }

    async fn revoke_all_inner(&self, user_id: UserId) -> Result<u64, SessionServiceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE)")
                .bind(user_id.to_string())
                .fetch_one(&mut *transaction)
                .await
                .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        if !exists {
            return Err(SessionServiceError::UserUnavailable);
        }
        let result = sqlx::query(
            "UPDATE sessions SET revoked_at = transaction_timestamp(), \
                     revocation_reason = 'user_revoke_all' \
             WHERE user_id = $1::uuid AND revoked_at IS NULL \
               AND idle_expires_at > transaction_timestamp() \
               AND absolute_expires_at > transaction_timestamp()",
        )
        .bind(user_id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        transaction
            .commit()
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
        Ok(result.rows_affected())
    }
}

async fn lock_active_user(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(), SessionServiceError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM users WHERE id = $1::uuid FOR UPDATE")
            .bind(user_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
    if status.as_deref() != Some("active") {
        return Err(SessionServiceError::UserUnavailable);
    }
    Ok(())
}

async fn enforce_session_limit(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(), SessionServiceError> {
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sessions \
         WHERE user_id = $1::uuid AND revoked_at IS NULL \
           AND idle_expires_at > transaction_timestamp() \
           AND absolute_expires_at > transaction_timestamp()",
    )
    .bind(user_id.to_string())
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| SessionServiceError::DatabaseUnavailable)?;
    if active >= MAX_ACTIVE_SESSIONS_PER_USER {
        return Err(SessionServiceError::SessionLimitReached);
    }
    Ok(())
}

async fn load_active_session(
    transaction: &mut Transaction<'_, Postgres>,
    digest: &[u8; TOKEN_DIGEST_BYTES],
) -> Result<(sqlx::postgres::PgRow, OffsetDateTime), SessionServiceError> {
    let row = sqlx::query(
        "SELECT s.id::text AS id, s.user_id::text AS user_id, s.created_at, \
                s.last_seen_at, s.idle_expires_at, s.absolute_expires_at, \
                s.last_reauthenticated_at, s.rotated_at, s.revoked_at, \
                s.revocation_reason, s.replaced_by_session_id::text, u.status, \
                transaction_timestamp() AS transaction_time \
         FROM sessions s JOIN users u ON u.id = s.user_id \
         WHERE s.token_hash = $1 FOR UPDATE OF s",
    )
    .bind(digest.as_slice())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| SessionServiceError::DatabaseUnavailable)?
    .ok_or(SessionServiceError::InvalidToken)?;
    let now: OffsetDateTime = row
        .try_get("transaction_time")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let created_at: OffsetDateTime = row
        .try_get("created_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let idle_expires_at: OffsetDateTime = row
        .try_get("idle_expires_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let absolute_expires_at: OffsetDateTime = row
        .try_get("absolute_expires_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let status: String = row
        .try_get("status")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let revoked_at: Option<OffsetDateTime> = row
        .try_get("revoked_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let rotated_at: Option<OffsetDateTime> = row
        .try_get("rotated_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    if status != "active"
        || now < created_at
        || now >= idle_expires_at
        || now >= absolute_expires_at
        || revoked_at.is_some()
        || rotated_at.is_some()
    {
        return Err(SessionServiceError::InvalidToken);
    }
    Ok((row, now))
}

fn session_from_row(row: &sqlx::postgres::PgRow) -> Result<Session, SessionServiceError> {
    let fields = SessionFields {
        id: parse_id(row, "id")?,
        user_id: parse_id(row, "user_id")?,
        created_at: parse_timestamp(row, "created_at")?,
        last_seen_at: parse_timestamp(row, "last_seen_at")?,
        idle_expires_at: parse_timestamp(row, "idle_expires_at")?,
        absolute_expires_at: parse_timestamp(row, "absolute_expires_at")?,
        last_reauthenticated_at: parse_optional_timestamp(row, "last_reauthenticated_at")?,
        rotated_at: parse_optional_timestamp(row, "rotated_at")?,
        revoked_at: parse_optional_timestamp(row, "revoked_at")?,
        revocation_reason: row
            .try_get("revocation_reason")
            .map_err(|_| SessionServiceError::InvariantViolation)?,
        replaced_by_session_id: parse_optional_id(row, "replaced_by_session_id")?,
    };
    Session::new(fields).map_err(|_| SessionServiceError::InvariantViolation)
}

fn parse_id<T>(row: &sqlx::postgres::PgRow, column: &str) -> Result<T, SessionServiceError>
where
    T: std::str::FromStr,
{
    row.try_get::<String, _>(column)
        .map_err(|_| SessionServiceError::InvariantViolation)?
        .parse()
        .map_err(|_| SessionServiceError::InvariantViolation)
}

fn parse_optional_id<T>(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<T>, SessionServiceError>
where
    T: std::str::FromStr,
{
    row.try_get::<Option<String>, _>(column)
        .map_err(|_| SessionServiceError::InvariantViolation)?
        .map(|value| {
            value
                .parse()
                .map_err(|_| SessionServiceError::InvariantViolation)
        })
        .transpose()
}

fn parse_timestamp(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Timestamp, SessionServiceError> {
    let value: OffsetDateTime = row
        .try_get(column)
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    Timestamp::from_datetime(value).map_err(|_| SessionServiceError::InvariantViolation)
}

fn parse_optional_timestamp(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<Timestamp>, SessionServiceError> {
    row.try_get::<Option<OffsetDateTime>, _>(column)
        .map_err(|_| SessionServiceError::InvariantViolation)?
        .map(Timestamp::from_datetime)
        .transpose()
        .map_err(|_| SessionServiceError::InvariantViolation)
}

fn validate_wire_token(value: &str) -> Result<(), SessionServiceError> {
    if value.len() != TOKEN_WIRE_BYTES || !value.starts_with(TOKEN_PREFIX) {
        return Err(SessionServiceError::InvalidToken);
    }
    let encoded = &value[TOKEN_PREFIX.len()..];
    if encoded.len() != TOKEN_ENCODED_BYTES
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(SessionServiceError::InvalidToken);
    }
    let mut decoded = [0_u8; TOKEN_BYTES];
    let written = URL_SAFE_NO_PAD
        .decode_slice(encoded, &mut decoded)
        .map_err(|_| SessionServiceError::InvalidToken)?;
    if written != TOKEN_BYTES {
        return Err(SessionServiceError::InvalidToken);
    }
    Ok(())
}

fn duration_seconds(value: Duration) -> Result<i64, SessionServiceError> {
    i64::try_from(value.as_secs()).map_err(|_| SessionServiceError::InvariantViolation)
}

fn time_duration(value: Duration) -> Result<time::Duration, SessionServiceError> {
    Ok(time::Duration::seconds(duration_seconds(value)?))
}

fn effective_absolute_expiry(
    row: &sqlx::postgres::PgRow,
    policy: SessionPolicy,
) -> Result<OffsetDateTime, SessionServiceError> {
    let created_at: OffsetDateTime = row
        .try_get("created_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let stored: OffsetDateTime = row
        .try_get("absolute_expires_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    Ok(std::cmp::min(
        stored,
        created_at + time_duration(policy.absolute_timeout)?,
    ))
}

fn effective_idle_timeout(
    row: &sqlx::postgres::PgRow,
    policy: SessionPolicy,
) -> Result<time::Duration, SessionServiceError> {
    let last_seen_at: OffsetDateTime = row
        .try_get("last_seen_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let stored_expiry: OffsetDateTime = row
        .try_get("idle_expires_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let stored = stored_expiry - last_seen_at;
    if stored <= time::Duration::ZERO {
        return Err(SessionServiceError::InvalidToken);
    }
    Ok(std::cmp::min(stored, time_duration(policy.idle_timeout)?))
}

fn ensure_within_effective_policy(
    row: &sqlx::postgres::PgRow,
    now: OffsetDateTime,
    policy: SessionPolicy,
) -> Result<(), SessionServiceError> {
    let last_seen_at: OffsetDateTime = row
        .try_get("last_seen_at")
        .map_err(|_| SessionServiceError::InvariantViolation)?;
    let idle_expires_at = last_seen_at + effective_idle_timeout(row, policy)?;
    if now >= idle_expires_at || now >= effective_absolute_expiry(row, policy)? {
        return Err(SessionServiceError::InvalidToken);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
