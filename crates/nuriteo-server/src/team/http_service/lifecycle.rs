use serde::Serialize;
use utoipa::ToSchema;

use crate::identity::BrowserRequestHeaders;
use crate::organization::OrganizationId;

use super::super::{Team, TeamDisplayName, TeamId, TeamPageLimit, TeamSlug, TeamVersion};
use super::{CursorBinding, TeamHttpError, TeamHttpService, TeamMutationView, map_service_error};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamView {
    pub(crate) id: String,
    pub(crate) organization_id: String,
    pub(crate) slug: String,
    pub(crate) display_name: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) version: i64,
}

impl From<Team> for TeamView {
    fn from(team: Team) -> Self {
        Self {
            id: team.id().to_string(),
            organization_id: team.organization_id().to_string(),
            slug: team.slug().to_string(),
            display_name: team.display_name().as_str().to_owned(),
            created_at: team.created_at().to_string(),
            updated_at: team.updated_at().to_string(),
            version: team.lock_version().get(),
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamListView {
    pub(crate) items: Vec<TeamView>,
    pub(crate) next_cursor: Option<String>,
}

impl TeamHttpService {
    pub(crate) async fn create(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        slug: TeamSlug,
        display_name: TeamDisplayName,
        request_id: &str,
    ) -> Result<TeamView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .teams
            .create(
                identity.principal(),
                organization_id,
                slug,
                display_name,
                &identity.audit(request_id),
            )
            .await
            .map(TeamView::from)
            .map_err(map_service_error)
    }

    pub(crate) async fn get(
        &self,
        request: BrowserRequestHeaders<'_>,
        team_id: TeamId,
    ) -> Result<TeamView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .teams
            .get(identity.principal(), team_id)
            .await
            .map(TeamView::from)
            .map_err(map_service_error)
    }

    pub(crate) async fn list(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        page_size: u16,
        cursor: Option<&str>,
    ) -> Result<TeamListView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        let binding = CursorBinding::teams(identity.user_id, organization_id, page_size);
        let key = cursor
            .map(|value| runtime.cursor.decode_team(value, &binding))
            .transpose()?;
        let limit = TeamPageLimit::new(page_size).map_err(|_| TeamHttpError::InvalidInput)?;
        let page = runtime
            .teams
            .list(identity.principal(), organization_id, limit, key.as_ref())
            .await
            .map_err(map_service_error)?;
        let next_cursor = page
            .next_key()
            .map(|key| runtime.cursor.encode_team(key, &binding))
            .transpose()?;
        Ok(TeamListView {
            items: page.teams().iter().cloned().map(TeamView::from).collect(),
            next_cursor,
        })
    }

    pub(crate) async fn rename(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        version: TeamVersion,
        display_name: TeamDisplayName,
        request_id: &str,
    ) -> Result<TeamView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        runtime
            .teams
            .rename(
                identity.principal(),
                team_id,
                version,
                display_name,
                &identity.audit(request_id),
            )
            .await
            .map(TeamView::from)
            .map_err(map_service_error)
    }

    pub(crate) async fn delete(
        &self,
        request: BrowserRequestHeaders<'_>,
        organization_id: OrganizationId,
        team_id: TeamId,
        version: TeamVersion,
        request_id: &str,
    ) -> Result<TeamMutationView, TeamHttpError> {
        let runtime = self.runtime()?;
        let identity = runtime.authenticate(request).await?;
        runtime
            .ensure_team_scope(identity.principal(), organization_id, team_id)
            .await?;
        runtime
            .teams
            .delete(
                identity.principal(),
                team_id,
                version,
                &identity.audit(request_id),
            )
            .await
            .map(TeamMutationView::from)
            .map_err(map_service_error)
    }
}
