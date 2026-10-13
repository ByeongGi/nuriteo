use std::fmt;
use std::time::Duration;

use sqlx::{Postgres, Row, Transaction};

use crate::identity::UserId;

const DEFAULT_THRESHOLD: u16 = 5;
const DEFAULT_WINDOW: Duration = Duration::from_secs(15 * 60);
const DEFAULT_LOCK_DURATION: Duration = Duration::from_secs(15 * 60);
const MIN_THRESHOLD: u16 = 3;
const MAX_THRESHOLD: u16 = 20;
const MIN_DURATION: Duration = Duration::from_secs(60);
const MAX_DURATION: Duration = Duration::from_secs(24 * 60 * 60);

/// Validated policy for failed local-password authentication.
///
/// Alpha uses [`Self::default`]. The constructor is the shared validation
/// boundary for a future administrator-controlled instance setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginLockoutPolicy {
    threshold: u16,
    window: Duration,
    lock_duration: Duration,
}

impl LoginLockoutPolicy {
    pub fn new(
        threshold: u16,
        window: Duration,
        lock_duration: Duration,
    ) -> Result<Self, LoginLockoutPolicyError> {
        if !(MIN_THRESHOLD..=MAX_THRESHOLD).contains(&threshold) {
            return Err(LoginLockoutPolicyError::InvalidThreshold);
        }
        if !(MIN_DURATION..=MAX_DURATION).contains(&window) {
            return Err(LoginLockoutPolicyError::InvalidWindow);
        }
        if !(MIN_DURATION..=MAX_DURATION).contains(&lock_duration) {
            return Err(LoginLockoutPolicyError::InvalidLockDuration);
        }
        Ok(Self {
            threshold,
            window,
            lock_duration,
        })
    }

    fn threshold_i16(self) -> i16 {
        // The constructor caps this value at 20.
        self.threshold as i16
    }

    fn window_seconds(self) -> i64 {
        // The constructor caps this duration at 24 hours.
        self.window.as_secs() as i64
    }

    fn lock_seconds(self) -> i64 {
        // The constructor caps this duration at 24 hours.
        self.lock_duration.as_secs() as i64
    }
}

impl Default for LoginLockoutPolicy {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_THRESHOLD,
            window: DEFAULT_WINDOW,
            lock_duration: DEFAULT_LOCK_DURATION,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginLockoutPolicyError {
    InvalidThreshold,
    InvalidWindow,
    InvalidLockDuration,
}

impl fmt::Display for LoginLockoutPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidThreshold => "login lockout threshold is invalid",
            Self::InvalidWindow => "login failure window is invalid",
            Self::InvalidLockDuration => "login lock duration is invalid",
        })
    }
}

impl std::error::Error for LoginLockoutPolicyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailureAccounting {
    NotTracked,
    Recorded,
    LockStarted,
    AlreadyLocked,
}

