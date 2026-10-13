use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::task::JoinSet;
use tokio::time;
use uuid::Uuid;

use crate::app::{Shutdown, Supervisor, SupervisorError, WorkerError};

use super::{
    ClaimedEmail, DeliveryBoundaryError, DeliveryEligibility, DeliveryEligibilityDecision,
    EmailAttemptPreparer, EmailOutboxRepository, EmailSendFailure, EmailSender,
    InvitationAttemptContext, InvitationAttemptTokenIssuer, NotificationWorkerError,
};

const MIN_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(60);
const MIN_ITEM_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_ITEM_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LEASE_DURATION: Duration = Duration::from_secs(10 * 60);
const MAX_BATCH_SIZE: u16 = 100;
const MAX_CONCURRENCY: u8 = 16;
const BASE_RETRY_SECONDS: u64 = 60;
const MAX_RETRY_SECONDS: u64 = 6 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotificationWorkerPolicy {
    batch_size: u16,
    concurrency: u8,
    poll_interval: Duration,
    item_timeout: Duration,
    lease_duration: Duration,
}

impl NotificationWorkerPolicy {
    pub fn new(
        batch_size: u16,
        concurrency: u8,
        poll_interval: Duration,
        item_timeout: Duration,
        lease_duration: Duration,
    ) -> Result<Self, NotificationWorkerPolicyError> {
        if !(1..=MAX_BATCH_SIZE).contains(&batch_size) {
            return Err(NotificationWorkerPolicyError::InvalidBatchSize);
        }
        if !(1..=MAX_CONCURRENCY).contains(&concurrency) || u16::from(concurrency) > batch_size {
            return Err(NotificationWorkerPolicyError::InvalidConcurrency);
        }
        if !(MIN_POLL_INTERVAL..=MAX_POLL_INTERVAL).contains(&poll_interval) {
            return Err(NotificationWorkerPolicyError::InvalidPollInterval);
        }
        if !(MIN_ITEM_TIMEOUT..=MAX_ITEM_TIMEOUT).contains(&item_timeout) {
            return Err(NotificationWorkerPolicyError::InvalidItemTimeout);
        }
        if lease_duration <= item_timeout || lease_duration > MAX_LEASE_DURATION {
            return Err(NotificationWorkerPolicyError::InvalidLeaseDuration);
        }
        Ok(Self {
            batch_size,
            concurrency,
            poll_interval,
            item_timeout,
            lease_duration,
        })
    }
}

impl Default for NotificationWorkerPolicy {
    fn default() -> Self {
        Self::new(
            16,
            4,
            Duration::from_secs(1),
            Duration::from_secs(5),
            Duration::from_secs(45),
        )
        .expect("production notification worker policy is valid")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationWorkerPolicyError {
    InvalidBatchSize,
    InvalidConcurrency,
    InvalidPollInterval,
    InvalidItemTimeout,
    InvalidLeaseDuration,
}

impl fmt::Display for NotificationWorkerPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("notification worker policy is invalid")
    }
}

impl std::error::Error for NotificationWorkerPolicyError {}

#[derive(Clone)]
pub struct NotificationWorker {
    repository: EmailOutboxRepository,
    eligibility: Arc<dyn DeliveryEligibility>,
    preparer: Arc<dyn EmailAttemptPreparer>,
    invitation_tokens: Option<Arc<dyn InvitationAttemptTokenIssuer>>,
    sender: Arc<dyn EmailSender>,
    policy: NotificationWorkerPolicy,
}

impl NotificationWorker {
    pub fn new(
        repository: EmailOutboxRepository,
        eligibility: Arc<dyn DeliveryEligibility>,
        preparer: Arc<dyn EmailAttemptPreparer>,
        invitation_tokens: Option<Arc<dyn InvitationAttemptTokenIssuer>>,
        sender: Arc<dyn EmailSender>,
        policy: NotificationWorkerPolicy,
    ) -> Result<Self, NotificationWorkerPolicyError> {
        let attempt_deadline = policy
            .item_timeout
            .checked_add(sender.timeout())
            .and_then(|duration| duration.checked_add(repository.operation_timeout()))
            .ok_or(NotificationWorkerPolicyError::InvalidLeaseDuration)?;
        if policy.lease_duration <= attempt_deadline {
            return Err(NotificationWorkerPolicyError::InvalidLeaseDuration);
        }
        Ok(Self {
            repository,
            eligibility,
            preparer,
            invitation_tokens,
            sender,
            policy,
        })
    }

