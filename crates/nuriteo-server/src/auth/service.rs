use std::fmt;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use sqlx::{Acquire, Row};
use time::OffsetDateTime;
use tokio::sync::Semaphore;
use tokio::time as tokio_time;
use url::Url;
use utoipa::ToSchema;

use crate::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriter, ScopeType,
};
use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserRequestHeaders, CookieLifetime, IssuedBrowserCookies,
    PasswordPolicy, PasswordService, PasswordVerification, Session, SessionPolicy, SessionService,
    SessionServiceError, SessionToken, StoredPasswordHash, Timestamp, TransactionRevocation,
    UserId,
};
use crate::workspace::{WorkspaceQueryError, WorkspaceQueryService};

use super::lockout::{self, FailureAccounting, LoginLockoutPolicy};

const DUMMY_PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";
const DEFAULT_BLOCKING_CONCURRENCY: usize = 4;
const DEFAULT_PASSWORD_DEADLINE: Duration = Duration::from_secs(5);
const DEFAULT_OPERATION_DEADLINE: Duration = Duration::from_secs(5);
const MIN_DEADLINE: Duration = Duration::from_millis(100);
const MAX_DEADLINE: Duration = Duration::from_secs(30);
const MAX_BLOCKING_CONCURRENCY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthPolicy {
    blocking_concurrency: usize,
    password_deadline: Duration,
    operation_deadline: Duration,
}

impl AuthPolicy {
    pub fn new(
        blocking_concurrency: usize,
        password_deadline: Duration,
        operation_deadline: Duration,
    ) -> Result<Self, AuthPolicyError> {
        if !(1..=MAX_BLOCKING_CONCURRENCY).contains(&blocking_concurrency) {
            return Err(AuthPolicyError::InvalidBlockingConcurrency);
        }
        if !(MIN_DEADLINE..=MAX_DEADLINE).contains(&password_deadline) {
            return Err(AuthPolicyError::InvalidPasswordDeadline);
        }
        if !(MIN_DEADLINE..=MAX_DEADLINE).contains(&operation_deadline) {
            return Err(AuthPolicyError::InvalidOperationDeadline);
        }
        Ok(Self {
            blocking_concurrency,
            password_deadline,
            operation_deadline,
        })
    }
}

impl Default for AuthPolicy {
    fn default() -> Self {
        Self {
            blocking_concurrency: DEFAULT_BLOCKING_CONCURRENCY,
            password_deadline: DEFAULT_PASSWORD_DEADLINE,
            operation_deadline: DEFAULT_OPERATION_DEADLINE,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthPolicyError {
    InvalidBlockingConcurrency,
    InvalidPasswordDeadline,
    InvalidOperationDeadline,
}

impl fmt::Display for AuthPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidBlockingConcurrency => "password concurrency limit is invalid",
            Self::InvalidPasswordDeadline => "password deadline is invalid",
            Self::InvalidOperationDeadline => "authentication operation deadline is invalid",
        })
    }
}

impl std::error::Error for AuthPolicyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthServiceError {
    AuthenticationFailed,
    RequestForbidden,
    Unavailable,
    OperationTimeout,
    Internal,
}

impl fmt::Display for AuthServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "authentication failed",
            Self::RequestForbidden => "request security policy rejected the request",
            Self::Unavailable => "authentication service is unavailable",
            Self::OperationTimeout => "authentication operation timed out",
            Self::Internal => "authentication operation failed",
        })
    }
}

impl std::error::Error for AuthServiceError {}

#[derive(Clone)]
pub struct AuthService {
    runtime: Option<Arc<AuthRuntime>>,
}

struct AuthRuntime {
    pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    password: PasswordExecutor,
    lockout: LoginLockoutPolicy,
    operation_deadline: Duration,
    workspaces: WorkspaceQueryService,
}

