use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::time::Duration;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use uuid::Uuid;

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders};
use crate::project::ProjectId;

use super::{
    AccessTokenManagementError, AccessTokenManagementService, AccessTokenScope, AccessTokenTarget,
    AccessTokenView, IssuedAccessTokenView,
};

const PERSONAL_PATH: &str = "/api/v1/access-tokens";
const PERSONAL_ITEM_PATH: &str = "/api/v1/access-tokens/{tokenId}";
const PERSONAL_ROTATE_PATH: &str = "/api/v1/access-tokens/{tokenId}/rotate";
const PROJECT_PATH: &str = "/api/v1/projects/{projectId}/access-tokens";
const PROJECT_ITEM_PATH: &str = "/api/v1/projects/{projectId}/access-tokens/{tokenId}";
const PROJECT_ROTATE_PATH: &str = "/api/v1/projects/{projectId}/access-tokens/{tokenId}/rotate";
const MAX_BODY_BYTES: usize = 4 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(6);
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<AccessTokenManagementService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(personal_list, personal_issue))
        .routes(routes!(personal_revoke))
        .routes(routes!(personal_rotate))
        .routes(routes!(project_list, project_issue))
        .routes(routes!(project_revoke))
        .routes(routes!(project_rotate))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct IssueRequest {
    name: String,
    scopes: Vec<String>,
    expiry_days: Option<u16>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RotateRequest {
    expiry_days: Option<u16>,
}

#[utoipa::path(get, path=PERSONAL_PATH, tag="access-tokens", security(("projectSessionCookie"=[])), responses(
    (status=200, body=[AccessTokenView]),
    (status=401, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
    (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")
))]
async fn personal_list(
    State(service): State<AccessTokenManagementService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    list(
        service,
        request_id,
        request,
        AccessTokenTarget::Personal,
        PERSONAL_PATH,
    )
    .await
}

#[utoipa::path(post, path=PERSONAL_PATH, tag="access-tokens", security(("projectSessionCookie"=[])),
    params(("Origin"=String, Header), ("X-CSRF-Token"=String, Header)), request_body=IssueRequest,
    responses(
        (status=201, body=IssuedAccessTokenView),
        (status=401, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=403, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=413, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=415, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=422, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")
    )
)]
async fn personal_issue(
    State(service): State<AccessTokenManagementService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    issue(
        service,
        request_id,
        request,
        AccessTokenTarget::Personal,
        PERSONAL_PATH,
    )
    .await
}

