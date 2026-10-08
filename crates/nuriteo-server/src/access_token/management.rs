use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sqlx::{Acquire, Postgres, Row, Transaction};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::time as tokio_time;
use url::Url;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserRequestHeaders, SessionId, SessionPolicy, SessionService,
    Timestamp, UserId,
};
use crate::notification::{
    EmailChannelPreference, Notification, NotificationClassification, NotificationDelivery,
    NotificationFields, NotificationId, NotificationPayload, NotificationWriter,
};
use crate::project::{EffectiveProjectRole, ProjectAccessRepository, ProjectId};

use super::{AccessTokenKind, AccessTokenScope, GeneratedAccessToken, generate_access_token};

const DEFAULT_DEADLINE: Duration = Duration::from_secs(5);

macro_rules! token_select {
    ($predicate:literal) => {
        concat!(
            "SELECT token.id::text,token.kind,token.name,token.project_id::text,token.scopes,",
            "CASE WHEN token.state='active' AND token.expires_at<=transaction_timestamp() ",
            "THEN 'expired' ELSE token.state END AS state,",
            "token.token_prefix,token.created_at,token.expires_at,token.revoked_at,token.last_used_at,",
            "token.last_api_category,COALESCE(array_agg(host(ip.source_ip) ORDER BY ip.last_seen_at DESC) ",
            "FILTER (WHERE ip.source_ip IS NOT NULL),ARRAY[]::text[]) AS recent_source_ips ",
            "FROM access_tokens token LEFT JOIN access_token_source_ips ip ON ip.token_id=token.id ",
            "WHERE ", $predicate,
            " GROUP BY token.id ORDER BY token.created_at DESC,token.id DESC LIMIT 200"
        )
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccessTokenTarget {
    Personal,
    Project(ProjectId),
}

#[derive(Debug, Clone, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccessTokenView {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub project_id: Option<String>,
    pub scopes: Vec<String>,
    pub status: String,
    pub prefix: String,
    pub created_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub last_used_at: Option<String>,
    pub last_api_category: Option<String>,
    pub recent_source_ips: Vec<String>,
}

#[derive(Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssuedAccessTokenView {
    pub token: AccessTokenView,
    pub plaintext: String,
}

