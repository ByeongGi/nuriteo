use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sqlx::{Acquire, Postgres, Row, Transaction};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::identity::{BrowserRequestHeaders, UserId};

use super::{
    AuthenticatedIdentity, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, NotificationHttpService,
    NotificationHttpServiceError, configure_transaction, format_time, smtp_configured,
};

const EXPIRED_RECEIPT_SWEEP_BATCH: i64 = 100;

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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageCursor {
    timestamp: String,
    id: String,
}

impl NotificationHttpService {
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

fn valid_idempotency_key(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}