    /// Registers the worker under its stable runtime name. Callers must only
    /// construct this worker after SMTP configuration, template preparation,
    /// and invitation-token issuance dependencies are available.
    pub fn register(self, supervisor: &mut Supervisor) -> Result<(), SupervisorError> {
        supervisor.register("notification-smtp", move |shutdown| self.run(shutdown))
    }

    /// Runs under the application supervisor. Shutdown stops new claims,
    /// drains already-claimed bounded attempts.
    pub async fn run(self, mut shutdown: Shutdown) -> Result<(), WorkerError> {
        let owner = Uuid::now_v7().to_string();
        loop {
            if shutdown.is_requested() {
                return Ok(());
            }
            let jobs = self
                .repository
                .claim(
                    &owner,
                    self.policy
                        .batch_size
                        .min(u16::from(self.policy.concurrency)),
                    self.policy.lease_duration,
                )
                .await
                .map_err(worker_error)?;
            if jobs.is_empty() {
                tokio::select! {
                    () = shutdown.requested() => return Ok(()),
                    () = time::sleep(self.policy.poll_interval) => {}
                }
                continue;
            }
            self.process_batch(&owner, jobs, &mut shutdown)
                .await
                .map_err(worker_error)?;
        }
    }

    async fn process_batch(
        &self,
        owner: &str,
        jobs: Vec<ClaimedEmail>,
        shutdown: &mut Shutdown,
    ) -> Result<(), NotificationWorkerError> {
        let mut running = JoinSet::new();
        for job in jobs {
            let worker = self.clone();
            let owner = owner.to_owned();
            running.spawn(async move { worker.process_one(&owner, job).await });
        }
        while !running.is_empty() {
            tokio::select! {
                () = shutdown.requested(), if !shutdown.is_requested() => {}
                result = running.join_next() => match result {
                    Some(Ok(result)) => result?,
                    Some(Err(_)) => return Err(NotificationWorkerError::Invariant),
                    None => break,
                }
            }
        }
        Ok(())
    }

    async fn process_one(
        &self,
        owner: &str,
        job: ClaimedEmail,
    ) -> Result<(), NotificationWorkerError> {
        match self.attempt(&job).await {
            AttemptOutcome::Accepted(code) => self.repository.mark_sent(owner, &job, code).await,
            AttemptOutcome::Cancel => self.repository.cancel(owner, &job).await,
            AttemptOutcome::Failure(failure) => {
                let retry_delay = retry_delay(&job);
                self.repository
                    .record_failure(owner, &job, failure, retry_delay)
                    .await
            }
        }
    }

    async fn attempt(&self, job: &ClaimedEmail) -> AttemptOutcome {
        let email = match time::timeout(self.policy.item_timeout, self.prepare_attempt(job)).await {
            Ok(Ok(email)) => email,
            Ok(Err(outcome)) => return outcome,
            Err(_) => return AttemptOutcome::Failure(EmailSendFailure::transient(None)),
        };
        match self.sender.send(job.recipient_email(), &email).await {
            Ok(acceptance) => AttemptOutcome::Accepted(acceptance.code()),
            Err(failure) => AttemptOutcome::Failure(failure),
        }
    }

    async fn prepare_attempt(
        &self,
        job: &ClaimedEmail,
    ) -> Result<super::PreparedEmail, AttemptOutcome> {
        let eligibility = self.eligibility.revalidate(job).await;
        match eligibility {
            Ok(DeliveryEligibilityDecision::Cancel) | Err(DeliveryBoundaryError::Cancel) => {
                return Err(AttemptOutcome::Cancel);
            }
            Err(DeliveryBoundaryError::Permanent) => {
                return Err(AttemptOutcome::Failure(EmailSendFailure::permanent(None)));
            }
            Err(DeliveryBoundaryError::Retryable) => {
                return Err(AttemptOutcome::Failure(EmailSendFailure::transient(None)));
            }
            Ok(DeliveryEligibilityDecision::Eligible) => {}
        }
        let invitation_token = if matches!(
            job.resource_type(),
            "activation_invitation" | "organization_invitation"
        ) {
            let Some(issuer) = &self.invitation_tokens else {
                return Err(AttemptOutcome::Failure(EmailSendFailure::permanent(None)));
            };
            let context = InvitationAttemptContext {
                invitation_id: job.resource_id().to_owned(),
                resource_type: job.resource_type().to_owned(),
                recipient_email: job.recipient_email().to_owned(),
                attempt_count: job.attempt_count(),
            };
            match issuer.issue(&context).await {
                Ok(token) => Some(token),
                Err(DeliveryBoundaryError::Cancel) => return Err(AttemptOutcome::Cancel),
                Err(DeliveryBoundaryError::Permanent) => {
                    return Err(AttemptOutcome::Failure(EmailSendFailure::permanent(None)));
                }
                Err(DeliveryBoundaryError::Retryable) => {
                    return Err(AttemptOutcome::Failure(EmailSendFailure::transient(None)));
                }
            }
        } else {
            None
        };
        match self.preparer.prepare(job, invitation_token.as_ref()).await {
            Ok(email) => Ok(email),
            Err(DeliveryBoundaryError::Cancel) => Err(AttemptOutcome::Cancel),
            Err(DeliveryBoundaryError::Permanent) => {
                Err(AttemptOutcome::Failure(EmailSendFailure::permanent(None)))
            }
            Err(DeliveryBoundaryError::Retryable) => {
                Err(AttemptOutcome::Failure(EmailSendFailure::transient(None)))
            }
        }
    }
}