impl fmt::Debug for IssuedAccessTokenView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedAccessTokenView")
            .field("token", &self.token)
            .field("plaintext", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct AccessTokenManagementService {
    runtime: Option<Arc<ManagementRuntime>>,
}

struct ManagementRuntime {
    pool: DatabasePool,
    cookies: BrowserCookieBoundary,
    sessions: SessionService,
    deadline: Duration,
}

#[derive(Debug, Clone, Copy)]
struct BrowserIdentity {
    user_id: UserId,
    session_id: SessionId,
}

impl fmt::Debug for AccessTokenManagementService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AccessTokenManagementService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl AccessTokenManagementService {
    pub(crate) const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub(crate) fn production(
        pool: DatabasePool,
        external_url: &Url,
        session_policy: SessionPolicy,
    ) -> Result<Self, AccessTokenManagementError> {
        Ok(Self {
            runtime: Some(Arc::new(ManagementRuntime {
                pool: pool.clone(),
                cookies: BrowserCookieBoundary::new(external_url)
                    .map_err(|_| AccessTokenManagementError::Internal)?,
                sessions: SessionService::new(pool, session_policy),
                deadline: DEFAULT_DEADLINE,
            })),
        })
    }

    pub(crate) async fn list(
        &self,
        request: BrowserRequestHeaders<'_>,
        target: AccessTokenTarget,
    ) -> Result<Vec<AccessTokenView>, AccessTokenManagementError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .bounded(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AccessTokenManagementError::Unavailable)?;
                let mut tx = connection.begin().await.map_err(unavailable)?;
                require_live_session(&mut tx, identity).await?;
                authorize_target(&mut tx, identity.user_id, target, false).await?;
                let rows = match target {
                    AccessTokenTarget::Personal => {
                        sqlx::query(token_select!(
                            "token.owner_user_id=$1::uuid AND token.kind='personal'"
                        ))
                        .bind(identity.user_id.to_string())
                        .fetch_all(&mut *tx)
                        .await
                    }
                    AccessTokenTarget::Project(project_id) => {
                        sqlx::query(token_select!(
                            "token.project_id=$1::uuid AND token.kind='project'"
                        ))
                        .bind(project_id.to_string())
                        .fetch_all(&mut *tx)
                        .await
                    }
                }
                .map_err(unavailable)?;
                tx.commit().await.map_err(unavailable)?;
                rows.into_iter().map(decode_view).collect()
            })
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn issue(
        &self,
        request: BrowserRequestHeaders<'_>,
        target: AccessTokenTarget,
        name: &str,
        scopes: Vec<AccessTokenScope>,
        expiry_days: Option<u16>,
        correlation_id: &str,
    ) -> Result<IssuedAccessTokenView, AccessTokenManagementError> {
        validate_name(name)?;
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .bounded(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AccessTokenManagementError::Unavailable)?;
                let mut tx = connection.begin().await.map_err(unavailable)?;
                require_recent_reauthentication(&mut tx, identity).await?;
                authorize_target(&mut tx, identity.user_id, target, true).await?;
                let days = resolve_expiry_days(&mut tx, expiry_days).await?;
                let kind = match target {
                    AccessTokenTarget::Personal => AccessTokenKind::Personal,
                    AccessTokenTarget::Project(_) => AccessTokenKind::Project,
                };
                let generated = generate_access_token(kind, scopes)
                    .map_err(|_| AccessTokenManagementError::InvalidInput)?;
                let view = insert_generated(
                    &mut tx,
                    identity.user_id,
                    target,
                    name,
                    days,
                    None,
                    generated,
                    correlation_id,
                    "access_token.created",
                )
                .await?;
                tx.commit().await.map_err(commit_unknown)?;
                Ok(view)
            })
            .await
    }

    pub(crate) async fn revoke(
        &self,
        request: BrowserRequestHeaders<'_>,
        target: AccessTokenTarget,
        token_id: Uuid,
        correlation_id: &str,
    ) -> Result<AccessTokenView, AccessTokenManagementError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .bounded(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AccessTokenManagementError::Unavailable)?;
                let mut tx = connection.begin().await.map_err(unavailable)?;
                require_recent_reauthentication(&mut tx, identity).await?;
                authorize_target(&mut tx, identity.user_id, target, true).await?;
                lock_owned_token(&mut tx, identity.user_id, token_id, target, true).await?;
                sqlx::query(
                    "UPDATE access_tokens SET state='revoked',secret_hash=NULL,\
                     revoked_at=transaction_timestamp(),revoke_reason='operator_revoked',\
                     updated_at=clock_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
                )
                .bind(token_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
                append_audit(
                    &mut tx,
                    identity.user_id,
                    token_id,
                    target,
                    "access_token.revoked",
                    correlation_id,
                )
                .await?;
                append_notification(&mut tx, identity.user_id, token_id, target, "revoked").await?;
                let row = load_token(&mut tx, token_id).await?;
                tx.commit().await.map_err(commit_unknown)?;
                decode_view(row)
            })
            .await
    }

    pub(crate) async fn rotate(
        &self,
        request: BrowserRequestHeaders<'_>,
        target: AccessTokenTarget,
        token_id: Uuid,
        expiry_days: Option<u16>,
        correlation_id: &str,
    ) -> Result<IssuedAccessTokenView, AccessTokenManagementError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .bounded(async {
                let mut connection = runtime
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| AccessTokenManagementError::Unavailable)?;
                let mut tx = connection.begin().await.map_err(unavailable)?;
                require_recent_reauthentication(&mut tx, identity).await?;
                authorize_target(&mut tx, identity.user_id, target, true).await?;
                let old =
                    lock_owned_token(&mut tx, identity.user_id, token_id, target, true).await?;
                let name: String = old.get("name");
                let scopes = old
                    .get::<Vec<String>, _>("scopes")
                    .iter()
                    .map(|scope| parse_scope(scope))
                    .collect::<Result<Vec<_>, _>>()?;
                let family = Uuid::parse_str(old.get("rotation_family_id"))
                    .map_err(|_| AccessTokenManagementError::Internal)?;
                let days = resolve_expiry_days(&mut tx, expiry_days).await?;
                let kind = match target {
                    AccessTokenTarget::Personal => AccessTokenKind::Personal,
                    AccessTokenTarget::Project(_) => AccessTokenKind::Project,
                };
                let generated = generate_access_token(kind, scopes)
                    .map_err(|_| AccessTokenManagementError::Internal)?;
                sqlx::query(
                    "UPDATE access_tokens SET state='revoked',secret_hash=NULL,\
                     revoked_at=transaction_timestamp(),revoke_reason='rotated',\
                     updated_at=clock_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
                )
                .bind(token_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
                let issued = insert_generated(
                    &mut tx,
                    identity.user_id,
                    target,
                    &name,
                    days,
                    Some((family, token_id)),
                    generated,
                    correlation_id,
                    "access_token.rotated",
                )
                .await?;
                tx.commit().await.map_err(commit_unknown)?;
                Ok(issued)
            })
            .await
    }

    fn runtime(&self) -> Result<&ManagementRuntime, AccessTokenManagementError> {
        self.runtime
            .as_deref()
            .ok_or(AccessTokenManagementError::Unavailable)
    }
}

