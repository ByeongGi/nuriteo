use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sqlx::Row;
use time::OffsetDateTime;
use tokio::time as tokio_time;
use url::Url;
use utoipa::ToSchema;

use crate::audit::AuditEventId;
use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, NormalizedEmail,
    SessionPolicy, SessionService, SessionServiceError, UserId,
};

use super::{
    IssuedOrganizationInvitation, MembershipChangeResult, MembershipRemoveResult, Organization,
    OrganizationAuditContext, OrganizationId, OrganizationInvitation, OrganizationInvitationActor,
    OrganizationInvitationAuditContext, OrganizationInvitationId, OrganizationInvitationInvitee,
    OrganizationInvitationPolicy, OrganizationInvitationRevokeResult,
    OrganizationInvitationService, OrganizationInvitationServiceError,
    OrganizationInvitationStatus, OrganizationInvitationToken, OrganizationPrincipal,
    OrganizationRole, OrganizationService, OrganizationServiceError, OrganizationServicePolicy,
    OrganizationVersion,
};

const LIST_LIMIT: i64 = super::MAX_MEMBERS;

#[derive(Debug, Clone, Copy)]
pub struct OrganizationHttpPolicy {
    operation_timeout: Duration,
}

impl Default for OrganizationHttpPolicy {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizationHttpError {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    InvalidInput,
    Conflict,
    PreconditionFailed,
    ReauthenticationRequired,
    Unavailable,
    Internal,
}

impl fmt::Display for OrganizationHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "organization authentication failed",
            Self::Forbidden => "organization request is forbidden",
            Self::NotFound => "organization resource was not found",
            Self::InvalidInput => "organization request is invalid",
            Self::Conflict => "organization state conflicts with the request",
            Self::PreconditionFailed => "organization precondition failed",
            Self::ReauthenticationRequired => "recent reauthentication is required",
            Self::Unavailable => "organization HTTP service is unavailable",
            Self::Internal => "organization HTTP operation failed",
        })
    }
}

impl std::error::Error for OrganizationHttpError {}

mod invitations;
mod lifecycle;
mod members;

pub(crate) use invitations::{IssuedOrganizationInvitationView, OrganizationInvitationView};
pub(crate) use lifecycle::OrganizationView;
pub(crate) use members::MemberView;

#[derive(Clone)]
pub struct OrganizationHttpService {
    runtime: Option<Arc<Runtime>>,
}

struct Runtime {
    pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    organizations: OrganizationService,
    invitations: OrganizationInvitationService,
    external_url: Url,
    timeout: Duration,
}

impl fmt::Debug for OrganizationHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OrganizationHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl OrganizationHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        policy: OrganizationHttpPolicy,
        session_policy: SessionPolicy,
    ) -> Result<Self, OrganizationHttpError> {
        if !(Duration::from_millis(100)..=Duration::from_secs(30))
            .contains(&policy.operation_timeout)
        {
            return Err(OrganizationHttpError::InvalidInput);
        }
        let cookies = BrowserCookieBoundary::new(external_url)
            .map_err(|_| OrganizationHttpError::InvalidInput)?;
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                sessions: SessionService::new(pool.clone(), session_policy),
                organizations: OrganizationService::new(
                    pool.clone(),
                    OrganizationServicePolicy::default(),
                ),
                invitations: OrganizationInvitationService::new_live(
                    pool.clone(),
                    OrganizationInvitationPolicy::default(),
                ),
                pool,
                cookies,
                external_url: external_url.clone(),
                timeout: policy.operation_timeout,
            })),
        })
    }

    fn runtime(&self) -> Result<&Runtime, OrganizationHttpError> {
        self.runtime
            .as_deref()
            .ok_or(OrganizationHttpError::Unavailable)
    }
}

#[derive(Clone)]
struct BrowserIdentity {
    user_id: UserId,
    session_id: crate::identity::SessionId,
    normalized_email: NormalizedEmail,
    display_name: String,
    is_instance_admin: bool,
}

impl BrowserIdentity {
    const fn read_principal(&self) -> OrganizationPrincipal {
        if self.is_instance_admin {
            OrganizationPrincipal::InstanceAdministrator(self.user_id)
        } else {
            OrganizationPrincipal::Owner(self.user_id)
        }
    }

    const fn invitation_actor(&self) -> OrganizationInvitationActor {
        OrganizationInvitationActor::new(self.user_id, self.session_id)
    }

    fn invitee(&self) -> Result<OrganizationInvitationInvitee, OrganizationHttpError> {
        Ok(OrganizationInvitationInvitee::new(
            self.user_id,
            self.session_id,
            self.normalized_email.clone(),
        ))
    }

    fn organization_audit(&self, correlation_id: &str) -> OrganizationAuditContext {
        OrganizationAuditContext::new(
            AuditEventId::new(),
            self.user_id,
            Some(self.display_name.clone()),
            correlation_id.into(),
            None,
        )
    }

    fn invitation_audit(&self, correlation_id: &str) -> OrganizationInvitationAuditContext {
        OrganizationInvitationAuditContext::new(
            AuditEventId::new(),
            self.user_id,
            Some(self.display_name.clone()),
            correlation_id.into(),
            None,
        )
    }
}

