use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sqlx::{Acquire, Postgres, Row, Transaction};
use tokio::time;
use utoipa::ToSchema;

use crate::config::{INSTANCE_SETTING_REGISTRY_VERSION, instance_setting_definition};
use crate::database::DatabasePool;
use crate::identity::{InvitationExpiryPolicy, SessionPolicy};
use crate::instance_settings::decode_complete_set;
use crate::quota::EffectiveQuota;

use super::maintenance::{GC_ELIGIBLE_PREDICATE, MAX_ATTEMPTS};
use super::{POLICY_DEFINITIONS, validate_policy_values};

const MIN_OPERATION_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectivePolicyError {
    InvalidOperationTimeout,
    OperationTimeout,
    PersistenceUnavailable,
    IncompleteSnapshot,
    InvalidSnapshot,
    UnknownPolicy,
    InvalidCandidate,
    ArithmeticOverflow,
}

impl fmt::Display for EffectivePolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidOperationTimeout => "effective policy operation timeout is invalid",
            Self::OperationTimeout => "effective policy operation timed out",
            Self::PersistenceUnavailable => "effective policy persistence is unavailable",
            Self::IncompleteSnapshot => "effective policy snapshot is incomplete",
            Self::InvalidSnapshot => "effective policy snapshot is invalid",
            Self::UnknownPolicy => "effective policy key is unknown",
            Self::InvalidCandidate => "effective policy candidate is invalid",
            Self::ArithmeticOverflow => "effective policy arithmetic overflowed",
        })
    }
}

impl std::error::Error for EffectivePolicyError {}

#[derive(Clone, PartialEq)]
pub struct EffectivePolicySnapshot {
    values: BTreeMap<&'static str, Value>,
    versions: BTreeMap<&'static str, u64>,
}

