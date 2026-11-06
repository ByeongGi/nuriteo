use serde::Serialize;
use utoipa::ToSchema;

use crate::identity::{BrowserRequestHeaders, UserId};
use crate::organization::OrganizationId;

use super::super::{TeamId, TeamMemberPageLimit, TeamMembership, TeamMembershipVersion, TeamRole};
use super::{CursorBinding, TeamHttpError, TeamHttpService, TeamMutationView, map_service_error};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamMemberView {
    pub(crate) team_id: String,
    pub(crate) organization_id: String,
    pub(crate) user_id: String,
    pub(crate) role: TeamRole,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) version: i64,
}

impl From<TeamMembership> for TeamMemberView {
    fn from(member: TeamMembership) -> Self {
        Self {
            team_id: member.team_id().to_string(),
            organization_id: member.organization_id().to_string(),
            user_id: member.user_id().to_string(),
            role: member.role(),
            created_at: member.created_at().to_string(),
            updated_at: member.updated_at().to_string(),
            version: member.lock_version().get(),
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamMemberListView {
    pub(crate) items: Vec<TeamMemberView>,
    pub(crate) next_cursor: Option<String>,
}

impl TeamHttpService {
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn members(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        page_size: u16,
        cursor: Option<&str>,
    ) -> Result<TeamMemberListView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        let binding = CursorBinding::members(identity.user_id, team_id, page_size);
        let key = cursor
            .map(|value| runtime.cursor.decode_member(value, &binding))
            .transpose()?;
        let limit = TeamMemberPageLimit::new(page_size).map_err(|_| TeamHttpError::InvalidInput)?;
        let page = runtime
            .teams
            .list_members(identity.principal(), team_id, limit, key)
            .await
            .map_err(map_service_error)?;
        let next_cursor = page
            .next_key()
            .map(|key| runtime.cursor.encode_member(key, &binding))
            .transpose()?;
        Ok(TeamMemberListView {
            items: page
                .items()
                .iter()
                .cloned()
                .map(TeamMemberView::from)
                .collect(),
            next_cursor,
        })
    }

    pub(crate) async fn add_member(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        user_id: UserId,
        role: TeamRole,
        request_id: &str,
    ) -> Result<TeamMemberView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        runtime
            .teams
            .add_member(
                identity.principal(),
                team_id,
                user_id,
                role,
                &identity.audit(request_id),
            )
            .await
            .map(TeamMemberView::from)
            .map_err(map_service_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn change_member(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        user_id: UserId,
        version: TeamMembershipVersion,
        role: TeamRole,
        request_id: &str,
    ) -> Result<TeamMemberView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        runtime
            .teams
            .change_member_role(
                identity.principal(),
                team_id,
                user_id,
                version,
                role,
                &identity.audit(request_id),
            )
            .await
            .map(TeamMemberView::from)
            .map_err(map_service_error)
    }

    pub(crate) async fn remove_member(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        user_id: UserId,
        version: TeamMembershipVersion,
        request_id: &str,
    ) -> Result<TeamMutationView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        runtime
            .teams
            .remove_member(
                identity.principal(),
                team_id,
                user_id,
                version,
                &identity.audit(request_id),
            )
            .await
            .map(TeamMutationView::from)
            .map_err(map_service_error)
    }
}
