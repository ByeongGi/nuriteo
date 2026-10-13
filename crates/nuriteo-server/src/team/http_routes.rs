use std::str::FromStr;

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, de::DeserializeOwned};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders, UserId};
use crate::organization::OrganizationId;
use crate::project::{ProjectId, ProjectRole};

use super::http_service::{
    TeamHttpError, TeamHttpService, TeamListView, TeamMemberListView, TeamMemberView,
    TeamMutationView, TeamProjectRoleListView, TeamProjectRoleView, TeamView,
};
use super::{
    TeamDisplayName, TeamId, TeamMembershipVersion, TeamProjectRoleVersion, TeamRole, TeamSlug,
    TeamVersion,
};

const COLLECTION: &str = "/api/v1/organizations/{organization_id}/teams";
const ITEM: &str = "/api/v1/organizations/{organization_id}/teams/{team_id}";
const MEMBERS: &str = "/api/v1/organizations/{organization_id}/teams/{team_id}/members";
const MEMBER: &str = "/api/v1/organizations/{organization_id}/teams/{team_id}/members/{user_id}";
const PROJECT_ROLES: &str = "/api/v1/organizations/{organization_id}/teams/{team_id}/project-roles";
const PROJECT_ROLE: &str =
    "/api/v1/organizations/{organization_id}/teams/{team_id}/project-roles/{project_id}";
const MAX_BODY: usize = 4096;
const MAX_QUERY: usize = 4096;
const DEFAULT_PAGE_SIZE: u16 = 50;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