impl fmt::Debug for EffectivePolicySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectivePolicySnapshot")
            .field("registry_version", &INSTANCE_SETTING_REGISTRY_VERSION)
            .field("keys", &self.values.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl EffectivePolicySnapshot {
    #[must_use]
    pub fn value(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    #[must_use]
    pub fn lock_version(&self, key: &str) -> Option<u64> {
        self.versions.get(key).copied()
    }

    pub fn session_policy(
        &self,
        operation_timeout: Duration,
    ) -> Result<SessionPolicy, EffectivePolicyError> {
        SessionPolicy::new(
            minutes(self.number("sessions.idle_timeout_minutes")?)?,
            minutes(self.number("sessions.absolute_timeout_minutes")?)?,
            operation_timeout,
        )
        .map_err(|_| EffectivePolicyError::InvalidSnapshot)
    }

    pub fn invitation_expiry(&self) -> Result<InvitationExpiryPolicy, EffectivePolicyError> {
        InvitationExpiryPolicy::new(hours(self.number("invitations.default_expiry_hours")?)?)
            .map_err(|_| EffectivePolicyError::InvalidSnapshot)
    }

    pub fn workspace_quota(
        &self,
        organization: bool,
    ) -> Result<EffectiveQuota, EffectivePolicyError> {
        let key = if organization {
            "workspace.organization_default_quota_bytes"
        } else {
            "workspace.personal_default_quota_bytes"
        };
        match self.values.get(key) {
            Some(Value::Null) => Ok(EffectiveQuota::unlimited()),
            Some(value) => EffectiveQuota::limited(
                value
                    .as_u64()
                    .ok_or(EffectivePolicyError::InvalidSnapshot)?,
            )
            .map_err(|_| EffectivePolicyError::InvalidSnapshot),
            None => Err(EffectivePolicyError::IncompleteSnapshot),
        }
    }

    #[must_use]
    pub fn gc_enabled(&self) -> bool {
        self.values
            .get("object_storage.gc.enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub fn gc_grace_period(&self) -> Result<Duration, EffectivePolicyError> {
        hours(self.number("object_storage.gc.grace_period_hours")?)
    }

    pub fn gc_interval(&self) -> Result<Duration, EffectivePolicyError> {
        hours(self.number("object_storage.gc.interval_hours")?)
    }

    pub fn gc_batch_size(&self) -> Result<u16, EffectivePolicyError> {
        u16::try_from(self.number("object_storage.gc.batch_size")?)
            .map_err(|_| EffectivePolicyError::InvalidSnapshot)
    }

    fn number(&self, key: &str) -> Result<u64, EffectivePolicyError> {
        self.values
            .get(key)
            .and_then(Value::as_u64)
            .ok_or(EffectivePolicyError::IncompleteSnapshot)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PolicyChangeDirection {
    Decrease,
    Increase,
    Unchanged,
    Changed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PolicyApplyScope {
    Immediate,
    NewOperations,
    NewResources,
    NextSweep,
    ServerRestart,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyImpactPreview {
    pub key: String,
    pub direction: PolicyChangeDirection,
    pub apply_scope: PolicyApplyScope,
    pub affected_resources: u64,
    pub non_compliant_resources: u64,
    pub grace_period_seconds: Option<u64>,
    pub requires_recent_reauthentication: bool,
    pub automatically_deletes_existing_data: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyCleanupPreview {
    pub gc_enabled: bool,
    pub grace_period_seconds: u64,
    pub eligible_candidates: u64,
    pub expected_reclaim_bytes: String,
    pub batch_limit: u16,
    pub dry_run: bool,
}

#[derive(Clone)]
pub struct EffectivePolicyEngine {
    pool: DatabasePool,
    operation_timeout: Duration,
}

impl EffectivePolicyEngine {
    pub fn new(
        pool: DatabasePool,
        operation_timeout: Duration,
    ) -> Result<Self, EffectivePolicyError> {
        if !(MIN_OPERATION_TIMEOUT..=MAX_OPERATION_TIMEOUT).contains(&operation_timeout) {
            return Err(EffectivePolicyError::InvalidOperationTimeout);
        }
        Ok(Self {
            pool,
            operation_timeout,
        })
    }

    pub async fn load(&self) -> Result<EffectivePolicySnapshot, EffectivePolicyError> {
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            let snapshot = Self::load_in_transaction(&mut transaction).await?;
            transaction
                .rollback()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            Ok(snapshot)
        })
        .await
        .map_err(|_| EffectivePolicyError::OperationTimeout)?
    }

    /// Reads one complete snapshot under row locks shared with administrator updates.
    pub(crate) async fn load_in_transaction(
        transaction: &mut Transaction<'_, Postgres>,
    ) -> Result<EffectivePolicySnapshot, EffectivePolicyError> {
        Self::load_optional_in_transaction(transaction)
            .await?
            .ok_or(EffectivePolicyError::IncompleteSnapshot)
    }

    /// Empty is a narrow pre-materialization state used by migration/setup tests.
    /// A partially materialized or corrupt registry always fails closed.
    pub(crate) async fn load_optional_in_transaction(
        transaction: &mut Transaction<'_, Postgres>,
    ) -> Result<Option<EffectivePolicySnapshot>, EffectivePolicyError> {
        let rows: Vec<(String, i16, String, String, i64)> = sqlx::query_as(
            "SELECT key,registry_version,value::text,bootstrap_origin,lock_version \
             FROM instance_settings ORDER BY key FOR SHARE",
        )
        .fetch_all(&mut **transaction)
        .await
        .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
        if rows.is_empty() {
            return Ok(None);
        }
        let complete =
            decode_complete_set(rows).map_err(|_| EffectivePolicyError::InvalidSnapshot)?;
        let mut values = BTreeMap::new();
        let mut versions = BTreeMap::new();
        for definition in POLICY_DEFINITIONS {
            let key = definition.field.key();
            let Some(setting) = complete.get(key) else {
                return Err(EffectivePolicyError::IncompleteSnapshot);
            };
            values.insert(key, setting.value().clone());
            versions.insert(key, setting.lock_version());
        }
        validate_policy_values(values.iter().map(|(key, value)| (*key, value)))
            .map_err(|_| EffectivePolicyError::InvalidSnapshot)?;
        Ok(Some(EffectivePolicySnapshot { values, versions }))
    }

    pub async fn preview_change(
        &self,
        key: &str,
        candidate: Value,
    ) -> Result<PolicyImpactPreview, EffectivePolicyError> {
        time::timeout(self.operation_timeout, async {
            let definition = instance_setting_definition(key)
                .filter(|_| {
                    POLICY_DEFINITIONS
                        .iter()
                        .any(|entry| entry.field.key() == key)
                })
                .ok_or(EffectivePolicyError::UnknownPolicy)?;
            definition
                .validate(&candidate)
                .map_err(|_| EffectivePolicyError::InvalidCandidate)?;
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            let current = Self::load_in_transaction(&mut transaction).await?;
            let mut proposed = current.values.clone();
            proposed.insert(definition.key, candidate.clone());
            validate_policy_values(proposed.iter().map(|(field, value)| (*field, value)))
                .map_err(|_| EffectivePolicyError::InvalidCandidate)?;
            let direction = direction(current.value(key), &candidate);
            let (apply_scope, affected, non_compliant, grace) =
                impact(&mut transaction, key, &candidate, &proposed).await?;
            let automatically_deletes_existing_data = affected > 0
                && match key {
                    "audit.retention_days"
                    | "notifications.general_retention_days"
                    | "notifications.security_retention_days"
                    | "object_storage.gc.grace_period_hours" => {
                        direction == PolicyChangeDirection::Decrease
                    }
                    "object_storage.gc.enabled" => candidate == Value::Bool(true),
                    _ => false,
                };
            transaction
                .rollback()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            Ok(PolicyImpactPreview {
                key: key.to_owned(),
                direction,
                apply_scope,
                affected_resources: affected,
                non_compliant_resources: non_compliant,
                grace_period_seconds: grace,
                requires_recent_reauthentication: requires_recent_reauthentication(
                    key,
                    current.value(key),
                    &candidate,
                ),
                automatically_deletes_existing_data,
            })
        })
        .await
        .map_err(|_| EffectivePolicyError::OperationTimeout)?
    }

    pub async fn cleanup_preview(
        &self,
        batch_limit: u16,
    ) -> Result<PolicyCleanupPreview, EffectivePolicyError> {
        if !(1..=100).contains(&batch_limit) {
            return Err(EffectivePolicyError::InvalidCandidate);
        }
        time::timeout(self.operation_timeout, async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            let snapshot = Self::load_in_transaction(&mut transaction).await?;
            let grace = snapshot.gc_grace_period()?;
            let query = format!(
                "SELECT COUNT(*)::bigint,COALESCE(SUM(expected_bytes),0)::text FROM (\
                 SELECT candidate.expected_bytes FROM gc_candidates candidate \
                 LEFT JOIN gc_candidate_leases lease ON lease.object_key=candidate.object_key \
                 WHERE {GC_ELIGIBLE_PREDICATE} ORDER BY candidate.created_at,candidate.object_key LIMIT $3) eligible"
            );
            let row = sqlx::query(sqlx::AssertSqlSafe(query))
            .bind(MAX_ATTEMPTS)
            .bind(
                i64::try_from(grace.as_secs())
                    .map_err(|_| EffectivePolicyError::ArithmeticOverflow)?,
            )
            .bind(i64::from(batch_limit))
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            let count: i64 = row
                .try_get(0)
                .map_err(|_| EffectivePolicyError::InvalidSnapshot)?;
            let bytes: String = row
                .try_get(1)
                .map_err(|_| EffectivePolicyError::InvalidSnapshot)?;
            transaction
                .rollback()
                .await
                .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            Ok(PolicyCleanupPreview {
                gc_enabled: snapshot.gc_enabled(),
                grace_period_seconds: grace.as_secs(),
                eligible_candidates: if snapshot.gc_enabled() {
                    non_negative(count)?
                } else {
                    0
                },
                expected_reclaim_bytes: if snapshot.gc_enabled() {
                    bounded_decimal(bytes)?
                } else {
                    "0".to_owned()
                },
                batch_limit,
                dry_run: true,
            })
        })
        .await
        .map_err(|_| EffectivePolicyError::OperationTimeout)?
    }
}

async fn impact(
    transaction: &mut Transaction<'_, Postgres>,
    key: &str,
    candidate: &Value,
    proposed: &BTreeMap<&'static str, Value>,
) -> Result<(PolicyApplyScope, u64, u64, Option<u64>), EffectivePolicyError> {
    match key {
        "sessions.idle_timeout_minutes" | "sessions.absolute_timeout_minutes" => {
            let idle = number(proposed, "sessions.idle_timeout_minutes")?;
            let absolute = number(proposed, "sessions.absolute_timeout_minutes")?;
            let row: (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL)::bigint, \
                   COUNT(*) FILTER (WHERE revoked_at IS NULL AND \
                     LEAST(last_seen_at + make_interval(secs => $1), \
                           created_at + make_interval(secs => $2)) <= transaction_timestamp())::bigint \
                 FROM sessions",
            )
            .bind(seconds_from_minutes(idle)?)
            .bind(seconds_from_minutes(absolute)?)
            .fetch_one(&mut **transaction)
            .await
            .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            Ok((
                PolicyApplyScope::Immediate,
                non_negative(row.0)?,
                non_negative(row.1)?,
                Some(0),
            ))
        }
        "invitations.default_expiry_hours" => {
            let hours = candidate
                .as_u64()
                .ok_or(EffectivePolicyError::InvalidCandidate)?;
            let affected: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM activation_invitations \
                 WHERE status='pending' AND expires_at > created_at + make_interval(secs => $1)",
            )
            .bind(seconds_from_hours(hours)?)
            .fetch_one(&mut **transaction)
            .await
            .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            Ok((
                PolicyApplyScope::NewResources,
                non_negative(affected)?,
                0,
                None,
            ))
        }
        "workspace.personal_default_quota_bytes" | "workspace.organization_default_quota_bytes" => {
            let organization = key.contains("organization");
            let limit = candidate
                .as_u64()
                .and_then(|value| i64::try_from(value).ok());
            let row: (i64, i64) = sqlx::query_as(
                "WITH selected_scopes AS (SELECT id FROM storage_scopes \
                    WHERE ($1 AND owner_organization_id IS NOT NULL) OR \
                          (NOT $1 AND owner_user_id IS NOT NULL)), \
                  live_bundles AS (SELECT project.storage_scope_id AS scope_id,project.working_head_bundle_id AS bundle_id \
                    FROM projects project JOIN selected_scopes selected ON selected.id=project.storage_scope_id \
                    WHERE project.working_head_bundle_id IS NOT NULL UNION \
                    SELECT reference.storage_scope_id,reference.bundle_id FROM project_bundle_refs reference \
                    JOIN selected_scopes selected ON selected.id=reference.storage_scope_id), \
                  used AS (SELECT live.scope_id,SUM(bundle.physical_bytes) AS bytes FROM live_bundles live \
                    JOIN bundles bundle ON bundle.id=live.bundle_id GROUP BY live.scope_id), \
                  reserved AS (SELECT reservation.storage_scope_id AS scope_id,SUM(reservation.reserved_bytes) AS bytes \
                    FROM storage_reservations reservation JOIN save_sessions session ON session.id=reservation.save_session_id \
                    WHERE reservation.expires_at > transaction_timestamp() \
                      AND session.state IN ('created','uploading','verifying') GROUP BY reservation.storage_scope_id), \
                  usage AS (SELECT selected.id,COALESCE(used.bytes,0)+COALESCE(reserved.bytes,0) AS bytes \
                    FROM selected_scopes selected LEFT JOIN used ON used.scope_id=selected.id \
                    LEFT JOIN reserved ON reserved.scope_id=selected.id) \
                 SELECT COUNT(*)::bigint,COUNT(*) FILTER (WHERE $2::bigint IS NOT NULL AND bytes > $2)::bigint FROM usage",
            )
            .bind(organization)
            .bind(limit)
            .fetch_one(&mut **transaction)
            .await
            .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            Ok((
                PolicyApplyScope::NewOperations,
                non_negative(row.0)?,
                non_negative(row.1)?,
                Some(0),
            ))
        }
        "audit.retention_days" => {
            let Some(days) = candidate.as_u64() else {
                return Ok((PolicyApplyScope::NextSweep, 0, 0, None));
            };
            let affected: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM audit_events WHERE occurred_at < transaction_timestamp() - make_interval(days => $1)",
            )
            .bind(i32::try_from(days).map_err(|_| EffectivePolicyError::ArithmeticOverflow)?)
            .fetch_one(&mut **transaction)
            .await
            .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            Ok((
                PolicyApplyScope::NextSweep,
                non_negative(affected)?,
                0,
                Some(0),
            ))
        }
        "notifications.general_retention_days" | "notifications.security_retention_days" => {
            let Some(days) = candidate.as_u64() else {
                return Ok((PolicyApplyScope::NextSweep, 0, 0, None));
            };
            let security = key.contains("security");
            let affected: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM notifications \
                   WHERE (($1 AND classification IN ('critical_security','account_access')) OR \
                          (NOT $1 AND classification IN ('collaboration','operations'))) \
                     AND created_at < transaction_timestamp() - make_interval(days => $2) \
                     AND status IN ('read','archived') AND action_state<>'pending' \
                     AND NOT EXISTS (SELECT 1 FROM email_outbox delivery \
                       WHERE delivery.notification_id=notifications.id \
                         AND delivery.state IN ('pending','sending','retry_wait','dead_letter'))",
            )
            .bind(security)
            .bind(i32::try_from(days).map_err(|_| EffectivePolicyError::ArithmeticOverflow)?)
            .fetch_one(&mut **transaction)
            .await
            .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
            Ok((
                PolicyApplyScope::NextSweep,
                non_negative(affected)?,
                0,
                Some(0),
            ))
        }
        "object_storage.gc.grace_period_hours" => {
            let hours = candidate
                .as_u64()
                .ok_or(EffectivePolicyError::InvalidCandidate)?;
            let affected = gc_eligible_count(transaction, seconds_from_hours(hours)?).await?;
            Ok((
                PolicyApplyScope::NextSweep,
                affected,
                0,
                Some(seconds_from_hours_u64(hours)?),
            ))
        }
        "object_storage.gc.enabled" => {
            let affected = if candidate == &Value::Bool(true) {
                gc_eligible_count(
                    transaction,
                    seconds_from_hours(number(proposed, "object_storage.gc.grace_period_hours")?)?,
                )
                .await?
            } else {
                0
            };
            Ok((PolicyApplyScope::NextSweep, affected, 0, Some(0)))
        }
        "object_storage.gc.interval_hours" | "object_storage.gc.batch_size" => {
            Ok((PolicyApplyScope::NextSweep, 0, 0, None))
        }
        _ => Ok((
            match instance_setting_definition(key).map(|entry| entry.apply_mode) {
                Some(crate::config::SettingApplyMode::Live) => PolicyApplyScope::NewOperations,
                Some(crate::config::SettingApplyMode::NewRuntime) => PolicyApplyScope::NewResources,
                Some(crate::config::SettingApplyMode::ServerRestart) | None => {
                    PolicyApplyScope::ServerRestart
                }
            },
            0,
            0,
            None,
        )),
    }
}

async fn gc_eligible_count(
    transaction: &mut Transaction<'_, Postgres>,
    grace_seconds: i64,
) -> Result<u64, EffectivePolicyError> {
    let query = format!(
        "SELECT COUNT(*)::bigint FROM gc_candidates candidate \
         LEFT JOIN gc_candidate_leases lease ON lease.object_key=candidate.object_key \
         WHERE {GC_ELIGIBLE_PREDICATE}"
    );
    let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
        .bind(MAX_ATTEMPTS)
        .bind(grace_seconds)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| EffectivePolicyError::PersistenceUnavailable)?;
    non_negative(count)
}