impl Runtime {
    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<BrowserIdentity, OrganizationHttpError> {
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
        let session_id = session.id();
        let user_id = session.user_id();
        self.within_timeout(async {
            let mut connection = self.pool.acquire().await.map_err(|_| OrganizationHttpError::Unavailable)?;
            let row = sqlx::query(
                "SELECT normalized_email, display_name, status, is_instance_admin FROM users WHERE id = $1::uuid",
            ).bind(user_id.to_string()).fetch_optional(&mut *connection).await
                .map_err(|_| OrganizationHttpError::Unavailable)?
                .ok_or(OrganizationHttpError::AuthenticationFailed)?;
            let status: String = row.try_get("status").map_err(|_| OrganizationHttpError::Internal)?;
            if status != "active" { return Err(OrganizationHttpError::AuthenticationFailed); }
            let normalized: String = row.try_get("normalized_email").map_err(|_| OrganizationHttpError::Internal)?;
            Ok(BrowserIdentity {
                user_id,
                session_id,
                normalized_email: NormalizedEmail::from_email(&normalized).map_err(|_| OrganizationHttpError::Internal)?,
                display_name: row.try_get("display_name").map_err(|_| OrganizationHttpError::Internal)?,
                is_instance_admin: row.try_get("is_instance_admin").map_err(|_| OrganizationHttpError::Internal)?,
            })
        }).await
    }

    async fn within_timeout<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, OrganizationHttpError>>,
    ) -> Result<T, OrganizationHttpError> {
        tokio_time::timeout(self.timeout, future)
            .await
            .map_err(|_| OrganizationHttpError::Unavailable)?
    }
}

fn parse_role(value: &str) -> Result<OrganizationRole, OrganizationHttpError> {
    match value {
        "owner" => Ok(OrganizationRole::Owner),
        "member" => Ok(OrganizationRole::Member),
        _ => Err(OrganizationHttpError::Internal),
    }
}

fn map_session_error(error: SessionServiceError) -> OrganizationHttpError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            OrganizationHttpError::AuthenticationFailed
        }
        SessionServiceError::DatabaseUnavailable | SessionServiceError::OperationTimeout => {
            OrganizationHttpError::Unavailable
        }
        _ => OrganizationHttpError::Internal,
    }
}

fn map_browser_error(error: BrowserCookieError) -> OrganizationHttpError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            OrganizationHttpError::AuthenticationFailed
        }
        _ => OrganizationHttpError::Forbidden,
    }
}

fn map_organization_error(error: OrganizationServiceError) -> OrganizationHttpError {
    match error {
        OrganizationServiceError::InvalidInput => OrganizationHttpError::InvalidInput,
        OrganizationServiceError::NotFound | OrganizationServiceError::MemberNotFound => {
            OrganizationHttpError::NotFound
        }
        OrganizationServiceError::Unauthorized => OrganizationHttpError::Forbidden,
        OrganizationServiceError::Archived
        | OrganizationServiceError::DuplicateSlug
        | OrganizationServiceError::MemberLimitReached
        | OrganizationServiceError::LastOwner => OrganizationHttpError::Conflict,
        OrganizationServiceError::StaleVersion => OrganizationHttpError::PreconditionFailed,
        OrganizationServiceError::DatabaseUnavailable
        | OrganizationServiceError::OperationTimeout => OrganizationHttpError::Unavailable,
        _ => OrganizationHttpError::Internal,
    }
}

fn map_invitation_error(error: OrganizationInvitationServiceError) -> OrganizationHttpError {
    match error {
        OrganizationInvitationServiceError::InvalidInput => OrganizationHttpError::InvalidInput,
        OrganizationInvitationServiceError::NotFound
        | OrganizationInvitationServiceError::InviteeUnavailable => OrganizationHttpError::NotFound,
        OrganizationInvitationServiceError::Unauthorized => OrganizationHttpError::Forbidden,
        OrganizationInvitationServiceError::ReauthenticationRequired => {
            OrganizationHttpError::ReauthenticationRequired
        }
        OrganizationInvitationServiceError::AlreadyPending
        | OrganizationInvitationServiceError::AlreadyMember
        | OrganizationInvitationServiceError::MemberLimitReached
        | OrganizationInvitationServiceError::InvalidInvitation
        | OrganizationInvitationServiceError::InvitationNotPending => {
            OrganizationHttpError::Conflict
        }
        OrganizationInvitationServiceError::DatabaseUnavailable
        | OrganizationInvitationServiceError::OperationTimeout => {
            OrganizationHttpError::Unavailable
        }
        _ => OrganizationHttpError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_limit_errors_map_to_conflict() {
        assert_eq!(
            map_organization_error(OrganizationServiceError::MemberLimitReached),
            OrganizationHttpError::Conflict
        );
        assert_eq!(
            map_invitation_error(OrganizationInvitationServiceError::MemberLimitReached),
            OrganizationHttpError::Conflict
        );
    }
}
