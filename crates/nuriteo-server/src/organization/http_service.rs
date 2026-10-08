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

    pub(crate) async fn create(
        &self,
        request: BrowserRequestHeaders<'_>,
        slug: String,
        display_name: String,
        correlation_id: &str,
    ) -> Result<OrganizationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .create(
                identity.user_id,
                slug,
                display_name,
                &identity.organization_audit(correlation_id),
            )
            .await
            .map(OrganizationView::from)
            .map_err(map_organization_error)
    }

    pub(crate) async fn get(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
    ) -> Result<OrganizationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .get(identity.read_principal(), organization_id)
            .await
            .map(OrganizationView::from)
            .map_err(map_organization_error)
    }

    pub(crate) async fn update(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        version: OrganizationVersion,
        display_name: String,
        correlation_id: &str,
    ) -> Result<OrganizationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .update_display_name(
                OrganizationPrincipal::Owner(identity.user_id),
                organization_id,
                version,
                display_name,
                &identity.organization_audit(correlation_id),
            )
            .await
            .map(OrganizationView::from)
            .map_err(map_organization_error)
    }

    pub(crate) async fn archive(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        version: OrganizationVersion,
        correlation_id: &str,
    ) -> Result<OrganizationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .archive(
                OrganizationPrincipal::Owner(identity.user_id),
                organization_id,
                version,
                &identity.organization_audit(correlation_id),
            )
            .await
            .map(OrganizationView::from)
            .map_err(map_organization_error)
    }

    pub(crate) async fn members(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
    ) -> Result<Vec<MemberView>, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime.list_members(identity, organization_id).await
    }

    pub(crate) async fn change_member_role(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        user_id: UserId,
        role: OrganizationRole,
        correlation_id: &str,
    ) -> Result<MembershipChangeResult, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .change_member_role(
                OrganizationPrincipal::Owner(identity.user_id),
                organization_id,
                user_id,
                role,
                &identity.organization_audit(correlation_id),
            )
            .await
            .map_err(map_organization_error)
    }

    pub(crate) async fn remove_member(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        user_id: UserId,
        correlation_id: &str,
    ) -> Result<MembershipRemoveResult, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .organizations
            .remove_member(
                OrganizationPrincipal::Owner(identity.user_id),
                organization_id,
                user_id,
                &identity.organization_audit(correlation_id),
            )
            .await
            .map_err(map_organization_error)
    }

    pub(crate) async fn list_invitations(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
    ) -> Result<Vec<OrganizationInvitationView>, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime.list_invitations(identity, organization_id).await
    }

    pub(crate) async fn issue_invitation(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        invitee_email: NormalizedEmail,
        role: OrganizationRole,
        correlation_id: &str,
    ) -> Result<IssuedOrganizationInvitationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let issued = runtime
            .invitations
            .issue(
                organization_id,
                identity.invitation_actor(),
                invitee_email,
                role,
                &identity.invitation_audit(correlation_id),
            )
            .await
            .map_err(map_invitation_error)?;
        runtime.issued_view(issued)
    }

    pub(crate) async fn reissue_invitation(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        invitation_id: OrganizationInvitationId,
        role: OrganizationRole,
        correlation_id: &str,
    ) -> Result<IssuedOrganizationInvitationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .authorize_invitation_item(&identity, organization_id, invitation_id)
            .await?;
        let issued = runtime
            .invitations
            .reissue(
                invitation_id,
                identity.invitation_actor(),
                role,
                &identity.invitation_audit(correlation_id),
            )
            .await
            .map_err(map_invitation_error)?;
        runtime.issued_view(issued)
    }

    pub(crate) async fn revoke_invitation(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        invitation_id: OrganizationInvitationId,
        correlation_id: &str,
    ) -> Result<OrganizationInvitationRevokeResult, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .authorize_invitation_item(&identity, organization_id, invitation_id)
            .await?;
        runtime
            .invitations
            .revoke(
                invitation_id,
                identity.invitation_actor(),
                &identity.invitation_audit(correlation_id),
            )
            .await
            .map_err(map_invitation_error)
    }

    pub(crate) async fn accept_invitation(
        &self,
        request: BrowserRequestHeaders<'_>,
        token: OrganizationInvitationToken,
        correlation_id: &str,
    ) -> Result<OrganizationInvitationView, OrganizationHttpError> {
        self.respond_to_invitation(request, token, correlation_id, true)
            .await
    }

    pub(crate) async fn decline_invitation(
        &self,
        request: BrowserRequestHeaders<'_>,
        token: OrganizationInvitationToken,
        correlation_id: &str,
    ) -> Result<OrganizationInvitationView, OrganizationHttpError> {
        self.respond_to_invitation(request, token, correlation_id, false)
            .await
    }

    async fn respond_to_invitation(
        &self,
        request: BrowserRequestHeaders<'_>,
        token: OrganizationInvitationToken,
        correlation_id: &str,
        accept: bool,
    ) -> Result<OrganizationInvitationView, OrganizationHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let invitee = identity.invitee()?;
        let audit = identity.invitation_audit(correlation_id);
        let invitation = if accept {
            runtime.invitations.accept(&token, &invitee, &audit).await
        } else {
            runtime.invitations.decline(&token, &invitee, &audit).await
        }
        .map_err(map_invitation_error)?;
        Ok(OrganizationInvitationView::from(invitation))
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

    async fn list_members(
        &self,
        identity: BrowserIdentity,
        organization_id: OrganizationId,
    ) -> Result<Vec<MemberView>, OrganizationHttpError> {
        self.within_timeout(async {
            let mut connection = self.pool.acquire().await.map_err(|_| OrganizationHttpError::Unavailable)?;
            let rows = sqlx::query(
                "SELECT member.id::text AS user_id, member.display_name, membership.role \
                 FROM organizations organization \
                 JOIN users actor ON actor.id = $2::uuid AND actor.status = 'active' \
                 LEFT JOIN organization_memberships actor_membership ON actor_membership.organization_id = organization.id AND actor_membership.user_id = actor.id \
                 JOIN organization_memberships membership ON membership.organization_id = organization.id \
                 JOIN users member ON member.id = membership.user_id AND member.status = 'active' \
                 WHERE organization.id = $1::uuid AND organization.status = 'active' \
                   AND (actor_membership.role IS NOT NULL OR ($3 AND actor.is_instance_admin)) \
                 ORDER BY member.id LIMIT $4",
            ).bind(organization_id.to_string()).bind(identity.user_id.to_string())
                .bind(identity.is_instance_admin).bind(LIST_LIMIT)
                .fetch_all(&mut *connection).await.map_err(|_| OrganizationHttpError::Unavailable)?;
            if rows.is_empty() {
                self.ensure_readable(&mut connection, &identity, organization_id).await?;
            }
            rows.into_iter().map(|row| {
                let role: String = row.try_get("role").map_err(|_| OrganizationHttpError::Internal)?;
                Ok(MemberView {
                    user_id: row.try_get("user_id").map_err(|_| OrganizationHttpError::Internal)?,
                    display_name: row.try_get("display_name").map_err(|_| OrganizationHttpError::Internal)?,
                    role: parse_role(&role)?,
                })
            }).collect()
        }).await
    }

    async fn list_invitations(
        &self,
        identity: BrowserIdentity,
        organization_id: OrganizationId,
    ) -> Result<Vec<OrganizationInvitationView>, OrganizationHttpError> {
        self.within_timeout(async {
            let mut connection = self.pool.acquire().await.map_err(|_| OrganizationHttpError::Unavailable)?;
            let authorized: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM organizations o JOIN organization_memberships m ON m.organization_id=o.id JOIN users u ON u.id=$2::uuid WHERE o.id=$1::uuid AND o.status='active' AND m.user_id=u.id AND m.role='owner' AND u.status='active')",
            ).bind(organization_id.to_string()).bind(identity.user_id.to_string())
                .fetch_one(&mut *connection).await.map_err(|_| OrganizationHttpError::Unavailable)?;
            if !authorized { return Err(OrganizationHttpError::Forbidden); }
            let rows = sqlx::query(
                "SELECT id::text, organization_id::text, invitee_user_id::text, proposed_role, status, created_at, expires_at, accepted_at, declined_at, expired_at, revoked_at, superseded_at, replaced_by_invitation_id::text \
                 FROM organization_invitations WHERE organization_id=$1::uuid ORDER BY created_at DESC, id DESC LIMIT $2",
            ).bind(organization_id.to_string()).bind(LIST_LIMIT)
                .fetch_all(&mut *connection).await.map_err(|_| OrganizationHttpError::Unavailable)?;
            rows.into_iter().map(invitation_view_from_row).collect()
        }).await
    }

    async fn ensure_readable(
        &self,
        connection: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        identity: &BrowserIdentity,
        organization_id: OrganizationId,
    ) -> Result<(), OrganizationHttpError> {
        let readable: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM organizations o JOIN users u ON u.id=$2::uuid LEFT JOIN organization_memberships m ON m.organization_id=o.id AND m.user_id=u.id WHERE o.id=$1::uuid AND o.status='active' AND u.status='active' AND (m.role IS NOT NULL OR ($3 AND u.is_instance_admin)))",
        ).bind(organization_id.to_string()).bind(identity.user_id.to_string()).bind(identity.is_instance_admin)
            .fetch_one(&mut **connection).await.map_err(|_| OrganizationHttpError::Unavailable)?;
        if readable {
            Ok(())
        } else {
            Err(OrganizationHttpError::NotFound)
        }
    }

    async fn authorize_invitation_item(
        &self,
        identity: &BrowserIdentity,
        organization_id: OrganizationId,
        invitation_id: OrganizationInvitationId,
    ) -> Result<(), OrganizationHttpError> {
        self.within_timeout(async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| OrganizationHttpError::Unavailable)?;
            let status: Option<String> = sqlx::query_scalar(
                "SELECT organization.status FROM organization_invitations invitation \
                 JOIN organizations organization ON organization.id=invitation.organization_id \
                 JOIN organization_memberships membership ON membership.organization_id=organization.id \
                 JOIN users actor ON actor.id=membership.user_id \
                 WHERE invitation.id=$1::uuid AND invitation.organization_id=$2::uuid \
                   AND membership.user_id=$3::uuid AND membership.role='owner' AND actor.status='active'",
            )
            .bind(invitation_id.to_string())
            .bind(organization_id.to_string())
            .bind(identity.user_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| OrganizationHttpError::Unavailable)?;
            match status.as_deref() {
                Some("active") => Ok(()),
                Some("archived") => Err(OrganizationHttpError::Conflict),
                Some(_) => Err(OrganizationHttpError::Internal),
                None => Err(OrganizationHttpError::NotFound),
            }
        })
        .await
    }

    fn issued_view(
        &self,
        issued: IssuedOrganizationInvitation,
    ) -> Result<IssuedOrganizationInvitationView, OrganizationHttpError> {
        let email_delivery_queued = issued.email_delivery_queued();
        let (invitation, token) = issued.into_parts();
        let (delivery, accept_url) = if email_delivery_queued {
            (OrganizationInvitationDeliveryView::EmailQueued, None)
        } else {
            let mut url = self.external_url.clone();
            url.set_path("/organization-invitations/accept");
            url.set_query(None);
            url.set_fragment(None);
            url.query_pairs_mut().append_pair("token", token.expose());
            (
                OrganizationInvitationDeliveryView::CopyOnce,
                Some(url.into()),
            )
        };
        Ok(IssuedOrganizationInvitationView {
            invitation: OrganizationInvitationView::from(invitation),
            delivery,
            accept_url,
        })
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

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrganizationView {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) display_name: String,
    pub(crate) status: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) archived_at: Option<String>,
    pub(crate) version: i64,
}