#[utoipa::path(delete, path=PERSONAL_ITEM_PATH, tag="access-tokens", security(("projectSessionCookie"=[])),
    params(("tokenId"=String, Path), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)),
    responses(
        (status=200, body=AccessTokenView),
        (status=401, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=403, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=404, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=409, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")
    )
)]
async fn personal_revoke(
    State(service): State<AccessTokenManagementService>,
    Extension(request_id): Extension<RequestId>,
    Path(token_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    revoke(
        service,
        request_id,
        request,
        AccessTokenTarget::Personal,
        &token_id,
        PERSONAL_ITEM_PATH,
    )
    .await
}

#[utoipa::path(post, path=PERSONAL_ROTATE_PATH, tag="access-tokens", security(("projectSessionCookie"=[])),
    params(("tokenId"=String, Path), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)), request_body=RotateRequest,
    responses(
        (status=201, body=IssuedAccessTokenView),
        (status=401, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=403, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=404, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=409, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=413, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=415, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=422, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")
    )
)]
async fn personal_rotate(
    State(service): State<AccessTokenManagementService>,
    Extension(request_id): Extension<RequestId>,
    Path(token_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    rotate(
        service,
        request_id,
        request,
        AccessTokenTarget::Personal,
        &token_id,
        PERSONAL_ROTATE_PATH,
    )
    .await
}

#[utoipa::path(get, path=PROJECT_PATH, tag="access-tokens", security(("projectSessionCookie"=[])), params(("projectId"=String, Path)), responses(
    (status=200, body=[AccessTokenView]),
    (status=401, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
    (status=403, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
    (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")
))]
async fn project_list(
    State(service): State<AccessTokenManagementService>,
    Extension(request_id): Extension<RequestId>,
    Path(project_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let target = project_target(&project_id, &request_id, PROJECT_PATH)?;
    list(service, request_id, request, target, PROJECT_PATH).await
}

#[utoipa::path(post, path=PROJECT_PATH, tag="access-tokens", security(("projectSessionCookie"=[])),
    params(("projectId"=String, Path), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)), request_body=IssueRequest,
    responses(
        (status=201, body=IssuedAccessTokenView),
        (status=401, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=403, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=409, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=413, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=415, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=422, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")
    )
)]
async fn project_issue(
    State(service): State<AccessTokenManagementService>,
    Extension(request_id): Extension<RequestId>,
    Path(project_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let target = project_target(&project_id, &request_id, PROJECT_PATH)?;
    issue(service, request_id, request, target, PROJECT_PATH).await
}

#[utoipa::path(delete, path=PROJECT_ITEM_PATH, tag="access-tokens", security(("projectSessionCookie"=[])),
    params(("projectId"=String, Path), ("tokenId"=String, Path), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)),
    responses(
        (status=200, body=AccessTokenView),
        (status=401, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=403, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=404, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=409, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")
    )
)]
async fn project_revoke(
    State(service): State<AccessTokenManagementService>,
    Extension(request_id): Extension<RequestId>,
    Path((project_id, token_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let target = project_target(&project_id, &request_id, PROJECT_ITEM_PATH)?;
    revoke(
        service,
        request_id,
        request,
        target,
        &token_id,
        PROJECT_ITEM_PATH,
    )
    .await
}

#[utoipa::path(post, path=PROJECT_ROTATE_PATH, tag="access-tokens", security(("projectSessionCookie"=[])),
    params(("projectId"=String, Path), ("tokenId"=String, Path), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)), request_body=RotateRequest,
    responses(
        (status=201, body=IssuedAccessTokenView),
        (status=401, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=403, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=404, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=409, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=413, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=415, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=422, body=crate::openapi::ProblemDetails, content_type="application/problem+json"),
        (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")
    )
)]
async fn project_rotate(
    State(service): State<AccessTokenManagementService>,
    Extension(request_id): Extension<RequestId>,
    Path((project_id, token_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let target = project_target(&project_id, &request_id, PROJECT_ROTATE_PATH)?;
    rotate(
        service,
        request_id,
        request,
        target,
        &token_id,
        PROJECT_ROTATE_PATH,
    )
    .await
}

async fn list(
    service: AccessTokenManagementService,
    request_id: RequestId,
    request: Request,
    target: AccessTokenTarget,
    path: &str,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, path)?;
    let value = deadline(service.list(headers.request(BrowserMethod::Get), target))
        .await
        .map_err(|error| map_error(error, request_id, path))?;
    Ok(no_store(Json(value).into_response()))
}

async fn issue(
    service: AccessTokenManagementService,
    request_id: RequestId,
    request: Request,
    target: AccessTokenTarget,
    path: &str,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, path)?;
    let input: IssueRequest = json_body(&parts.headers, body, &request_id, path).await?;
    let scopes = parse_scopes(&input.scopes, &request_id, path)?;
    let value = deadline(service.issue(
        headers.request(BrowserMethod::Post),
        target,
        &input.name,
        scopes,
        input.expiry_days,
        request_id.as_str(),
    ))
    .await
    .map_err(|error| map_error(error, request_id.clone(), path))?;
    Ok(no_store((StatusCode::CREATED, Json(value)).into_response()))
}

async fn revoke(
    service: AccessTokenManagementService,
    request_id: RequestId,
    request: Request,
    target: AccessTokenTarget,
    token_id: &str,
    path: &str,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, path)?;
    let token_id = parse_uuid(token_id, &request_id, path, "tokenId")?;
    let value = deadline(service.revoke(
        headers.request(BrowserMethod::Delete),
        target,
        token_id,
        request_id.as_str(),
    ))
    .await
    .map_err(|error| map_error(error, request_id, path))?;
    Ok(no_store(Json(value).into_response()))
}

async fn rotate(
    service: AccessTokenManagementService,
    request_id: RequestId,
    request: Request,
    target: AccessTokenTarget,
    token_id: &str,
    path: &str,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, path)?;
    let token_id = parse_uuid(token_id, &request_id, path, "tokenId")?;
    let input: RotateRequest = json_body(&parts.headers, body, &request_id, path).await?;
    let value = deadline(service.rotate(
        headers.request(BrowserMethod::Post),
        target,
        token_id,
        input.expiry_days,
        request_id.as_str(),
    ))
    .await
    .map_err(|error| map_error(error, request_id.clone(), path))?;
    Ok(no_store((StatusCode::CREATED, Json(value)).into_response()))
}

