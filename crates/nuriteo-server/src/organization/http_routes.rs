use std::str::FromStr;

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Request, State};
use axum::http::header::{CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders, NormalizedEmail, UserId};

use super::http_service::{
    IssuedOrganizationInvitationView, MemberView, OrganizationHttpError, OrganizationHttpService,
    OrganizationInvitationView, OrganizationView,
};
use super::{
    OrganizationId, OrganizationInvitationId, OrganizationInvitationToken, OrganizationRole,
    OrganizationVersion,
};

const COLLECTION: &str = "/api/v1/organizations";
const ITEM: &str = "/api/v1/organizations/{organization_id}";
const ARCHIVE: &str = "/api/v1/organizations/{organization_id}/archive";
const MEMBERS: &str = "/api/v1/organizations/{organization_id}/members";
const MEMBER: &str = "/api/v1/organizations/{organization_id}/members/{user_id}";
const INVITATIONS: &str = "/api/v1/organizations/{organization_id}/invitations";
const INVITATION: &str = "/api/v1/organizations/{organization_id}/invitations/{invitation_id}";
const REISSUE: &str = "/api/v1/organizations/{organization_id}/invitations/{invitation_id}/reissue";
const ACCEPT: &str = "/api/v1/me/organization-invitations/accept";
const DECLINE: &str = "/api/v1/me/organization-invitations/decline";
const MAX_BODY: usize = 4096;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<OrganizationHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(create_organization))
        .routes(routes!(get_organization, update_organization))
        .routes(routes!(archive_organization))
        .routes(routes!(list_members))
        .routes(routes!(change_member, remove_member))
        .routes(routes!(list_invitations, issue_invitation))
        .routes(routes!(reissue_invitation))
        .routes(routes!(revoke_invitation))
        .routes(routes!(accept_invitation))
        .routes(routes!(decline_invitation))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateOrganizationRequest {
    #[schema(max_length = 63, example = "acme")]
    slug: String,
    #[schema(max_length = 200, example = "Acme")]
    display_name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateOrganizationRequest {
    #[schema(max_length = 200, example = "Acme Engineering")]
    display_name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct RoleRequest {
    role: OrganizationRole,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct IssueInvitationRequest {
    #[schema(max_length = 320, example = "member@example.test")]
    email: String,
    role: OrganizationRole,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct TokenRequest {
    #[schema(format = Password, max_length = 55)]
    token: String,
}

#[derive(Serialize, ToSchema)]
struct MemberListResponse {
    items: Vec<MemberView>,
}

#[derive(Serialize, ToSchema)]
struct InvitationListResponse {
    items: Vec<OrganizationInvitationView>,
}

#[utoipa::path(post, path = "/api/v1/organizations", tag = "organizations",
    request_body(content = CreateOrganizationRequest, content_type = "application/json"),
    responses(
        (status = 201, description = "Organization created with creator as Owner", body = OrganizationView,
         headers(("Location" = String, description = "Canonical Organization URL"), ("ETag" = String, description = "Strong Organization version validator"))),
        (status = 401, description = "Active Session required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, description = "Exact Origin and CSRF required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, description = "Slug conflicts with an existing Organization", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, description = "Request validation failed", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn create_organization(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, COLLECTION)?;
    let input: CreateOrganizationRequest =
        json_body(&parts.headers, body, &request_id, COLLECTION).await?;
    let view = service
        .create(
            headers.request(BrowserMethod::Post),
            input.slug,
            input.display_name,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), COLLECTION))?;
    organization_response(StatusCode::CREATED, view, true, request_id, COLLECTION)
}

#[utoipa::path(get, path = "/api/v1/organizations/{organization_id}", tag = "organizations",
    params(("organization_id" = String, Path, description = "UUIDv7 Organization identifier")),
    responses((status = 200, body = OrganizationView, headers(("ETag" = String, description = "Strong Organization version validator"))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn get_organization(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, ITEM)?;
    let id = parse_org_id(&id, &request_id, ITEM)?;
    let view = service
        .get(headers.request(BrowserMethod::Get), id)
        .await
        .map_err(|e| map_error(e, request_id.clone(), ITEM))?;
    organization_response(StatusCode::OK, view, false, request_id, ITEM)
}

#[utoipa::path(patch, path = "/api/v1/organizations/{organization_id}", tag = "organizations",
    params(("organization_id" = String, Path), ("If-Match" = String, Header, description = "Exactly one current strong Organization ETag")),
    request_body(content = UpdateOrganizationRequest, content_type = "application/json"),
    responses((status = 200, body = OrganizationView, headers(("ETag" = String, description = "Updated strong validator"))),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn update_organization(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, ITEM)?;
    let version = parse_if_match(&parts.headers, &request_id, ITEM)?;
    let input: UpdateOrganizationRequest =
        json_body(&parts.headers, body, &request_id, ITEM).await?;
    let view = service
        .update(
            headers.request(BrowserMethod::Patch),
            parse_org_id(&id, &request_id, ITEM)?,
            version,
            input.display_name,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), ITEM))?;
    organization_response(StatusCode::OK, view, false, request_id, ITEM)
}

#[utoipa::path(post, path = "/api/v1/organizations/{organization_id}/archive", tag = "organizations",
    params(("organization_id" = String, Path), ("If-Match" = String, Header, description = "Exactly one current strong Organization ETag")),
    responses((status = 200, body = OrganizationView, headers(("ETag" = String, description = "Updated strong validator"))),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn archive_organization(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, ARCHIVE)?;
    let version = parse_if_match(request.headers(), &request_id, ARCHIVE)?;
    let view = service
        .archive(
            headers.request(BrowserMethod::Post),
            parse_org_id(&id, &request_id, ARCHIVE)?,
            version,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), ARCHIVE))?;
    organization_response(StatusCode::OK, view, false, request_id, ARCHIVE)
}

