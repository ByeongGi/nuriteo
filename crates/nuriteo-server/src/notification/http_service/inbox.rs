use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sqlx::{Acquire, Row};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::identity::BrowserRequestHeaders;

use super::{
    DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, NotificationHttpService, NotificationHttpServiceError,
    configure_transaction, format_time,
};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInboxItemView {
    pub id: String,
    pub classification: String,
    pub event_code: String,
    pub title: String,
    pub summary: String,
    pub status: String,
    pub action_state: String,
    pub occurrence_count: u32,
    pub occurred_at: String,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInboxView {
    pub items: Vec<NotificationInboxItemView>,
    pub next_cursor: Option<String>,
    pub unread_count: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InboxCursor {
    snapshot_at: String,
    created_at: String,
    id: String,
}

impl NotificationHttpService {
    pub(crate) async fn inbox(
        &self,
        request: BrowserRequestHeaders<'_>,
        archived: bool,
        cursor: Option<&str>,
        limit: Option<u16>,
    ) -> Result<NotificationInboxView, NotificationHttpServiceError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
        if !(1..=MAX_PAGE_SIZE).contains(&limit) {
            return Err(NotificationHttpServiceError::InvalidInput);
        }
        let cursor = cursor.map(decode_inbox_cursor).transpose()?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        configure_transaction(&mut tx).await?;
        let (snapshot_at, boundary) = if let Some(cursor) = cursor {
            (cursor.snapshot_at, Some((cursor.created_at, cursor.id)))
        } else {
            let snapshot_at: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| NotificationHttpServiceError::Unavailable)?;
            (snapshot_at, None)
        };
        let mut rows = if let Some((created_at, id)) = boundary {
            sqlx::query(
                "SELECT id::text,classification,event_code,status,action_state,occurrence_count,\
                 last_occurred_at,created_at,lock_version FROM notifications WHERE recipient_user_id=$1::uuid \
                 AND (($2 AND status='archived') OR (NOT $2 AND status<>'archived')) \
                 AND created_at<=$3::timestamptz AND (created_at,id)<($4::timestamptz,$5::uuid) \
                 ORDER BY created_at DESC,id DESC LIMIT $6",
            )
            .bind(identity.user_id.to_string())
            .bind(archived)
            .bind(snapshot_at)
            .bind(created_at)
            .bind(id.to_string())
            .bind(i64::from(limit) + 1)
            .fetch_all(&mut *tx)
            .await
        } else {
            sqlx::query(
                "SELECT id::text,classification,event_code,status,action_state,occurrence_count,\
                 last_occurred_at,created_at,lock_version FROM notifications WHERE recipient_user_id=$1::uuid \
                 AND (($2 AND status='archived') OR (NOT $2 AND status<>'archived')) \
                 AND created_at<=$3::timestamptz ORDER BY created_at DESC,id DESC LIMIT $4",
            )
            .bind(identity.user_id.to_string())
            .bind(archived)
            .bind(snapshot_at)
            .bind(i64::from(limit) + 1)
            .fetch_all(&mut *tx)
            .await
        }
        .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        let unread_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE recipient_user_id=$1::uuid \
             AND status='unread' AND created_at<=$2::timestamptz",
        )
        .bind(identity.user_id.to_string())
        .bind(snapshot_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        let next_cursor = if rows.len() > usize::from(limit) {
            rows.pop();
            rows.last()
                .map(|row| encode_inbox_cursor(snapshot_at, row.get("created_at"), row.get("id")))
                .transpose()?
        } else {
            None
        };
        let items = rows
            .into_iter()
            .map(inbox_item)
            .collect::<Result<Vec<_>, _>>()?;
        tx.commit()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        Ok(NotificationInboxView {
            items,
            next_cursor,
            unread_count: u64::try_from(unread_count)
                .map_err(|_| NotificationHttpServiceError::Internal)?,
        })
    }

    pub(crate) async fn update_status(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        status: &str,
        expected_version: u64,
    ) -> Result<NotificationInboxItemView, NotificationHttpServiceError> {
        if !matches!(status, "unread" | "read" | "archived") {
            return Err(NotificationHttpServiceError::InvalidInput);
        }
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let expected = i64::try_from(expected_version)
            .map_err(|_| NotificationHttpServiceError::PreconditionFailed)?;
        let mut connection = runtime
            .pool
            .acquire()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        configure_transaction(&mut tx).await?;
        let row = sqlx::query(
            "UPDATE notifications SET status=$3,updated_at=transaction_timestamp(),lock_version=lock_version+1 \
             WHERE id=$1::uuid AND recipient_user_id=$2::uuid AND lock_version=$4 \
             RETURNING id::text,classification,event_code,status,action_state,occurrence_count,last_occurred_at,lock_version",
        )
        .bind(id.to_string())
        .bind(identity.user_id.to_string())
        .bind(status)
        .bind(expected)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        if let Some(row) = row {
            let item = inbox_item(row)?;
            tx.commit()
                .await
                .map_err(|_| NotificationHttpServiceError::CommitOutcomeUnknown)?;
            return Ok(item);
        }
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM notifications WHERE id=$1::uuid AND recipient_user_id=$2::uuid)",
        )
        .bind(id.to_string())
        .bind(identity.user_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        Err(if exists {
            NotificationHttpServiceError::PreconditionFailed
        } else {
            NotificationHttpServiceError::NotFound
        })
    }
}