async fn deadline<T>(
    future: impl Future<Output = Result<T, AccessTokenManagementError>>,
) -> Result<T, AccessTokenManagementError> {
    tokio::time::timeout(HTTP_TIMEOUT, future)
        .await
        .map_err(|_| AccessTokenManagementError::OperationTimeout)?
}

struct BrowserHeaders<'a> {
    origins: Vec<&'a str>,
    cookies: Vec<&'a str>,
    csrf: Vec<&'a str>,
}
impl<'a> BrowserHeaders<'a> {
    fn read(headers: &'a HeaderMap, request_id: &RequestId, path: &str) -> Result<Self, HttpError> {
        Ok(Self {
            origins: values(headers, &ORIGIN)
                .map_err(|_| HttpError::forbidden(request_id.clone(), path))?,
            cookies: values(headers, &COOKIE)
                .map_err(|_| HttpError::forbidden(request_id.clone(), path))?,
            csrf: values(headers, &CSRF)
                .map_err(|_| HttpError::forbidden(request_id.clone(), path))?,
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
fn values<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<Vec<&'a str>, ()> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().map_err(|_| ()))
        .collect()
}

async fn json_body<T: for<'de> Deserialize<'de>>(
    headers: &HeaderMap,
    body: Body,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    let values = headers.get_all(CONTENT_TYPE).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    };
    if !value
        .to_str()
        .ok()
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    }
    let bytes = to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| HttpError::payload_too_large(request_id.clone(), path))?;
    serde_json::from_slice(&bytes).map_err(|_| validation(request_id, path, "body"))
}

fn parse_scopes(
    values: &[String],
    request_id: &RequestId,
    path: &str,
) -> Result<Vec<AccessTokenScope>, HttpError> {
    values
        .iter()
        .map(|value| match value.as_str() {
            "project:read" => Ok(AccessTokenScope::ProjectRead),
            "project:write" => Ok(AccessTokenScope::ProjectWrite),
            "project:publish" => Ok(AccessTokenScope::ProjectPublish),
            "project:manage" => Ok(AccessTokenScope::ProjectManage),
            "git:read" => Ok(AccessTokenScope::GitRead),
            "git:write" => Ok(AccessTokenScope::GitWrite),
            _ => Err(validation(request_id, path, "scopes")),
        })
        .collect()
}
fn project_target(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<AccessTokenTarget, HttpError> {
    value
        .parse::<ProjectId>()
        .map(AccessTokenTarget::Project)
        .map_err(|_| validation(request_id, path, "projectId"))
}
fn parse_uuid(
    value: &str,
    request_id: &RequestId,
    path: &str,
    field: &str,
) -> Result<Uuid, HttpError> {
    Uuid::parse_str(value).map_err(|_| validation(request_id, path, field))
}
fn validation(request_id: &RequestId, path: &str, field: &str) -> HttpError {
    HttpError::validation(
        request_id.clone(),
        path,
        [FieldViolation::new(
            field,
            "INVALID",
            "The field is invalid.",
        )],
    )
}
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}
fn map_error(error: AccessTokenManagementError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        AccessTokenManagementError::AuthenticationFailed => {
            HttpError::authentication(request_id, path)
        }
        AccessTokenManagementError::Forbidden
        | AccessTokenManagementError::ReauthenticationRequired => {
            HttpError::forbidden(request_id, path)
        }
        AccessTokenManagementError::InvalidInput => validation(&request_id, path, "body"),
        AccessTokenManagementError::NotFound => HttpError::not_found(request_id, path),
        AccessTokenManagementError::Conflict => HttpError::conflict(request_id, path),
        AccessTokenManagementError::CommitOutcomeUnknown => {
            HttpError::commit_outcome_unknown(request_id, path)
        }
        AccessTokenManagementError::Unavailable | AccessTokenManagementError::OperationTimeout => {
            HttpError::service_unavailable(request_id, path)
        }
        AccessTokenManagementError::Internal => HttpError::internal(request_id, path),
    }
}