pub(crate) fn openapi_router(document: utoipa::openapi::OpenApi) -> OpenApiRouter<TeamHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(create_team, list_teams))
        .routes(routes!(get_team, rename_team, delete_team))
        .routes(routes!(list_members, add_member))
        .routes(routes!(change_member, remove_member))
        .routes(routes!(list_project_roles, add_project_role))
        .routes(routes!(change_project_role, remove_project_role))
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTeamRequest {
    #[schema(max_length = 63, example = "platform")]
    slug: String,
    #[schema(max_length = 200, example = "Platform")]
    display_name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameTeamRequest {
    #[schema(max_length = 200, example = "Platform Engineering")]
    display_name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddMemberRequest {
    user_id: String,
    role: TeamRole,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct TeamRoleRequest {
    role: TeamRole,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddProjectRoleRequest {
    project_id: String,
    role: ProjectRole,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ProjectRoleRequest {
    role: ProjectRole,
}

#[utoipa::path(post, path = COLLECTION, tag = "teams", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = CreateTeamRequest, content_type = "application/json"),
    responses((status = 201, body = TeamView, headers(("Location" = String), ("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn create_team(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(organization_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, COLLECTION)?;
    let input: CreateTeamRequest = json_body(&parts.headers, body, &request_id, COLLECTION).await?;
    let view = service
        .create(
            browser.request(BrowserMethod::Post),
            parse_organization_id(&organization_id, &request_id, COLLECTION)?,
            TeamSlug::new(input.slug).map_err(|_| validation(&request_id, COLLECTION, "slug"))?,
            TeamDisplayName::new(input.display_name)
                .map_err(|_| validation(&request_id, COLLECTION, "displayName"))?,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), COLLECTION))?;
    team_response(StatusCode::CREATED, view, true, request_id, COLLECTION)
}

#[utoipa::path(get, path = COLLECTION, tag = "teams", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("pageSize" = Option<u16>, Query, minimum = 1, maximum = 100), ("cursor" = Option<String>, Query)),
    responses((status = 200, body = TeamListView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_teams(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(organization_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(request.headers(), &request_id, COLLECTION)?;
    let query = ListQuery::parse(request.uri().query(), &request_id, COLLECTION)?;
    let view = service
        .list(
            browser.request(BrowserMethod::Get),
            parse_organization_id(&organization_id, &request_id, COLLECTION)?,
            query.page_size,
            query.cursor.as_deref(),
        )
        .await
        .map_err(|error| map_error(error, request_id, COLLECTION))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(get, path = ITEM, tag = "teams", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path)),
    responses((status = 200, body = TeamView, headers(("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn get_team(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(request.headers(), &request_id, ITEM)?;
    let organization_id = parse_organization_id(&organization_id, &request_id, ITEM)?;
    let view = service
        .get(
            browser.request(BrowserMethod::Get),
            parse_team_id(&team_id, &request_id, ITEM)?,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ITEM))?;
    ensure_organization(&view, organization_id, &request_id, ITEM)?;
    team_response(StatusCode::OK, view, false, request_id, ITEM)
}

#[utoipa::path(patch, path = ITEM, tag = "teams", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = RenameTeamRequest, content_type = "application/json"),
    responses((status = 200, body = TeamView, headers(("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn rename_team(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, ITEM)?;
    let organization_id = parse_organization_id(&organization_id, &request_id, ITEM)?;
    let version = parse_if_match::<TeamVersion>(&parts.headers, "team", &request_id, ITEM)?;
    let input: RenameTeamRequest = json_body(&parts.headers, body, &request_id, ITEM).await?;
    let view = service
        .rename(
            browser.request(BrowserMethod::Patch),
            organization_id,
            parse_team_id(&team_id, &request_id, ITEM)?,
            version,
            TeamDisplayName::new(input.display_name)
                .map_err(|_| validation(&request_id, ITEM, "displayName"))?,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ITEM))?;
    team_response(StatusCode::OK, view, false, request_id, ITEM)
}

#[utoipa::path(delete, path = ITEM, tag = "teams", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    responses((status = 200, body = TeamMutationView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn delete_team(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(request.headers(), &request_id, ITEM)?;
    let organization_id = parse_organization_id(&organization_id, &request_id, ITEM)?;
    let view = service
        .delete(
            browser.request(BrowserMethod::Delete),
            organization_id,
            parse_team_id(&team_id, &request_id, ITEM)?,
            parse_if_match::<TeamVersion>(request.headers(), "team", &request_id, ITEM)?,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, ITEM))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(get, path = MEMBERS, tag = "team-members", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("pageSize" = Option<u16>, Query), ("cursor" = Option<String>, Query)),
    responses((status = 200, body = TeamMemberListView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_members(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let organization_id = parse_organization_id(&organization_id, &request_id, MEMBERS)?;
    let browser = BrowserHeaders::read(request.headers(), &request_id, MEMBERS)?;
    let query = ListQuery::parse(request.uri().query(), &request_id, MEMBERS)?;
    let view = service
        .members(
            browser.request(BrowserMethod::Get),
            organization_id,
            parse_team_id(&team_id, &request_id, MEMBERS)?,
            query.page_size,
            query.cursor.as_deref(),
        )
        .await
        .map_err(|e| map_error(e, request_id, MEMBERS))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(post, path = MEMBERS, tag = "team-members", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = AddMemberRequest, content_type = "application/json"),
    responses((status = 201, body = TeamMemberView, headers(("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn add_member(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let organization_id = parse_organization_id(&organization_id, &request_id, MEMBERS)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, MEMBERS)?;
    let input: AddMemberRequest = json_body(&parts.headers, body, &request_id, MEMBERS).await?;
    let view = service
        .add_member(
            browser.request(BrowserMethod::Post),
            organization_id,
            parse_team_id(&team_id, &request_id, MEMBERS)?,
            parse_user_id(&input.user_id, &request_id, MEMBERS)?,
            input.role,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), MEMBERS))?;
    member_response(StatusCode::CREATED, view, request_id, MEMBERS)
}

#[utoipa::path(patch, path = MEMBER, tag = "team-members", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("user_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = TeamRoleRequest, content_type = "application/json"),
    responses((status = 200, body = TeamMemberView, headers(("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn change_member(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id, user_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let organization_id = parse_organization_id(&organization_id, &request_id, MEMBER)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, MEMBER)?;
    let version = parse_if_match::<TeamMembershipVersion>(
        &parts.headers,
        "team-member",
        &request_id,
        MEMBER,
    )?;
    let input: TeamRoleRequest = json_body(&parts.headers, body, &request_id, MEMBER).await?;
    let view = service
        .change_member(
            browser.request(BrowserMethod::Patch),
            organization_id,
            parse_team_id(&team_id, &request_id, MEMBER)?,
            parse_user_id(&user_id, &request_id, MEMBER)?,
            version,
            input.role,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), MEMBER))?;
    member_response(StatusCode::OK, view, request_id, MEMBER)
}

#[utoipa::path(delete, path = MEMBER, tag = "team-members", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("user_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    responses((status = 200, body = TeamMutationView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn remove_member(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id, user_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let organization_id = parse_organization_id(&organization_id, &request_id, MEMBER)?;
    let browser = BrowserHeaders::read(request.headers(), &request_id, MEMBER)?;
    let view = service
        .remove_member(
            browser.request(BrowserMethod::Delete),
            organization_id,
            parse_team_id(&team_id, &request_id, MEMBER)?,
            parse_user_id(&user_id, &request_id, MEMBER)?,
            parse_if_match::<TeamMembershipVersion>(
                request.headers(),
                "team-member",
                &request_id,
                MEMBER,
            )?,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id, MEMBER))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(get, path = PROJECT_ROLES, tag = "team-project-roles", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("pageSize" = Option<u16>, Query), ("cursor" = Option<String>, Query)),
    responses((status = 200, body = TeamProjectRoleListView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_project_roles(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let organization_id = parse_organization_id(&organization_id, &request_id, PROJECT_ROLES)?;
    let browser = BrowserHeaders::read(request.headers(), &request_id, PROJECT_ROLES)?;
    let query = ListQuery::parse(request.uri().query(), &request_id, PROJECT_ROLES)?;
    let view = service
        .project_roles(
            browser.request(BrowserMethod::Get),
            organization_id,
            parse_team_id(&team_id, &request_id, PROJECT_ROLES)?,
            query.page_size,
            query.cursor.as_deref(),
        )
        .await
        .map_err(|e| map_error(e, request_id, PROJECT_ROLES))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(post, path = PROJECT_ROLES, tag = "team-project-roles", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = AddProjectRoleRequest, content_type = "application/json"),
    responses((status = 201, body = TeamProjectRoleView, headers(("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn add_project_role(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let organization_id = parse_organization_id(&organization_id, &request_id, PROJECT_ROLES)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, PROJECT_ROLES)?;
    let input: AddProjectRoleRequest =
        json_body(&parts.headers, body, &request_id, PROJECT_ROLES).await?;
    let view = service
        .add_project_role(
            browser.request(BrowserMethod::Post),
            organization_id,
            parse_team_id(&team_id, &request_id, PROJECT_ROLES)?,
            parse_project_id(&input.project_id, &request_id, PROJECT_ROLES)?,
            input.role,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), PROJECT_ROLES))?;
    project_role_response(StatusCode::CREATED, view, request_id, PROJECT_ROLES)
}

#[utoipa::path(patch, path = PROJECT_ROLE, tag = "team-project-roles", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("project_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = ProjectRoleRequest, content_type = "application/json"),
    responses((status = 200, body = TeamProjectRoleView, headers(("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn change_project_role(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let organization_id = parse_organization_id(&organization_id, &request_id, PROJECT_ROLE)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, PROJECT_ROLE)?;
    let version = parse_if_match::<TeamProjectRoleVersion>(
        &parts.headers,
        "team-project-role",
        &request_id,
        PROJECT_ROLE,
    )?;
    let input: ProjectRoleRequest =
        json_body(&parts.headers, body, &request_id, PROJECT_ROLE).await?;
    let view = service
        .change_project_role(
            browser.request(BrowserMethod::Patch),
            organization_id,
            parse_team_id(&team_id, &request_id, PROJECT_ROLE)?,
            parse_project_id(&project_id, &request_id, PROJECT_ROLE)?,
            version,
            input.role,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), PROJECT_ROLE))?;
    project_role_response(StatusCode::OK, view, request_id, PROJECT_ROLE)
}

#[utoipa::path(delete, path = PROJECT_ROLE, tag = "team-project-roles", security(("projectSessionCookie" = [])),
    params(("organization_id" = String, Path), ("team_id" = String, Path), ("project_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    responses((status = 200, body = TeamMutationView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn remove_project_role(
    State(service): State<TeamHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, team_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let organization_id = parse_organization_id(&organization_id, &request_id, PROJECT_ROLE)?;
    let browser = BrowserHeaders::read(request.headers(), &request_id, PROJECT_ROLE)?;
    let view = service
        .remove_project_role(
            browser.request(BrowserMethod::Delete),
            organization_id,
            parse_team_id(&team_id, &request_id, PROJECT_ROLE)?,
            parse_project_id(&project_id, &request_id, PROJECT_ROLE)?,
            parse_if_match::<TeamProjectRoleVersion>(
                request.headers(),
                "team-project-role",
                &request_id,
                PROJECT_ROLE,
            )?,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id, PROJECT_ROLE))?;
    Ok(no_store(Json(view).into_response()))
}

struct BrowserHeaders<'a> {
    cookies: Vec<&'a str>,
    origins: Vec<&'a str>,
    csrf: Vec<&'a str>,
}
impl<'a> BrowserHeaders<'a> {
    fn read(headers: &'a HeaderMap, request_id: &RequestId, path: &str) -> Result<Self, HttpError> {
        fn values<'a>(
            headers: &'a HeaderMap,
            name: HeaderName,
            request_id: &RequestId,
            path: &str,
        ) -> Result<Vec<&'a str>, HttpError> {
            headers
                .get_all(name)
                .iter()
                .map(|value| {
                    value
                        .to_str()
                        .map_err(|_| validation(request_id, path, "headers"))
                })
                .collect()
        }
        Ok(Self {
            cookies: values(headers, COOKIE, request_id, path)?,
            origins: values(headers, ORIGIN, request_id, path)?,
            csrf: values(headers, CSRF, request_id, path)?,
        })
    }
    fn request(&self, method: BrowserMethod) -> BrowserRequestHeaders<'_> {
        BrowserRequestHeaders {
            method,
            origins: &self.origins,
            cookie_headers: &self.cookies,
            csrf_headers: &self.csrf,
        }
    }
}

struct ListQuery {
    page_size: u16,
    cursor: Option<String>,
}
impl ListQuery {
    fn parse(raw: Option<&str>, request_id: &RequestId, path: &str) -> Result<Self, HttpError> {
        let raw = raw.unwrap_or_default();
        if raw.len() > MAX_QUERY {
            return Err(validation(request_id, path, "query"));
        }
        let mut page_size = None;
        let mut cursor = None;
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "pageSize" if page_size.is_none() => {
                    page_size = Some(
                        value
                            .parse::<u16>()
                            .map_err(|_| validation(request_id, path, "pageSize"))?,
                    )
                }
                "cursor" if cursor.is_none() && !value.is_empty() => {
                    cursor = Some(value.into_owned())
                }
                _ => return Err(validation(request_id, path, "query")),
            }
        }
        let page_size = page_size.unwrap_or(DEFAULT_PAGE_SIZE);
        if !(1..=100).contains(&page_size) {
            return Err(validation(request_id, path, "pageSize"));
        }
        Ok(Self { page_size, cursor })
    }
}

async fn json_body<T: DeserializeOwned>(
    headers: &HeaderMap,
    body: Body,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    let content_types: Vec<_> = headers.get_all(CONTENT_TYPE).iter().collect();
    if content_types.len() != 1
        || content_types[0]
            .to_str()
            .ok()
            .and_then(|v| v.split(';').next())
            .map(str::trim)
            != Some("application/json")
    {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    }
    let bytes = to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| HttpError::payload_too_large(request_id.clone(), path))?;
    serde_json::from_slice(&bytes).map_err(|_| validation(request_id, path, "body"))
}

fn parse_organization_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<OrganizationId, HttpError> {
    OrganizationId::from_str(value).map_err(|_| validation(request_id, path, "organizationId"))
}
fn parse_team_id(value: &str, request_id: &RequestId, path: &str) -> Result<TeamId, HttpError> {
    TeamId::from_str(value).map_err(|_| validation(request_id, path, "teamId"))
}
fn parse_user_id(value: &str, request_id: &RequestId, path: &str) -> Result<UserId, HttpError> {
    UserId::from_str(value).map_err(|_| validation(request_id, path, "userId"))
}
fn parse_project_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectId, HttpError> {
    ProjectId::from_str(value).map_err(|_| validation(request_id, path, "projectId"))
}

fn parse_if_match<T>(
    headers: &HeaderMap,
    kind: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError>
where
    T: TryFrom<i64>,
{
    let values: Vec<_> = headers.get_all(IF_MATCH).iter().collect();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    if values.len() != 1 {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    let prefix = format!("\"{kind}-v");
    let number = values[0]
        .to_str()
        .ok()
        .and_then(|value| value.strip_prefix(&prefix))
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))?;
    T::try_from(number).map_err(|_| HttpError::precondition_failed(request_id.clone(), path))
}

fn team_response(
    status: StatusCode,
    view: TeamView,
    location: bool,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let mut response = no_store((status, Json(view.clone())).into_response());
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"team-v{}\"", view.version))
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    if location {
        response.headers_mut().insert(
            LOCATION,
            HeaderValue::from_str(&format!(
                "/api/v1/organizations/{}/teams/{}",
                view.organization_id, view.id
            ))
            .map_err(|_| HttpError::internal(request_id, path))?,
        );
    }
    Ok(response)
}
fn member_response(
    status: StatusCode,
    view: TeamMemberView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let mut response = no_store((status, Json(view.clone())).into_response());
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"team-member-v{}\"", view.version))
            .map_err(|_| HttpError::internal(request_id, path))?,
    );
    Ok(response)
}
fn project_role_response(
    status: StatusCode,
    view: TeamProjectRoleView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let mut response = no_store((status, Json(view.clone())).into_response());
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"team-project-role-v{}\"", view.version))
            .map_err(|_| HttpError::internal(request_id, path))?,
    );
    Ok(response)
}
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}
fn ensure_organization(
    view: &TeamView,
    expected: OrganizationId,
    request_id: &RequestId,
    path: &str,
) -> Result<(), HttpError> {
    if view.organization_id == expected.to_string() {
        Ok(())
    } else {
        Err(HttpError::not_found(request_id.clone(), path))
    }
}
fn validation(request_id: &RequestId, path: &str, field: &str) -> HttpError {
    HttpError::validation(
        request_id.clone(),
        path,
        [FieldViolation::new(
            field,
            "INVALID",
            "The value is invalid.",
        )],
    )
}
fn map_error(error: TeamHttpError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        TeamHttpError::AuthenticationFailed => HttpError::authentication(request_id, path),
        TeamHttpError::Forbidden => HttpError::forbidden(request_id, path),
        TeamHttpError::NotFound => HttpError::not_found(request_id, path),
        TeamHttpError::InvalidInput => validation(&request_id, path, "request"),
        TeamHttpError::Conflict => HttpError::conflict(request_id, path),
        TeamHttpError::PreconditionFailed => HttpError::precondition_failed(request_id, path),
        TeamHttpError::OperationTimeout => HttpError::operation_timeout(request_id, path),
        TeamHttpError::AuditUnavailable | TeamHttpError::Unavailable | TeamHttpError::Internal => {
            HttpError::internal(request_id, path)
        }
    }
}