fn inbox_item(
    row: sqlx::postgres::PgRow,
) -> Result<NotificationInboxItemView, NotificationHttpServiceError> {
    let classification: String = row.get("classification");
    let event_code: String = row.get("event_code");
    let (title, summary) = notification_copy(&classification, &event_code);
    Ok(NotificationInboxItemView {
        id: row.get("id"),
        classification,
        event_code,
        title: title.into(),
        summary: summary.into(),
        status: row.get("status"),
        action_state: row.get("action_state"),
        occurrence_count: u32::try_from(row.get::<i32, _>("occurrence_count"))
            .map_err(|_| NotificationHttpServiceError::Internal)?,
        occurred_at: format_time(row.get("last_occurred_at"))?,
        version: u64::try_from(row.get::<i64, _>("lock_version"))
            .map_err(|_| NotificationHttpServiceError::Internal)?,
    })
}

fn notification_copy(classification: &str, event_code: &str) -> (&'static str, &'static str) {
    match event_code {
        "access_token.created" => (
            "Access token issued",
            "A new automation credential was issued. Review it if this was unexpected.",
        ),
        "access_token.rotated" => (
            "Access token rotated",
            "An automation credential was replaced and the previous value was revoked.",
        ),
        "access_token.revoked" => (
            "Access token revoked",
            "An automation credential was revoked and can no longer authenticate.",
        ),
        "mfa.enrollment_required" => (
            "Multi-factor authentication required",
            "Complete enrollment before the displayed deadline.",
        ),
        _ => match classification {
            "critical_security" => (
                "Security notification",
                "Review this account security event.",
            ),
            "account_access" => (
                "Account access updated",
                "Review this account or access change.",
            ),
            "collaboration" => ("Collaboration update", "Review this collaboration event."),
            _ => (
                "Operations notification",
                "Review this instance operations event.",
            ),
        },
    }
}

fn encode_inbox_cursor(
    snapshot_at: OffsetDateTime,
    created_at: OffsetDateTime,
    id: String,
) -> Result<String, NotificationHttpServiceError> {
    serde_json::to_vec(&InboxCursor {
        snapshot_at: format_time(snapshot_at)?,
        created_at: format_time(created_at)?,
        id,
    })
    .map(|value| URL_SAFE_NO_PAD.encode(value))
    .map_err(|_| NotificationHttpServiceError::Internal)
}

fn decode_inbox_cursor(value: &str) -> Result<InboxCursorValue, NotificationHttpServiceError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    let cursor: InboxCursor =
        serde_json::from_slice(&bytes).map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    let snapshot_at = OffsetDateTime::parse(&cursor.snapshot_at, &Rfc3339)
        .map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    let created_at = OffsetDateTime::parse(&cursor.created_at, &Rfc3339)
        .map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    let id = Uuid::parse_str(&cursor.id).map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    if id.get_version_num() != 7 || created_at > snapshot_at {
        return Err(NotificationHttpServiceError::InvalidInput);
    }
    Ok(InboxCursorValue {
        snapshot_at,
        created_at,
        id,
    })
}

struct InboxCursorValue {
    snapshot_at: OffsetDateTime,
    created_at: OffsetDateTime,
    id: Uuid,
}