impl fmt::Debug for AuthService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl AuthService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        auth_policy: AuthPolicy,
        session_policy: SessionPolicy,
    ) -> Result<Self, AuthServiceError> {
        Self::production_with_lockout_policy(
            pool,
            external_url,
            auth_policy,
            LoginLockoutPolicy::default(),
            session_policy,
        )
    }

    pub fn production_with_lockout_policy(
        pool: DatabasePool,
        external_url: &Url,
        auth_policy: AuthPolicy,
        lockout_policy: LoginLockoutPolicy,
        session_policy: SessionPolicy,
    ) -> Result<Self, AuthServiceError> {
        let cookies =
            BrowserCookieBoundary::new(external_url).map_err(|_| AuthServiceError::Internal)?;
        let sessions = SessionService::new(pool.clone(), session_policy);
        Ok(Self {
            runtime: Some(Arc::new(AuthRuntime {
                pool: pool.clone(),
                sessions,
                cookies,
                password: PasswordExecutor::new(auth_policy),
                lockout: lockout_policy,
                operation_deadline: auth_policy.operation_deadline,
                workspaces: WorkspaceQueryService::new(pool, auth_policy.operation_deadline),
            })),
        })
    }

    pub(crate) async fn login(
        &self,
        email: String,
        password: Vec<u8>,
        origins: &[&str],
        correlation_id: &str,
    ) -> Result<LoginResult, AuthServiceError> {
        let runtime = self.runtime()?;
        runtime
            .cookies
            .validate_unauthenticated_origin(origins)
            .map_err(|_| AuthServiceError::RequestForbidden)?;
        let candidate = runtime.load_candidate(&email).await?;
        let eligible = candidate.as_ref().is_some_and(LoginCandidate::eligible);
        let failure_user_id = candidate
            .as_ref()
            .filter(|candidate| candidate.eligible())
            .map(|candidate| candidate.user_id);
        let verifier = match candidate.as_ref().filter(|candidate| candidate.eligible()) {
            Some(candidate) => StoredPasswordHash::new(candidate.password_verifier.clone())
                .map_err(|_| AuthServiceError::Internal)?,
            None => StoredPasswordHash::new(DUMMY_PASSWORD_HASH.to_owned())
                .map_err(|_| AuthServiceError::Internal)?,
        };
        let verification = runtime.password.verify(password, verifier).await?;
        if !eligible || verification != PasswordVerification::Match {
            runtime
                .record_login_failure(failure_user_id, correlation_id)
                .await?;
            return Err(AuthServiceError::AuthenticationFailed);
        }
        let candidate = candidate.ok_or(AuthServiceError::Internal)?;
        match runtime
            .commit_login(candidate.user_id, &candidate.display_name, correlation_id)
            .await
        {
            Ok(result) => Ok(result),
            Err(AuthServiceError::AuthenticationFailed) => {
                runtime
                    .record_login_failure(Some(candidate.user_id), correlation_id)
                    .await?;
                Err(AuthServiceError::AuthenticationFailed)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn logout(
        &self,
        request: BrowserRequestHeaders<'_>,
        correlation_id: &str,
    ) -> Result<IssuedBrowserCookies, AuthServiceError> {
        let runtime = self.runtime()?;
        let token = runtime
            .cookies
            .validate(request)
            .map_err(|_| AuthServiceError::RequestForbidden)?
            .into_session_token();
        let deletion = runtime
            .cookies
            .deletion()
            .map_err(|_| AuthServiceError::Internal)?;
        runtime.commit_logout(&token, correlation_id).await?;
        Ok(deletion)
    }

    pub(crate) async fn me(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<MeView, AuthServiceError> {
        let runtime = self.runtime()?;
        let token = runtime
            .cookies
            .validate(request)
            .map_err(|_| AuthServiceError::AuthenticationFailed)?
            .into_session_token();
        let session = runtime
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_session_authentication)?;
        runtime.load_me(session).await
    }

    pub(crate) async fn workspaces(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<Vec<crate::workspace::Workspace>, AuthServiceError> {
        let runtime = self.runtime()?;
        let token = runtime
            .cookies
            .validate(request)
            .map_err(|_| AuthServiceError::AuthenticationFailed)?
            .into_session_token();
        let session = runtime
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_session_authentication)?;
        runtime
            .workspaces
            .list_for_user(session.user_id())
            .await
            .map_err(map_workspace_query)
    }

    fn runtime(&self) -> Result<&AuthRuntime, AuthServiceError> {
        self.runtime.as_deref().ok_or(AuthServiceError::Unavailable)
    }
}

struct LoginCandidate {
    user_id: UserId,
    display_name: String,
    status: String,
    password_verifier: String,
}

impl LoginCandidate {
    fn eligible(&self) -> bool {
        self.status == "active"
    }
}

pub(crate) struct LoginResult {
    pub(crate) cookies: IssuedBrowserCookies,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct MeView {
    pub(crate) user: MeUser,
    pub(crate) session: MeSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct MeUser {
    pub(crate) id: String,
    pub(crate) email: String,
    pub(crate) display_name: String,
    pub(crate) is_instance_admin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct MeSession {
    pub(crate) id: String,
    pub(crate) last_seen_at: String,
    pub(crate) idle_expires_at: String,
    pub(crate) absolute_expires_at: String,
}

impl AuthRuntime {
    async fn load_candidate(
        &self,
        normalized_email: &str,
    ) -> Result<Option<LoginCandidate>, AuthServiceError> {
        self.within_deadline(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            let row = sqlx::query(
                "SELECT u.id::text AS user_id, u.display_name, u.status, c.password_verifier \
                 FROM users u LEFT JOIN local_password_credentials c ON c.user_id = u.id \
                 WHERE u.normalized_email = $1",
            )
            .bind(normalized_email)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| AuthServiceError::Unavailable)?;
            let Some(row) = row else {
                return Ok(None);
            };
            let verifier: Option<String> = row
                .try_get("password_verifier")
                .map_err(|_| AuthServiceError::Internal)?;
            let Some(password_verifier) = verifier else {
                return Ok(None);
            };
            Ok(Some(LoginCandidate {
                user_id: parse_user_id(&row, "user_id")?,
                display_name: row
                    .try_get("display_name")
                    .map_err(|_| AuthServiceError::Internal)?,
                status: row
                    .try_get("status")
                    .map_err(|_| AuthServiceError::Internal)?,
                password_verifier,
            }))
        })
        .await
    }

    async fn commit_login(
        &self,
        user_id: UserId,
        display_name: &str,
        correlation_id: &str,
    ) -> Result<LoginResult, AuthServiceError> {
        self.within_deadline(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            if !lockout::lock_eligible_user_for_update(&mut transaction, user_id)
                .await
                .map_err(|_| AuthServiceError::Unavailable)?
                || lockout::is_locked_for_update(&mut transaction, user_id)
                    .await
                    .map_err(|_| AuthServiceError::Unavailable)?
            {
                return Err(AuthServiceError::AuthenticationFailed);
            }
            let issued = self
                .sessions
                .issue_in_transaction(&mut transaction, user_id)
                .await
                .map_err(map_session_issue)?;
            let session_fields = issued.session().clone().into_fields();
            let lifetime = CookieLifetime::new(
                session_fields.created_at,
                session_fields.absolute_expires_at,
            )
            .map_err(|_| AuthServiceError::Internal)?;
            let cookies = self
                .cookies
                .issue(issued.token(), lifetime)
                .map_err(|_| AuthServiceError::Internal)?;
            let event = login_success_event(
                user_id,
                display_name,
                session_fields.id.to_string(),
                session_fields.created_at,
                correlation_id,
            )?;
            lockout::clear(&mut transaction, user_id)
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            AuditWriter::append(&mut transaction, &event)
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            transaction
                .commit()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            Ok(LoginResult { cookies })
        })
        .await
    }

    async fn record_login_failure(
        &self,
        user_id: Option<UserId>,
        correlation_id: &str,
    ) -> Result<(), AuthServiceError> {
        self.within_deadline(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            let now: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *transaction)
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            let accounting = match user_id {
                Some(user_id) => lockout::record_failure(&mut transaction, user_id, self.lockout)
                    .await
                    .map_err(|_| AuthServiceError::Unavailable)?,
                None => FailureAccounting::NotTracked,
            };
            let event = login_failure_event(timestamp(now)?, correlation_id)?;
            AuditWriter::append(&mut transaction, &event)
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            if accounting == FailureAccounting::LockStarted {
                let user_id = user_id.ok_or(AuthServiceError::Internal)?;
                let event = login_locked_event(user_id, timestamp(now)?, correlation_id)?;
                AuditWriter::append(&mut transaction, &event)
                    .await
                    .map_err(|_| AuthServiceError::Unavailable)?;
            }
            transaction
                .commit()
                .await
                .map_err(|_| AuthServiceError::Unavailable)
        })
        .await
    }

    async fn commit_logout(
        &self,
        token: &SessionToken,
        correlation_id: &str,
    ) -> Result<(), AuthServiceError> {
        self.within_deadline(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            let mut transaction = connection
                .begin()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            let revocation = self
                .sessions
                .revoke_in_transaction(&mut transaction, token)
                .await
                .map_err(map_session_internal)?;
            append_logout_audit(&mut transaction, &revocation, correlation_id).await?;
            transaction
                .commit()
                .await
                .map_err(|_| AuthServiceError::Unavailable)
        })
        .await
    }

    async fn load_me(&self, session: Session) -> Result<MeView, AuthServiceError> {
        let fields = session.into_fields();
        self.within_deadline(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| AuthServiceError::Unavailable)?;
            let row = sqlx::query(
                "SELECT id::text, email, display_name, is_instance_admin, status \
                 FROM users WHERE id = $1::uuid",
            )
            .bind(fields.user_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| AuthServiceError::Unavailable)?
            .ok_or(AuthServiceError::AuthenticationFailed)?;
            let status: String = row
                .try_get("status")
                .map_err(|_| AuthServiceError::Internal)?;
            if status != "active" {
                return Err(AuthServiceError::AuthenticationFailed);
            }
            Ok(MeView {
                user: MeUser {
                    id: row.try_get("id").map_err(|_| AuthServiceError::Internal)?,
                    email: row
                        .try_get("email")
                        .map_err(|_| AuthServiceError::Internal)?,
                    display_name: row
                        .try_get("display_name")
                        .map_err(|_| AuthServiceError::Internal)?,
                    is_instance_admin: row
                        .try_get("is_instance_admin")
                        .map_err(|_| AuthServiceError::Internal)?,
                },
                session: MeSession {
                    id: fields.id.to_string(),
                    last_seen_at: fields.last_seen_at.to_string(),
                    idle_expires_at: fields.idle_expires_at.to_string(),
                    absolute_expires_at: fields.absolute_expires_at.to_string(),
                },
            })
        })
        .await
    }

    async fn within_deadline<T>(
        &self,
        operation: impl std::future::Future<Output = Result<T, AuthServiceError>>,
    ) -> Result<T, AuthServiceError> {
        tokio_time::timeout(self.operation_deadline, operation)
            .await
            .map_err(|_| AuthServiceError::OperationTimeout)?
    }
}