impl ManagementRuntime {
    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<BrowserIdentity, AccessTokenManagementError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(|_| AccessTokenManagementError::AuthenticationFailed)?
            .into_session_token();
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(|_| AccessTokenManagementError::AuthenticationFailed)?;
        Ok(BrowserIdentity {
            user_id: session.user_id(),
            session_id: session.id(),
        })
    }

    async fn bounded<T>(
        &self,
        operation: impl Future<Output = Result<T, AccessTokenManagementError>>,
    ) -> Result<T, AccessTokenManagementError> {
        tokio_time::timeout(self.deadline, operation)
            .await
            .map_err(|_| AccessTokenManagementError::OperationTimeout)?
    }
}

async fn authorize_target(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    target: AccessTokenTarget,
    mutation: bool,
) -> Result<(), AccessTokenManagementError> {
    if target == AccessTokenTarget::Personal {
        let active: bool =
            sqlx::query_scalar("SELECT status='active' FROM users WHERE id=$1::uuid FOR SHARE")
                .bind(user_id.to_string())
                .fetch_optional(&mut **tx)
                .await
                .map_err(unavailable)?
                .unwrap_or(false);
        return active
            .then_some(())
            .ok_or(AccessTokenManagementError::AuthenticationFailed);
    }
    let AccessTokenTarget::Project(project_id) = target else {
        unreachable!()
    };
    let role = ProjectAccessRepository::resolve_effective_role(tx, project_id, user_id)
        .await
        .map_err(|_| AccessTokenManagementError::Forbidden)?;
    if role < EffectiveProjectRole::Admin {
        return Err(AccessTokenManagementError::Forbidden);
    }
    if mutation {
        let active: bool =
            sqlx::query_scalar("SELECT state='active' FROM projects WHERE id=$1::uuid FOR SHARE")
                .bind(project_id.to_string())
                .fetch_optional(&mut **tx)
                .await
                .map_err(unavailable)?
                .unwrap_or(false);
        if !active {
            return Err(AccessTokenManagementError::Conflict);
        }
    }
    Ok(())
}

