use std::fmt;
use std::net::IpAddr;
use std::str::FromStr;
use std::time::Duration;

use serde_json::Value;
use sqlx::{Acquire, Row};
use tokio::time as tokio_time;
use uuid::Uuid;

use crate::database::DatabasePool;
use crate::identity::UserId;
use crate::project::{EffectiveProjectRole, ProjectAccessRepository, ProjectId};

use super::{
    AccessTokenHash, AccessTokenKind, AccessTokenScope, parse_presented_token, verify_parsed_secret,
};

const DEFAULT_DEADLINE: Duration = Duration::from_secs(5);
const DEFAULT_POINTS_PER_MINUTE: i32 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApiCategory {
    Read,
    Write,
    Save,
    Integration,
}

impl ApiCategory {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Save => "save",
            Self::Integration => "integration",
        }
    }

    const fn points(self) -> i32 {
        match self {
            Self::Read => 1,
            Self::Write => 5,
            Self::Save => 10,
            Self::Integration => 20,
        }
    }
}

pub(crate) struct AccessTokenRequest<'a> {
    pub(crate) bearer: &'a str,
    pub(crate) required_scope: AccessTokenScope,
    pub(crate) project_id: Option<ProjectId>,
    pub(crate) source_ip: Option<IpAddr>,
    pub(crate) category: ApiCategory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccessTokenPrincipal {
    User(UserId),
    Project(ProjectId),
}

#[derive(Clone)]
pub(crate) struct AccessTokenAuthenticator {
    pool: DatabasePool,
    deadline: Duration,
    points_per_minute: i32,
}

impl fmt::Debug for AccessTokenAuthenticator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AccessTokenAuthenticator")
            .field("deadline", &self.deadline)
            .field("points_per_minute", &self.points_per_minute)
            .finish_non_exhaustive()
    }
}

impl AccessTokenAuthenticator {
    pub(crate) fn new(pool: DatabasePool) -> Self {
        Self {
            pool,
            deadline: DEFAULT_DEADLINE,
            points_per_minute: DEFAULT_POINTS_PER_MINUTE,
        }
    }

    pub(crate) async fn authenticate(
        &self,
        request: AccessTokenRequest<'_>,
    ) -> Result<AccessTokenPrincipal, AccessTokenServiceError> {
        tokio_time::timeout(self.deadline, self.authenticate_inner(request))
            .await
            .map_err(|_| AccessTokenServiceError::OperationTimeout)?
    }

