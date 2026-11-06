use serde::Serialize;
use utoipa::ToSchema;

use crate::identity::BrowserRequestHeaders;
use crate::organization::OrganizationId;
use crate::project::{ProjectId, ProjectRole};

use super::super::{
    TeamId, TeamProjectRoleGrant, TeamProjectRolePageLimit, TeamProjectRoleVersion,
};
use super::{CursorBinding, TeamHttpError, TeamHttpService, TeamMutationView, map_service_error};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamProjectRoleView {
    pub(crate) team_id: String,
    pub(crate) organization_id: String,
    pub(crate) project_id: String,
    pub(crate) role: ProjectRole,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) version: i64,
}

impl From<TeamProjectRoleGrant> for TeamProjectRoleView {
    fn from(grant: TeamProjectRoleGrant) -> Self {
        Self {
            team_id: grant.team_id().to_string(),
            organization_id: grant.organization_id().to_string(),
            project_id: grant.project_id().to_string(),
            role: grant.role(),
            created_at: grant.created_at().to_string(),
            updated_at: grant.updated_at().to_string(),
            version: grant.lock_version().get(),
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamProjectRoleListView {
    pub(crate) items: Vec<TeamProjectRoleView>,
    pub(crate) next_cursor: Option<String>,
}

impl TeamHttpService {
    pub(crate) async fn project_roles(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        page_size: u16,
        cursor: Option<&str>,
    ) -> Result<TeamProjectRoleListView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        let binding = CursorBinding::project_roles(identity.user_id, team_id, page_size);
        let key = cursor
            .map(|value| runtime.cursor.decode_project_role(value, &binding))
            .transpose()?;
        let limit =
            TeamProjectRolePageLimit::new(page_size).map_err(|_| TeamHttpError::InvalidInput)?;
        let page = runtime
            .teams
            .list_project_roles(identity.principal(), team_id, limit, key)
            .await
            .map_err(map_service_error)?;
        let next_cursor = page
            .next_key()
            .map(|key| runtime.cursor.encode_project_role(key, &binding))
            .transpose()?;
        Ok(TeamProjectRoleListView {
            items: page
                .items()
                .iter()
                .cloned()
                .map(TeamProjectRoleView::from)
                .collect(),
            next_cursor,
        })
    }

    pub(crate) async fn add_project_role(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        project_id: ProjectId,
        role: ProjectRole,
        request_id: &str,
    ) -> Result<TeamProjectRoleView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        runtime
            .teams
            .add_project_role(
                identity.principal(),
                team_id,
                project_id,
                role,
                &identity.audit(request_id),
            )
            .await
            .map(TeamProjectRoleView::from)
            .map_err(map_service_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn change_project_role(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        project_id: ProjectId,
        version: TeamProjectRoleVersion,
        role: ProjectRole,
        request_id: &str,
    ) -> Result<TeamProjectRoleView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        runtime
            .teams
            .change_project_role(
                identity.principal(),
                team_id,
                project_id,
                version,
                role,
                &identity.audit(request_id),
            )
            .await
            .map(TeamProjectRoleView::from)
            .map_err(map_service_error)
    }

    pub(crate) async fn remove_project_role(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        project_id: ProjectId,
        version: TeamProjectRoleVersion,
        request_id: &str,
    ) -> Result<TeamMutationView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        runtime
            .teams
            .remove_project_role(
                identity.principal(),
                team_id,
                project_id,
                version,
                &identity.audit(request_id),
            )
            .await
            .map(TeamMutationView::from)
            .map_err(map_service_error)
    }
}
