use std::fmt;
use std::future::Future;
use std::time::Duration;

use sqlx::{Acquire, Row};
use tokio::time;
use uuid::{Uuid, Variant, Version};

use crate::database::DatabasePool;

use super::{
    ClaimedEmail, DeliveryBoundaryError, DeliveryEligibility, DeliveryEligibilityDecision,
    EmailSendFailure, EmailSendFailureClass,
};

const MAX_ATTEMPTS: i16 = 8;
const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LEASE_DURATION: Duration = Duration::from_secs(10 * 60);
const MAX_BATCH_SIZE: u16 = 100;
const MAX_RETRY_DELAY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone)]
pub struct EmailOutboxRepository {
    pool: DatabasePool,
    operation_timeout: Duration,
}

impl EmailOutboxRepository {
    pub fn new(
        pool: DatabasePool,
        operation_timeout: Duration,
    ) -> Result<Self, NotificationWorkerError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(NotificationWorkerError::Invariant);
        }
        Ok(Self {
            pool,
            operation_timeout,
        })
    }

    pub(crate) const fn operation_timeout(&self) -> Duration {
        self.operation_timeout
    }

    pub async fn claim(
        &self,
        owner: &str,
        limit: u16,
        lease_duration: Duration,
    ) -> Result<Vec<ClaimedEmail>, NotificationWorkerError> {
        validate_owner(owner)?;
        if !(1..=MAX_BATCH_SIZE).contains(&limit)
            || lease_duration <= self.operation_timeout
            || lease_duration > MAX_LEASE_DURATION
        {
            return Err(NotificationWorkerError::Invariant);
        }
        self.bounded(self.claim_inner(owner, limit, lease_duration))
            .await
    }

    async fn claim_inner(
        &self,
        owner: &str,
        limit: u16,
        lease_duration: Duration,
    ) -> Result<Vec<ClaimedEmail>, NotificationWorkerError> {
        let lease_millis = i64::try_from(lease_duration.as_millis())
            .map_err(|_| NotificationWorkerError::Invariant)?;
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| NotificationWorkerError::Unavailable)?;
        let mut transaction = connection.begin().await.map_err(map_database_error)?;

        sqlx::query(
            "WITH expired AS (\
                 SELECT id FROM email_outbox \
                 WHERE state='sending' AND lease_expires_at<=clock_timestamp() \
                   AND (attempt_count >= $1 OR first_attempt_at <= clock_timestamp()-INTERVAL '24 hours') \
                 ORDER BY lease_expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED\
             ) \
             UPDATE email_outbox job SET state='dead_letter',lease_owner=NULL,lease_expires_at=NULL,\
                    last_error_class=COALESCE(last_error_class,'ambiguous'),\
                    updated_at=clock_timestamp(),lock_version=lock_version+1 \
             FROM expired WHERE job.id=expired.id",
        )
        .bind(MAX_ATTEMPTS)
        .bind(i64::from(limit))
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
        sqlx::query(
            "WITH expired AS (\
                 SELECT id FROM email_outbox \
                 WHERE state='sending' AND lease_expires_at<=clock_timestamp() \
                   AND attempt_count < $1 \
                   AND first_attempt_at > clock_timestamp()-INTERVAL '24 hours' \
                 ORDER BY lease_expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED\
             ) \
             UPDATE email_outbox job SET state='retry_wait',lease_owner=NULL,lease_expires_at=NULL,\
                    available_at=GREATEST(available_at,statement_timestamp()),\
                    last_error_class='ambiguous',updated_at=statement_timestamp(),\
                    lock_version=lock_version+1 \
             FROM expired WHERE job.id=expired.id",
        )
        .bind(MAX_ATTEMPTS)
        .bind(i64::from(limit))
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
        sqlx::query(
            "WITH exhausted AS (\
                 SELECT id FROM email_outbox \
                 WHERE state='retry_wait' \
                   AND (attempt_count >= $1 OR first_attempt_at <= clock_timestamp()-INTERVAL '24 hours') \
                 ORDER BY available_at,id LIMIT $2 FOR UPDATE SKIP LOCKED\
             ) \
             UPDATE email_outbox job SET state='dead_letter',\
                    last_error_class=COALESCE(last_error_class,'transient'),\
                    updated_at=clock_timestamp(),lock_version=lock_version+1 \
             FROM exhausted WHERE job.id=exhausted.id",
        )
        .bind(MAX_ATTEMPTS)
        .bind(i64::from(limit))
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;

        let rows = sqlx::query(
            "WITH candidates AS (\
                 SELECT id FROM email_outbox \
                 WHERE state IN ('pending','retry_wait') \
                   AND available_at<=clock_timestamp() \
                   AND attempt_count<$1 \
                   AND (first_attempt_at IS NULL \
                        OR first_attempt_at>clock_timestamp()-INTERVAL '24 hours') \
                 ORDER BY available_at,id LIMIT $2 FOR UPDATE SKIP LOCKED\
             ) \
             UPDATE email_outbox job SET state='sending',attempt_count=job.attempt_count+1,\
                    first_attempt_at=COALESCE(job.first_attempt_at,statement_timestamp()),\
                    last_attempt_at=statement_timestamp(),lease_owner=$3,\
                    lease_expires_at=statement_timestamp()+($4::bigint*INTERVAL '1 millisecond'),\
                    updated_at=statement_timestamp(),lock_version=job.lock_version+1 \
             FROM candidates WHERE job.id=candidates.id \
             RETURNING job.id::text,job.notification_id::text,job.recipient_user_id::text,\
                       job.recipient_email,job.classification,job.template_id,job.locale,\
                       job.resource_type,job.resource_id,job.rendering_data::text,\
                       job.attempt_count::int,job.lock_version",
        )
        .bind(MAX_ATTEMPTS)
        .bind(i64::from(limit))
        .bind(owner)
        .bind(lease_millis)
        .fetch_all(&mut *transaction)
        .await
        .map_err(map_database_error)?;
        transaction.commit().await.map_err(map_database_error)?;
        rows.into_iter().map(decode_claim).collect()
    }

    pub async fn mark_sent(
        &self,
        owner: &str,
        job: &ClaimedEmail,
        smtp_code: u16,
    ) -> Result<(), NotificationWorkerError> {
        validate_owner(owner)?;
        if !(200..300).contains(&smtp_code) {
            return Err(NotificationWorkerError::Invariant);
        }
        self.bounded(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| NotificationWorkerError::Unavailable)?;
            let result = sqlx::query(
                "UPDATE email_outbox SET state='sent',sent_at=clock_timestamp(),\
                 lease_owner=NULL,lease_expires_at=NULL,last_smtp_code=$4,last_error_class=NULL,\
                 updated_at=clock_timestamp(),lock_version=lock_version+1 \
                 WHERE id=$1::uuid AND state='sending' AND lease_owner=$2 AND lock_version=$3",
            )
            .bind(&job.id)
            .bind(owner)
            .bind(job.lock_version)
            .bind(i32::from(smtp_code))
            .execute(&mut *connection)
            .await
            .map_err(map_database_error)?;
            exactly_one(result.rows_affected())
        })
        .await
    }

    pub async fn cancel(
        &self,
        owner: &str,
        job: &ClaimedEmail,
    ) -> Result<(), NotificationWorkerError> {
        validate_owner(owner)?;
        self.bounded(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| NotificationWorkerError::Unavailable)?;
            let result = sqlx::query(
                "UPDATE email_outbox SET state='canceled',lease_owner=NULL,lease_expires_at=NULL,\
                 last_smtp_code=NULL,last_error_class=NULL,updated_at=clock_timestamp(),\
                 lock_version=lock_version+1 \
                 WHERE id=$1::uuid AND state='sending' AND lease_owner=$2 AND lock_version=$3",
            )
            .bind(&job.id)
            .bind(owner)
            .bind(job.lock_version)
            .execute(&mut *connection)
            .await
            .map_err(map_database_error)?;
            exactly_one(result.rows_affected())
        })
        .await
    }

    pub async fn record_failure(
        &self,
        owner: &str,
        job: &ClaimedEmail,
        failure: EmailSendFailure,
        retry_delay: Duration,
    ) -> Result<(), NotificationWorkerError> {
        validate_owner(owner)?;
        if retry_delay.is_zero() || retry_delay > MAX_RETRY_DELAY {
            return Err(NotificationWorkerError::Invariant);
        }
        let error_class = match failure.class() {
            EmailSendFailureClass::Transient => "transient",
            EmailSendFailureClass::Permanent => "permanent",
            EmailSendFailureClass::Ambiguous => "ambiguous",
        };
        let smtp_code = failure.smtp_code().map(i32::from);
        let retry_millis = i64::try_from(retry_delay.as_millis())
            .map_err(|_| NotificationWorkerError::Invariant)?;
        self.bounded(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| NotificationWorkerError::Unavailable)?;
            let result = if failure.class() == EmailSendFailureClass::Permanent {
                sqlx::query(
                    "UPDATE email_outbox SET state='dead_letter',lease_owner=NULL,lease_expires_at=NULL,\
                 last_smtp_code=$4,last_error_class=$5,updated_at=clock_timestamp(),\
                 lock_version=lock_version+1 \
                 WHERE id=$1::uuid AND state='sending' AND lease_owner=$2 AND lock_version=$3",
                )
                .bind(&job.id)
                .bind(owner)
                .bind(job.lock_version)
                .bind(smtp_code)
                .bind(error_class)
                .execute(&mut *connection)
                .await
            } else {
                sqlx::query(
                    "UPDATE email_outbox SET \
                    state=CASE WHEN attempt_count>=8 \
                                    OR first_attempt_at<=clock_timestamp()-INTERVAL '24 hours' \
                                    OR statement_timestamp()+($6::bigint*INTERVAL '1 millisecond')\
                                       >=first_attempt_at+INTERVAL '24 hours' \
                               THEN 'dead_letter' ELSE 'retry_wait' END,\
                    available_at=CASE WHEN attempt_count>=8 \
                                           OR first_attempt_at<=clock_timestamp()-INTERVAL '24 hours' \
                                           OR statement_timestamp()+($6::bigint*INTERVAL '1 millisecond')\
                                              >=first_attempt_at+INTERVAL '24 hours' \
                                      THEN available_at \
                                      ELSE statement_timestamp()+($6::bigint*INTERVAL '1 millisecond') END,\
                    lease_owner=NULL,lease_expires_at=NULL,last_smtp_code=$4,last_error_class=$5,\
                    updated_at=clock_timestamp(),lock_version=lock_version+1 \
                 WHERE id=$1::uuid AND state='sending' AND lease_owner=$2 AND lock_version=$3",
                )
                .bind(&job.id)
                .bind(owner)
                .bind(job.lock_version)
                .bind(smtp_code)
                .bind(error_class)
                .bind(retry_millis)
                .execute(&mut *connection)
                .await
            }
            .map_err(map_database_error)?;
            exactly_one(result.rows_affected())
        })
        .await
    }

    pub async fn release_claims(
        &self,
        owner: &str,
        jobs: &[(ClaimedEmail, Duration)],
    ) -> Result<(), NotificationWorkerError> {
        validate_owner(owner)?;
        if jobs.len() > usize::from(MAX_BATCH_SIZE)
            || jobs
                .iter()
                .any(|(_, delay)| delay.is_zero() || *delay > MAX_RETRY_DELAY)
        {
            return Err(NotificationWorkerError::Invariant);
        }
        self.bounded(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| NotificationWorkerError::Unavailable)?;
            let mut transaction = connection.begin().await.map_err(map_database_error)?;
            let mut released = 0_u64;
            for (job, delay) in jobs {
                let delay_millis = i64::try_from(delay.as_millis())
                    .map_err(|_| NotificationWorkerError::Invariant)?;
                let result = sqlx::query(
                    "UPDATE email_outbox SET state=CASE WHEN attempt_count>=8 \
                        OR first_attempt_at<=clock_timestamp()-INTERVAL '24 hours' \
                        THEN 'dead_letter' ELSE 'retry_wait' END,\
                     available_at=CASE WHEN attempt_count>=8 \
                        OR first_attempt_at<=clock_timestamp()-INTERVAL '24 hours' \
                        THEN available_at ELSE statement_timestamp()+($4::bigint*INTERVAL '1 millisecond') END,\
                     lease_owner=NULL,lease_expires_at=NULL,last_error_class='transient',\
                     updated_at=clock_timestamp(),lock_version=lock_version+1 \
                     WHERE id=$1::uuid AND state='sending' AND lease_owner=$2 AND lock_version=$3",
                )
                .bind(&job.id)
                .bind(owner)
                .bind(job.lock_version)
                .bind(delay_millis)
                .execute(&mut *transaction)
                .await
                .map_err(map_database_error)?;
                released = released.saturating_add(result.rows_affected());
            }
            if released != jobs.len() as u64 {
                transaction.rollback().await.map_err(map_database_error)?;
                return Err(NotificationWorkerError::LostClaim);
            }
            transaction.commit().await.map_err(map_database_error)
        })
        .await
    }

    async fn bounded<T>(
        &self,
        future: impl Future<Output = Result<T, NotificationWorkerError>>,
    ) -> Result<T, NotificationWorkerError> {
        time::timeout(self.operation_timeout, future)
            .await
            .map_err(|_| NotificationWorkerError::Unavailable)?
    }
}