#[utoipa::path(get, path = "/api/v1/organizations/{organization_id}/members", tag = "organizations",
    params(("organization_id" = String, Path)), responses((status = 200, body = MemberListResponse),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_members(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Json<MemberListResponse>, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, MEMBERS)?;
    let items = service
        .members(
            headers.request(BrowserMethod::Get),
            parse_org_id(&id, &request_id, MEMBERS)?,
        )
        .await
        .map_err(|e| map_error(e, request_id, MEMBERS))?;
    Ok(Json(MemberListResponse { items }))
}

#[utoipa::path(patch, path = "/api/v1/organizations/{organization_id}/members/{user_id}", tag = "organizations",
    params(("organization_id" = String, Path), ("user_id" = String, Path)), request_body(content = RoleRequest, content_type = "application/json"),
    responses((status = 204), (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn change_member(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, user_id)): Path<(String, String)>,
    request: Request,
) -> Result<StatusCode, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, MEMBER)?;
    let input: RoleRequest = json_body(&parts.headers, body, &request_id, MEMBER).await?;
    service
        .change_member_role(
            headers.request(BrowserMethod::Patch),
            parse_org_id(&organization_id, &request_id, MEMBER)?,
            parse_user_id(&user_id, &request_id, MEMBER)?,
            input.role,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id, MEMBER))?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/api/v1/organizations/{organization_id}/members/{user_id}", tag = "organizations",
    params(("organization_id" = String, Path), ("user_id" = String, Path)),
    responses((status = 204), (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn remove_member(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, user_id)): Path<(String, String)>,
    request: Request,
) -> Result<StatusCode, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, MEMBER)?;
    service
        .remove_member(
            headers.request(BrowserMethod::Delete),
            parse_org_id(&organization_id, &request_id, MEMBER)?,
            parse_user_id(&user_id, &request_id, MEMBER)?,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id, MEMBER))?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/api/v1/organizations/{organization_id}/invitations", tag = "organization-invitations",
    params(("organization_id" = String, Path)), responses((status = 200, body = InvitationListResponse),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_invitations(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Json<InvitationListResponse>, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, INVITATIONS)?;
    let items = service
        .list_invitations(
            headers.request(BrowserMethod::Get),
            parse_org_id(&id, &request_id, INVITATIONS)?,
        )
        .await
        .map_err(|e| map_error(e, request_id, INVITATIONS))?;
    Ok(Json(InvitationListResponse { items }))
}

#[utoipa::path(post, path = "/api/v1/organizations/{organization_id}/invitations", tag = "organization-invitations",
    params(("organization_id" = String, Path)), request_body(content = IssueInvitationRequest, content_type = "application/json"),
    responses((status = 201, description = "Invitation issued; delivery is either a copy-once accept URL or queued email", body = IssuedOrganizationInvitationView),
      (status = 401, description = "Active Session required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, description = "Exact Origin, CSRF, or recent reauthentication required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, description = "Owner authorization or active invitee is unavailable", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, description = "Invitee is already a member or already has a pending invitation", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, description = "Request validation failed", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn issue_invitation(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<(StatusCode, Json<IssuedOrganizationInvitationView>), HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, INVITATIONS)?;
    let input: IssueInvitationRequest =
        json_body(&parts.headers, body, &request_id, INVITATIONS).await?;
    let invitee_email = NormalizedEmail::from_email(&input.email)
        .map_err(|_| validation(&request_id, INVITATIONS, "email"))?;
    let view = service
        .issue_invitation(
            headers.request(BrowserMethod::Post),
            parse_org_id(&id, &request_id, INVITATIONS)?,
            invitee_email,
            input.role,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id, INVITATIONS))?;
    Ok((StatusCode::CREATED, Json(view)))
}

#[utoipa::path(post, path = "/api/v1/organizations/{organization_id}/invitations/{invitation_id}/reissue", tag = "organization-invitations",
    params(("organization_id" = String, Path), ("invitation_id" = String, Path)), request_body(content = RoleRequest, content_type = "application/json"),
    responses((status = 200, description = "Replacement issued; delivery is either a copy-once accept URL or queued email", body = IssuedOrganizationInvitationView),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn reissue_invitation(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, invitation_id)): Path<(String, String)>,
    request: Request,
) -> Result<Json<IssuedOrganizationInvitationView>, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, REISSUE)?;
    let input: RoleRequest = json_body(&parts.headers, body, &request_id, REISSUE).await?;
    let view = service
        .reissue_invitation(
            headers.request(BrowserMethod::Post),
            parse_org_id(&organization_id, &request_id, REISSUE)?,
            parse_invitation_id(&invitation_id, &request_id, REISSUE)?,
            input.role,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id, REISSUE))?;
    Ok(Json(view))
}