fn direction(current: Option<&Value>, candidate: &Value) -> PolicyChangeDirection {
    match (current, candidate) {
        (Some(current), candidate) if current == candidate => PolicyChangeDirection::Unchanged,
        (Some(Value::Number(current)), Value::Number(candidate)) => {
            match (current.as_u64(), candidate.as_u64()) {
                (Some(current), Some(candidate)) if candidate < current => {
                    PolicyChangeDirection::Decrease
                }
                (Some(current), Some(candidate)) if candidate > current => {
                    PolicyChangeDirection::Increase
                }
                _ => PolicyChangeDirection::Changed,
            }
        }
        (Some(Value::Null), Value::Number(_)) => PolicyChangeDirection::Decrease,
        (Some(Value::Number(_)), Value::Null) => PolicyChangeDirection::Increase,
        _ => PolicyChangeDirection::Changed,
    }
}

pub(crate) fn requires_recent_reauthentication(
    key: &str,
    current: Option<&Value>,
    candidate: &Value,
) -> bool {
    key.starts_with("security.")
        || matches!(
            direction(current, candidate),
            PolicyChangeDirection::Decrease
        )
}

fn number(values: &BTreeMap<&'static str, Value>, key: &str) -> Result<u64, EffectivePolicyError> {
    values
        .get(key)
        .and_then(Value::as_u64)
        .ok_or(EffectivePolicyError::IncompleteSnapshot)
}

