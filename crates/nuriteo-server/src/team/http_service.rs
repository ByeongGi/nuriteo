use std::fmt;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use url::Url;
use utoipa::ToSchema;

use crate::audit::AuditEventId;
use crate::database::DatabasePool;
use crate::identity::{
    BrowserCookieBoundary, BrowserCookieError, BrowserRequestHeaders, SessionPolicy,
    SessionService, SessionServiceError, UserId,
};
use crate::organization::OrganizationId;
use crate::project::{ProjectId, ProjectRole};

use super::{
    Team, TeamAuditContext, TeamDisplayName, TeamId, TeamMemberPageKey, TeamMemberPageLimit,
    TeamMembership, TeamMembershipVersion, TeamMutationResult, TeamPageKey, TeamPageLimit,
    TeamPrincipal, TeamProjectRoleGrant, TeamProjectRolePageKey, TeamProjectRolePageLimit,
    TeamRole, TeamService, TeamServiceError, TeamServicePolicy, TeamSlug, TeamVersion,
};

const CURSOR_PREFIX: &str = "nrt_team_cursor_";
const MAX_CURSOR_BYTES: usize = 2048;

#[derive(Debug, Clone, Copy)]
pub struct TeamHttpPolicy {
    operation_timeout: Duration,
}

impl TeamHttpPolicy {
    pub fn new(operation_timeout: Duration) -> Result<Self, TeamHttpError> {
        if !(Duration::from_millis(100)..=Duration::from_secs(30)).contains(&operation_timeout) {
            return Err(TeamHttpError::InvalidInput);
        }
        Ok(Self { operation_timeout })
    }
}

impl Default for TeamHttpPolicy {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamHttpError {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    InvalidInput,
    Conflict,
    PreconditionFailed,
    AuditUnavailable,
    Unavailable,
    OperationTimeout,
    Internal,
}

impl fmt::Display for TeamHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AuthenticationFailed => "team authentication failed",
            Self::Forbidden => "team request is forbidden",
            Self::NotFound => "team resource was not found",
            Self::InvalidInput => "team request is invalid",
            Self::Conflict => "team state conflicts with the request",
            Self::PreconditionFailed => "team precondition failed",
            Self::AuditUnavailable => "team audit is unavailable",
            Self::Unavailable => "team service is unavailable",
            Self::OperationTimeout => "team operation timed out",
            Self::Internal => "team operation failed",
        })
    }
}

impl std::error::Error for TeamHttpError {}

#[derive(Clone)]
pub struct TeamHttpService {
    runtime: Option<Arc<Runtime>>,
}

struct Runtime {
    pool: DatabasePool,
    sessions: SessionService,
    cookies: BrowserCookieBoundary,
    teams: TeamService,
    cursor: CursorCodec,
}

impl fmt::Debug for TeamHttpService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TeamHttpService")
            .field("configured", &self.runtime.is_some())
            .finish()
    }
}

impl TeamHttpService {
    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { runtime: None }
    }

    pub fn production(
        pool: DatabasePool,
        external_url: &Url,
        policy: TeamHttpPolicy,
        session_policy: SessionPolicy,
    ) -> Result<Self, TeamHttpError> {
        let cookies =
            BrowserCookieBoundary::new(external_url).map_err(|_| TeamHttpError::InvalidInput)?;
        let service_policy = TeamServicePolicy::new(policy.operation_timeout)
            .map_err(|_| TeamHttpError::InvalidInput)?;
        Ok(Self {
            runtime: Some(Arc::new(Runtime {
                sessions: SessionService::new(pool.clone(), session_policy),
                teams: TeamService::new(pool.clone(), service_policy),
                pool,
                cookies,
                cursor: CursorCodec,
            })),
        })
    }

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
        version: super::TeamProjectRoleVersion,
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
        version: super::TeamProjectRoleVersion,
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

    fn runtime(&self) -> Result<&Runtime, TeamHttpError> {
        self.runtime.as_deref().ok_or(TeamHttpError::Unavailable)
    }
}

