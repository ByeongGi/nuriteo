use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use tokio::sync::Semaphore;
use tokio::time as tokio_time;
use url::Url;
use utoipa::ToSchema;

use crate::audit::{ActorType, AuditActor, AuditEventId};
use crate::database::DatabasePool;
use crate::identity::{
    ActivationInvitation, ActivationInvitationId, ActivationInvitationStatus, ActivationToken,
    BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, InvitationActivationError,
    InvitationActivationFuture, InvitationActivator, InvitationAuditContext,
    InvitationExpiryPolicy, InvitationService, InvitationServiceError, InvitationServicePolicy,
    NormalizedEmail, PasswordPolicy, PasswordService, SessionPolicy, SessionService,
    SessionServiceError, StoredPasswordHash, Timestamp, User, UserFields, UserId, UserStatus,
    acquire_mfa_population_lock,
};
use crate::workspace::PersonalStorageScopeRepository;

const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_PASSWORD_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_PASSWORD_CONCURRENCY: usize = 4;
const MAX_PASSWORD_CONCURRENCY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvitationHttpPolicy {
    operation_timeout: Duration,
    password_timeout: Duration,
    password_concurrency: usize,
}

impl InvitationHttpPolicy {
    pub fn new(
        operation_timeout: Duration,
        password_timeout: Duration,
        password_concurrency: usize,
    ) -> Result<Self, InvitationHttpServiceError> {
        let valid_timeout =
            |value| (Duration::from_millis(100)..=Duration::from_secs(30)).contains(&value);
        if !valid_timeout(operation_timeout)
            || !valid_timeout(password_timeout)
            || !(1..=MAX_PASSWORD_CONCURRENCY).contains(&password_concurrency)
        {
            return Err(InvitationHttpServiceError::Configuration);
        }
        Ok(Self {
            operation_timeout,
            password_timeout,
            password_concurrency,
        })
    }
}

impl Default for InvitationHttpPolicy {
    fn default() -> Self {
        Self {
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
            password_timeout: DEFAULT_PASSWORD_TIMEOUT,
            password_concurrency: DEFAULT_PASSWORD_CONCURRENCY,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationHttpServiceError {
    AuthenticationFailed,
    RequestForbidden,
    Conflict,
    InvalidInvitation,
    Unavailable,
    OperationTimeout,
    Configuration,
    Internal,
}

impl fmt::Display for InvitationHttpServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "invitation authentication failed",
            Self::RequestForbidden => "invitation request was forbidden",
            Self::Conflict => "invitation state conflicts with the request",
            Self::InvalidInvitation => "invitation activation failed",
            Self::Unavailable => "invitation service is unavailable",
            Self::OperationTimeout => "invitation operation timed out",
            Self::Configuration => "invitation service configuration is invalid",
            Self::Internal => "invitation operation failed",
        })
    }
}

impl std::error::Error for InvitationHttpServiceError {}

#[derive(Clone)]
pub struct InvitationHttpService {
    runtime: Option<Arc<InvitationRuntime>>,
}

struct InvitationRuntime {
    pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    external_url: Url,
    password: PasswordHashExecutor,
    operation_timeout: Duration,
}

