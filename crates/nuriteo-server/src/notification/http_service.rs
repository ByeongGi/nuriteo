use std::fmt;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sqlx::{Acquire, Postgres, Row, Transaction};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionId, SessionPolicy,
    SessionService, SessionServiceError, UserId,
};

const DEFAULT_PAGE_SIZE: u16 = 25;
const MAX_PAGE_SIZE: u16 = 100;
const EXPIRED_RECEIPT_SWEEP_BATCH: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationHttpServiceError {
    AuthenticationFailed,
    Forbidden,
    ReauthenticationRequired,
    InvalidInput,
    NotFound,
    Conflict,
    PreconditionFailed,
    CommitOutcomeUnknown,
    Unavailable,
    Internal,
}

impl fmt::Display for NotificationHttpServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "notification authentication failed",
            Self::Forbidden => "notification request was forbidden",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::InvalidInput => "notification request is invalid",
            Self::NotFound => "notification resource was not found",
            Self::Conflict => "notification operation conflicts with current state",
            Self::PreconditionFailed => "notification version is stale",
            Self::CommitOutcomeUnknown => "notification commit outcome is unknown",
            Self::Unavailable => "notification service is unavailable",
            Self::Internal => "notification operation failed",
        })
    }
}

impl std::error::Error for NotificationHttpServiceError {}

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

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferencesView {
    pub critical_security: bool,
    pub account_access: bool,
    pub collaboration: bool,
    pub operations: bool,
    pub smtp_configured: bool,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EmailDeliveryView {
    pub id: String,
    pub recipient_email: String,
    pub classification: String,
    pub template_id: String,
    pub resource_type: String,
    pub resource_id: String,
    pub state: String,
    pub attempt_count: u16,
    pub smtp_code: Option<u16>,
    pub error_class: Option<String>,
    pub available_at: String,
    pub updated_at: String,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EmailDeliveryCollectionView {
    pub items: Vec<EmailDeliveryView>,
    pub next_cursor: Option<String>,
    pub smtp_configured: bool,
}

#[derive(Clone)]
pub struct NotificationHttpService {
    runtime: Option<Arc<NotificationRuntime>>,
}

struct NotificationRuntime {
    pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
}

#[derive(Clone, Copy)]
struct AuthenticatedIdentity {
    user_id: UserId,
    session_id: SessionId,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageCursor {
    timestamp: String,
    id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InboxCursor {
    snapshot_at: String,
    created_at: String,
    id: String,
}

impl fmt::Debug for NotificationHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl NotificationHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        session_policy: SessionPolicy,
    ) -> Result<Self, NotificationHttpServiceError> {
        let cookies = BrowserCookieBoundary::new(external_url)
            .map_err(|_| NotificationHttpServiceError::Internal)?;
        Ok(Self {
            runtime: Some(Arc::new(NotificationRuntime {
                sessions: SessionService::new(pool.clone(), session_policy),
                pool,
                cookies,
            })),
        })
    }

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

    pub(crate) async fn preferences(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<NotificationPreferencesView, NotificationHttpServiceError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
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
        let view = load_preferences(&mut tx, identity.user_id).await?;
        tx.commit()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        Ok(view)
    }

    pub(crate) async fn update_preferences(
        &self,
        request: BrowserRequestHeaders<'_>,
        account_access: bool,
        collaboration: bool,
        operations: bool,
        expected_version: u64,
    ) -> Result<NotificationPreferencesView, NotificationHttpServiceError> {
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
        let changed = if expected == 1 {
            sqlx::query(
                "INSERT INTO notification_email_preferences(user_id,account_access,collaboration,operations,lock_version) \
                 VALUES($1::uuid,$2,$3,$4,2) ON CONFLICT(user_id) DO UPDATE SET \
                 account_access=EXCLUDED.account_access,collaboration=EXCLUDED.collaboration,\
                 operations=EXCLUDED.operations,updated_at=transaction_timestamp(),\
                 lock_version=notification_email_preferences.lock_version+1 \
                 WHERE notification_email_preferences.lock_version=1 RETURNING lock_version",
            )
            .bind(identity.user_id.to_string())
            .bind(account_access)
            .bind(collaboration)
            .bind(operations)
            .fetch_optional(&mut *tx)
            .await
        } else {
            sqlx::query(
                "UPDATE notification_email_preferences SET account_access=$2,collaboration=$3,operations=$4,\
                 updated_at=transaction_timestamp(),lock_version=lock_version+1 \
                 WHERE user_id=$1::uuid AND lock_version=$5 RETURNING lock_version",
            )
            .bind(identity.user_id.to_string())
            .bind(account_access)
            .bind(collaboration)
            .bind(operations)
            .bind(expected)
            .fetch_optional(&mut *tx)
            .await
        }
        .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        if changed.is_none() {
            return Err(NotificationHttpServiceError::PreconditionFailed);
        }
        let view = load_preferences(&mut tx, identity.user_id).await?;
        tx.commit()
            .await
            .map_err(|_| NotificationHttpServiceError::CommitOutcomeUnknown)?;
        Ok(view)
    }

    pub(crate) async fn deliveries(
        &self,
        request: BrowserRequestHeaders<'_>,
        state: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u16>,
    ) -> Result<EmailDeliveryCollectionView, NotificationHttpServiceError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let state = state.unwrap_or("dead_letter");
        if !matches!(
            state,
            "pending" | "sending" | "retry_wait" | "sent" | "dead_letter" | "canceled"
        ) {
            return Err(NotificationHttpServiceError::InvalidInput);
        }
        let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
        if !(1..=MAX_PAGE_SIZE).contains(&limit) {
            return Err(NotificationHttpServiceError::InvalidInput);
        }
        let cursor = cursor.map(decode_cursor).transpose()?;
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
        require_admin(&mut tx, identity.user_id).await?;
        let rows = if let Some((timestamp, id)) = cursor {
            sqlx::query("SELECT id::text,recipient_email,classification,template_id,resource_type,resource_id,state,attempt_count,last_smtp_code,last_error_class,available_at,updated_at,lock_version FROM email_outbox WHERE state=$1 AND (updated_at,id)<($2::timestamptz,$3::uuid) ORDER BY updated_at DESC,id DESC LIMIT $4")
                .bind(state).bind(timestamp).bind(id.to_string()).bind(i64::from(limit)+1).fetch_all(&mut *tx).await
        } else {
            sqlx::query("SELECT id::text,recipient_email,classification,template_id,resource_type,resource_id,state,attempt_count,last_smtp_code,last_error_class,available_at,updated_at,lock_version FROM email_outbox WHERE state=$1 ORDER BY updated_at DESC,id DESC LIMIT $2")
                .bind(state).bind(i64::from(limit)+1).fetch_all(&mut *tx).await
        }.map_err(|_| NotificationHttpServiceError::Unavailable)?;
        let mut items = rows
            .into_iter()
            .map(delivery_item)
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if items.len() > usize::from(limit) {
            items.pop();
            items.last().map(encode_delivery_cursor).transpose()?
        } else {
            None
        };
        let view = EmailDeliveryCollectionView {
            items,
            next_cursor,
            smtp_configured: smtp_configured(&mut tx).await?,
        };
        tx.commit()
            .await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        Ok(view)
    }

    pub(crate) async fn retry_delivery(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        expected_version: u64,
        idempotency_key: &str,
        correlation_id: &str,
    ) -> Result<EmailDeliveryView, NotificationHttpServiceError> {
        self.admin_delivery_mutation(
            request,
            id,
            expected_version,
            idempotency_key,
            correlation_id,
            true,
        )
        .await
    }

    pub(crate) async fn cancel_delivery(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        expected_version: u64,
        idempotency_key: &str,
        correlation_id: &str,
    ) -> Result<EmailDeliveryView, NotificationHttpServiceError> {
        self.admin_delivery_mutation(
            request,
            id,
            expected_version,
            idempotency_key,
            correlation_id,
            false,
        )
        .await
    }

    async fn admin_delivery_mutation(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: Uuid,
        expected_version: u64,
        idempotency_key: &str,
        correlation_id: &str,
        retry: bool,
    ) -> Result<EmailDeliveryView, NotificationHttpServiceError> {
        if !valid_idempotency_key(idempotency_key) {
            return Err(NotificationHttpServiceError::InvalidInput);
        }
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
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
        require_recent_admin(&mut tx, identity).await?;
        let operation = if retry { "retry" } else { "cancel" };
        sqlx::query(
            "WITH expired AS (SELECT actor_user_id,idempotency_key FROM notification_admin_operation_receipts \
             WHERE expires_at<=transaction_timestamp() ORDER BY expires_at,actor_user_id,idempotency_key \
             LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM notification_admin_operation_receipts receipt \
             USING expired WHERE receipt.actor_user_id=expired.actor_user_id \
             AND receipt.idempotency_key=expired.idempotency_key",
        )
        .bind(EXPIRED_RECEIPT_SWEEP_BATCH)
        .execute(&mut *tx)
        .await
        .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        let receipt = sqlx::query("SELECT operation,target_email_outbox_id::text,result_email_outbox_id::text FROM notification_admin_operation_receipts WHERE actor_user_id=$1::uuid AND idempotency_key=$2 AND expires_at>transaction_timestamp()")
            .bind(identity.user_id.to_string()).bind(idempotency_key).fetch_optional(&mut *tx).await
            .map_err(|_| NotificationHttpServiceError::Unavailable)?;
        if let Some(receipt) = receipt {
            let target: String = receipt.get("target_email_outbox_id");
            let stored_operation: String = receipt.get("operation");
            if target != id.to_string() || stored_operation != operation {
                return Err(NotificationHttpServiceError::Conflict);
            }
            let result = receipt
                .get::<Option<String>, _>("result_email_outbox_id")
                .unwrap_or(target);
            let row = load_delivery(&mut tx, &result).await?;
            tx.commit()
                .await
                .map_err(|_| NotificationHttpServiceError::Unavailable)?;
            return delivery_item(row);
        }
        let expected = i64::try_from(expected_version)
            .map_err(|_| NotificationHttpServiceError::PreconditionFailed)?;
        let source = sqlx::query("SELECT id::text,notification_id::text,recipient_user_id::text,recipient_email,classification,template_id,locale,resource_type,resource_id,rendering_data::text,state,attempt_count,last_smtp_code,last_error_class,available_at,updated_at,lock_version FROM email_outbox WHERE id=$1::uuid FOR UPDATE")
            .bind(id.to_string()).fetch_optional(&mut *tx).await.map_err(|_| NotificationHttpServiceError::Unavailable)?
            .ok_or(NotificationHttpServiceError::NotFound)?;
        if source.get::<i64, _>("lock_version") != expected {
            return Err(NotificationHttpServiceError::PreconditionFailed);
        }
        let result_id = if retry {
            if source.get::<String, _>("state") != "dead_letter" {
                return Err(NotificationHttpServiceError::Conflict);
            }
            let new_id = Uuid::now_v7();
            sqlx::query("INSERT INTO email_outbox(id,notification_id,recipient_user_id,recipient_email,classification,template_id,locale,resource_type,resource_id,rendering_data) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::jsonb)")
                .bind(new_id.to_string()).bind(source.get::<Option<String>,_>("notification_id"))
                .bind(source.get::<Option<String>,_>("recipient_user_id")).bind(source.get::<String,_>("recipient_email"))
                .bind(source.get::<String,_>("classification")).bind(source.get::<String,_>("template_id"))
                .bind(source.get::<String,_>("locale")).bind(source.get::<String,_>("resource_type"))
                .bind(source.get::<String,_>("resource_id")).bind(source.get::<String,_>("rendering_data"))
                .execute(&mut *tx).await.map_err(|_| NotificationHttpServiceError::Unavailable)?;
            Some(new_id)
        } else {
            let state: String = source.get("state");
            if !matches!(state.as_str(), "pending" | "retry_wait") {
                return Err(NotificationHttpServiceError::Conflict);
            }
            sqlx::query("UPDATE email_outbox SET state='canceled',lease_owner=NULL,lease_expires_at=NULL,last_smtp_code=NULL,last_error_class=NULL,updated_at=clock_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid AND lock_version=$2")
                .bind(id.to_string()).bind(expected).execute(&mut *tx).await.map_err(|_| NotificationHttpServiceError::Unavailable)?;
            None
        };
        sqlx::query("INSERT INTO notification_admin_operation_receipts(actor_user_id,idempotency_key,operation,target_email_outbox_id,result_email_outbox_id) VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid)")
            .bind(identity.user_id.to_string()).bind(idempotency_key).bind(operation).bind(id.to_string())
            .bind(result_id.map(|value| value.to_string())).execute(&mut *tx).await.map_err(|_| NotificationHttpServiceError::Unavailable)?;
        append_admin_audit(&mut tx, identity.user_id, id, operation, correlation_id).await?;
        let result_key = result_id.unwrap_or(id).to_string();
        let row = load_delivery(&mut tx, &result_key).await?;
        tx.commit()
            .await
            .map_err(|_| NotificationHttpServiceError::CommitOutcomeUnknown)?;
        delivery_item(row)
    }

    fn runtime(&self) -> Result<&NotificationRuntime, NotificationHttpServiceError> {
        self.runtime
            .as_deref()
            .ok_or(NotificationHttpServiceError::Unavailable)
    }
}

impl NotificationRuntime {
    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AuthenticatedIdentity, NotificationHttpServiceError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(map_browser_error)?
            .into_session_token();
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_session_error)?;
        Ok(AuthenticatedIdentity {
            user_id: session.user_id(),
            session_id: session.id(),
        })
    }
}