struct BrowserIdentity {
    user_id: UserId,
    display_name: String,
    is_instance_admin: bool,
}

impl BrowserIdentity {
    const fn principal(&self) -> TeamPrincipal {
        if self.is_instance_admin {
            TeamPrincipal::InstanceAdministrator(self.user_id)
        } else {
            TeamPrincipal::User(self.user_id)
        }
    }

    fn audit(&self, request_id: &str) -> TeamAuditContext {
        TeamAuditContext::new(
            AuditEventId::new(),
            self.user_id,
            Some(self.display_name.clone()),
            request_id.to_owned(),
            None::<IpAddr>,
        )
    }
}

impl Runtime {
    async fn ensure_team_scope(
        &self,
        principal: TeamPrincipal,
        organization_id: OrganizationId,
        team_id: TeamId,
    ) -> Result<(), TeamHttpError> {
        let team = match self.teams.get(principal, team_id).await {
            Ok(team) => team,
            Err(TeamServiceError::NotFound | TeamServiceError::Unauthorized) => {
                return Err(TeamHttpError::NotFound);
            }
            Err(error) => return Err(map_service_error(error)),
        };
        if team.organization_id() == organization_id {
            Ok(())
        } else {
            Err(TeamHttpError::NotFound)
        }
    }

    async fn authenticate(
        &self,
        request: BrowserRequestHeaders<'_>,
    ) -> Result<BrowserIdentity, TeamHttpError> {
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
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| TeamHttpError::Unavailable)?;
        let row = sqlx::query(
            "SELECT display_name,status,is_instance_admin FROM users WHERE id=$1::uuid",
        )
        .bind(session.user_id().to_string())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| TeamHttpError::Unavailable)?
        .ok_or(TeamHttpError::AuthenticationFailed)?;
        let status: String = row.try_get("status").map_err(|_| TeamHttpError::Internal)?;
        if status != "active" {
            return Err(TeamHttpError::AuthenticationFailed);
        }
        Ok(BrowserIdentity {
            user_id: session.user_id(),
            display_name: row
                .try_get("display_name")
                .map_err(|_| TeamHttpError::Internal)?,
            is_instance_admin: row
                .try_get("is_instance_admin")
                .map_err(|_| TeamHttpError::Internal)?,
        })
    }
}

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

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamMutationView {
    pub(crate) changed: bool,
}