    async fn authenticate_inner(
        &self,
        request: AccessTokenRequest<'_>,
    ) -> Result<AccessTokenPrincipal, AccessTokenServiceError> {
        let parsed = parse_presented_token(request.bearer)
            .ok_or(AccessTokenServiceError::AuthenticationFailed)?;
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| AccessTokenServiceError::Unavailable)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| AccessTokenServiceError::Unavailable)?;
        let row = sqlx::query(
            "SELECT kind,principal_id::text,owner_user_id::text,project_id::text,scopes,secret_hash,\
                    state,expires_at<=transaction_timestamp() AS expired,\
                    (last_used_at IS NOT NULL AND last_used_at>transaction_timestamp()-interval '10 minutes') AS usage_recent,\
                    lock_version \
             FROM access_tokens WHERE id=$1::uuid FOR UPDATE",
        )
        .bind(parsed.id.to_string())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?
        .ok_or(AccessTokenServiceError::AuthenticationFailed)?;

        let persisted_kind = AccessTokenKind::parse(row.get("kind"))
            .ok_or(AccessTokenServiceError::InvalidPersistedState)?;
        let state: String = row.get("state");
        if state != "active" || persisted_kind != parsed.kind {
            return Err(AccessTokenServiceError::AuthenticationFailed);
        }
        if row.get::<bool, _>("expired") {
            sqlx::query(
                "UPDATE access_tokens SET state='revoked',secret_hash=NULL,\
                 revoked_at=clock_timestamp(),revoke_reason='expired',updated_at=clock_timestamp(),\
                 lock_version=lock_version+1 WHERE id=$1::uuid AND state='active'",
            )
            .bind(parsed.id.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(|_| AccessTokenServiceError::Unavailable)?;
            transaction
                .commit()
                .await
                .map_err(|_| AccessTokenServiceError::Unavailable)?;
            return Err(AccessTokenServiceError::AuthenticationFailed);
        }
        let secret_hash = row
            .get::<Option<Vec<u8>>, _>("secret_hash")
            .as_deref()
            .and_then(AccessTokenHash::from_slice)
            .ok_or(AccessTokenServiceError::InvalidPersistedState)?;
        if !verify_parsed_secret(&parsed, &secret_hash) {
            return Err(AccessTokenServiceError::AuthenticationFailed);
        }
        let scopes: Vec<String> = row.get("scopes");
        if !scopes
            .iter()
            .any(|scope| scope == request.required_scope.as_str())
        {
            return Err(AccessTokenServiceError::Forbidden);
        }

        let principal_id = Uuid::parse_str(row.get::<&str, _>("principal_id"))
            .map_err(|_| AccessTokenServiceError::InvalidPersistedState)?;
        let principal = match persisted_kind {
            AccessTokenKind::Personal => {
                let user_id = UserId::from_str(
                    row.get::<Option<&str>, _>("owner_user_id")
                        .ok_or(AccessTokenServiceError::AuthenticationFailed)?,
                )
                .map_err(|_| AccessTokenServiceError::InvalidPersistedState)?;
                ensure_active_user(&mut transaction, user_id).await?;
                if let Some(project_id) = request.project_id {
                    let role = ProjectAccessRepository::resolve_effective_role(
                        &mut transaction,
                        project_id,
                        user_id,
                    )
                    .await
                    .map_err(|_| AccessTokenServiceError::Forbidden)?;
                    if role < minimum_role(request.required_scope) {
                        return Err(AccessTokenServiceError::Forbidden);
                    }
                }
                AccessTokenPrincipal::User(user_id)
            }
            AccessTokenKind::Project => {
                let project_id = ProjectId::from_str(
                    row.get::<Option<&str>, _>("project_id")
                        .ok_or(AccessTokenServiceError::AuthenticationFailed)?,
                )
                .map_err(|_| AccessTokenServiceError::InvalidPersistedState)?;
                if request.project_id != Some(project_id)
                    || !project_state_allows(&mut transaction, project_id, request.required_scope)
                        .await?
                {
                    return Err(AccessTokenServiceError::Forbidden);
                }
                AccessTokenPrincipal::Project(project_id)
            }
        };

        charge_rate_limit(
            &mut transaction,
            "principal",
            principal_id,
            request.source_ip,
            request.category.points(),
            self.points_per_minute,
        )
        .await?;
        charge_rate_limit(
            &mut transaction,
            "token",
            parsed.id,
            request.source_ip,
            request.category.points(),
            self.points_per_minute,
        )
        .await?;
        record_usage(
            &mut transaction,
            parsed.id,
            row.get("usage_recent"),
            request.source_ip,
            request.category,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|_| AccessTokenServiceError::Unavailable)?;
        Ok(principal)
    }
}

async fn ensure_active_user(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: UserId,
) -> Result<(), AccessTokenServiceError> {
    let active: bool =
        sqlx::query_scalar("SELECT status='active' FROM users WHERE id=$1::uuid FOR SHARE")
            .bind(user_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| AccessTokenServiceError::Unavailable)?
            .unwrap_or(false);
    if active {
        Ok(())
    } else {
        Err(AccessTokenServiceError::AuthenticationFailed)
    }
}

const fn minimum_role(scope: AccessTokenScope) -> EffectiveProjectRole {
    match scope {
        AccessTokenScope::ProjectRead | AccessTokenScope::GitRead => EffectiveProjectRole::Read,
        AccessTokenScope::ProjectWrite
        | AccessTokenScope::ProjectPublish
        | AccessTokenScope::GitWrite => EffectiveProjectRole::Write,
        AccessTokenScope::ProjectManage => EffectiveProjectRole::Admin,
    }
}

async fn project_state_allows(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project_id: ProjectId,
    scope: AccessTokenScope,
) -> Result<bool, AccessTokenServiceError> {
    let state: Option<String> =
        sqlx::query_scalar("SELECT state FROM projects WHERE id=$1::uuid FOR SHARE")
            .bind(project_id.to_string())
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| AccessTokenServiceError::Unavailable)?;
    Ok(matches!(state.as_deref(), Some("active"))
        || (state.as_deref() == Some("archived") && scope == AccessTokenScope::ProjectRead))
}

