use serde::Serialize;
use sqlx::Row;
use utoipa::ToSchema;

use crate::identity::{BrowserRequestHeaders, UserId};

use super::super::{
    MembershipChangeResult, MembershipRemoveResult, OrganizationId, OrganizationPrincipal,
    OrganizationRole,
};
use super::{
    BrowserIdentity, LIST_LIMIT, OrganizationHttpError, OrganizationHttpService, Runtime,
    map_organization_error, parse_role,
};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberView {
    user_id: String,
    display_name: String,
    role: OrganizationRole,
}

impl OrganizationHttpService {
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
}

impl Runtime {
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
}
