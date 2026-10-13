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

impl Default for AdminAuditListInput {
    fn default() -> Self {
        Self {
            from: None,
            to: None,
            actor_type: None,
            actor_id: None,
            action_code: None,
            result: None,
            scope_type: None,
            scope_id: None,
            target_type: None,
            target_id: None,
            cursor: None,
            limit: DEFAULT_PAGE_SIZE,
        }
    }
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

struct DecodedCursor {
    occurred_at: Timestamp,
    id: AuditEventId,
}

struct AuditPage {
    items: Vec<AdminAuditEventView>,
    next_cursor: Option<String>,
}

impl AdminHttpService {
    pub(crate) async fn list_audit_events(
        &self,
        request: BrowserRequestHeaders<'_>,
        input: AdminAuditListInput,
    ) -> Result<AdminAuditEventCollectionView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        validate_input(&input, MAX_PAGE_SIZE)?;
        runtime
            .within_timeout(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let mut transaction = connection
                    .begin()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                authorize_admin(&mut transaction, session).await?;
                let page = query_page(&mut transaction, &input).await?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                Ok(AdminAuditEventCollectionView {
                    items: page.items,
                    next_cursor: page.next_cursor,
                })
            })
            .await
    }

    pub(crate) async fn get_audit_event(
        &self,
        request: BrowserRequestHeaders<'_>,
        event_id: AuditEventId,
    ) -> Result<AdminAuditEventView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        runtime
            .within_timeout(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let mut transaction = connection
                    .begin()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                authorize_admin(&mut transaction, session).await?;
                let row = sqlx::query(AUDIT_SELECT_BY_ID)
                    .bind(event_id.to_string())
                    .fetch_optional(&mut *transaction)
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?
                    .ok_or(AdminHttpServiceError::AuditEventNotFound)?;
                let event = decode_event(&row)?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                Ok(event)
            })
            .await
    }

    pub(crate) async fn export_audit_events(
        &self,
        request: BrowserRequestHeaders<'_>,
        mut input: AdminAuditExportInput,
        correlation_id: &str,
    ) -> Result<AdminAuditExportView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        input.query.limit = MAX_EXPORT_EVENTS;
        validate_input(&input.query, MAX_EXPORT_EVENTS)?;
        runtime
            .within_timeout(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let mut transaction = connection
                    .begin()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let actor = authorize_admin(&mut transaction, session).await?;
                let page = query_page(&mut transaction, &input.query).await?;
                let bytes = encode_export(&page.items, input.format)?;
                append_export_audit(
                    &mut transaction,
                    &actor,
                    correlation_id,
                    input.format,
                    page.items.len(),
                )
                .await?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let (content_type, filename) = match input.format {
                    AdminAuditExportFormat::Jsonl => {
                        ("application/x-ndjson; charset=utf-8", "nuriteo-audit.jsonl")
                    }
                    AdminAuditExportFormat::Csv => ("text/csv; charset=utf-8", "nuriteo-audit.csv"),
                };
                Ok(AdminAuditExportView {
                    bytes,
                    content_type,
                    filename,
                    next_cursor: page.next_cursor,
                })
            })
            .await
    }

    pub(crate) async fn preview_audit_retention(
        &self,
        request: BrowserRequestHeaders<'_>,
        retention_days: Option<u16>,
    ) -> Result<AdminAuditRetentionPreview, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        validate_retention(retention_days)?;
        runtime
            .within_timeout(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                let mut transaction = connection
                    .begin()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                authorize_admin(&mut transaction, session).await?;
                let preview = retention_preview(&mut transaction, retention_days).await?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| AdminHttpServiceError::Unavailable)?;
                Ok(preview)
            })
            .await
    }

    pub(crate) async fn prune_audit_retention(
        &self,
        request: BrowserRequestHeaders<'_>,
        limit: u16,
        correlation_id: &str,
    ) -> Result<AdminAuditRetentionPruneView, AdminHttpServiceError> {
        let runtime = self.runtime()?;
        let session = runtime.authenticate(request).await?;
        if !(1..=MAX_PRUNE_LIMIT).contains(&limit) {
            return Err(AdminHttpServiceError::InvalidAuditQuery);
        }
        runtime
            .within_timeout(prune_retention(runtime, session, limit, correlation_id))
            .await
    }
}

