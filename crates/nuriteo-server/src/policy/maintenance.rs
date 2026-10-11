use std::fmt;
use std::future::Future;
use std::time::Duration;

use ::time::OffsetDateTime;
use serde_json::json;
use sqlx::{Acquire, Row};
use tokio::task::JoinSet;
use tokio::time;
use uuid::Uuid;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::database::DatabasePool;
use crate::identity::Timestamp;
use crate::object_storage::{ObjectKey, ObjectStoreErrorKind, S3ObjectStore};

use super::{EffectivePolicyEngine, EffectivePolicyError, EffectivePolicySnapshot};

const MAX_CONCURRENCY: usize = 4;
pub(crate) const MAX_ATTEMPTS: i32 = 8;
const LEASE_DURATION: Duration = Duration::from_secs(60 * 60);
const ITEM_TIMEOUT: Duration = Duration::from_secs(30);
const NOTIFICATION_BATCH: i64 = 100;
const AUDIT_BATCH: i64 = 1_000;
const MAX_RUN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub(crate) const GC_ELIGIBLE_PREDICATE: &str = "candidate.attempts<$1 \
 AND candidate.eligible_at<=transaction_timestamp() \
 AND candidate.created_at+make_interval(secs=>$2)<=transaction_timestamp() \
 AND NOT EXISTS (SELECT 1 FROM projects project JOIN bundles bundle ON bundle.id=project.working_head_bundle_id WHERE bundle.object_key=candidate.object_key) \
 AND NOT EXISTS (SELECT 1 FROM project_bundle_refs reference JOIN bundles bundle ON bundle.id=reference.bundle_id WHERE bundle.object_key=candidate.object_key) \
 AND NOT EXISTS (SELECT 1 FROM save_sessions session WHERE session.staging_object_key=candidate.object_key AND session.state IN ('created','uploading','verifying')) \
 AND NOT EXISTS (SELECT 1 FROM object_retention_holds hold WHERE hold.object_key=candidate.object_key AND (hold.retain_until IS NULL OR hold.retain_until>transaction_timestamp())) \
 AND (candidate.status='queued' \
   OR (candidate.status='retry_wait' AND candidate.retry_at<=transaction_timestamp()) \
   OR (candidate.status='running' AND (lease.object_key IS NULL OR lease.lease_expires_at<=transaction_timestamp())))";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectDeleteOutcome {
    Deleted,
    Absent,
    Retryable,
    Permanent,
}

pub trait ObjectGcBackend: Clone + Send + Sync + 'static {
    fn delete_object(&self, key: ObjectKey) -> impl Future<Output = ObjectDeleteOutcome> + Send;
}

impl ObjectGcBackend for S3ObjectStore {
    async fn delete_object(&self, key: ObjectKey) -> ObjectDeleteOutcome {
        match self.delete(&key).await {
            Ok(()) => ObjectDeleteOutcome::Deleted,
            Err(error) if error.kind() == ObjectStoreErrorKind::NotFound => {
                ObjectDeleteOutcome::Absent
            }
            Err(error) if error.is_retryable() => ObjectDeleteOutcome::Retryable,
            Err(_) => ObjectDeleteOutcome::Permanent,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PolicyMaintenanceReport {
    pub gc_claimed: u16,
    pub gc_completed: u16,
    pub gc_retried: u16,
    pub gc_failed: u16,
    pub notifications_deleted: u16,
    pub audit_events_deleted: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyMaintenanceError {
    Policy,
    Database,
    Timeout,
    Invariant,
}

impl fmt::Display for PolicyMaintenanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Policy => "policy maintenance configuration is unavailable",
            Self::Database => "policy maintenance persistence is unavailable",
            Self::Timeout => "policy maintenance operation timed out",
            Self::Invariant => "policy maintenance state is invalid",
        })
    }
}

impl std::error::Error for PolicyMaintenanceError {}

#[derive(Clone)]
pub struct PolicyMaintenanceWorker<B = S3ObjectStore> {
    pool: DatabasePool,
    backend: B,
    operation_timeout: Duration,
}