impl fmt::Debug for NotificationWorker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationWorker")
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

enum AttemptOutcome {
    Accepted(u16),
    Cancel,
    Failure(EmailSendFailure),
}

fn retry_delay(job: &ClaimedEmail) -> Duration {
    let exponent = u32::from(job.attempt_count.saturating_sub(1)).min(15);
    let base = BASE_RETRY_SECONDS
        .checked_mul(1_u64 << exponent)
        .unwrap_or(MAX_RETRY_SECONDS)
        .min(MAX_RETRY_SECONDS);
    let digest = Sha256::digest(format!("{}:{}", job.id, job.attempt_count).as_bytes());
    let sample = u16::from_be_bytes([digest[0], digest[1]]);
    // Stable 80%..120% jitter avoids synchronized retries without a global RNG.
    let permille = 800_u64 + (u64::from(sample) * 401 / u64::from(u16::MAX));
    let seconds = base
        .saturating_mul(permille)
        .checked_div(1000)
        .unwrap_or(base)
        .clamp(1, MAX_RETRY_SECONDS);
    Duration::from_secs(seconds)
}

fn worker_error(error: NotificationWorkerError) -> WorkerError {
    WorkerError::new(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn job(attempt_count: u8) -> ClaimedEmail {
        ClaimedEmail {
            id: "0199ee6c-c777-7000-8000-000000004201".to_owned(),
            notification_id: Some("0199ee6c-c777-7000-8000-000000004202".to_owned()),
            recipient_user_id: Some("0199ee6c-c777-7000-8000-000000004203".to_owned()),
            recipient_email: "private@example.test".to_owned(),
            classification: "account_access".to_owned(),
            template_id: "identity.changed".to_owned(),
            locale: "en-US".to_owned(),
            resource_type: "user".to_owned(),
            resource_id: "0199ee6c-c777-7000-8000-000000004203".to_owned(),
            rendering_data: json!({"displayName":"Private"}),
            attempt_count,
            lock_version: 2,
        }
    }

    #[test]
    fn retry_delay_is_exponential_jittered_and_capped() {
        let one = retry_delay(&job(1)).as_secs();
        let two = retry_delay(&job(2)).as_secs();
        assert!((48..=72).contains(&one));
        assert!((96..=144).contains(&two));
        assert!(retry_delay(&job(32)).as_secs() <= MAX_RETRY_SECONDS);
    }

    #[test]
    fn debug_contracts_redact_message_and_recipient() {
        let claimed = job(1);
        let prepared = super::super::PreparedEmail::new(
            "Private subject".to_owned(),
            "private body".to_owned(),
        )
        .unwrap();
        let rendered = format!("{claimed:?} {prepared:?}");
        for prohibited in ["private@example.test", "Private subject", "private body"] {
            assert!(!rendered.contains(prohibited));
        }
    }

    #[test]
    fn worker_policy_is_bounded() {
        assert!(
            NotificationWorkerPolicy::new(
                16,
                4,
                Duration::from_secs(1),
                Duration::from_secs(5),
                Duration::from_secs(30),
            )
            .is_ok()
        );
        assert_eq!(
            NotificationWorkerPolicy::new(
                16,
                17,
                Duration::from_secs(1),
                Duration::from_secs(5),
                Duration::from_secs(30),
            ),
            Err(NotificationWorkerPolicyError::InvalidConcurrency)
        );
    }
}