async fn require_recent_reauthentication(
    tx: &mut Transaction<'_, Postgres>,
    identity: BrowserIdentity,
) -> Result<(), AccessTokenManagementError> {
    let recent: Option<bool> = sqlx::query_scalar(
        "SELECT session.last_reauthenticated_at IS NOT NULL \
         AND session.last_reauthenticated_at>=transaction_timestamp()-make_interval(mins=>(policy.value #>> '{}')::integer) \
         AND session.last_reauthenticated_at<=transaction_timestamp() \
         FROM sessions session CROSS JOIN instance_settings policy \
         WHERE session.id=$1::uuid AND session.user_id=$2::uuid AND session.revoked_at IS NULL \
         AND session.rotated_at IS NULL \
         AND session.idle_expires_at>transaction_timestamp() \
         AND session.absolute_expires_at>transaction_timestamp() \
         AND policy.key='security.reauthentication_window_minutes' FOR UPDATE OF session",
    )
    .bind(identity.session_id.to_string())
    .bind(identity.user_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?;
    match recent {
        Some(true) => Ok(()),
        Some(false) => Err(AccessTokenManagementError::ReauthenticationRequired),
        None => Err(AccessTokenManagementError::AuthenticationFailed),
    }
}

async fn require_live_session(
    tx: &mut Transaction<'_, Postgres>,
    identity: BrowserIdentity,
) -> Result<(), AccessTokenManagementError> {
    let live: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=$1::uuid AND user_id=$2::uuid \
         AND revoked_at IS NULL AND rotated_at IS NULL \
         AND idle_expires_at>transaction_timestamp() AND absolute_expires_at>transaction_timestamp())",
    )
    .bind(identity.session_id.to_string())
    .bind(identity.user_id.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(unavailable)?;
    live.then_some(())
        .ok_or(AccessTokenManagementError::AuthenticationFailed)
}

async fn resolve_expiry_days(
    tx: &mut Transaction<'_, Postgres>,
    requested: Option<u16>,
) -> Result<u16, AccessTokenManagementError> {
    let rows: Vec<(String, i32)> = sqlx::query_as(
        "SELECT key,(value #>> '{}')::integer FROM instance_settings \
         WHERE key IN ('tokens.default_expiry_days','tokens.maximum_expiry_days') \
         ORDER BY key FOR SHARE",
    )
    .fetch_all(&mut **tx)
    .await
    .map_err(unavailable)?;
    if rows.len() != 2 {
        return Err(AccessTokenManagementError::Unavailable);
    }
    let default = rows
        .iter()
        .find(|(key, _)| key == "tokens.default_expiry_days")
        .map(|(_, value)| *value)
        .ok_or(AccessTokenManagementError::Unavailable)?;
    let maximum = rows
        .iter()
        .find(|(key, _)| key == "tokens.maximum_expiry_days")
        .map(|(_, value)| *value)
        .ok_or(AccessTokenManagementError::Unavailable)?;
    let days =
        i32::from(requested.unwrap_or(
            u16::try_from(default).map_err(|_| AccessTokenManagementError::Unavailable)?,
        ));
    if !(1..=365).contains(&days) || days > maximum || default > maximum {
        return Err(AccessTokenManagementError::InvalidInput);
    }
    u16::try_from(days).map_err(|_| AccessTokenManagementError::InvalidInput)
}