async fn query_page(
    transaction: &mut Transaction<'_, Postgres>,
    input: &AdminAuditListInput,
) -> Result<AuditPage, AdminHttpServiceError> {
    let cursor = input.cursor.as_deref().map(decode_cursor).transpose()?;
    let row_limit = i64::from(input.limit) + 1;
    let rows = sqlx::query(AUDIT_LIST_QUERY)
        .bind(input.from.map(|value| value.to_string()))
        .bind(input.to.map(|value| value.to_string()))
        .bind(&input.actor_type)
        .bind(&input.actor_id)
        .bind(&input.action_code)
        .bind(&input.result)
        .bind(&input.scope_type)
        .bind(&input.scope_id)
        .bind(&input.target_type)
        .bind(&input.target_id)
        .bind(cursor.as_ref().map(|value| value.occurred_at.to_string()))
        .bind(cursor.as_ref().map(|value| value.id.to_string()))
        .bind(row_limit)
        .fetch_all(&mut **transaction)
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let mut items = rows
        .iter()
        .map(decode_event)
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = items.len() > usize::from(input.limit);
    if has_more {
        items.pop();
    }
    let next_cursor = if has_more {
        items.last().map(encode_cursor).transpose()?
    } else {
        None
    };
    Ok(AuditPage { items, next_cursor })
}

fn validate_input(
    input: &AdminAuditListInput,
    maximum_limit: u16,
) -> Result<(), AdminHttpServiceError> {
    if !(1..=maximum_limit).contains(&input.limit)
        || input.from.zip(input.to).is_some_and(|(from, to)| from > to)
    {
        return Err(AdminHttpServiceError::InvalidAuditQuery);
    }
    validate_optional_enum(
        input.actor_type.as_deref(),
        &["user", "system", "bootstrap", "background_job", "cli"],
    )?;
    validate_optional_enum(input.result.as_deref(), &["succeeded", "denied", "failed"])?;
    validate_optional_enum(
        input.scope_type.as_deref(),
        &["instance", "workspace", "organization", "project", "user"],
    )?;
    for (value, maximum, code) in [
        (input.actor_id.as_deref(), 200, false),
        (input.action_code.as_deref(), 128, true),
        (input.scope_id.as_deref(), 200, false),
        (input.target_type.as_deref(), 64, true),
        (input.target_id.as_deref(), 200, false),
    ] {
        if value.is_some_and(|value| {
            if code {
                !valid_code(value, maximum)
            } else {
                !valid_text(value, maximum)
            }
        }) {
            return Err(AdminHttpServiceError::InvalidAuditQuery);
        }
    }
    if let Some(cursor) = input.cursor.as_deref() {
        decode_cursor(cursor)?;
    }
    Ok(())
}

fn validate_optional_enum(
    value: Option<&str>,
    allowed: &[&str],
) -> Result<(), AdminHttpServiceError> {
    if value.is_some_and(|value| !allowed.contains(&value)) {
        return Err(AdminHttpServiceError::InvalidAuditQuery);
    }
    Ok(())
}

fn valid_code(value: &str, maximum: usize) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && value.len() <= maximum
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
}

fn valid_text(value: &str, maximum: usize) -> bool {
    value == value.trim_matches(' ')
        && (1..=maximum).contains(&value.chars().count())
        && !value.chars().any(char::is_control)
}

fn decode_cursor(value: &str) -> Result<DecodedCursor, AdminHttpServiceError> {
    if value.len() > MAX_CURSOR_BYTES || value.is_empty() {
        return Err(AdminHttpServiceError::InvalidAuditQuery);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AdminHttpServiceError::InvalidAuditQuery)?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err(AdminHttpServiceError::InvalidAuditQuery);
    }
    let cursor: AuditCursor =
        serde_json::from_slice(&bytes).map_err(|_| AdminHttpServiceError::InvalidAuditQuery)?;
    let occurred_at: Timestamp = cursor
        .occurred_at
        .parse()
        .map_err(|_| AdminHttpServiceError::InvalidAuditQuery)?;
    let id: AuditEventId = cursor
        .id
        .parse()
        .map_err(|_| AdminHttpServiceError::InvalidAuditQuery)?;
    let canonical = AuditCursor {
        occurred_at: occurred_at.to_string(),
        id: id.to_string(),
    };
    let encoded = serde_json::to_vec(&canonical).map_err(|_| AdminHttpServiceError::Internal)?;
    if URL_SAFE_NO_PAD.encode(encoded) != value {
        return Err(AdminHttpServiceError::InvalidAuditQuery);
    }
    Ok(DecodedCursor { occurred_at, id })
}