async fn load_preferences(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<NotificationPreferencesView, NotificationHttpServiceError> {
    let row = sqlx::query("SELECT account_access,collaboration,operations,lock_version FROM notification_email_preferences WHERE user_id=$1::uuid")
        .bind(user_id.to_string()).fetch_optional(&mut **tx).await.map_err(|_| NotificationHttpServiceError::Unavailable)?;
    let (account_access, collaboration, operations, version) =
        row.map_or((true, false, false, 1), |row| {
            (
                row.get("account_access"),
                row.get("collaboration"),
                row.get("operations"),
                row.get::<i64, _>("lock_version"),
            )
        });
    Ok(NotificationPreferencesView {
        critical_security: true,
        account_access,
        collaboration,
        operations,
        smtp_configured: smtp_configured(tx).await?,
        version: u64::try_from(version).map_err(|_| NotificationHttpServiceError::Internal)?,
    })
}

async fn smtp_configured(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<bool, NotificationHttpServiceError> {
    sqlx::query_scalar("SELECT COALESCE((SELECT value #>> '{}'='true' FROM instance_settings WHERE key='smtp.enabled'),FALSE)")
        .fetch_one(&mut **tx)
        .await.map_err(|_| NotificationHttpServiceError::Unavailable)
}

async fn configure_transaction(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(), NotificationHttpServiceError> {
    sqlx::query(
        "SELECT set_config('lock_timeout','1000ms',TRUE),\
         set_config('statement_timeout','4000ms',TRUE)",
    )
    .execute(&mut **tx)
    .await
    .map_err(|_| NotificationHttpServiceError::Unavailable)?;
    Ok(())
}

async fn require_admin(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<(), NotificationHttpServiceError> {
    let authorized: Option<bool> = sqlx::query_scalar(
        "SELECT status='active' AND is_instance_admin FROM users WHERE id=$1::uuid",
    )
    .bind(user_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| NotificationHttpServiceError::Unavailable)?;
    match authorized {
        Some(true) => Ok(()),
        Some(false) => Err(NotificationHttpServiceError::Forbidden),
        None => Err(NotificationHttpServiceError::AuthenticationFailed),
    }
}

async fn require_recent_admin(
    tx: &mut Transaction<'_, Postgres>,
    identity: AuthenticatedIdentity,
) -> Result<(), NotificationHttpServiceError> {
    let row = sqlx::query("SELECT session.last_reauthenticated_at,transaction_timestamp() AS now FROM users actor JOIN sessions session ON session.user_id=actor.id WHERE actor.id=$1::uuid AND session.id=$2::uuid AND actor.status='active' AND actor.is_instance_admin AND session.revoked_at IS NULL AND session.idle_expires_at>transaction_timestamp() AND session.absolute_expires_at>transaction_timestamp() FOR UPDATE OF actor,session")
        .bind(identity.user_id.to_string()).bind(identity.session_id.to_string()).fetch_optional(&mut **tx).await
        .map_err(|_| NotificationHttpServiceError::Unavailable)?.ok_or(NotificationHttpServiceError::Forbidden)?;
    let last: Option<OffsetDateTime> = row.get("last_reauthenticated_at");
    let now: OffsetDateTime = row.get("now");
    let minutes: i32 = sqlx::query_scalar(
        "SELECT (value #>> '{}')::integer FROM instance_settings \
         WHERE key='security.reauthentication_window_minutes' FOR SHARE",
    )
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| NotificationHttpServiceError::Unavailable)?
    .ok_or(NotificationHttpServiceError::Unavailable)?;
    if !(15..=120).contains(&minutes) {
        return Err(NotificationHttpServiceError::Unavailable);
    }
    if !last.is_some_and(|value| {
        value <= now && value >= now - time::Duration::minutes(i64::from(minutes))
    }) {
        return Err(NotificationHttpServiceError::ReauthenticationRequired);
    }
    Ok(())
}

async fn append_admin_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    target: Uuid,
    operation: &str,
    correlation_id: &str,
) -> Result<(), NotificationHttpServiceError> {
    sqlx::query("INSERT INTO audit_events(id,actor_type,actor_id,actor_user_id,action_code,target_type,target_id,scope_type,scope_id,result,correlation_id,changed_fields,metadata) VALUES($1::uuid,'user',$2,$2::uuid,$3,'email_delivery',$4,'instance','instance','succeeded',$5,ARRAY['state'],jsonb_build_object('operation',$6))")
        .bind(Uuid::now_v7().to_string()).bind(actor.to_string()).bind(format!("notification.delivery_{operation}"))
        .bind(target.to_string()).bind(correlation_id).bind(operation).execute(&mut **tx).await
        .map_err(|_| NotificationHttpServiceError::Unavailable)?;
    Ok(())
}

async fn load_delivery(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
) -> Result<sqlx::postgres::PgRow, NotificationHttpServiceError> {
    sqlx::query("SELECT id::text,recipient_email,classification,template_id,resource_type,resource_id,state,attempt_count,last_smtp_code,last_error_class,available_at,updated_at,lock_version FROM email_outbox WHERE id=$1::uuid")
        .bind(id).fetch_one(&mut **tx).await.map_err(|_| NotificationHttpServiceError::Unavailable)
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

fn delivery_item(
    row: sqlx::postgres::PgRow,
) -> Result<EmailDeliveryView, NotificationHttpServiceError> {
    Ok(EmailDeliveryView {
        id: row.get("id"),
        recipient_email: row.get("recipient_email"),
        classification: row.get("classification"),
        template_id: row.get("template_id"),
        resource_type: row.get("resource_type"),
        resource_id: row.get("resource_id"),
        state: row.get("state"),
        attempt_count: u16::try_from(row.get::<i16, _>("attempt_count"))
            .map_err(|_| NotificationHttpServiceError::Internal)?,
        smtp_code: row
            .get::<Option<i32>, _>("last_smtp_code")
            .map(|value| u16::try_from(value).map_err(|_| NotificationHttpServiceError::Internal))
            .transpose()?,
        error_class: row.get("last_error_class"),
        available_at: format_time(row.get("available_at"))?,
        updated_at: format_time(row.get("updated_at"))?,
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
fn encode_delivery_cursor(
    item: &EmailDeliveryView,
) -> Result<String, NotificationHttpServiceError> {
    encode_cursor(&item.updated_at, &item.id)
}
fn encode_cursor(timestamp: &str, id: &str) -> Result<String, NotificationHttpServiceError> {
    serde_json::to_vec(&PageCursor {
        timestamp: timestamp.into(),
        id: id.into(),
    })
    .map(|value| URL_SAFE_NO_PAD.encode(value))
    .map_err(|_| NotificationHttpServiceError::Internal)
}
fn decode_cursor(value: &str) -> Result<(OffsetDateTime, Uuid), NotificationHttpServiceError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    let cursor: PageCursor =
        serde_json::from_slice(&bytes).map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    let timestamp = OffsetDateTime::parse(&cursor.timestamp, &Rfc3339)
        .map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    let id = Uuid::parse_str(&cursor.id).map_err(|_| NotificationHttpServiceError::InvalidInput)?;
    if id.get_version_num() != 7 {
        return Err(NotificationHttpServiceError::InvalidInput);
    }
    Ok((timestamp, id))
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
fn format_time(value: OffsetDateTime) -> Result<String, NotificationHttpServiceError> {
    value
        .format(&Rfc3339)
        .map_err(|_| NotificationHttpServiceError::Internal)
}
fn valid_idempotency_key(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}
fn map_browser_error(error: BrowserCookieError) -> NotificationHttpServiceError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            NotificationHttpServiceError::AuthenticationFailed
        }
        _ => NotificationHttpServiceError::Forbidden,
    }
}
fn map_session_error(error: SessionServiceError) -> NotificationHttpServiceError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            NotificationHttpServiceError::AuthenticationFailed
        }
        _ => NotificationHttpServiceError::Unavailable,
    }
}