async fn charge_rate_limit(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    subject_kind: &str,
    subject_id: Uuid,
    source_ip: Option<IpAddr>,
    points: i32,
    budget: i32,
) -> Result<(), AccessTokenServiceError> {
    sqlx::query(
        "WITH expired AS (SELECT subject_kind,subject_id,window_started_at \
         FROM api_rate_limit_buckets WHERE window_started_at<date_trunc('minute',transaction_timestamp())-interval '1 minute' \
         ORDER BY window_started_at,subject_kind,subject_id FOR UPDATE SKIP LOCKED LIMIT 100) \
         DELETE FROM api_rate_limit_buckets bucket USING expired \
         WHERE bucket.subject_kind=expired.subject_kind AND bucket.subject_id=expired.subject_id \
         AND bucket.window_started_at=expired.window_started_at",
    )
    .execute(&mut **transaction)
    .await
    .map_err(|_| AccessTokenServiceError::Unavailable)?;
    let accepted: Option<i32> = sqlx::query_scalar(
        "INSERT INTO api_rate_limit_buckets \
         (subject_kind,subject_id,source_ip,window_started_at,used_points) \
         VALUES($1,$2::uuid,$3::inet,date_trunc('minute',transaction_timestamp()),$4) \
         ON CONFLICT(subject_kind,subject_id,window_started_at) DO UPDATE SET \
           used_points=api_rate_limit_buckets.used_points+EXCLUDED.used_points,\
           source_ip=EXCLUDED.source_ip,updated_at=transaction_timestamp() \
         WHERE api_rate_limit_buckets.used_points+EXCLUDED.used_points<=$5 \
         RETURNING used_points",
    )
    .bind(subject_kind)
    .bind(subject_id.to_string())
    .bind(source_ip.map(|value| value.to_string()))
    .bind(points)
    .bind(budget)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| AccessTokenServiceError::Unavailable)?;
    accepted
        .map(|_| ())
        .ok_or(AccessTokenServiceError::RateLimited)
}

