#![allow(unused_imports)]
use super::events::*;
use super::*;
use std::net::IpAddr;

use std::str::FromStr;

use base64::Engine as _;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use serde::{Deserialize, Serialize};

use serde_json::{Value, json};

use sqlx::{Acquire, Postgres, Row, Transaction};

use time::OffsetDateTime;

use utoipa::ToSchema;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};

use crate::identity::{BrowserRequestHeaders, Timestamp, UserId};

use super::super::http_service::{
    AdminRuntime, AdminSession, AuditActorIdentity, authorize_recent_admin,
};

use super::super::{AdminHttpService, AdminHttpServiceError};
use super::{
    AUDIT_LIST_QUERY, AUDIT_SELECT_BY_ID, AdminAuditEventCollectionView, AdminAuditEventView,
    AdminAuditExportFormat, AdminAuditExportInput, AdminAuditExportView, AdminAuditListInput,
    AdminAuditRetentionPreview, AdminAuditRetentionPruneView, AuditCursor, AuditPage,
    DEFAULT_PAGE_SIZE, DecodedCursor, MAX_CURSOR_BYTES, MAX_EXPORT_BYTES, MAX_EXPORT_EVENTS,
    MAX_PAGE_SIZE, MAX_PRUNE_LIMIT, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS,
    SHORT_RETENTION_WARNING_DAYS,
};

pub(crate) async fn retention_preview(
    transaction: &mut Transaction<'_, Postgres>,
    retention_days: Option<u16>,
) -> Result<AdminAuditRetentionPreview, AdminHttpServiceError> {
    let Some(days) = retention_days else {
        return Ok(AdminAuditRetentionPreview {
            retention_days: None,
            delete_count: 0,
            oldest_occurred_at: None,
            newest_occurred_at: None,
            short_retention_warning: false,
        });
    };
    let row = sqlx::query(
        "SELECT COUNT(*)::bigint AS count, MIN(occurred_at) AS oldest, \
                MAX(occurred_at) AS newest FROM audit_events \
         WHERE occurred_at < transaction_timestamp() - make_interval(days => $1::int) \
           AND NOT EXISTS (SELECT 1 FROM project_history_promotions promotion \
                           WHERE promotion.audit_event_id = audit_events.id)",
    )
    .bind(i32::from(days))
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let count: i64 = row
        .try_get("count")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    Ok(AdminAuditRetentionPreview {
        retention_days: Some(days),
        delete_count: u64::try_from(count).map_err(|_| AdminHttpServiceError::Internal)?,
        oldest_occurred_at: optional_timestamp(
            row.try_get("oldest")
                .map_err(|_| AdminHttpServiceError::Internal)?,
        )?,
        newest_occurred_at: optional_timestamp(
            row.try_get("newest")
                .map_err(|_| AdminHttpServiceError::Internal)?,
        )?,
        short_retention_warning: days < SHORT_RETENTION_WARNING_DAYS,
    })
}

pub(crate) async fn current_retention_days(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Option<u16>, AdminHttpServiceError> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT value::text FROM instance_settings WHERE key = 'audit.retention_days' FOR SHARE",
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let value: Value = serde_json::from_str(raw.as_deref().ok_or(AdminHttpServiceError::Internal)?)
        .map_err(|_| AdminHttpServiceError::Internal)?;
    match value {
        Value::Null => Ok(None),
        Value::Number(number) => number
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| (MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS).contains(value))
            .map(Some)
            .ok_or(AdminHttpServiceError::Internal),
        _ => Err(AdminHttpServiceError::Internal),
    }
}

pub(crate) fn validate_retention(retention_days: Option<u16>) -> Result<(), AdminHttpServiceError> {
    if retention_days
        .is_some_and(|value| !(MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS).contains(&value))
    {
        return Err(AdminHttpServiceError::InvalidAuditQuery);
    }
    Ok(())
}

pub(crate) async fn append_operation_audit(
    transaction: &mut Transaction<'_, Postgres>,
    actor: &AuditActorIdentity,
    correlation_id: &str,
    action_code: &str,
    metadata: Value,
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
        action_code: action_code.into(),
        target: AuditTarget {
            kind: "audit_log".into(),
            id: "instance".into(),
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

pub(crate) fn optional_timestamp(
    value: Option<OffsetDateTime>,
) -> Result<Option<String>, AdminHttpServiceError> {
    value
        .map(Timestamp::from_datetime)
        .transpose()
        .map(|value| value.map(|value| value.to_string()))
        .map_err(|_| AdminHttpServiceError::Internal)
}