pub(crate) async fn record_failure(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    policy: LoginLockoutPolicy,
) -> Result<FailureAccounting, sqlx::Error> {
    if !lock_eligible_user_for_update(transaction, user_id).await? {
        return Ok(FailureAccounting::NotTracked);
    }

    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO local_auth_failures \
         (user_id, failure_count, window_started_at, last_failed_at, updated_at) \
         VALUES ($1::uuid, 1, transaction_timestamp(), transaction_timestamp(), \
                 transaction_timestamp()) \
         ON CONFLICT (user_id) DO NOTHING \
         RETURNING user_id::text",
    )
    .bind(user_id.to_string())
    .fetch_optional(&mut **transaction)
    .await?;
    if inserted.is_some() {
        return Ok(FailureAccounting::Recorded);
    }

    let row = sqlx::query(
        "SELECT f.failure_count, f.locked_until, \
                f.locked_until IS NOT NULL \
                    AND f.locked_until > transaction_timestamp() AS actively_locked, \
                f.window_started_at \
                    + make_interval(secs => $2::double precision) \
                    <= transaction_timestamp() AS window_expired \
         FROM local_auth_failures f \
         WHERE f.user_id = $1::uuid \
         FOR UPDATE OF f",
    )
    .bind(user_id.to_string())
    .bind(policy.window_seconds())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = row else {
        return Ok(FailureAccounting::NotTracked);
    };

    let actively_locked: bool = row.try_get("actively_locked")?;
    if actively_locked {
        sqlx::query(
            "UPDATE local_auth_failures \
             SET last_failed_at = GREATEST(last_failed_at, transaction_timestamp()), \
                 updated_at = GREATEST(last_failed_at, transaction_timestamp()) \
             WHERE user_id = $1::uuid",
        )
        .bind(user_id.to_string())
        .execute(&mut **transaction)
        .await?;
        return Ok(FailureAccounting::AlreadyLocked);
    }

    let locked_until: Option<time::OffsetDateTime> = row.try_get("locked_until")?;
    let window_expired: bool = row.try_get("window_expired")?;
    if locked_until.is_some() || window_expired {
        sqlx::query(
            "UPDATE local_auth_failures \
             SET failure_count = 1, \
                 window_started_at = GREATEST(last_failed_at, transaction_timestamp()), \
                 last_failed_at = GREATEST(last_failed_at, transaction_timestamp()), \
                 locked_at = NULL, \
                 locked_until = NULL, \
                 updated_at = GREATEST(last_failed_at, transaction_timestamp()) \
             WHERE user_id = $1::uuid",
        )
        .bind(user_id.to_string())
        .execute(&mut **transaction)
        .await?;
        return Ok(FailureAccounting::Recorded);
    }

    let failure_count: i16 = row.try_get("failure_count")?;
    let next_count = failure_count + 1;
    if next_count >= policy.threshold_i16() {
        sqlx::query(
            "UPDATE local_auth_failures \
             SET failure_count = $2, \
                 last_failed_at = GREATEST(last_failed_at, transaction_timestamp()), \
                 locked_at = GREATEST(last_failed_at, transaction_timestamp()), \
                 locked_until = GREATEST(last_failed_at, transaction_timestamp()) \
                     + make_interval(secs => $3::double precision), \
                 updated_at = GREATEST(last_failed_at, transaction_timestamp()) \
             WHERE user_id = $1::uuid",
        )
        .bind(user_id.to_string())
        .bind(policy.threshold_i16())
        .bind(policy.lock_seconds())
        .execute(&mut **transaction)
        .await?;
        return Ok(FailureAccounting::LockStarted);
    }

    sqlx::query(
        "UPDATE local_auth_failures \
         SET failure_count = $2, \
             last_failed_at = GREATEST(last_failed_at, transaction_timestamp()), \
             updated_at = GREATEST(last_failed_at, transaction_timestamp()) \
         WHERE user_id = $1::uuid",
    )
    .bind(user_id.to_string())
    .bind(next_count)
    .execute(&mut **transaction)
    .await?;
    Ok(FailureAccounting::Recorded)
}

pub(crate) async fn lock_eligible_user_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "SELECT u.id::text \
         FROM users u \
         JOIN local_password_credentials c ON c.user_id = u.id \
         WHERE u.id = $1::uuid AND u.status = 'active' \
         FOR UPDATE OF u, c",
    )
    .bind(user_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map(|row| row.is_some())
}

pub(crate) async fn is_locked_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(locked_until > transaction_timestamp(), FALSE) \
         FROM local_auth_failures \
         WHERE user_id = $1::uuid \
         FOR UPDATE",
    )
    .bind(user_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map(Option::unwrap_or_default)
}

pub(crate) async fn clear(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM local_auth_failures WHERE user_id = $1::uuid")
        .bind(user_id.to_string())
        .execute(&mut **transaction)
        .await?;
    Ok(())
}