#[allow(clippy::too_many_arguments)]
async fn insert_generated(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    target: AccessTokenTarget,
    name: &str,
    expiry_days: u16,
    rotation: Option<(Uuid, Uuid)>,
    generated: GeneratedAccessToken,
    correlation_id: &str,
    action: &str,
) -> Result<IssuedAccessTokenView, AccessTokenManagementError> {
    let (owner_user, project_id, principal) = match target {
        AccessTokenTarget::Personal => (Some(actor.to_string()), None, actor.to_string()),
        AccessTokenTarget::Project(id) => (None, Some(id.to_string()), id.to_string()),
    };
    let scope_values = generated
        .scopes
        .iter()
        .map(|scope| scope.as_str())
        .collect::<Vec<_>>();
    let (family, rotated_from) = rotation
        .map(|(family, from)| (family, Some(from)))
        .unwrap_or_else(|| (Uuid::now_v7(), None));
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,project_id,created_by_user_id,scopes,\
          token_prefix,secret_hash,expires_at,rotation_family_id,rotated_from_id) \
         VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,\
                transaction_timestamp()+make_interval(days=>$11),$12::uuid,$13::uuid)",
    )
    .bind(generated.id.to_string())
    .bind(match generated.kind {
        AccessTokenKind::Personal => "personal",
        AccessTokenKind::Project => "project",
    })
    .bind(name)
    .bind(principal)
    .bind(owner_user)
    .bind(project_id)
    .bind(actor.to_string())
    .bind(scope_values)
    .bind(&generated.token_prefix)
    .bind(generated.secret_hash.as_bytes().as_slice())
    .bind(i32::from(expiry_days))
    .bind(family.to_string())
    .bind(rotated_from.map(|id| id.to_string()))
    .execute(&mut **tx)
    .await
    .map_err(unavailable)?;
    append_audit(tx, actor, generated.id, target, action, correlation_id).await?;
    let lifecycle = action
        .strip_prefix("access_token.")
        .ok_or(AccessTokenManagementError::Internal)?;
    append_notification(tx, actor, generated.id, target, lifecycle).await?;
    let view = decode_view(load_token(tx, generated.id).await?)?;
    Ok(IssuedAccessTokenView {
        token: view,
        plaintext: generated.plaintext.expose_once().to_owned(),
    })
}

async fn lock_owned_token(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    token_id: Uuid,
    target: AccessTokenTarget,
    require_active: bool,
) -> Result<sqlx::postgres::PgRow, AccessTokenManagementError> {
    let row = sqlx::query(
        "SELECT name,scopes,rotation_family_id::text,state,owner_user_id::text,project_id::text \
         FROM access_tokens WHERE id=$1::uuid FOR UPDATE",
    )
    .bind(token_id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    .ok_or(AccessTokenManagementError::NotFound)?;
    let actor_id = actor.to_string();
    let owned = match target {
        AccessTokenTarget::Personal => {
            row.get::<Option<&str>, _>("owner_user_id") == Some(actor_id.as_str())
        }
        AccessTokenTarget::Project(project_id) => {
            let project_id = project_id.to_string();
            row.get::<Option<&str>, _>("project_id") == Some(project_id.as_str())
        }
    };
    if !owned {
        return Err(AccessTokenManagementError::NotFound);
    }
    if require_active && row.get::<&str, _>("state") != "active" {
        return Err(AccessTokenManagementError::Conflict);
    }
    Ok(row)
}

async fn append_audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    token_id: Uuid,
    target: AccessTokenTarget,
    action: &str,
    correlation_id: &str,
) -> Result<(), AccessTokenManagementError> {
    let occurred_at: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)?;
    let occurred_at =
        Timestamp::from_datetime(occurred_at).map_err(|_| AccessTokenManagementError::Internal)?;
    let event =
        access_token_audit_event(actor, token_id, target, action, correlation_id, occurred_at)?;
    AuditWriter::append(tx, &event)
        .await
        .map_err(|_| AccessTokenManagementError::Unavailable)
}