#[derive(Clone)]
struct PasswordExecutor {
    service: PasswordService,
    permits: Arc<Semaphore>,
    deadline: Duration,
}

impl PasswordExecutor {
    fn new(policy: AuthPolicy) -> Self {
        Self {
            service: PasswordService::new(PasswordPolicy::STANDARD),
            permits: Arc::new(Semaphore::new(policy.blocking_concurrency)),
            deadline: policy.password_deadline,
        }
    }

    async fn verify(
        &self,
        mut password: Vec<u8>,
        stored: StoredPasswordHash,
    ) -> Result<PasswordVerification, AuthServiceError> {
        let deadline = tokio_time::Instant::now() + self.deadline;
        let permit = tokio_time::timeout_at(deadline, Arc::clone(&self.permits).acquire_owned())
            .await
            .map_err(|_| AuthServiceError::OperationTimeout)?
            .map_err(|_| AuthServiceError::Unavailable)?;
        let service = self.service;
        let operation = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let result = service.verify(&password, &stored);
            password.fill(0);
            result
        });
        tokio_time::timeout_at(deadline, operation)
            .await
            .map_err(|_| AuthServiceError::OperationTimeout)?
            .map_err(|_| AuthServiceError::Internal)?
            .map_err(|_| AuthServiceError::Internal)
    }
}