impl fmt::Debug for InvitationHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InvitationHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl InvitationHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        policy: InvitationHttpPolicy,
        session_policy: SessionPolicy,
    ) -> Result<Self, InvitationHttpServiceError> {
        let cookies = BrowserCookieBoundary::new(external_url)
            .map_err(|_| InvitationHttpServiceError::Configuration)?;
        Ok(Self {
            runtime: Some(Arc::new(InvitationRuntime {
                sessions: SessionService::new(pool.clone(), session_policy),
                pool,
                cookies,
                external_url: external_url.clone(),
                password: PasswordHashExecutor::new(policy),
                operation_timeout: policy.operation_timeout,
            })),
        })
    }

    pub(crate) async fn issue(
        &self,
        request: BrowserRequestHeaders<'_>,
        email: String,
        expiry: Option<Duration>,
        correlation_id: &str,
    ) -> Result<IssuedInvitationView, InvitationHttpServiceError> {
        let runtime = self.runtime()?;
        let admin = runtime.authenticate_admin(request).await?;
        let service = runtime.lifecycle(expiry)?;
        let issued = service
            .issue(&email, admin.user_id, &admin.audit(correlation_id))
            .await
            .map_err(map_lifecycle_error)?;
        runtime.issued_view(issued)
    }

    pub(crate) async fn list(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<Vec<InvitationView>, InvitationHttpServiceError> {
        let runtime = self.runtime()?;
        let admin = runtime.authenticate_admin(request).await?;
        InvitationService::new(runtime.pool.clone(), InvitationServicePolicy::default())
            .list(admin.user_id)
            .await
            .map_err(map_lifecycle_error)
            .map(|items| items.into_iter().map(InvitationView::from).collect())
    }

    pub(crate) async fn reissue(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: ActivationInvitationId,
        expiry: Option<Duration>,
        correlation_id: &str,
    ) -> Result<IssuedInvitationView, InvitationHttpServiceError> {
        let runtime = self.runtime()?;
        let admin = runtime.authenticate_admin(request).await?;
        let issued = runtime
            .lifecycle(expiry)?
            .reissue(id, &admin.audit(correlation_id))
            .await
            .map_err(map_lifecycle_error)?;
        runtime.issued_view(issued)
    }

    pub(crate) async fn revoke(
        &self,
        request: BrowserRequestHeaders<'_>,
        id: ActivationInvitationId,
        correlation_id: &str,
    ) -> Result<(), InvitationHttpServiceError> {
        let runtime = self.runtime()?;
        let admin = runtime.authenticate_admin(request).await?;
        InvitationService::new(runtime.pool.clone(), InvitationServicePolicy::default())
            .revoke(id, &admin.audit(correlation_id))
            .await
            .map_err(map_lifecycle_error)?;
        Ok(())
    }

    pub(crate) async fn activate(
        &self,
        origins: &[&str],
        input: ActivationInput,
        correlation_id: &str,
    ) -> Result<(), InvitationHttpServiceError> {
        let runtime = self.runtime()?;
        runtime
            .cookies
            .validate_unauthenticated_origin(origins)
            .map_err(|_| InvitationHttpServiceError::RequestForbidden)?;
        let token = ActivationToken::parse(input.token)
            .map_err(|_| InvitationHttpServiceError::InvalidInvitation)?;
        let normalized_email = NormalizedEmail::from_email(&input.email)
            .map_err(|_| InvitationHttpServiceError::InvalidInvitation)?;
        let verifier = runtime.password.hash(input.password).await?;
        let activator = AccountActivator {
            user_id: UserId::new(),
            email: input.email,
            normalized_email,
            display_name: input.display_name,
            verifier,
        };
        let audit = InvitationAuditContext::new(
            AuditEventId::new(),
            AuditActor {
                kind: ActorType::System,
                id: "activation".into(),
                user_id: None,
                display_name: None,
            },
            correlation_id.into(),
            None,
            "primary".into(),
        );
        InvitationService::new(runtime.pool.clone(), InvitationServicePolicy::default())
            .accept(&token, &audit, &activator)
            .await
            .map_err(map_activation_error)?;
        Ok(())
    }

    fn runtime(&self) -> Result<&InvitationRuntime, InvitationHttpServiceError> {
        self.runtime
            .as_deref()
            .ok_or(InvitationHttpServiceError::Unavailable)
    }
}

pub(crate) struct ActivationInput {
    pub(crate) token: String,
    pub(crate) email: String,
    pub(crate) display_name: String,
    pub(crate) password: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct InvitationView {
    pub(crate) id: String,
    pub(crate) email: String,
    pub(crate) status: String,
    pub(crate) created_at: String,
    pub(crate) expires_at: String,
    pub(crate) accepted_at: Option<String>,
    pub(crate) revoked_at: Option<String>,
    pub(crate) superseded_at: Option<String>,
    pub(crate) replacement_id: Option<String>,
}

impl From<ActivationInvitation> for InvitationView {
    fn from(value: ActivationInvitation) -> Self {
        let fields = value.into_fields();
        Self {
            id: fields.id.to_string(),
            email: fields.normalized_email.as_str().to_owned(),
            status: match fields.status {
                ActivationInvitationStatus::Pending => "pending",
                ActivationInvitationStatus::Accepted => "accepted",
                ActivationInvitationStatus::Expired => "expired",
                ActivationInvitationStatus::Revoked => "revoked",
                ActivationInvitationStatus::Superseded => "superseded",
            }
            .into(),
            created_at: fields.created_at.to_string(),
            expires_at: fields.expires_at.to_string(),
            accepted_at: fields.accepted_at.map(|value| value.to_string()),
            revoked_at: fields.revoked_at.map(|value| value.to_string()),
            superseded_at: fields.superseded_at.map(|value| value.to_string()),
            replacement_id: fields
                .replaced_by_invitation_id
                .map(|value| value.to_string()),
        }
    }
}

#[derive(Clone, Serialize, ToSchema)]
pub(crate) struct IssuedInvitationView {
    #[serde(flatten)]
    pub(crate) invitation: InvitationView,
    pub(crate) delivery: InvitationDeliveryView,
    #[schema(required)]
    pub(crate) activation_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InvitationDeliveryView {
    CopyOnce,
    EmailQueued,
}

impl fmt::Debug for IssuedInvitationView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedInvitationView")
            .field("invitation", &self.invitation)
            .field("activation_url", &"[REDACTED]")
            .finish()
    }
}