fn access_token_audit_event(
    actor: UserId,
    token_id: Uuid,
    target: AccessTokenTarget,
    action: &str,
    correlation_id: &str,
    occurred_at: Timestamp,
) -> Result<AuditEvent, AccessTokenManagementError> {
    let (scope_type, scope_id) = match target {
        AccessTokenTarget::Personal => (ScopeType::User, actor.to_string()),
        AccessTokenTarget::Project(project_id) => (ScopeType::Project, project_id.to_string()),
    };
    AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at,
        actor: AuditActor {
            kind: ActorType::User,
            id: actor.to_string(),
            user_id: Some(actor),
            display_name: None,
        },
        action_code: action.into(),
        target: AuditTarget {
            kind: "access_token".into(),
            id: token_id.to_string(),
        },
        scope: AuditScope {
            kind: scope_type,
            id: scope_id,
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec!["state".into()],
        metadata: AuditMetadata::new(serde_json::json!({}))
            .map_err(|_| AccessTokenManagementError::Internal)?,
    })
    .map_err(|_| AccessTokenManagementError::Internal)
}

async fn append_notification(
    tx: &mut Transaction<'_, Postgres>,
    recipient: UserId,
    token_id: Uuid,
    target: AccessTokenTarget,
    lifecycle: &str,
) -> Result<(), AccessTokenManagementError> {
    let occurred_at: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)?;
    let occurred_at = crate::identity::Timestamp::from_datetime(occurred_at)
        .map_err(|_| AccessTokenManagementError::Internal)?;
    let kind = match target {
        AccessTokenTarget::Personal => "personal",
        AccessTokenTarget::Project(_) => "project",
    };
    let notification = Notification::new(NotificationFields {
        id: NotificationId::new(),
        recipient_user_id: recipient,
        classification: NotificationClassification::AccountAccess,
        event_code: format!("access_token.{lifecycle}"),
        template_id: "access-token-lifecycle-v1".into(),
        locale: "en".into(),
        resource_type: "access_token".into(),
        resource_id: token_id.to_string(),
        rendering_data: NotificationPayload::new(serde_json::json!({
            "kind": kind,
            "lifecycle": lifecycle,
        }))
        .map_err(|_| AccessTokenManagementError::Internal)?,
        requires_action: false,
        occurred_at,
    })
    .map_err(|_| AccessTokenManagementError::Internal)?;
    let delivery = NotificationDelivery::new(
        notification,
        false,
        EmailChannelPreference::Default,
        None,
        None,
    )
    .map_err(|_| AccessTokenManagementError::Internal)?;
    NotificationWriter::enqueue(tx, &delivery)
        .await
        .map_err(|_| AccessTokenManagementError::Unavailable)
}