impl From<Organization> for OrganizationView {
    fn from(value: Organization) -> Self {
        let fields = value.into_fields();
        Self {
            id: fields.id.to_string(),
            slug: fields.slug,
            display_name: fields.display_name,
            status: match fields.status {
                super::OrganizationStatus::Active => "active",
                super::OrganizationStatus::Archived => "archived",
            }
            .into(),
            created_at: fields.created_at.to_string(),
            updated_at: fields.updated_at.to_string(),
            archived_at: fields.archived_at.map(|value| value.to_string()),
            version: fields.lock_version.get(),
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberView {
    user_id: String,
    display_name: String,
    role: OrganizationRole,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrganizationInvitationView {
    id: String,
    organization_id: String,
    invitee_user_id: String,
    proposed_role: OrganizationRole,
    status: OrganizationInvitationStatus,
    created_at: String,
    expires_at: String,
    accepted_at: Option<String>,
    declined_at: Option<String>,
    expired_at: Option<String>,
    revoked_at: Option<String>,
    superseded_at: Option<String>,
    replacement_id: Option<String>,
}

impl From<OrganizationInvitation> for OrganizationInvitationView {
    fn from(value: OrganizationInvitation) -> Self {
        let fields = value.into_fields();
        Self {
            id: fields.id.to_string(),
            organization_id: fields.organization_id.to_string(),
            invitee_user_id: fields.invitee_user_id.to_string(),
            proposed_role: fields.proposed_role,
            status: fields.status,
            created_at: fields.created_at.to_string(),
            expires_at: fields.expires_at.to_string(),
            accepted_at: fields.accepted_at.map(|v| v.to_string()),
            declined_at: fields.declined_at.map(|v| v.to_string()),
            expired_at: fields.expired_at.map(|v| v.to_string()),
            revoked_at: fields.revoked_at.map(|v| v.to_string()),
            superseded_at: fields.superseded_at.map(|v| v.to_string()),
            replacement_id: fields.replaced_by_invitation_id.map(|v| v.to_string()),
        }
    }
}

#[derive(Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssuedOrganizationInvitationView {
    #[serde(flatten)]
    invitation: OrganizationInvitationView,
    delivery: OrganizationInvitationDeliveryView,
    #[schema(required)]
    accept_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OrganizationInvitationDeliveryView {
    CopyOnce,
    EmailQueued,
}

impl fmt::Debug for IssuedOrganizationInvitationView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedOrganizationInvitationView")
            .field("invitation", &self.invitation)
            .field("accept_url", &"[REDACTED]")
            .finish()
    }
}

fn invitation_view_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<OrganizationInvitationView, OrganizationHttpError> {
    fn optional_time(
        row: &sqlx::postgres::PgRow,
        name: &str,
    ) -> Result<Option<String>, OrganizationHttpError> {
        let value: Option<OffsetDateTime> = row
            .try_get(name)
            .map_err(|_| OrganizationHttpError::Internal)?;
        Ok(value.map(|value| value.to_string()))
    }
    let role: String = row
        .try_get("proposed_role")
        .map_err(|_| OrganizationHttpError::Internal)?;
    let status: String = row
        .try_get("status")
        .map_err(|_| OrganizationHttpError::Internal)?;
    let created: OffsetDateTime = row
        .try_get("created_at")
        .map_err(|_| OrganizationHttpError::Internal)?;
    let expires: OffsetDateTime = row
        .try_get("expires_at")
        .map_err(|_| OrganizationHttpError::Internal)?;
    Ok(OrganizationInvitationView {
        id: row
            .try_get("id")
            .map_err(|_| OrganizationHttpError::Internal)?,
        organization_id: row
            .try_get("organization_id")
            .map_err(|_| OrganizationHttpError::Internal)?,
        invitee_user_id: row
            .try_get("invitee_user_id")
            .map_err(|_| OrganizationHttpError::Internal)?,
        proposed_role: parse_role(&role)?,
        status: parse_status(&status)?,
        created_at: created.to_string(),
        expires_at: expires.to_string(),
        accepted_at: optional_time(&row, "accepted_at")?,
        declined_at: optional_time(&row, "declined_at")?,
        expired_at: optional_time(&row, "expired_at")?,
        revoked_at: optional_time(&row, "revoked_at")?,
        superseded_at: optional_time(&row, "superseded_at")?,
        replacement_id: row
            .try_get("replaced_by_invitation_id")
            .map_err(|_| OrganizationHttpError::Internal)?,
    })
}

fn parse_role(value: &str) -> Result<OrganizationRole, OrganizationHttpError> {
    match value {
        "owner" => Ok(OrganizationRole::Owner),
        "member" => Ok(OrganizationRole::Member),
        _ => Err(OrganizationHttpError::Internal),
    }
}

fn parse_status(value: &str) -> Result<OrganizationInvitationStatus, OrganizationHttpError> {
    match value {
        "pending" => Ok(OrganizationInvitationStatus::Pending),
        "accepted" => Ok(OrganizationInvitationStatus::Accepted),
        "declined" => Ok(OrganizationInvitationStatus::Declined),
        "expired" => Ok(OrganizationInvitationStatus::Expired),
        "revoked" => Ok(OrganizationInvitationStatus::Revoked),
        "superseded" => Ok(OrganizationInvitationStatus::Superseded),
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