async fn record_usage(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    token_id: Uuid,
    usage_recent: bool,
    source_ip: Option<IpAddr>,
    category: ApiCategory,
) -> Result<(), AccessTokenServiceError> {
    if !usage_recent {
        sqlx::query(
            "UPDATE access_tokens SET last_used_at=transaction_timestamp(),last_api_category=$2,\
             updated_at=clock_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
        )
        .bind(token_id.to_string())
        .bind(category.as_str())
        .execute(&mut **transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?;
    }
    if let Some(source_ip) = source_ip {
        sqlx::query(
            "INSERT INTO access_token_source_ips(token_id,source_ip) VALUES($1::uuid,$2::inet) \
             ON CONFLICT(token_id,source_ip) DO UPDATE SET last_seen_at=transaction_timestamp() \
             WHERE access_token_source_ips.last_seen_at<=transaction_timestamp()-interval '10 minutes'",
        )
        .bind(token_id.to_string())
        .bind(source_ip.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?;
        sqlx::query(
            "DELETE FROM access_token_source_ips WHERE token_id=$1::uuid AND source_ip NOT IN \
             (SELECT source_ip FROM access_token_source_ips WHERE token_id=$1::uuid \
              ORDER BY last_seen_at DESC,source_ip LIMIT 5)",
        )
        .bind(token_id.to_string())
        .execute(&mut **transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccessTokenServiceError {
    AuthenticationFailed,
    Forbidden,
    RateLimited,
    OperationTimeout,
    Unavailable,
    InvalidPersistedState,
}

impl fmt::Display for AccessTokenServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "access token authentication failed",
            Self::Forbidden => "access token is not authorized for this operation",
            Self::RateLimited => "API rate limit exceeded",
            Self::OperationTimeout => "access token operation timed out",
            Self::Unavailable => "access token service unavailable",
            Self::InvalidPersistedState => "access token persisted state is invalid",
        })
    }
}

impl std::error::Error for AccessTokenServiceError {}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum IdempotencyReservation {
    New,
    Replay { status: u16, body: Value },
    InProgress,
    Conflict,
}

pub(crate) struct ApiIdempotencyRepository;

impl ApiIdempotencyRepository {
    #[allow(
        clippy::too_many_arguments,
        reason = "the complete HTTP identity is the idempotency key"
    )]
    pub(crate) async fn reserve(
        transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        principal_id: Uuid,
        token_id: Uuid,
        method: &str,
        canonical_route: &str,
        key: &str,
        request_fingerprint: &[u8; 32],
    ) -> Result<IdempotencyReservation, AccessTokenServiceError> {
        sqlx::query(
            "DELETE FROM api_idempotency_receipts WHERE principal_id=$1::uuid AND method=$2 \
             AND canonical_route=$3 AND idempotency_key=$4 AND expires_at<=transaction_timestamp()",
        )
        .bind(principal_id.to_string())
        .bind(method)
        .bind(canonical_route)
        .bind(key)
        .execute(&mut **transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?;
        sqlx::query(
            "WITH expired AS (SELECT principal_id,method,canonical_route,idempotency_key \
             FROM api_idempotency_receipts WHERE expires_at<=transaction_timestamp() \
             ORDER BY expires_at,principal_id,method,canonical_route,idempotency_key \
             FOR UPDATE SKIP LOCKED LIMIT 100) \
             DELETE FROM api_idempotency_receipts receipt USING expired \
             WHERE receipt.principal_id=expired.principal_id AND receipt.method=expired.method \
             AND receipt.canonical_route=expired.canonical_route \
             AND receipt.idempotency_key=expired.idempotency_key",
        )
        .execute(&mut **transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?;
        let inserted = sqlx::query(
            "INSERT INTO api_idempotency_receipts \
             (principal_id,token_id,method,canonical_route,idempotency_key,request_fingerprint) \
             VALUES($1::uuid,$2::uuid,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        )
        .bind(principal_id.to_string())
        .bind(token_id.to_string())
        .bind(method)
        .bind(canonical_route)
        .bind(key)
        .bind(request_fingerprint.as_slice())
        .execute(&mut **transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?;
        if inserted.rows_affected() == 1 {
            return Ok(IdempotencyReservation::New);
        }
        let row = sqlx::query(
            "SELECT request_fingerprint,state,response_status,response_body::text AS response_body \
             FROM api_idempotency_receipts WHERE principal_id=$1::uuid AND method=$2 \
             AND canonical_route=$3 AND idempotency_key=$4 FOR UPDATE",
        )
        .bind(principal_id.to_string())
        .bind(method)
        .bind(canonical_route)
        .bind(key)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?;
        if row.get::<Vec<u8>, _>("request_fingerprint") != request_fingerprint.as_slice() {
            return Ok(IdempotencyReservation::Conflict);
        }
        if row.get::<String, _>("state") == "processing" {
            return Ok(IdempotencyReservation::InProgress);
        }
        let status = u16::try_from(row.get::<i32, _>("response_status"))
            .map_err(|_| AccessTokenServiceError::InvalidPersistedState)?;
        let body = serde_json::from_str(row.get::<&str, _>("response_body"))
            .map_err(|_| AccessTokenServiceError::InvalidPersistedState)?;
        Ok(IdempotencyReservation::Replay { status, body })
    }

    pub(crate) async fn complete(
        transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        principal_id: Uuid,
        method: &str,
        canonical_route: &str,
        key: &str,
        status: u16,
        body: &Value,
    ) -> Result<(), AccessTokenServiceError> {
        let updated = sqlx::query(
            "UPDATE api_idempotency_receipts SET state='completed',response_status=$5,\
             response_body=$6::jsonb,completed_at=transaction_timestamp() \
             WHERE principal_id=$1::uuid AND method=$2 AND canonical_route=$3 \
             AND idempotency_key=$4 AND state='processing'",
        )
        .bind(principal_id.to_string())
        .bind(method)
        .bind(canonical_route)
        .bind(key)
        .bind(i32::from(status))
        .bind(
            serde_json::to_string(body)
                .map_err(|_| AccessTokenServiceError::InvalidPersistedState)?,
        )
        .execute(&mut **transaction)
        .await
        .map_err(|_| AccessTokenServiceError::Unavailable)?;
        if updated.rows_affected() == 1 {
            Ok(())
        } else {
            Err(AccessTokenServiceError::InvalidPersistedState)
        }
    }
}