#[derive(Debug, Clone)]
pub struct DatabaseDeliveryEligibility {
    pool: DatabasePool,
}

impl DatabaseDeliveryEligibility {
    #[must_use]
    pub const fn new(pool: DatabasePool) -> Self {
        Self { pool }
    }

    async fn check(
        &self,
        email: &ClaimedEmail,
    ) -> Result<DeliveryEligibilityDecision, DeliveryBoundaryError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| DeliveryBoundaryError::Retryable)?;
        let domain_active = match email.resource_type.as_str() {
            "activation_invitation" => {
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM activation_invitations \
                     WHERE id=$1::uuid AND normalized_email=$2 AND status='pending' \
                       AND expires_at>clock_timestamp())",
                )
                .bind(&email.resource_id)
                .bind(&email.recipient_email)
                .fetch_one(&mut *connection)
                .await
            }
            "organization_invitation" => {
                let Some(recipient_user_id) = email.recipient_user_id.as_deref() else {
                    return Ok(DeliveryEligibilityDecision::Cancel);
                };
                sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM organization_invitations \
                     WHERE id=$1::uuid AND invitee_user_id=$2::uuid AND normalized_email=$3 \
                       AND status='pending' AND expires_at>clock_timestamp())",
                )
                .bind(&email.resource_id)
                .bind(recipient_user_id)
                .bind(&email.recipient_email)
                .fetch_one(&mut *connection)
                .await
            }
            _ => {
                let Some(recipient_user_id) = email.recipient_user_id.as_deref() else {
                    return Ok(DeliveryEligibilityDecision::Cancel);
                };
                return sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM users \
                     WHERE id=$1::uuid AND status='active' AND normalized_email=$2)",
                )
                .bind(recipient_user_id)
                .bind(&email.recipient_email)
                .fetch_one(&mut *connection)
                .await
                .map(|active| {
                    if active {
                        DeliveryEligibilityDecision::Eligible
                    } else {
                        DeliveryEligibilityDecision::Cancel
                    }
                })
                .map_err(|_| DeliveryBoundaryError::Retryable);
            }
        }
        .map_err(|_| DeliveryBoundaryError::Retryable)?;
        Ok(if domain_active {
            DeliveryEligibilityDecision::Eligible
        } else {
            DeliveryEligibilityDecision::Cancel
        })
    }
}