impl InvitationRuntime {
    async fn authenticate_admin(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<AdministratorIdentity, InvitationHttpServiceError> {
        let token = self
            .cookies
            .validate(request)
            .map_err(map_browser_authentication)?
            .into_session_token();
        let session = self
            .sessions
            .authenticate(&token)
            .await
            .map_err(map_session_error)?;
        let user_id = session.user_id();
        self.within_timeout(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| InvitationHttpServiceError::Unavailable)?;
            let row = sqlx::query(
                "SELECT display_name, status, is_instance_admin FROM users WHERE id = $1::uuid",
            )
            .bind(user_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| InvitationHttpServiceError::Unavailable)?
            .ok_or(InvitationHttpServiceError::AuthenticationFailed)?;
            let status: String = row
                .try_get("status")
                .map_err(|_| InvitationHttpServiceError::Internal)?;
            let is_admin: bool = row
                .try_get("is_instance_admin")
                .map_err(|_| InvitationHttpServiceError::Internal)?;
            if status != "active" {
                return Err(InvitationHttpServiceError::AuthenticationFailed);
            }
            if !is_admin {
                return Err(InvitationHttpServiceError::RequestForbidden);
            }
            Ok(AdministratorIdentity {
                user_id,
                display_name: row
                    .try_get("display_name")
                    .map_err(|_| InvitationHttpServiceError::Internal)?,
            })
        })
        .await
    }

    fn lifecycle(
        &self,
        expiry: Option<Duration>,
    ) -> Result<InvitationService, InvitationHttpServiceError> {
        let Some(expiry) = expiry else {
            return Ok(InvitationService::new_live_default(
                self.pool.clone(),
                self.operation_timeout,
            ));
        };
        let expiry = InvitationExpiryPolicy::new(expiry)
            .map_err(|_| InvitationHttpServiceError::Internal)?;
        let policy = InvitationServicePolicy::new(expiry, self.operation_timeout)
            .map_err(|_| InvitationHttpServiceError::Configuration)?;
        Ok(InvitationService::new(self.pool.clone(), policy))
    }

    fn issued_view(
        &self,
        issued: crate::identity::IssuedActivationInvitation,
    ) -> Result<IssuedInvitationView, InvitationHttpServiceError> {
        let email_delivery_queued = issued.email_delivery_queued();
        let (invitation, token) = issued.into_parts();
        let (delivery, activation_url) = if email_delivery_queued {
            (InvitationDeliveryView::EmailQueued, None)
        } else {
            let mut url = self.external_url.clone();
            url.set_path("/activate");
            url.set_query(None);
            url.set_fragment(None);
            url.query_pairs_mut().append_pair("token", token.expose());
            (InvitationDeliveryView::CopyOnce, Some(url.into()))
        };
        Ok(IssuedInvitationView {
            invitation: invitation.into(),
            delivery,
            activation_url,
        })
    }

    async fn within_timeout<T>(
        &self,
        future: impl Future<Output = Result<T, InvitationHttpServiceError>>,
    ) -> Result<T, InvitationHttpServiceError> {
        tokio_time::timeout(self.operation_timeout, future)
            .await
            .map_err(|_| InvitationHttpServiceError::OperationTimeout)?
    }
}

struct AdministratorIdentity {
    user_id: UserId,
    display_name: String,
}

impl AdministratorIdentity {
    fn audit(&self, correlation_id: &str) -> InvitationAuditContext {
        InvitationAuditContext::new(
            AuditEventId::new(),
            AuditActor {
                kind: ActorType::User,
                id: self.user_id.to_string(),
                user_id: Some(self.user_id),
                display_name: Some(self.display_name.clone()),
            },
            correlation_id.into(),
            None::<IpAddr>,
            "primary".into(),
        )
    }
}

#[derive(Clone)]
struct PasswordHashExecutor {
    service: PasswordService,
    permits: Arc<Semaphore>,
    deadline: Duration,
}

impl PasswordHashExecutor {
    fn new(policy: InvitationHttpPolicy) -> Self {
        Self {
            service: PasswordService::new(PasswordPolicy::STANDARD),
            permits: Arc::new(Semaphore::new(policy.password_concurrency)),
            deadline: policy.password_timeout,
        }
    }

    async fn hash(
        &self,
        mut password: Vec<u8>,
    ) -> Result<StoredPasswordHash, InvitationHttpServiceError> {
        let deadline = tokio_time::Instant::now() + self.deadline;
        let permit = tokio_time::timeout_at(deadline, Arc::clone(&self.permits).acquire_owned())
            .await
            .map_err(|_| InvitationHttpServiceError::OperationTimeout)?
            .map_err(|_| InvitationHttpServiceError::Unavailable)?;
        let service = self.service;
        let operation = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let result = service.hash(&password);
            password.fill(0);
            result
        });
        tokio_time::timeout_at(deadline, operation)
            .await
            .map_err(|_| InvitationHttpServiceError::OperationTimeout)?
            .map_err(|_| InvitationHttpServiceError::Internal)?
            .map_err(|_| InvitationHttpServiceError::Internal)
    }
}