fn encode_cursor(event: &AdminAuditEventView) -> Result<String, AdminHttpServiceError> {
    let cursor = AuditCursor {
        occurred_at: event.occurred_at.clone(),
        id: event.id.clone(),
    };
    serde_json::to_vec(&cursor)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| AdminHttpServiceError::Internal)
}

fn decode_event(row: &sqlx::postgres::PgRow) -> Result<AdminAuditEventView, AdminHttpServiceError> {
    let id: String = row
        .try_get("id")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let event_id = id.parse().map_err(|_| AdminHttpServiceError::Internal)?;
    let occurred_at: OffsetDateTime = row
        .try_get("occurred_at")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let occurred_at =
        Timestamp::from_datetime(occurred_at).map_err(|_| AdminHttpServiceError::Internal)?;
    let actor_type: String = row
        .try_get("actor_type")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let actor_kind = actor_type_from_str(&actor_type)?;
    let actor_id: String = row
        .try_get("actor_id")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let actor_user_id: Option<String> = row
        .try_get("actor_user_id")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let actor_user_id = actor_user_id
        .as_deref()
        .map(UserId::from_str)
        .transpose()
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let validation_actor_user_id = match (actor_kind, actor_user_id) {
        (ActorType::User, None) => {
            Some(UserId::from_str(&actor_id).map_err(|_| AdminHttpServiceError::Internal)?)
        }
        (_, value) => value,
    };
    let actor_display_name: Option<String> = row
        .try_get("actor_display_name")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let action_code: String = row
        .try_get("action_code")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let target_type: String = row
        .try_get("target_type")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let target_id: String = row
        .try_get("target_id")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let scope_type: String = row
        .try_get("scope_type")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let scope_kind = scope_type_from_str(&scope_type)?;
    let scope_id: String = row
        .try_get("scope_id")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let result: String = row
        .try_get("result")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let result_kind = result_from_str(&result)?;
    let reason_code: Option<String> = row
        .try_get("reason_code")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let correlation_id: String = row
        .try_get("correlation_id")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let source_ip: Option<String> = row
        .try_get("source_ip")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let parsed_source_ip = source_ip
        .as_deref()
        .map(IpAddr::from_str)
        .transpose()
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let schema_version: i32 = row
        .try_get("schema_version")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let changed_fields: Vec<String> = row
        .try_get("changed_fields")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let metadata_text: String = row
        .try_get("metadata")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let metadata: Value =
        serde_json::from_str(&metadata_text).map_err(|_| AdminHttpServiceError::Internal)?;
    let validated_metadata =
        AuditMetadata::new(metadata.clone()).map_err(|_| AdminHttpServiceError::Internal)?;
    AuditEvent::new(AuditEventFields {
        id: event_id,
        occurred_at,
        actor: AuditActor {
            kind: actor_kind,
            id: actor_id.clone(),
            user_id: validation_actor_user_id,
            display_name: actor_display_name.clone(),
        },
        action_code: action_code.clone(),
        target: AuditTarget {
            kind: target_type.clone(),
            id: target_id.clone(),
        },
        scope: AuditScope {
            kind: scope_kind,
            id: scope_id.clone(),
        },
        result: result_kind,
        reason_code: reason_code.clone(),
        correlation_id: correlation_id.clone(),
        source_ip: parsed_source_ip,
        schema_version,
        changed_fields: changed_fields.clone(),
        metadata: validated_metadata,
    })
    .map_err(|_| AdminHttpServiceError::Internal)?;
    Ok(AdminAuditEventView {
        id: event_id.to_string(),
        occurred_at: occurred_at.to_string(),
        actor_type,
        actor_id,
        actor_display_name,
        action_code,
        target_type,
        target_id,
        scope_type,
        scope_id,
        result,
        reason_code,
        correlation_id,
        source_ip,
        schema_version,
        changed_fields,
        metadata,
    })
}

fn actor_type_from_str(value: &str) -> Result<ActorType, AdminHttpServiceError> {
    match value {
        "user" => Ok(ActorType::User),
        "system" => Ok(ActorType::System),
        "bootstrap" => Ok(ActorType::Bootstrap),
        "background_job" => Ok(ActorType::BackgroundJob),
        "cli" => Ok(ActorType::Cli),
        _ => Err(AdminHttpServiceError::Internal),
    }
}

fn scope_type_from_str(value: &str) -> Result<ScopeType, AdminHttpServiceError> {
    match value {
        "instance" => Ok(ScopeType::Instance),
        "workspace" => Ok(ScopeType::Workspace),
        "organization" => Ok(ScopeType::Organization),
        "project" => Ok(ScopeType::Project),
        "user" => Ok(ScopeType::User),
        _ => Err(AdminHttpServiceError::Internal),
    }
}