impl<B> PolicyMaintenanceWorker<B>
where
    B: ObjectGcBackend,
{
    pub fn new(
        pool: DatabasePool,
        backend: B,
        operation_timeout: Duration,
    ) -> Result<Self, PolicyMaintenanceError> {
        if !(Duration::from_millis(100)..=Duration::from_secs(30)).contains(&operation_timeout) {
            return Err(PolicyMaintenanceError::Policy);
        }
        Ok(Self {
            pool,
            backend,
            operation_timeout,
        })
    }

    pub async fn run_once(&self) -> Result<PolicyMaintenanceReport, PolicyMaintenanceError> {
        // The configured timeout bounds each policy/DB operation. A complete
        // batch can legitimately take several item timeouts, but must always
        // finish before its one-hour lease can expire.
        time::timeout(MAX_RUN_TIMEOUT, self.run_once_inner())
            .await
            .map_err(|_| PolicyMaintenanceError::Timeout)?
    }

    pub async fn run_until(
        self,
        shutdown: impl Future<Output = ()> + Send,
    ) -> Result<(), PolicyMaintenanceError> {
        tokio::pin!(shutdown);
        loop {
            let snapshot = EffectivePolicyEngine::new(self.pool.clone(), self.operation_timeout)
                .map_err(map_policy)?
                .load()
                .await
                .map_err(map_policy)?;
            let interval = snapshot.gc_interval().map_err(map_policy)?;
            tokio::select! {
                _ = &mut shutdown => return Ok(()),
                result = self.run_once() => { result?; }
            }
            tokio::select! {
                _ = &mut shutdown => return Ok(()),
                () = time::sleep(interval) => {}
            }
        }
    }

    async fn run_once_inner(&self) -> Result<PolicyMaintenanceReport, PolicyMaintenanceError> {
        let notifications_deleted = self.sweep_notifications().await?;
        let audit_events_deleted = self.sweep_audit_events().await?;
        let snapshot = EffectivePolicyEngine::new(self.pool.clone(), self.operation_timeout)
            .map_err(map_policy)?
            .load()
            .await
            .map_err(map_policy)?;
        if !snapshot.gc_enabled() {
            return Ok(PolicyMaintenanceReport {
                notifications_deleted,
                audit_events_deleted,
                ..PolicyMaintenanceReport::default()
            });
        }
        let owner = Uuid::now_v7();
        let jobs = self.claim_gc(&snapshot, owner).await?;
        let claimed = u16::try_from(jobs.len()).map_err(|_| PolicyMaintenanceError::Invariant)?;
        let mut running = JoinSet::new();
        let mut jobs = jobs.into_iter();
        for _ in 0..MAX_CONCURRENCY {
            if let Some(job) = jobs.next() {
                let worker = self.clone();
                running.spawn(async move { worker.process_gc(owner, job).await });
            }
        }
        let mut report = PolicyMaintenanceReport {
            gc_claimed: claimed,
            notifications_deleted,
            audit_events_deleted,
            ..PolicyMaintenanceReport::default()
        };
        while let Some(result) = running.join_next().await {
            match result.map_err(|_| PolicyMaintenanceError::Invariant)?? {
                GcResult::Completed => report.gc_completed += 1,
                GcResult::Retry => report.gc_retried += 1,
                GcResult::Failed => report.gc_failed += 1,
            }
            if let Some(job) = jobs.next() {
                let worker = self.clone();
                running.spawn(async move { worker.process_gc(owner, job).await });
            }
        }
        Ok(report)
    }

    async fn sweep_notifications(&self) -> Result<u16, PolicyMaintenanceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let snapshot = EffectivePolicyEngine::load_in_transaction(&mut tx)
            .await
            .map_err(map_policy)?;
        let general = retention_days(&snapshot, "notifications.general_retention_days")?
            .ok_or(PolicyMaintenanceError::Invariant)?;
        let security = retention_days(&snapshot, "notifications.security_retention_days")?;
        let deleted: i64 = sqlx::query_scalar(
            "WITH candidates AS (SELECT notification.id FROM notifications notification \
             WHERE notification.status IN ('read','archived') AND notification.action_state<>'pending' \
               AND (($1::integer IS NOT NULL AND notification.classification IN ('critical_security','account_access') \
                     AND notification.created_at < transaction_timestamp()-make_interval(days=>$1)) \
                 OR (notification.classification IN ('collaboration','operations') \
                     AND notification.created_at < transaction_timestamp()-make_interval(days=>$2))) \
               AND NOT EXISTS (SELECT 1 FROM email_outbox delivery WHERE delivery.notification_id=notification.id \
                   AND delivery.state IN ('pending','sending','retry_wait','dead_letter')) \
             ORDER BY notification.created_at,notification.id LIMIT $3 FOR UPDATE SKIP LOCKED), \
             deleted AS (DELETE FROM notifications notification USING candidates \
                 WHERE notification.id=candidates.id RETURNING notification.id) \
             SELECT COUNT(*)::bigint FROM deleted",
        )
        .bind(security)
        .bind(general)
        .bind(NOTIFICATION_BATCH)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| PolicyMaintenanceError::Database)?;
        tx.commit()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        u16::try_from(deleted).map_err(|_| PolicyMaintenanceError::Invariant)
    }

    async fn sweep_audit_events(&self) -> Result<u16, PolicyMaintenanceError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let snapshot = EffectivePolicyEngine::load_in_transaction(&mut tx)
            .await
            .map_err(map_policy)?;
        let Some(days) = retention_days(&snapshot, "audit.retention_days")? else {
            tx.commit()
                .await
                .map_err(|_| PolicyMaintenanceError::Database)?;
            return Ok(0);
        };
        let deleted: i64 = sqlx::query_scalar(
            "WITH candidates AS (SELECT event.id FROM audit_events event \
             WHERE event.occurred_at < transaction_timestamp()-make_interval(days=>$1) \
               AND NOT EXISTS (SELECT 1 FROM project_history_promotions promotion \
                               WHERE promotion.audit_event_id=event.id) \
             ORDER BY event.occurred_at,event.id LIMIT $2 FOR UPDATE SKIP LOCKED), \
             removed AS (DELETE FROM audit_events event USING candidates \
               WHERE event.id=candidates.id RETURNING event.id) \
             SELECT COUNT(*)::bigint FROM removed",
        )
        .bind(days)
        .bind(AUDIT_BATCH)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| PolicyMaintenanceError::Database)?;
        let deleted = u16::try_from(deleted).map_err(|_| PolicyMaintenanceError::Invariant)?;
        if deleted != 0 {
            let event = AuditEvent::new(AuditEventFields {
                id: AuditEventId::new(),
                occurred_at: Timestamp::from_datetime(OffsetDateTime::now_utc())
                    .map_err(|_| PolicyMaintenanceError::Invariant)?,
                actor: AuditActor {
                    kind: ActorType::BackgroundJob,
                    id: "policy-maintenance".into(),
                    user_id: None,
                    display_name: None,
                },
                action_code: "audit.retention_pruned".into(),
                target: AuditTarget {
                    kind: "audit_retention".into(),
                    id: "instance".into(),
                },
                scope: AuditScope {
                    kind: ScopeType::Instance,
                    id: "instance".into(),
                },
                result: AuditResult::Succeeded,
                reason_code: None,
                correlation_id: format!("maintenance:audit:{}", AuditEventId::new()),
                source_ip: None,
                schema_version: 1,
                changed_fields: Vec::new(),
                metadata: AuditMetadata::new(json!({
                    "deletedCount": deleted,
                    "retentionDays": days,
                    "source": "policy-maintenance"
                }))
                .map_err(|_| PolicyMaintenanceError::Invariant)?,
            })
            .map_err(|_| PolicyMaintenanceError::Invariant)?;
            AuditWriter::append(&mut tx, &event)
                .await
                .map_err(|_| PolicyMaintenanceError::Database)?;
        }
        tx.commit()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        Ok(deleted)
    }

    async fn claim_gc(
        &self,
        snapshot: &EffectivePolicySnapshot,
        owner: Uuid,
    ) -> Result<Vec<GcJob>, PolicyMaintenanceError> {
        let grace = i64::try_from(snapshot.gc_grace_period().map_err(map_policy)?.as_secs())
            .map_err(|_| PolicyMaintenanceError::Invariant)?;
        let batch = i64::from(snapshot.gc_batch_size().map_err(map_policy)?);
        let lease = i64::try_from(LEASE_DURATION.as_secs())
            .map_err(|_| PolicyMaintenanceError::Invariant)?;
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let query = format!(
            "SELECT candidate.object_key,candidate.expected_sha256,candidate.expected_bytes,candidate.attempts FROM gc_candidates candidate \
             LEFT JOIN gc_candidate_leases lease ON lease.object_key=candidate.object_key \
             WHERE {GC_ELIGIBLE_PREDICATE} \
             ORDER BY candidate.created_at,candidate.object_key LIMIT $3 FOR UPDATE OF candidate SKIP LOCKED"
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(query))
            .bind(MAX_ATTEMPTS)
            .bind(grace)
            .bind(batch)
            .fetch_all(&mut *tx)
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let mut jobs = Vec::with_capacity(rows.len());
        for row in rows {
            let key: String = row
                .try_get("object_key")
                .map_err(|_| PolicyMaintenanceError::Invariant)?;
            let attempts: i32 = row
                .try_get("attempts")
                .map_err(|_| PolicyMaintenanceError::Invariant)?;
            let expected_sha256: Vec<u8> = row
                .try_get("expected_sha256")
                .map_err(|_| PolicyMaintenanceError::Invariant)?;
            let expected_bytes: i64 = row
                .try_get("expected_bytes")
                .map_err(|_| PolicyMaintenanceError::Invariant)?;
            if expected_sha256.len() != 32 || expected_bytes < 0 {
                return Err(PolicyMaintenanceError::Invariant);
            }
            // Serialize the queued->running fence with every Bundle/reference
            // admission. Once this transaction commits, the existing database
            // triggers reject new references until deletion is reconciled.
            sqlx::query("SELECT lock_bundle_object_lifecycle($1)")
                .bind(&key)
                .execute(&mut *tx)
                .await
                .map_err(|_| PolicyMaintenanceError::Database)?;
            let referenced: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM projects project JOIN bundles bundle ON bundle.id=project.working_head_bundle_id WHERE bundle.object_key=$1) \
                 OR EXISTS(SELECT 1 FROM project_bundle_refs reference JOIN bundles bundle ON bundle.id=reference.bundle_id WHERE bundle.object_key=$1) \
                 OR EXISTS(SELECT 1 FROM save_sessions session WHERE session.staging_object_key=$1 AND session.state IN ('created','uploading','verifying')) \
                 OR EXISTS(SELECT 1 FROM object_retention_holds hold WHERE hold.object_key=$1 AND (hold.retain_until IS NULL OR hold.retain_until>transaction_timestamp()))",
            )
            .bind(&key)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
            if referenced {
                continue;
            }
            sqlx::query("DELETE FROM gc_candidate_leases WHERE object_key=$1 AND lease_expires_at<=transaction_timestamp()")
                .bind(&key).execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
            sqlx::query("UPDATE gc_candidates SET status='queued',retry_at=NULL,started_at=NULL,updated_at=transaction_timestamp() WHERE object_key=$1 AND status='running'")
                .bind(&key).execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
            sqlx::query("UPDATE gc_candidates SET status='running',attempts=attempts+1,retry_at=NULL,started_at=transaction_timestamp(),updated_at=transaction_timestamp() WHERE object_key=$1")
                .bind(&key).execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
            sqlx::query("INSERT INTO gc_candidate_leases(object_key,lease_owner,lease_expires_at) VALUES($1,$2::uuid,transaction_timestamp()+make_interval(secs=>$3))")
                .bind(&key).bind(owner.to_string()).bind(lease).execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
            jobs.push(GcJob {
                key: ObjectKey::parse(key).map_err(|_| PolicyMaintenanceError::Invariant)?,
                attempt: attempts + 1,
                expected_sha256,
                expected_bytes,
            });
        }
        tx.commit()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        Ok(jobs)
    }

    async fn process_gc(
        &self,
        owner: Uuid,
        job: GcJob,
    ) -> Result<GcResult, PolicyMaintenanceError> {
        let outcome = time::timeout(ITEM_TIMEOUT, self.backend.delete_object(job.key.clone()))
            .await
            .unwrap_or(ObjectDeleteOutcome::Retryable);
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let key = job.key.expose();
        let owned: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM gc_candidate_leases WHERE object_key=$1 AND lease_owner=$2::uuid AND lease_expires_at>transaction_timestamp())",
        )
        .bind(key).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
        if !owned {
            return Err(PolicyMaintenanceError::Invariant);
        }
        sqlx::query("SELECT lock_bundle_object_lifecycle($1)")
            .bind(key)
            .execute(&mut *tx)
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        let referenced: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM projects project JOIN bundles bundle ON bundle.id=project.working_head_bundle_id WHERE bundle.object_key=$1) \
             OR EXISTS(SELECT 1 FROM project_bundle_refs reference JOIN bundles bundle ON bundle.id=reference.bundle_id WHERE bundle.object_key=$1) \
             OR EXISTS(SELECT 1 FROM save_sessions session WHERE session.staging_object_key=$1 AND session.state IN ('created','uploading','verifying')) \
             OR EXISTS(SELECT 1 FROM object_retention_holds hold WHERE hold.object_key=$1 AND (hold.retain_until IS NULL OR hold.retain_until>transaction_timestamp()))",
        ).bind(key).fetch_one(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
        let result = if referenced {
            sqlx::query("UPDATE gc_candidates SET status='failed',retry_at=NULL,updated_at=transaction_timestamp() WHERE object_key=$1 AND status='running'")
                .bind(key).execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
            sqlx::query(
                "DELETE FROM gc_candidate_leases WHERE object_key=$1 AND lease_owner=$2::uuid",
            )
            .bind(key)
            .bind(owner.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
            sqlx::query("DELETE FROM gc_candidates WHERE object_key=$1 AND status='failed'")
                .bind(key)
                .execute(&mut *tx)
                .await
                .map_err(|_| PolicyMaintenanceError::Database)?;
            GcResult::Failed
        } else {
            match outcome {
                ObjectDeleteOutcome::Deleted | ObjectDeleteOutcome::Absent => {
                    let receipt_outcome = if outcome == ObjectDeleteOutcome::Deleted {
                        "deleted"
                    } else {
                        "absent"
                    };
                    sqlx::query("INSERT INTO gc_object_deletion_receipts(object_key,expected_sha256,expected_bytes,outcome) VALUES($1,$2,$3,$4) ON CONFLICT(object_key) DO NOTHING")
                        .bind(key).bind(&job.expected_sha256).bind(job.expected_bytes).bind(receipt_outcome)
                        .execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
                    sqlx::query("UPDATE gc_candidates SET status='completed',retry_at=NULL,completed_at=transaction_timestamp(),updated_at=transaction_timestamp() WHERE object_key=$1 AND status='running'")
                        .bind(key).execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
                    GcResult::Completed
                }
                ObjectDeleteOutcome::Retryable if job.attempt < MAX_ATTEMPTS => {
                    let backoff = i64::from(
                        1_i32
                            << u32::try_from(job.attempt.saturating_sub(1))
                                .unwrap_or(0)
                                .min(10),
                    );
                    sqlx::query("UPDATE gc_candidates SET status='retry_wait',retry_at=transaction_timestamp()+make_interval(secs=>$2),updated_at=transaction_timestamp() WHERE object_key=$1 AND status='running'")
                        .bind(key).bind(backoff).execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
                    GcResult::Retry
                }
                ObjectDeleteOutcome::Retryable | ObjectDeleteOutcome::Permanent => {
                    sqlx::query("UPDATE gc_candidates SET status='failed',retry_at=NULL,updated_at=transaction_timestamp() WHERE object_key=$1 AND status='running'")
                        .bind(key).execute(&mut *tx).await.map_err(|_| PolicyMaintenanceError::Database)?;
                    GcResult::Failed
                }
            }
        };
        sqlx::query("DELETE FROM gc_candidate_leases WHERE object_key=$1 AND lease_owner=$2::uuid")
            .bind(key)
            .bind(owner.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        tx.commit()
            .await
            .map_err(|_| PolicyMaintenanceError::Database)?;
        Ok(result)
    }
}

#[derive(Clone)]
struct GcJob {
    key: ObjectKey,
    attempt: i32,
    expected_sha256: Vec<u8>,
    expected_bytes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GcResult {
    Completed,
    Retry,
    Failed,
}

fn retention_days(
    snapshot: &EffectivePolicySnapshot,
    key: &str,
) -> Result<Option<i32>, PolicyMaintenanceError> {
    match snapshot.value(key) {
        Some(serde_json::Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|days| i32::try_from(days).ok())
            .map(Some)
            .ok_or(PolicyMaintenanceError::Invariant),
        None => Err(PolicyMaintenanceError::Invariant),
    }
}

fn map_policy(_: EffectivePolicyError) -> PolicyMaintenanceError {
    PolicyMaintenanceError::Policy
}