async fn append_logout_audit(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    revocation: &TransactionRevocation,
    correlation_id: &str,
) -> Result<(), AuthServiceError> {
    let Some(identity) = &revocation.identity else {
        return Ok(());
    };
    let now: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut **transaction)
        .await
        .map_err(|_| AuthServiceError::Unavailable)?;
    let event = AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at: timestamp(now)?,
        actor: AuditActor {
            kind: ActorType::User,
            id: identity.user_id.to_string(),
            user_id: Some(identity.user_id),
            display_name: Some(identity.display_name.clone()),
        },
        action_code: "auth.logout".into(),
        target: AuditTarget {
            kind: "session".into(),
            id: identity.session_id.to_string(),
        },
        scope: AuditScope {
            kind: ScopeType::User,
            id: identity.user_id.to_string(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec![],
        metadata: empty_metadata()?,
    })
    .map_err(|_| AuthServiceError::Internal)?;
    AuditWriter::append(transaction, &event)
        .await
        .map_err(|_| AuthServiceError::Unavailable)
}

fn login_success_event(
    user_id: UserId,
    display_name: &str,
    session_id: String,
    occurred_at: Timestamp,
    correlation_id: &str,
) -> Result<AuditEvent, AuthServiceError> {
    AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at,
        actor: AuditActor {
            kind: ActorType::User,
            id: user_id.to_string(),
            user_id: Some(user_id),
            display_name: Some(display_name.into()),
        },
        action_code: "auth.login_succeeded".into(),
        target: AuditTarget {
            kind: "session".into(),
            id: session_id,
        },
        scope: AuditScope {
            kind: ScopeType::User,
            id: user_id.to_string(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec![],
        metadata: empty_metadata()?,
    })
    .map_err(|_| AuthServiceError::Internal)
}

