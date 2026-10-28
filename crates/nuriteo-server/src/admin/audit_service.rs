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

use super::http_service::{AdminRuntime, AdminSession, AuditActorIdentity, authorize_recent_admin};

use super::{AdminHttpService, AdminHttpServiceError};

const DEFAULT_PAGE_SIZE: u16 = 50;

const MAX_PAGE_SIZE: u16 = 100;

const MAX_EXPORT_EVENTS: u16 = 1_000;

const MAX_EXPORT_BYTES: usize = 20 * 1024 * 1024;

const MAX_PRUNE_LIMIT: u16 = 1_000;

const MIN_RETENTION_DAYS: u16 = 30;

const MAX_RETENTION_DAYS: u16 = 3_650;

const SHORT_RETENTION_WARNING_DAYS: u16 = 180;

const MAX_CURSOR_BYTES: usize = 512;

#[derive(Debug, Clone)]
pub struct AdminAuditListInput {
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    pub actor_type: Option<String>,
    pub actor_id: Option<String>,
    pub action_code: Option<String>,
    pub result: Option<String>,
    pub scope_type: Option<String>,
    pub scope_id: Option<String>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AdminAuditExportFormat {
    Jsonl,
    Csv,
}

#[derive(Debug, Clone)]
pub struct AdminAuditExportInput {
    pub query: AdminAuditListInput,
    pub format: AdminAuditExportFormat,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminAuditEventView {
    pub id: String,
    pub occurred_at: String,
    pub actor_type: String,
    pub actor_id: String,
    pub actor_display_name: Option<String>,
    pub action_code: String,
    pub target_type: String,
    pub target_id: String,
    pub scope_type: String,
    pub scope_id: String,
    pub result: String,
    pub reason_code: Option<String>,
    pub correlation_id: String,
    pub source_ip: Option<String>,
    pub schema_version: i32,
    pub changed_fields: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminAuditEventCollectionView {
    pub items: Vec<AdminAuditEventView>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminAuditRetentionPreview {
    pub retention_days: Option<u16>,
    pub delete_count: u64,
    pub oldest_occurred_at: Option<String>,
    pub newest_occurred_at: Option<String>,
    pub short_retention_warning: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminAuditRetentionPruneView {
    pub retention_days: Option<u16>,
    pub deleted_count: u64,
    pub oldest_deleted_at: Option<String>,
    pub newest_deleted_at: Option<String>,
    pub more_expired_events: bool,
}

pub struct AdminAuditExportView {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    pub filename: &'static str,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuditCursor {
    occurred_at: String,
    id: String,
}

pub(crate) struct DecodedCursor {
    occurred_at: Timestamp,
    id: AuditEventId,
}

pub(crate) struct AuditPage {
    items: Vec<AdminAuditEventView>,
    next_cursor: Option<String>,
}

const AUDIT_SELECT_BY_ID: &str = "SELECT id::text AS id, occurred_at, actor_type, actor_id, actor_user_id::text AS actor_user_id, \
    actor_display_name, action_code, target_type, target_id, scope_type, scope_id, result, \
    reason_code, correlation_id, host(source_ip) AS source_ip, schema_version, changed_fields, \
    metadata::text AS metadata FROM audit_events WHERE id = $1::uuid";

const AUDIT_LIST_QUERY: &str = concat!(
    "SELECT id::text AS id, occurred_at, actor_type, actor_id, actor_user_id::text AS actor_user_id, ",
    "actor_display_name, action_code, target_type, target_id, scope_type, scope_id, result, ",
    "reason_code, correlation_id, host(source_ip) AS source_ip, schema_version, changed_fields, ",
    "metadata::text AS metadata FROM audit_events WHERE ",
    "($1::timestamptz IS NULL OR occurred_at >= $1::timestamptz) AND ",
    "($2::timestamptz IS NULL OR occurred_at <= $2::timestamptz) AND ",
    "($3::text IS NULL OR actor_type = $3) AND ",
    "($4::text IS NULL OR actor_id = $4) AND ",
    "($5::text IS NULL OR action_code = $5) AND ",
    "($6::text IS NULL OR result = $6) AND ",
    "($7::text IS NULL OR scope_type = $7) AND ",
    "($8::text IS NULL OR scope_id = $8) AND ",
    "($9::text IS NULL OR target_type = $9) AND ",
    "($10::text IS NULL OR target_id = $10) AND ",
    "($11::timestamptz IS NULL OR (occurred_at, id) < ($11::timestamptz, $12::uuid)) ",
    "ORDER BY occurred_at DESC, id DESC LIMIT $13"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_is_canonical_and_filter_bounds_fail_closed() {
        let event = AdminAuditEventView {
            id: "01890f3e-0000-7000-8000-000000000301".into(),
            occurred_at: "2026-10-07T00:00:00Z".into(),
            actor_type: "system".into(),
            actor_id: "fixture".into(),
            actor_display_name: None,
            action_code: "fixture.created".into(),
            target_type: "fixture".into(),
            target_id: "fixture".into(),
            scope_type: "instance".into(),
            scope_id: "instance".into(),
            result: "succeeded".into(),
            reason_code: None,
            correlation_id: "fixture".into(),
            source_ip: None,
            schema_version: 1,
            changed_fields: vec![],
            metadata: json!({}),
        };
        let cursor = encode_cursor(&event).unwrap();
        let decoded = decode_cursor(&cursor).unwrap();
        assert_eq!(decoded.id.to_string(), event.id);
        assert!(decode_cursor("not-canonical").is_err());

        let invalid = AdminAuditListInput {
            action_code: Some("Invalid Action".into()),
            ..AdminAuditListInput::default()
        };
        assert!(validate_input(&invalid, MAX_PAGE_SIZE).is_err());
    }

    #[test]
    fn csv_neutralizes_formula_cells_and_quotes_fields() {
        assert_eq!(csv_cell("=cmd"), "\"'=cmd\"");
        assert_eq!(csv_cell("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_cell("safe"), "\"safe\"");
    }
}

mod events;
pub(crate) use events::*;
mod retention;
pub(crate) use retention::*;