#[utoipa::path(delete, path = "/api/v1/organizations/{organization_id}/invitations/{invitation_id}", tag = "organization-invitations",
    params(("organization_id" = String, Path), ("invitation_id" = String, Path)), responses((status = 204),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn revoke_invitation(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((organization_id, invitation_id)): Path<(String, String)>,
    request: Request,
) -> Result<StatusCode, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, INVITATION)?;
    service
        .revoke_invitation(
            headers.request(BrowserMethod::Delete),
            parse_org_id(&organization_id, &request_id, INVITATION)?,
            parse_invitation_id(&invitation_id, &request_id, INVITATION)?,
            request_id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, request_id, INVITATION))?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/v1/me/organization-invitations/accept", tag = "organization-invitations",
    request_body(content = TokenRequest, content_type = "application/json"), responses((status = 200, body = OrganizationInvitationView),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn accept_invitation(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Json<OrganizationInvitationView>, HttpError> {
    respond(service, request_id, request, ACCEPT, true).await
}

#[utoipa::path(post, path = "/api/v1/me/organization-invitations/decline", tag = "organization-invitations",
    request_body(content = TokenRequest, content_type = "application/json"), responses((status = 200, body = OrganizationInvitationView),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn decline_invitation(
    State(service): State<OrganizationHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Json<OrganizationInvitationView>, HttpError> {
    respond(service, request_id, request, DECLINE, false).await
}

async fn respond(
    service: OrganizationHttpService,
    request_id: RequestId,
    request: Request,
    path: &'static str,
    accept: bool,
) -> Result<Json<OrganizationInvitationView>, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, path)?;
    let input: TokenRequest = json_body(&parts.headers, body, &request_id, path).await?;
    let token = OrganizationInvitationToken::parse(input.token)
        .map_err(|_| validation(&request_id, path, "token"))?;
    let view = if accept {
        service
            .accept_invitation(
                headers.request(BrowserMethod::Post),
                token,
                request_id.as_str(),
            )
            .await
    } else {
        service
            .decline_invitation(
                headers.request(BrowserMethod::Post),
                token,
                request_id.as_str(),
            )
            .await
    }
    .map_err(|e| map_error(e, request_id, path))?;
    Ok(Json(view))
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
                .map(|v| {
                    v.to_str().map_err(|_| {
                        HttpError::validation(
                            request_id.clone(),
                            path,
                            [FieldViolation::new(
                                "headers",
                                "INVALID",
                                "A request header is invalid.",
                            )],
                        )
                    })
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

fn parse_org_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<OrganizationId, HttpError> {
    OrganizationId::from_str(value).map_err(|_| validation(request_id, path, "organizationId"))
}
fn parse_invitation_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<OrganizationInvitationId, HttpError> {
    OrganizationInvitationId::from_str(value)
        .map_err(|_| validation(request_id, path, "invitationId"))
}
fn parse_user_id(value: &str, request_id: &RequestId, path: &str) -> Result<UserId, HttpError> {
    UserId::from_str(value).map_err(|_| validation(request_id, path, "userId"))
}

fn parse_if_match(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<OrganizationVersion, HttpError> {
    let values: Vec<_> = headers.get_all(IF_MATCH).iter().collect();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    if values.len() != 1 {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    let value = values[0]
        .to_str()
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))?;
    let number = value
        .strip_prefix("\"org-v")
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))?;
    OrganizationVersion::new(number)
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))
}

fn organization_response(
    status: StatusCode,
    view: OrganizationView,
    location: bool,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let mut response = (status, Json(view.clone())).into_response();
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"org-v{}\"", view.version))
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    if location {
        response.headers_mut().insert(
            LOCATION,
            HeaderValue::from_str(&format!("/api/v1/organizations/{}", view.id))
                .map_err(|_| HttpError::internal(request_id, path))?,
        );
    }
    Ok(response)
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

fn map_error(error: OrganizationHttpError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        OrganizationHttpError::AuthenticationFailed => HttpError::authentication(request_id, path),
        OrganizationHttpError::Forbidden | OrganizationHttpError::ReauthenticationRequired => {
            HttpError::forbidden(request_id, path)
        }
        OrganizationHttpError::NotFound => HttpError::not_found(request_id, path),
        OrganizationHttpError::InvalidInput => validation(&request_id, path, "request"),
        OrganizationHttpError::Conflict => HttpError::conflict(request_id, path),
        OrganizationHttpError::PreconditionFailed => {
            HttpError::precondition_failed(request_id, path)
        }
        OrganizationHttpError::Unavailable | OrganizationHttpError::Internal => {
            HttpError::internal(request_id, path)
        }
    }
}