impl From<TeamMutationResult> for TeamMutationView {
    fn from(result: TeamMutationResult) -> Self {
        Self {
            changed: matches!(result, TeamMutationResult::Changed),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorClaims {
    version: u8,
    kind: String,
    actor_id: String,
    scope_id: String,
    page_size: u16,
    first: Option<String>,
    second: Option<String>,
}

struct CursorBinding {
    kind: &'static str,
    actor_id: String,
    scope_id: String,
    page_size: u16,
}

impl CursorBinding {
    fn teams(actor: UserId, organization: OrganizationId, page_size: u16) -> Self {
        Self::new("teams", actor, organization.to_string(), page_size)
    }

    fn members(actor: UserId, team: TeamId, page_size: u16) -> Self {
        Self::new("members", actor, team.to_string(), page_size)
    }

    fn project_roles(actor: UserId, team: TeamId, page_size: u16) -> Self {
        Self::new("project-roles", actor, team.to_string(), page_size)
    }

    fn new(kind: &'static str, actor: UserId, scope_id: String, page_size: u16) -> Self {
        Self {
            kind,
            actor_id: actor.to_string(),
            scope_id,
            page_size,
        }
    }
}

#[derive(Clone, Copy)]
struct CursorCodec;

impl CursorCodec {
    fn encode_team(
        &self,
        key: &TeamPageKey,
        binding: &CursorBinding,
    ) -> Result<String, TeamHttpError> {
        self.encode(
            binding,
            Some(key.slug().to_string()),
            Some(key.id().to_string()),
        )
    }

    fn encode_member(
        &self,
        key: TeamMemberPageKey,
        binding: &CursorBinding,
    ) -> Result<String, TeamHttpError> {
        self.encode(binding, Some(key.user_id().to_string()), None)
    }

    fn encode_project_role(
        &self,
        key: TeamProjectRolePageKey,
        binding: &CursorBinding,
    ) -> Result<String, TeamHttpError> {
        self.encode(binding, Some(key.project_id().to_string()), None)
    }

    fn encode(
        &self,
        binding: &CursorBinding,
        first: Option<String>,
        second: Option<String>,
    ) -> Result<String, TeamHttpError> {
        let claims = CursorClaims {
            version: 1,
            kind: binding.kind.to_owned(),
            actor_id: binding.actor_id.clone(),
            scope_id: binding.scope_id.clone(),
            page_size: binding.page_size,
            first,
            second,
        };
        let payload = serde_json::to_vec(&claims).map_err(|_| TeamHttpError::Internal)?;
        // The position is only an untrusted keyset hint. Authorization and
        // canonical Organization/Team scope are revalidated on every page, so
        // this deliberately stateless cursor remains valid across replicas and
        // restarts without creating a new cluster secret.
        Ok(format!(
            "{CURSOR_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(payload)
        ))
    }

    fn decode_team(
        &self,
        value: &str,
        binding: &CursorBinding,
    ) -> Result<TeamPageKey, TeamHttpError> {
        let claims = self.decode(value, binding)?;
        match (claims.first, claims.second) {
            (Some(slug), Some(id)) => Ok(TeamPageKey::new(
                slug.parse().map_err(|_| TeamHttpError::InvalidInput)?,
                id.parse().map_err(|_| TeamHttpError::InvalidInput)?,
            )),
            _ => Err(TeamHttpError::InvalidInput),
        }
    }

    fn decode_member(
        &self,
        value: &str,
        binding: &CursorBinding,
    ) -> Result<TeamMemberPageKey, TeamHttpError> {
        let claims = self.decode(value, binding)?;
        match (claims.first, claims.second) {
            (Some(id), None) => Ok(TeamMemberPageKey::new(
                id.parse().map_err(|_| TeamHttpError::InvalidInput)?,
            )),
            _ => Err(TeamHttpError::InvalidInput),
        }
    }

    fn decode_project_role(
        &self,
        value: &str,
        binding: &CursorBinding,
    ) -> Result<TeamProjectRolePageKey, TeamHttpError> {
        let claims = self.decode(value, binding)?;
        match (claims.first, claims.second) {
            (Some(id), None) => Ok(TeamProjectRolePageKey::new(
                id.parse().map_err(|_| TeamHttpError::InvalidInput)?,
            )),
            _ => Err(TeamHttpError::InvalidInput),
        }
    }

    fn decode(&self, value: &str, binding: &CursorBinding) -> Result<CursorClaims, TeamHttpError> {
        if value.len() > MAX_CURSOR_BYTES {
            return Err(TeamHttpError::InvalidInput);
        }
        let encoded = value
            .strip_prefix(CURSOR_PREFIX)
            .ok_or(TeamHttpError::InvalidInput)?;
        let payload = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| TeamHttpError::InvalidInput)?;
        let claims: CursorClaims =
            serde_json::from_slice(&payload).map_err(|_| TeamHttpError::InvalidInput)?;
        let canonical = serde_json::to_vec(&claims).map_err(|_| TeamHttpError::Internal)?;
        if canonical != payload || URL_SAFE_NO_PAD.encode(&canonical) != encoded {
            return Err(TeamHttpError::InvalidInput);
        }
        if claims.version != 1
            || claims.kind != binding.kind
            || claims.actor_id != binding.actor_id
            || claims.scope_id != binding.scope_id
            || claims.page_size != binding.page_size
        {
            return Err(TeamHttpError::InvalidInput);
        }
        Ok(claims)
    }
}

fn map_service_error(error: TeamServiceError) -> TeamHttpError {
    match error {
        TeamServiceError::InvalidInput => TeamHttpError::InvalidInput,
        TeamServiceError::NotFound
        | TeamServiceError::MembershipNotFound
        | TeamServiceError::ProjectRoleNotFound => TeamHttpError::NotFound,
        TeamServiceError::Unauthorized => TeamHttpError::Forbidden,
        TeamServiceError::UserUnavailable
        | TeamServiceError::OrganizationUnavailable
        | TeamServiceError::TeamUnavailable
        | TeamServiceError::ProjectUnavailable
        | TeamServiceError::DuplicateSlug
        | TeamServiceError::MembershipAlreadyExists
        | TeamServiceError::ProjectRoleAlreadyExists => TeamHttpError::Conflict,
        TeamServiceError::StaleVersion => TeamHttpError::PreconditionFailed,
        TeamServiceError::AuditUnavailable => TeamHttpError::AuditUnavailable,
        TeamServiceError::DatabaseUnavailable => TeamHttpError::Unavailable,
        TeamServiceError::OperationTimeout => TeamHttpError::OperationTimeout,
        TeamServiceError::InvariantViolation => TeamHttpError::Internal,
    }
}

fn map_browser_error(error: BrowserCookieError) -> TeamHttpError {
    match error {
        BrowserCookieError::MissingSessionCookie | BrowserCookieError::InvalidSessionCookie => {
            TeamHttpError::AuthenticationFailed
        }
        _ => TeamHttpError::Forbidden,
    }
}

fn map_session_error(error: SessionServiceError) -> TeamHttpError {
    match error {
        SessionServiceError::InvalidToken | SessionServiceError::UserUnavailable => {
            TeamHttpError::AuthenticationFailed
        }
        SessionServiceError::DatabaseUnavailable => TeamHttpError::Unavailable,
        SessionServiceError::OperationTimeout => TeamHttpError::OperationTimeout,
        _ => TeamHttpError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stateless_cursor_survives_replica_change_and_rejects_scope_change() {
        let actor: UserId = "0199ee6c-c777-7000-8000-000000000001".parse().unwrap();
        let organization: OrganizationId = "0199ee6c-c777-7000-8000-000000000002".parse().unwrap();
        let other_organization: OrganizationId =
            "0199ee6c-c777-7000-8000-000000000003".parse().unwrap();
        let team: TeamId = "0199ee6c-c777-7000-8000-000000000004".parse().unwrap();
        let binding = CursorBinding::teams(actor, organization, 50);
        let cursor = CursorCodec
            .encode_team(
                &TeamPageKey::new("platform".parse().unwrap(), team),
                &binding,
            )
            .unwrap();

        let decoded = CursorCodec.decode_team(&cursor, &binding).unwrap();
        assert_eq!(decoded.slug().as_str(), "platform");
        assert_eq!(decoded.id(), team);
        assert_eq!(
            CursorCodec.decode_team(
                &cursor,
                &CursorBinding::teams(actor, other_organization, 50)
            ),
            Err(TeamHttpError::InvalidInput)
        );
    }

    #[test]
    fn cursor_rejects_noncanonical_and_unknown_json_fields() {
        let actor: UserId = "0199ee6c-c777-7000-8000-000000000001".parse().unwrap();
        let organization: OrganizationId = "0199ee6c-c777-7000-8000-000000000002".parse().unwrap();
        let binding = CursorBinding::teams(actor, organization, 50);
        let payload = format!(
            "{{\"version\":1,\"kind\":\"teams\",\"actor_id\":\"{actor}\",\"scope_id\":\"{organization}\",\"page_size\":50,\"first\":\"platform\",\"second\":\"0199ee6c-c777-7000-8000-000000000004\",\"extra\":true}}"
        );
        let cursor = format!("{CURSOR_PREFIX}{}", URL_SAFE_NO_PAD.encode(payload));
        assert_eq!(
            CursorCodec.decode_team(&cursor, &binding),
            Err(TeamHttpError::InvalidInput)
        );
    }
}