fn minutes(value: u64) -> Result<Duration, EffectivePolicyError> {
    Ok(Duration::from_secs(seconds_from_minutes_u64(value)?))
}

fn hours(value: u64) -> Result<Duration, EffectivePolicyError> {
    Ok(Duration::from_secs(seconds_from_hours_u64(value)?))
}

fn seconds_from_minutes(value: u64) -> Result<i64, EffectivePolicyError> {
    i64::try_from(seconds_from_minutes_u64(value)?)
        .map_err(|_| EffectivePolicyError::ArithmeticOverflow)
}

fn seconds_from_minutes_u64(value: u64) -> Result<u64, EffectivePolicyError> {
    value
        .checked_mul(60)
        .ok_or(EffectivePolicyError::ArithmeticOverflow)
}

fn seconds_from_hours(value: u64) -> Result<i64, EffectivePolicyError> {
    i64::try_from(seconds_from_hours_u64(value)?)
        .map_err(|_| EffectivePolicyError::ArithmeticOverflow)
}

fn seconds_from_hours_u64(value: u64) -> Result<u64, EffectivePolicyError> {
    value
        .checked_mul(60 * 60)
        .ok_or(EffectivePolicyError::ArithmeticOverflow)
}

fn non_negative(value: i64) -> Result<u64, EffectivePolicyError> {
    u64::try_from(value).map_err(|_| EffectivePolicyError::InvalidSnapshot)
}

fn bounded_decimal(value: String) -> Result<String, EffectivePolicyError> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(EffectivePolicyError::InvalidSnapshot);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_handles_unlimited_and_numbers_without_value_leakage() {
        assert_eq!(
            direction(Some(&Value::Null), &Value::from(10)),
            PolicyChangeDirection::Decrease
        );
        assert_eq!(
            direction(Some(&Value::from(10)), &Value::Null),
            PolicyChangeDirection::Increase
        );
        assert_eq!(
            direction(Some(&Value::from(10)), &Value::from(9)),
            PolicyChangeDirection::Decrease
        );
        assert!(
            !EffectivePolicyError::InvalidCandidate
                .to_string()
                .contains('9')
        );
    }
}