fn result_from_str(value: &str) -> Result<AuditResult, AdminHttpServiceError> {
    match value {
        "succeeded" => Ok(AuditResult::Succeeded),
        "denied" => Ok(AuditResult::Denied),
        "failed" => Ok(AuditResult::Failed),
        _ => Err(AdminHttpServiceError::Internal),
    }
}

async fn authorize_admin(
    transaction: &mut Transaction<'_, Postgres>,
    session: AdminSession,
) -> Result<AuditActorIdentity, AdminHttpServiceError> {
    let row = sqlx::query(
        "SELECT actor.display_name, transaction_timestamp() AS now \
         FROM users actor JOIN sessions active ON active.user_id = actor.id \
         WHERE actor.id = $1::uuid AND active.id = $2::uuid \
           AND actor.status = 'active' AND actor.is_instance_admin \
           AND active.revoked_at IS NULL \
           AND active.idle_expires_at > transaction_timestamp() \
           AND active.absolute_expires_at > transaction_timestamp() \
         FOR SHARE OF actor, active",
    )
    .bind(session.user_id.to_string())
    .bind(session.session_id.to_string())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?
    .ok_or(AdminHttpServiceError::Forbidden)?;
    let now: OffsetDateTime = row
        .try_get("now")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    Ok(AuditActorIdentity {
        user_id: session.user_id,
        display_name: row
            .try_get("display_name")
            .map_err(|_| AdminHttpServiceError::Internal)?,
        occurred_at: Timestamp::from_datetime(now).map_err(|_| AdminHttpServiceError::Internal)?,
        last_reauthenticated_at: None,
    })
}

fn encode_export(
    events: &[AdminAuditEventView],
    format: AdminAuditExportFormat,
) -> Result<Vec<u8>, AdminHttpServiceError> {
    let mut output = Vec::new();
    match format {
        AdminAuditExportFormat::Jsonl => {
            for event in events {
                serde_json::to_writer(&mut output, event)
                    .map_err(|_| AdminHttpServiceError::Internal)?;
                output.push(b'\n');
                if output.len() > MAX_EXPORT_BYTES {
                    return Err(AdminHttpServiceError::AuditExportTooLarge);
                }
            }
        }
        AdminAuditExportFormat::Csv => encode_csv(events, &mut output)?,
    }
    Ok(output)
}

fn encode_csv(
    events: &[AdminAuditEventView],
    output: &mut Vec<u8>,
) -> Result<(), AdminHttpServiceError> {
    output.extend_from_slice(b"id,occurred_at,actor_type,actor_id,actor_display_name,action_code,target_type,target_id,scope_type,scope_id,result,reason_code,correlation_id,source_ip,schema_version,changed_fields,metadata\r\n");
    for event in events {
        let changed = serde_json::to_string(&event.changed_fields)
            .map_err(|_| AdminHttpServiceError::Internal)?;
        let metadata =
            serde_json::to_string(&event.metadata).map_err(|_| AdminHttpServiceError::Internal)?;
        let fields = [
            event.id.as_str(),
            event.occurred_at.as_str(),
            event.actor_type.as_str(),
            event.actor_id.as_str(),
            event.actor_display_name.as_deref().unwrap_or(""),
            event.action_code.as_str(),
            event.target_type.as_str(),
            event.target_id.as_str(),
            event.scope_type.as_str(),
            event.scope_id.as_str(),
            event.result.as_str(),
            event.reason_code.as_deref().unwrap_or(""),
            event.correlation_id.as_str(),
            event.source_ip.as_deref().unwrap_or(""),
            &event.schema_version.to_string(),
            &changed,
            &metadata,
        ];
        let line = fields
            .iter()
            .map(|value| csv_cell(value))
            .collect::<Vec<_>>()
            .join(",");
        output.extend_from_slice(line.as_bytes());
        output.extend_from_slice(b"\r\n");
        if output.len() > MAX_EXPORT_BYTES {
            return Err(AdminHttpServiceError::AuditExportTooLarge);
        }
    }
    Ok(())
}