fn login_failure_event(
    occurred_at: Timestamp,
    correlation_id: &str,
) -> Result<AuditEvent, AuthServiceError> {
    AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at,
        actor: AuditActor {
            kind: ActorType::System,
            id: "local-auth".into(),
            user_id: None,
            display_name: None,
        },
        action_code: "auth.login_failed".into(),
        target: AuditTarget {
            kind: "authentication".into(),
            id: "local".into(),
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: "primary".into(),
        },
        result: AuditResult::Denied,
        reason_code: Some("INVALID_CREDENTIALS".into()),
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec![],
        metadata: empty_metadata()?,
    })
    .map_err(|_| AuthServiceError::Internal)
}

fn login_locked_event(
    user_id: UserId,
    occurred_at: Timestamp,
    correlation_id: &str,
) -> Result<AuditEvent, AuthServiceError> {
    AuditEvent::new(AuditEventFields {
        id: AuditEventId::new(),
        occurred_at,
        actor: AuditActor {
            kind: ActorType::System,
            id: "local-auth".into(),
            user_id: None,
            display_name: None,
        },
        action_code: "auth.login_locked".into(),
        target: AuditTarget {
            kind: "user".into(),
            id: user_id.to_string(),
        },
        scope: AuditScope {
            kind: ScopeType::User,
            id: user_id.to_string(),
        },
        result: AuditResult::Denied,
        reason_code: Some("FAILED_LOGIN_THRESHOLD".into()),
        correlation_id: correlation_id.into(),
        source_ip: None,
        schema_version: 1,
        changed_fields: vec![],
        metadata: empty_metadata()?,
    })
    .map_err(|_| AuthServiceError::Internal)
}

fn empty_metadata() -> Result<AuditMetadata, AuthServiceError> {
    AuditMetadata::new(json!({})).map_err(|_| AuthServiceError::Internal)
}

fn timestamp(value: OffsetDateTime) -> Result<Timestamp, AuthServiceError> {
    Timestamp::from_datetime(value).map_err(|_| AuthServiceError::Internal)
}

fn parse_user_id(row: &sqlx::postgres::PgRow, column: &str) -> Result<UserId, AuthServiceError> {
    let value: String = row
        .try_get(column)
        .map_err(|_| AuthServiceError::Internal)?;
    UserId::from_str(&value).map_err(|_| AuthServiceError::Internal)
}

fn map_session_authentication(error: SessionServiceError) -> AuthServiceError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            AuthServiceError::AuthenticationFailed
        }
        SessionServiceError::OperationTimeout => AuthServiceError::OperationTimeout,
        SessionServiceError::DatabaseUnavailable => AuthServiceError::Unavailable,
        _ => AuthServiceError::Internal,
    }
}

fn map_session_issue(error: SessionServiceError) -> AuthServiceError {
    match error {
        SessionServiceError::UserUnavailable => AuthServiceError::AuthenticationFailed,
        SessionServiceError::OperationTimeout => AuthServiceError::OperationTimeout,
        SessionServiceError::DatabaseUnavailable => AuthServiceError::Unavailable,
        _ => AuthServiceError::Internal,
    }
}

fn map_session_internal(error: SessionServiceError) -> AuthServiceError {
    match error {
        SessionServiceError::OperationTimeout => AuthServiceError::OperationTimeout,
        SessionServiceError::DatabaseUnavailable => AuthServiceError::Unavailable,
        _ => AuthServiceError::Internal,
    }
}

fn map_workspace_query(error: WorkspaceQueryError) -> AuthServiceError {
    match error {
        WorkspaceQueryError::UserUnavailable => AuthServiceError::AuthenticationFailed,
        WorkspaceQueryError::PersistenceUnavailable => AuthServiceError::Unavailable,
        WorkspaceQueryError::OperationTimeout => AuthServiceError::OperationTimeout,
        WorkspaceQueryError::InvalidPersistedState => AuthServiceError::Internal,
    }
}