impl DeliveryEligibility for DatabaseDeliveryEligibility {
    fn revalidate<'a>(
        &'a self,
        email: &'a ClaimedEmail,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<DeliveryEligibilityDecision, DeliveryBoundaryError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(self.check(email))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationWorkerError {
    Unavailable,
    LostClaim,
    Invariant,
}

impl fmt::Display for NotificationWorkerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "notification worker dependency is unavailable",
            Self::LostClaim => "notification worker claim is no longer owned",
            Self::Invariant => "notification worker invariant failed",
        })
    }
}

impl std::error::Error for NotificationWorkerError {}

fn decode_claim(row: sqlx::postgres::PgRow) -> Result<ClaimedEmail, NotificationWorkerError> {
    let rendering_data: String = row
        .try_get(9)
        .map_err(|_| NotificationWorkerError::Invariant)?;
    let attempt_count: i32 = row
        .try_get(10)
        .map_err(|_| NotificationWorkerError::Invariant)?;
    Ok(ClaimedEmail {
        id: row
            .try_get(0)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        notification_id: row
            .try_get(1)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        recipient_user_id: row
            .try_get(2)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        recipient_email: row
            .try_get(3)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        classification: row
            .try_get(4)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        template_id: row
            .try_get(5)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        locale: row
            .try_get(6)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        resource_type: row
            .try_get(7)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        resource_id: row
            .try_get(8)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        rendering_data: serde_json::from_str(&rendering_data)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        attempt_count: u8::try_from(attempt_count)
            .map_err(|_| NotificationWorkerError::Invariant)?,
        lock_version: row
            .try_get(11)
            .map_err(|_| NotificationWorkerError::Invariant)?,
    })
}

fn map_database_error(error: sqlx::Error) -> NotificationWorkerError {
    match error {
        sqlx::Error::RowNotFound
        | sqlx::Error::ColumnNotFound(_)
        | sqlx::Error::ColumnDecode { .. }
        | sqlx::Error::Decode(_) => NotificationWorkerError::Invariant,
        sqlx::Error::Database(error)
            if error.is_check_violation()
                || error.is_foreign_key_violation()
                || error.is_unique_violation() =>
        {
            NotificationWorkerError::Invariant
        }
        _ => NotificationWorkerError::Unavailable,
    }
}

fn exactly_one(rows: u64) -> Result<(), NotificationWorkerError> {
    if rows == 1 {
        Ok(())
    } else {
        Err(NotificationWorkerError::LostClaim)
    }
}

fn validate_owner(owner: &str) -> Result<(), NotificationWorkerError> {
    let id = Uuid::parse_str(owner).map_err(|_| NotificationWorkerError::Invariant)?;
    if id.get_version() == Some(Version::SortRand) && id.get_variant() == Variant::RFC4122 {
        Ok(())
    } else {
        Err(NotificationWorkerError::Invariant)
    }
}
