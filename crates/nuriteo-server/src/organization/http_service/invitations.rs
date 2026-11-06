use std::fmt;

use serde::Serialize;
use sqlx::Row;
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::identity::{BrowserRequestHeaders, NormalizedEmail, UserId};

use super::super::{
    IssuedOrganizationInvitation, OrganizationId, OrganizationInvitation, OrganizationInvitationId,
    OrganizationInvitationRevokeResult, OrganizationInvitationServiceError,
    OrganizationInvitationStatus, OrganizationInvitationToken, OrganizationRole,
};
use super::{
    BrowserIdentity, LIST_LIMIT, OrganizationHttpError, OrganizationHttpService, Runtime,
    map_invitation_error, parse_role,
};

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

impl OrganizationHttpService {
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
}

impl Runtime {
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
}