fn csv_cell(value: &str) -> String {
    let formula_safe = if value
        .as_bytes()
        .first()
        .is_some_and(|byte| matches!(byte, b'=' | b'+' | b'-' | b'@'))
    {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    format!("\"{}\"", formula_safe.replace('"', "\"\""))
}

async fn append_export_audit(
    transaction: &mut Transaction<'_, Postgres>,
    actor: &AuditActorIdentity,
    correlation_id: &str,
    format: AdminAuditExportFormat,
    event_count: usize,
) -> Result<(), AdminHttpServiceError> {
    let format_name = match format {
        AdminAuditExportFormat::Jsonl => "jsonl",
        AdminAuditExportFormat::Csv => "csv",
    };
    append_operation_audit(
        transaction,
        actor,
        correlation_id,
        "audit.exported",
        json!({"eventCount": event_count, "format": format_name}),
    )
    .await
}

async fn prune_retention(
    runtime: &AdminRuntime,
    session: AdminSession,
    limit: u16,
    correlation_id: &str,
) -> Result<AdminAuditRetentionPruneView, AdminHttpServiceError> {
    let mut connection = runtime
        .pool
        .acquire()
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let actor = authorize_recent_admin(&mut transaction, session).await?;
    let retention_days = current_retention_days(&mut transaction).await?;
    let Some(days) = retention_days else {
        append_operation_audit(
            &mut transaction,
            &actor,
            correlation_id,
            "audit.retention_pruned",
            json!({
                "deletedCount": 0,
                "moreExpiredEvents": false,
                "retentionDays": null
            }),
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|_| AdminHttpServiceError::Unavailable)?;
        return Ok(AdminAuditRetentionPruneView {
            retention_days: None,
            deleted_count: 0,
            oldest_deleted_at: None,
            newest_deleted_at: None,
            more_expired_events: false,
        });
    };
    let deleted = sqlx::query(
        "WITH candidates AS ( \
           SELECT id FROM audit_events \
           WHERE occurred_at < transaction_timestamp() - make_interval(days => $1::int) \
             AND NOT EXISTS (SELECT 1 FROM project_history_promotions promotion \
                             WHERE promotion.audit_event_id = audit_events.id) \
           ORDER BY occurred_at ASC, id ASC LIMIT $2 FOR UPDATE SKIP LOCKED \
         ), removed AS ( \
           DELETE FROM audit_events event USING candidates \
           WHERE event.id = candidates.id RETURNING event.occurred_at \
         ) SELECT COUNT(*)::bigint AS count, MIN(occurred_at) AS oldest, \
                  MAX(occurred_at) AS newest FROM removed",
    )
    .bind(i32::from(days))
    .bind(i64::from(limit))
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?;
    let deleted_count: i64 = deleted
        .try_get("count")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let oldest: Option<OffsetDateTime> = deleted
        .try_get("oldest")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let newest: Option<OffsetDateTime> = deleted
        .try_get("newest")
        .map_err(|_| AdminHttpServiceError::Internal)?;
    let more_expired_events: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM audit_events \
         WHERE occurred_at < transaction_timestamp() - make_interval(days => $1::int) \
           AND NOT EXISTS (SELECT 1 FROM project_history_promotions promotion \
                           WHERE promotion.audit_event_id = audit_events.id))",
    )
    .bind(i32::from(days))
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| AdminHttpServiceError::Unavailable)?;
    append_operation_audit(
        &mut transaction,
        &actor,
        correlation_id,
        "audit.retention_pruned",
        json!({
            "deletedCount": deleted_count,
            "moreExpiredEvents": more_expired_events,
            "retentionDays": days
        }),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| AdminHttpServiceError::Unavailable)?;
    Ok(AdminAuditRetentionPruneView {
        retention_days: Some(days),
        deleted_count: u64::try_from(deleted_count).map_err(|_| AdminHttpServiceError::Internal)?,
        oldest_deleted_at: optional_timestamp(oldest)?,
        newest_deleted_at: optional_timestamp(newest)?,
        more_expired_events,
    })
}

async fn retention_preview(
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

async fn current_retention_days(
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

fn validate_retention(retention_days: Option<u16>) -> Result<(), AdminHttpServiceError> {
    if retention_days
        .is_some_and(|value| !(MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS).contains(&value))
    {
        return Err(AdminHttpServiceError::InvalidAuditQuery);
    }
    Ok(())
}

async fn append_operation_audit(
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

fn optional_timestamp(
    value: Option<OffsetDateTime>,
) -> Result<Option<String>, AdminHttpServiceError> {
    value
        .map(Timestamp::from_datetime)
        .transpose()
        .map(|value| value.map(|value| value.to_string()))
        .map_err(|_| AdminHttpServiceError::Internal)
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