async fn load_token(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<sqlx::postgres::PgRow, AccessTokenManagementError> {
    sqlx::query(token_select!("token.id=$1::uuid"))
        .bind(id.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)
}

fn decode_view(row: sqlx::postgres::PgRow) -> Result<AccessTokenView, AccessTokenManagementError> {
    Ok(AccessTokenView {
        id: row.get("id"),
        kind: row.get("kind"),
        name: row.get("name"),
        project_id: row.get("project_id"),
        scopes: row.get("scopes"),
        status: row.get("state"),
        prefix: row.get("token_prefix"),
        created_at: format_time(row.get("created_at"))?,
        expires_at: format_time(row.get("expires_at"))?,
        revoked_at: format_optional_time(row.get("revoked_at"))?,
        last_used_at: format_optional_time(row.get("last_used_at"))?,
        last_api_category: row.get("last_api_category"),
        recent_source_ips: row.get("recent_source_ips"),
    })
}

fn format_time(value: OffsetDateTime) -> Result<String, AccessTokenManagementError> {
    value
        .format(&Rfc3339)
        .map_err(|_| AccessTokenManagementError::Internal)
}

fn format_optional_time(
    value: Option<OffsetDateTime>,
) -> Result<Option<String>, AccessTokenManagementError> {
    value.map(format_time).transpose()
}

fn parse_scope(value: &str) -> Result<AccessTokenScope, AccessTokenManagementError> {
    match value {
        "project:read" => Ok(AccessTokenScope::ProjectRead),
        "project:write" => Ok(AccessTokenScope::ProjectWrite),
        "project:publish" => Ok(AccessTokenScope::ProjectPublish),
        "project:manage" => Ok(AccessTokenScope::ProjectManage),
        "git:read" => Ok(AccessTokenScope::GitRead),
        "git:write" => Ok(AccessTokenScope::GitWrite),
        _ => Err(AccessTokenManagementError::Internal),
    }
}

fn validate_name(name: &str) -> Result<(), AccessTokenManagementError> {
    if name.trim() == name
        && (1..=120).contains(&name.chars().count())
        && !name.chars().any(char::is_control)
    {
        Ok(())
    } else {
        Err(AccessTokenManagementError::InvalidInput)
    }
}

fn unavailable(_: sqlx::Error) -> AccessTokenManagementError {
    AccessTokenManagementError::Unavailable
}

fn commit_unknown(_: sqlx::Error) -> AccessTokenManagementError {
    AccessTokenManagementError::CommitOutcomeUnknown
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccessTokenManagementError {
    AuthenticationFailed,
    Forbidden,
    ReauthenticationRequired,
    InvalidInput,
    NotFound,
    Conflict,
    OperationTimeout,
    Unavailable,
    CommitOutcomeUnknown,
    Internal,
}

impl fmt::Display for AccessTokenManagementError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "token management authentication failed",
            Self::Forbidden => "token management operation is forbidden",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::InvalidInput => "token management request is invalid",
            Self::NotFound => "access token was not found",
            Self::Conflict => "access token state conflicts with this operation",
            Self::OperationTimeout => "token management operation timed out",
            Self::Unavailable => "token management service is unavailable",
            Self::CommitOutcomeUnknown => "token management commit outcome is unknown",
            Self::Internal => "token management operation failed",
        })
    }
}

impl std::error::Error for AccessTokenManagementError {}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use crate::identity::{Timestamp, UserId};

    use super::{
        AccessTokenTarget, AccessTokenView, IssuedAccessTokenView, access_token_audit_event,
    };

    #[test]
    fn access_token_lifecycle_audit_uses_validated_safe_metadata() {
        let actor = "0199c963-d5ab-75de-a29e-e349e8f58c3d"
            .parse::<UserId>()
            .expect("fixture user ID must be valid");
        let token_id = Uuid::parse_str("0199c963-d5ab-75de-a29e-e349e8f58c3e")
            .expect("fixture token ID must be valid");
        let occurred_at =
            Timestamp::from_unix_timestamp(1_800_000_000).expect("fixture timestamp must be valid");

        assert!(
            access_token_audit_event(
                actor,
                token_id,
                AccessTokenTarget::Personal,
                "access_token.created",
                "access-token-audit-test",
                occurred_at,
            )
            .is_ok()
        );
    }

    #[test]
    fn issued_token_serializes_with_nested_token_metadata() {
        let issued = IssuedAccessTokenView {
            token: AccessTokenView {
                id: "0199c963-d5ab-75de-a29e-e349e8f58c3d".to_owned(),
                kind: "personal".to_owned(),
                name: "CLI".to_owned(),
                project_id: None,
                scopes: vec!["project:read".to_owned()],
                status: "active".to_owned(),
                prefix: "nur_pat_0199c963".to_owned(),
                created_at: "2026-10-09T00:00:00Z".to_owned(),
                expires_at: "2026-10-10T00:00:00Z".to_owned(),
                revoked_at: None,
                last_used_at: None,
                last_api_category: None,
                recent_source_ips: Vec::new(),
            },
            plaintext: "nur_pat_copy_once".to_owned(),
        };

        let value = serde_json::to_value(issued).expect("issued token view must serialize");

        assert_eq!(value["plaintext"], json!("nur_pat_copy_once"));
        assert_eq!(
            value["token"]["id"],
            json!("0199c963-d5ab-75de-a29e-e349e8f58c3d")
        );
        assert!(value.get("id").is_none());
    }
}