struct AccountActivator {
    user_id: UserId,
    email: String,
    normalized_email: NormalizedEmail,
    display_name: String,
    verifier: StoredPasswordHash,
}

impl InvitationActivator for AccountActivator {
    fn activate<'a>(
        &'a self,
        transaction: &'a mut Transaction<'_, Postgres>,
        invitation: &'a crate::identity::PendingInvitationActivation,
    ) -> InvitationActivationFuture<'a> {
        Box::pin(async move {
            if invitation.normalized_email() != &self.normalized_email {
                return Err(InvitationActivationError::Rejected);
            }
            acquire_mfa_population_lock(transaction)
                .await
                .map_err(|_| InvitationActivationError::DatabaseUnavailable)?;
            let now: OffsetDateTime = sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut **transaction)
                .await
                .map_err(|_| InvitationActivationError::DatabaseUnavailable)?;
            let now = Timestamp::from_datetime(now)
                .map_err(|_| InvitationActivationError::InvariantViolation)?;
            let user = User::new(UserFields {
                id: self.user_id,
                email: self.email.clone(),
                normalized_email: self.normalized_email.as_str().to_owned(),
                display_name: self.display_name.clone(),
                status: UserStatus::Active,
                is_instance_admin: false,
                created_at: now,
                updated_at: now,
                disabled_at: None,
            })
            .map_err(|_| InvitationActivationError::Rejected)?
            .into_fields();
            sqlx::query("INSERT INTO users (id, email, normalized_email, display_name, status, is_instance_admin, created_at, updated_at) VALUES ($1::uuid, $2, $3, $4, 'active', FALSE, $5::timestamptz, $5::timestamptz)")
                .bind(user.id.to_string()).bind(&user.email).bind(&user.normalized_email).bind(&user.display_name).bind(user.created_at.to_string())
                .execute(&mut **transaction).await.map_err(|_| InvitationActivationError::DatabaseUnavailable)?;
            sqlx::query("INSERT INTO local_password_credentials (user_id, password_verifier, created_at, updated_at) VALUES ($1::uuid, $2, $3::timestamptz, $3::timestamptz)")
                .bind(user.id.to_string()).bind(self.verifier.expose()).bind(user.created_at.to_string())
                .execute(&mut **transaction).await.map_err(|_| InvitationActivationError::DatabaseUnavailable)?;
            PersonalStorageScopeRepository::provision(transaction, user.id, user.created_at)
                .await
                .map_err(|_| InvitationActivationError::DatabaseUnavailable)?;
            Ok(())
        })
    }
}

fn map_session_error(error: SessionServiceError) -> InvitationHttpServiceError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            InvitationHttpServiceError::AuthenticationFailed
        }
        SessionServiceError::OperationTimeout => InvitationHttpServiceError::OperationTimeout,
        SessionServiceError::DatabaseUnavailable => InvitationHttpServiceError::Unavailable,
        _ => InvitationHttpServiceError::Internal,
    }
}

fn map_browser_authentication(error: BrowserCookieError) -> InvitationHttpServiceError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            InvitationHttpServiceError::AuthenticationFailed
        }
        _ => InvitationHttpServiceError::RequestForbidden,
    }
}

fn map_lifecycle_error(error: InvitationServiceError) -> InvitationHttpServiceError {
    match error {
        InvitationServiceError::AlreadyPending | InvitationServiceError::InvitationNotPending => {
            InvitationHttpServiceError::Conflict
        }
        InvitationServiceError::InviterUnavailable => InvitationHttpServiceError::RequestForbidden,
        InvitationServiceError::InvalidInvitation | InvitationServiceError::ActivationFailed => {
            InvitationHttpServiceError::InvalidInvitation
        }
        InvitationServiceError::OperationTimeout => InvitationHttpServiceError::OperationTimeout,
        InvitationServiceError::DatabaseUnavailable | InvitationServiceError::AuditUnavailable => {
            InvitationHttpServiceError::Unavailable
        }
        _ => InvitationHttpServiceError::Internal,
    }
}

fn map_activation_error(error: InvitationServiceError) -> InvitationHttpServiceError {
    match error {
        InvitationServiceError::InvalidInvitation | InvitationServiceError::ActivationFailed => {
            InvitationHttpServiceError::InvalidInvitation
        }
        other => map_lifecycle_error(other),
    }
}
