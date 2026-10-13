use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Acquire, Postgres, Row, Transaction};
use time::{OffsetDateTime, Time};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::identity::{BrowserRequestHeaders, Timestamp};

use super::http_service::{
    AdminHttpService, AdminHttpServiceError, AuditActorIdentity, authorize_recent_admin,
};

const MAX_HISTORY: i64 = 20;
const MAX_RESTORE_POINTS: i64 = 50;

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupPolicyView {
    pub enabled: bool,
    pub interval_hours: u16,
    pub schedule_time: String,
    pub schedule_timezone: String,
    pub daily_retention: Option<u16>,
    pub weekly_retention: Option<u16>,
    pub monthly_retention: Option<u16>,
    pub failed_retention_days: u16,
    pub multipart_cleanup_hours: u16,
    pub warning_after_hours: u16,
    pub critical_after_failures: u16,
    pub drill_frequency: String,
    pub drill_time: String,
    pub drill_timezone: String,
    pub version: u64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AdminBackupPolicyUpdate {
    pub enabled: bool,
    pub interval_hours: u16,
    pub schedule_time: String,
    pub schedule_timezone: String,
    pub daily_retention: Option<u16>,
    pub weekly_retention: Option<u16>,
    pub monthly_retention: Option<u16>,
    pub failed_retention_days: u16,
    pub multipart_cleanup_hours: u16,
    pub warning_after_hours: u16,
    pub critical_after_failures: u16,
    pub drill_frequency: String,
    pub drill_time: String,
    pub drill_timezone: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupRestorePointView {
    pub id: String,
    pub release_version: String,
    pub schema_version: i64,
    pub object_count: u64,
    pub payload_bytes: String,
    pub completed_at: String,
    pub retained_as: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupOperationView {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub backup_id: Option<String>,
    pub state: String,
    pub failure_code: Option<String>,
    pub requested_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupAlertView {
    pub level: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupConsoleView {
    pub policy: AdminBackupPolicyView,
    pub restore_points: Vec<AdminBackupRestorePointView>,
    pub operations: Vec<AdminBackupOperationView>,
    pub alerts: Vec<AdminBackupAlertView>,
    pub prune_candidates: u64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AdminBackupOperationRequest {
    pub kind: String,
    pub backup_id: Option<String>,
}

impl AdminHttpService {
    pub(crate) async fn backup_console(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdminBackupConsoleView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        runtime.authenticate(request).await?;
        runtime.within_timeout(load_console(&runtime.pool)).await
    }

    pub(crate) async fn update_backup_policy(
        &self,
        request: BrowserRequestHeaders<'_>,
        input: AdminBackupPolicyUpdate,
        expected_version: u64,
        correlation_id: &str,
    ) -> Result<AdminBackupConsoleView, AdminHttpServiceError> {
        validate_policy(&input)?;
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        runtime
            .within_timeout(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let mut transaction = connection.begin().await.map_err(unavailable)?;
                let actor = authorize_recent_admin(&mut transaction, session).await?;
                validate_timezone(&mut transaction, &input.schedule_timezone).await?;
                validate_timezone(&mut transaction, &input.drill_timezone).await?;
                let expected = i64::try_from(expected_version)
                    .map_err(|_| AdminHttpServiceError::PreconditionFailed)?;
                let result = sqlx::query(
                    "UPDATE backup_policy SET enabled=$1,interval_hours=$2,schedule_time=$3::time,schedule_timezone=$4,\
                     daily_retention=$5,weekly_retention=$6,monthly_retention=$7,failed_retention_days=$8,\
                     multipart_cleanup_hours=$9,warning_after_hours=$10,critical_after_failures=$11,drill_frequency=$12,\
                     drill_time=$13::time,drill_timezone=$14,lock_version=lock_version+1,\
                     updated_at=transaction_timestamp() WHERE singleton AND lock_version=$15",
                )
                .bind(input.enabled)
                .bind(i32::from(input.interval_hours))
                .bind(&input.schedule_time)
                .bind(&input.schedule_timezone)
                .bind(input.daily_retention.map(i32::from))
                .bind(input.weekly_retention.map(i32::from))
                .bind(input.monthly_retention.map(i32::from))
                .bind(i32::from(input.failed_retention_days))
                .bind(i32::from(input.multipart_cleanup_hours))
                .bind(i32::from(input.warning_after_hours))
                .bind(i32::from(input.critical_after_failures))
                .bind(&input.drill_frequency)
                .bind(&input.drill_time)
                .bind(&input.drill_timezone)
                .bind(expected)
                .execute(&mut *transaction)
                .await
                .map_err(unavailable)?;
                if result.rows_affected() != 1 {
                    return Err(AdminHttpServiceError::PreconditionFailed);
                }
                append_backup_audit(
                    &mut transaction,
                    &actor,
                    "backup.policy_updated",
                    "backup_policy",
                    correlation_id,
                    json!({"source":"admin-backup-api"}),
                )
                .await?;
                transaction.commit().await.map_err(unavailable)?;
                load_console(&runtime.pool).await
            })
            .await
    }

    pub(crate) async fn enqueue_backup_operation(
        &self,
        request: BrowserRequestHeaders<'_>,
        input: AdminBackupOperationRequest,
        correlation_id: &str,
    ) -> Result<AdminBackupConsoleView, AdminHttpServiceError> {
        let backup_id = validate_operation(&input)?;
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        runtime
            .within_timeout(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let mut transaction = connection.begin().await.map_err(unavailable)?;
                let actor = authorize_recent_admin(&mut transaction, session).await?;
                if let Some(id) = backup_id {
                    let exists: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM backup_generations WHERE id=$1::uuid AND state='complete' AND prune_requested_at IS NULL)",
                    )
                    .bind(id.to_string())
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(unavailable)?;
                    if !exists {
                        return Err(AdminHttpServiceError::BackupNotFound);
                    }
                }
                let operation_id = Uuid::now_v7();
                let inserted = sqlx::query(
                    "INSERT INTO backup_operations(id,kind,source,backup_id,requested_by) \
                     VALUES($1::uuid,$2,'manual',$3::uuid,$4::uuid) ON CONFLICT DO NOTHING",
                )
                .bind(operation_id.to_string())
                .bind(&input.kind)
                .bind(backup_id.map(|id| id.to_string()))
                .bind(actor.user_id.to_string())
                .execute(&mut *transaction)
                .await
                .map_err(unavailable)?;
                if inserted.rows_affected() != 1 {
                    return Err(AdminHttpServiceError::BackupOperationActive);
                }
                append_backup_audit(
                    &mut transaction,
                    &actor,
                    "backup.operation_queued",
                    &operation_id.to_string(),
                    correlation_id,
                    json!({"source":"admin-backup-api","kind":input.kind,"backupId":backup_id}),
                )
                .await?;
                transaction.commit().await.map_err(unavailable)?;
                load_console(&runtime.pool).await
            })
            .await
    }
}

async fn load_console(
    pool: &crate::database::DatabasePool,
) -> Result<AdminBackupConsoleView, AdminHttpServiceError> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let policy_row = sqlx::query(
        "SELECT enabled,interval_hours,schedule_time,schedule_timezone,daily_retention,weekly_retention,\
         monthly_retention,failed_retention_days,multipart_cleanup_hours,warning_after_hours,critical_after_failures,\
         drill_frequency,drill_time,drill_timezone,lock_version FROM backup_policy WHERE singleton",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(unavailable)?;
    let policy = policy_from_row(&policy_row)?;
    let restore_rows = sqlx::query(
        "SELECT generation.id::text AS id,generation.nuriteo_version,generation.schema_version,\
         generation.expected_object_count,generation.expected_payload_bytes,generation.completed_at,\
         COALESCE(array_agg(claim.retention_class ORDER BY claim.retention_class) \
           FILTER (WHERE claim.retention_class IS NOT NULL AND (claim.retain_until IS NULL OR claim.retain_until>transaction_timestamp())),ARRAY[]::text[]) AS retained_as \
         FROM backup_generations generation LEFT JOIN backup_retention_claims claim ON claim.backup_id=generation.id \
         WHERE generation.state='complete' AND generation.prune_requested_at IS NULL \
         GROUP BY generation.id ORDER BY generation.completed_at DESC,generation.id DESC LIMIT $1",
    )
    .bind(MAX_RESTORE_POINTS)
    .fetch_all(&mut *connection)
    .await
    .map_err(unavailable)?;
    let restore_points = restore_rows
        .iter()
        .map(restore_point_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let operation_rows = sqlx::query(
        "SELECT id::text AS id,kind,source,backup_id::text AS backup_id,state,failure_code,requested_at,started_at,completed_at \
         FROM backup_operations ORDER BY requested_at DESC,id DESC LIMIT $1",
    )
    .bind(MAX_HISTORY)
    .fetch_all(&mut *connection)
    .await
    .map_err(unavailable)?;
    let operations = operation_rows
        .iter()
        .map(operation_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let latest_overdue: bool = sqlx::query_scalar(
        "SELECT COALESCE(MAX(completed_at) < transaction_timestamp() - make_interval(hours => $1),TRUE) \
         FROM backup_generations WHERE state='complete' AND prune_requested_at IS NULL",
    )
    .bind(i32::from(policy.warning_after_hours))
    .fetch_one(&mut *connection)
    .await
    .map_err(unavailable)?;
    let prune_candidates: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM backup_generations generation WHERE generation.state='complete' \
         AND generation.prune_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM backup_retention_claims claim \
         WHERE claim.backup_id=generation.id AND (claim.retain_until IS NULL OR claim.retain_until>transaction_timestamp()))",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(unavailable)?;
    let alerts = backup_alerts(&policy, &restore_points, &operations, latest_overdue);
    Ok(AdminBackupConsoleView {
        policy,
        restore_points,
        operations,
        alerts,
        prune_candidates: non_negative(prune_candidates)?,
    })
}

fn validate_policy(input: &AdminBackupPolicyUpdate) -> Result<(), AdminHttpServiceError> {
    if parse_time(&input.schedule_time).is_none()
        || parse_time(&input.drill_time).is_none()
        || !(1..=168).contains(&input.interval_hours)
        || input.daily_retention.is_some_and(|value| value > 365)
        || input.weekly_retention.is_some_and(|value| value > 104)
        || input.monthly_retention.is_some_and(|value| value > 120)
        || !(1..=90).contains(&input.failed_retention_days)
        || !(1..=168).contains(&input.multipart_cleanup_hours)
        || !(1..=720).contains(&input.warning_after_hours)
        || !(1..=100).contains(&input.critical_after_failures)
        || !matches!(
            input.drill_frequency.as_str(),
            "off" | "weekly" | "monthly" | "quarterly"
        )
    {
        return Err(AdminHttpServiceError::InvalidBackupPolicy);
    }
    Ok(())
}

fn validate_operation(
    input: &AdminBackupOperationRequest,
) -> Result<Option<Uuid>, AdminHttpServiceError> {
    match input.kind.as_str() {
        "create" | "drill" | "prune" if input.backup_id.is_none() => Ok(None),
        "verify" => input
            .backup_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok())
            .map(Some)
            .ok_or(AdminHttpServiceError::InvalidBackupOperation),
        _ => Err(AdminHttpServiceError::InvalidBackupOperation),
    }
}

async fn validate_timezone(
    transaction: &mut Transaction<'_, Postgres>,
    timezone: &str,
) -> Result<(), AdminHttpServiceError> {
    if timezone.is_empty() || timezone.len() > 128 || timezone.trim() != timezone {
        return Err(AdminHttpServiceError::InvalidBackupPolicy);
    }
    let valid: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
            .bind(timezone)
            .fetch_one(&mut **transaction)
            .await
            .map_err(unavailable)?;
    valid
        .then_some(())
        .ok_or(AdminHttpServiceError::InvalidBackupPolicy)
}

fn policy_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<AdminBackupPolicyView, AdminHttpServiceError> {
    Ok(AdminBackupPolicyView {
        enabled: row.try_get("enabled").map_err(internal)?,
        interval_hours: small_unsigned(row.try_get("interval_hours").map_err(internal)?)?,
        schedule_time: format_time(row.try_get("schedule_time").map_err(internal)?),
        schedule_timezone: row.try_get("schedule_timezone").map_err(internal)?,
        daily_retention: small_optional(row.try_get("daily_retention").map_err(internal)?)?,
        weekly_retention: small_optional(row.try_get("weekly_retention").map_err(internal)?)?,
        monthly_retention: small_optional(row.try_get("monthly_retention").map_err(internal)?)?,
        failed_retention_days: small_unsigned(
            row.try_get("failed_retention_days").map_err(internal)?,
        )?,
        multipart_cleanup_hours: small_unsigned(
            row.try_get("multipart_cleanup_hours").map_err(internal)?,
        )?,
        warning_after_hours: small_unsigned(row.try_get("warning_after_hours").map_err(internal)?)?,
        critical_after_failures: small_unsigned(
            row.try_get("critical_after_failures").map_err(internal)?,
        )?,
        drill_frequency: row.try_get("drill_frequency").map_err(internal)?,
        drill_time: format_time(row.try_get("drill_time").map_err(internal)?),
        drill_timezone: row.try_get("drill_timezone").map_err(internal)?,
        version: u64::try_from(row.try_get::<i64, _>("lock_version").map_err(internal)?)
            .map_err(|_| AdminHttpServiceError::Internal)?,
    })
}

fn restore_point_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<AdminBackupRestorePointView, AdminHttpServiceError> {
    Ok(AdminBackupRestorePointView {
        id: row.try_get("id").map_err(internal)?,
        release_version: row.try_get("nuriteo_version").map_err(internal)?,
        schema_version: row.try_get("schema_version").map_err(internal)?,
        object_count: non_negative(row.try_get("expected_object_count").map_err(internal)?)?,
        payload_bytes: row
            .try_get::<i64, _>("expected_payload_bytes")
            .map_err(internal)?
            .to_string(),
        completed_at: timestamp(row.try_get("completed_at").map_err(internal)?)?,
        retained_as: row.try_get("retained_as").map_err(internal)?,
    })
}

fn operation_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<AdminBackupOperationView, AdminHttpServiceError> {
    Ok(AdminBackupOperationView {
        id: row.try_get("id").map_err(internal)?,
        kind: row.try_get("kind").map_err(internal)?,
        source: row.try_get("source").map_err(internal)?,
        backup_id: row.try_get("backup_id").map_err(internal)?,
        state: row.try_get("state").map_err(internal)?,
        failure_code: row.try_get("failure_code").map_err(internal)?,
        requested_at: timestamp(row.try_get("requested_at").map_err(internal)?)?,
        started_at: optional_timestamp(row.try_get("started_at").map_err(internal)?)?,
        completed_at: optional_timestamp(row.try_get("completed_at").map_err(internal)?)?,
    })
}

fn backup_alerts(
    policy: &AdminBackupPolicyView,
    restore_points: &[AdminBackupRestorePointView],
    operations: &[AdminBackupOperationView],
    latest_overdue: bool,
) -> Vec<AdminBackupAlertView> {
    let mut alerts = Vec::new();
    if !policy.enabled {
        alerts.push(AdminBackupAlertView {
            level: "warning".into(),
            code: "automatic_backup_paused".into(),
            message: "Automatic backups are paused.".into(),
        });
    } else if restore_points.is_empty() {
        alerts.push(AdminBackupAlertView {
            level: "warning".into(),
            code: "no_restore_point".into(),
            message: "No successful restore point is available yet.".into(),
        });
    } else if latest_overdue {
        alerts.push(AdminBackupAlertView {
            level: "warning".into(),
            code: "latest_backup_overdue".into(),
            message: "The latest successful backup is older than the configured warning threshold."
                .into(),
        });
    }
    let consecutive_failures = operations
        .iter()
        .filter(|operation| operation.kind == "create")
        .take_while(|operation| operation.state == "failed")
        .count();
    if consecutive_failures >= usize::from(policy.critical_after_failures) {
        alerts.push(AdminBackupAlertView {
            level: "critical".into(),
            code: "consecutive_failures".into(),
            message: "The configured consecutive backup failure threshold was reached.".into(),
        });
    }
    alerts
}

async fn append_backup_audit(
    transaction: &mut Transaction<'_, Postgres>,
    actor: &AuditActorIdentity,
    action: &str,
    target_id: &str,
    correlation_id: &str,
    metadata: serde_json::Value,
) -> Result<(), AdminHttpServiceError> {
    let event = AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at: actor.occurred_at,
        actor: AuditActor {
            kind: ActorType::User,
            id: actor.user_id.to_string(),
            user_id: Some(actor.user_id),
            display_name: Some(actor.display_name.clone()),
        },
        action_code: action.into(),
        target: AuditTarget {
            kind: "backup".into(),
            id: target_id.into(),
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: "instance".into(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: Vec::new(),
        metadata: AuditMetadata::new(metadata).map_err(|_| AdminHttpServiceError::Internal)?,
    })
    .map_err(|_| AdminHttpServiceError::Internal)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| AdminHttpServiceError::AuditUnavailable)
}

fn parse_time(value: &str) -> Option<Time> {
    let mut parts = value.split(':');
    let hour = parts.next()?.parse().ok()?;
    let minute = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Time::from_hms(hour, minute, 0).ok()
}

fn format_time(value: Time) -> String {
    format!("{:02}:{:02}", value.hour(), value.minute())
}
fn timestamp(value: OffsetDateTime) -> Result<String, AdminHttpServiceError> {
    Timestamp::from_datetime(value)
        .map(|value| value.to_string())
        .map_err(|_| AdminHttpServiceError::Internal)
}
fn optional_timestamp(
    value: Option<OffsetDateTime>,
) -> Result<Option<String>, AdminHttpServiceError> {
    value.map(timestamp).transpose()
}
fn small_unsigned(value: i32) -> Result<u16, AdminHttpServiceError> {
    u16::try_from(value).map_err(|_| AdminHttpServiceError::Internal)
}
fn small_optional(value: Option<i32>) -> Result<Option<u16>, AdminHttpServiceError> {
    value.map(small_unsigned).transpose()
}
fn non_negative(value: i64) -> Result<u64, AdminHttpServiceError> {
    u64::try_from(value).map_err(|_| AdminHttpServiceError::Internal)
}
fn unavailable(_: sqlx::Error) -> AdminHttpServiceError {
    AdminHttpServiceError::Unavailable
}
fn internal(_: sqlx::Error) -> AdminHttpServiceError {
    AdminHttpServiceError::Internal
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> AdminBackupPolicyUpdate {
        AdminBackupPolicyUpdate {
            enabled: true,
            interval_hours: 24,
            schedule_time: "02:00".into(),
            schedule_timezone: "Asia/Seoul".into(),
            daily_retention: Some(7),
            weekly_retention: Some(4),
            monthly_retention: Some(6),
            failed_retention_days: 7,
            multipart_cleanup_hours: 24,
            warning_after_hours: 24,
            critical_after_failures: 3,
            drill_frequency: "monthly".into(),
            drill_time: "03:00".into(),
            drill_timezone: "Asia/Seoul".into(),
        }
    }

    #[test]
    fn policy_and_operation_inputs_are_closed() {
        assert!(validate_policy(&policy()).is_ok());
        let mut invalid = policy();
        invalid.schedule_time = "24:00".into();
        assert!(validate_policy(&invalid).is_err());
        assert!(
            validate_operation(&AdminBackupOperationRequest {
                kind: "create".into(),
                backup_id: None
            })
            .is_ok()
        );
        assert!(
            validate_operation(&AdminBackupOperationRequest {
                kind: "verify".into(),
                backup_id: None
            })
            .is_err()
        );
    }
}
