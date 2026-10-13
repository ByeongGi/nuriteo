use std::str::FromStr;

use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Extension, Path, Request, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH},
    },
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use uuid::Uuid;

use crate::{
    git_provider::{GitProviderInput, GitProviderKind, GitProviderUpdate},
    http::{FieldViolation, HttpError, RequestId},
    identity::{BrowserMethod, BrowserRequestHeaders},
    project::ProjectId,
};

use super::http_service::{
    GitConnectionView, GitHttpError, GitHttpService, GitOperationView, GitProviderAdminView,
    GitProviderView, GitRemoteView,
};

const PROVIDERS: &str = "/api/v1/me/git-providers";
const CONNECTIONS: &str = "/api/v1/me/git-connections";
const CONNECTION: &str = "/api/v1/me/git-connections/{connection_id}";
const ROTATE: &str = "/api/v1/me/git-connections/{connection_id}/rotate";
const REMOTE: &str = "/api/v1/projects/{project_id}/git";
const IMPORT: &str = "/api/v1/projects/{project_id}/git/import";
const PULL: &str = "/api/v1/projects/{project_id}/git/pull";
const COMMIT_PUSH: &str = "/api/v1/projects/{project_id}/git/commit-push";
const ADMIN_PROVIDERS: &str = "/api/v1/admin/git-providers";
const ADMIN_PROVIDER: &str = "/api/v1/admin/git-providers/{provider_id}";
const ADMIN_ACTIVATE: &str = "/api/v1/admin/git-providers/{provider_id}/activate";
const ADMIN_DISABLE: &str = "/api/v1/admin/git-providers/{provider_id}/disable";
const MAX_BODY_BYTES: usize = 70 * 1024;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

pub(crate) fn openapi_router(document: utoipa::openapi::OpenApi) -> OpenApiRouter<GitHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(list_providers))
        .routes(routes!(list_connections, connect))
        .routes(routes!(disconnect))
        .routes(routes!(rotate))
        .routes(routes!(get_remote))
        .routes(routes!(import))
        .routes(routes!(pull))
        .routes(routes!(commit_push))
        .routes(routes!(list_admin_providers, create_admin_provider))
        .routes(routes!(update_admin_provider, delete_admin_provider))
        .routes(routes!(activate_admin_provider))
        .routes(routes!(disable_admin_provider))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectRequest {
    provider_id: String,
    token: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct RotateRequest {
    token: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    repository_url: String,
    branch: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitPushRequest {
    commit_message: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdminProviderInput {
    display_name: String,
    kind: String,
    host: String,
    port: u16,
    api_base_url: String,
    oauth_authorization_url: Option<String>,
    oauth_token_url: Option<String>,
    oauth_client_id: Option<String>,
    allows_read: bool,
    allows_write: bool,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdminProviderUpdate {
    display_name: String,
    api_base_url: String,
    oauth_authorization_url: Option<String>,
    oauth_token_url: Option<String>,
    oauth_client_id: Option<String>,
    allows_read: bool,
    allows_write: bool,
}

#[utoipa::path(get, path = ADMIN_PROVIDERS, tag = "git-administration", security(("projectSessionCookie"=[])), responses((status=200, body=[GitProviderAdminView])))]
async fn list_admin_providers(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(&headers, &request_id, ADMIN_PROVIDERS)?;
    let values = service
        .list_admin_providers(browser.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, ADMIN_PROVIDERS))?;
    Ok(private_no_store(Json(values).into_response()))
}

#[utoipa::path(post, path = ADMIN_PROVIDERS, tag = "git-administration", security(("projectSessionCookie"=[])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body=AdminProviderInput, responses((status=201, body=GitProviderAdminView, headers(("ETag" = String)))))]
async fn create_admin_provider(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, ADMIN_PROVIDERS)?;
    let value: AdminProviderInput =
        json_body(&parts.headers, body, &request_id, ADMIN_PROVIDERS).await?;
    let input = GitProviderInput::new(
        value.display_name,
        parse_provider_kind(&value.kind, &request_id, ADMIN_PROVIDERS)?,
        value.host,
        value.port,
        value.api_base_url,
        value.oauth_authorization_url,
        value.oauth_token_url,
        value.oauth_client_id,
        value.allows_read,
        value.allows_write,
    )
    .map_err(|_| validation(&request_id, ADMIN_PROVIDERS, "body"))?;
    let view = service
        .create_admin_provider(
            browser.request(BrowserMethod::Post),
            input,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ADMIN_PROVIDERS))?;
    admin_provider_response(StatusCode::CREATED, view, request_id, ADMIN_PROVIDERS)
}

#[utoipa::path(patch, path = ADMIN_PROVIDER, tag = "git-administration", security(("projectSessionCookie"=[])),
    params(("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body=AdminProviderUpdate, responses((status=200, body=GitProviderAdminView, headers(("ETag" = String)))))]
async fn update_admin_provider(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let id = parse_uuid(&raw_id, "providerId", &request_id, ADMIN_PROVIDER)?;
    let (parts, body) = request.into_parts();
    let version = parse_provider_etag(&parts.headers, &request_id, ADMIN_PROVIDER)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, ADMIN_PROVIDER)?;
    let value: AdminProviderUpdate =
        json_body(&parts.headers, body, &request_id, ADMIN_PROVIDER).await?;
    let update = GitProviderUpdate::new(
        value.display_name,
        value.api_base_url,
        value.oauth_authorization_url,
        value.oauth_token_url,
        value.oauth_client_id,
        value.allows_read,
        value.allows_write,
    )
    .map_err(|_| validation(&request_id, ADMIN_PROVIDER, "body"))?;
    let view = service
        .update_admin_provider(
            browser.request(BrowserMethod::Patch),
            id,
            version,
            update,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ADMIN_PROVIDER))?;
    admin_provider_response(StatusCode::OK, view, request_id, ADMIN_PROVIDER)
}

#[utoipa::path(delete, path = ADMIN_PROVIDER, tag = "git-administration", security(("projectSessionCookie"=[])),
    params(("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)), responses((status=204)))]
async fn delete_admin_provider(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let id = parse_uuid(&raw_id, "providerId", &request_id, ADMIN_PROVIDER)?;
    let version = parse_provider_etag(&headers, &request_id, ADMIN_PROVIDER)?;
    let browser = BrowserHeaders::read(&headers, &request_id, ADMIN_PROVIDER)?;
    service
        .delete_admin_provider(
            browser.request(BrowserMethod::Delete),
            id,
            version,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, ADMIN_PROVIDER))?;
    Ok(private_no_store(StatusCode::NO_CONTENT.into_response()))
}

macro_rules! admin_provider_action {
    ($handler:ident, $path:expr, $method:expr, $call:ident) => {
        #[utoipa::path(post, path = $path, tag = "git-administration", security(("projectSessionCookie"=[])),
            params(("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
            responses((status=200, body=GitProviderAdminView, headers(("ETag" = String)))))]
        async fn $handler(State(service): State<GitHttpService>, Extension(request_id): Extension<RequestId>, Path(raw_id): Path<String>, headers: HeaderMap) -> Result<Response, HttpError> {
            let id = parse_uuid(&raw_id, "providerId", &request_id, $path)?;
            let version = parse_provider_etag(&headers, &request_id, $path)?;
            let browser = BrowserHeaders::read(&headers, &request_id, $path)?;
            let view = service.$call(browser.request($method), id, version, request_id.as_str()).await.map_err(|error| map_error(error, request_id.clone(), $path))?;
            admin_provider_response(StatusCode::OK, view, request_id, $path)
        }
    };
}
admin_provider_action!(
    activate_admin_provider,
    ADMIN_ACTIVATE,
    BrowserMethod::Post,
    activate_admin_provider
);
admin_provider_action!(
    disable_admin_provider,
    ADMIN_DISABLE,
    BrowserMethod::Post,
    disable_admin_provider
);

#[utoipa::path(get, path = PROVIDERS, tag = "git", security(("projectSessionCookie"=[])),
    responses(
        (status = 200, body = [GitProviderView]),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn list_providers(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(&headers, &request_id, PROVIDERS)?;
    let view = service
        .list_providers(browser.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, PROVIDERS))?;
    Ok(private_no_store(Json(view).into_response()))
}

#[utoipa::path(get, path = CONNECTIONS, tag = "git", security(("projectSessionCookie"=[])),
    responses(
        (status = 200, body = [GitConnectionView]),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn list_connections(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(&headers, &request_id, CONNECTIONS)?;
    let view = service
        .list_connections(browser.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, CONNECTIONS))?;
    Ok(private_no_store(Json(view).into_response()))
}

#[utoipa::path(post, path = CONNECTIONS, tag = "git", security(("projectSessionCookie"=[])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = ConnectRequest, content_type = "application/json"),
    responses(
        (status = 201, body = GitConnectionView, headers(("ETag" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn connect(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, CONNECTIONS)?;
    let input: ConnectRequest = json_body(&parts.headers, body, &request_id, CONNECTIONS).await?;
    let provider_id = parse_uuid(&input.provider_id, "providerId", &request_id, CONNECTIONS)?;
    let view = service
        .connect(
            browser.request(BrowserMethod::Post),
            provider_id,
            input.token.into_bytes(),
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), CONNECTIONS))?;
    connection_response(StatusCode::CREATED, view, request_id, CONNECTIONS)
}

#[utoipa::path(delete, path = CONNECTION, tag = "git", security(("projectSessionCookie"=[])),
    params(("connection_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    responses(
        (status = 204),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn disconnect(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let connection_id = parse_uuid(&raw_id, "connectionId", &request_id, CONNECTION)?;
    let version = parse_connection_etag(&headers, &request_id, CONNECTION)?;
    let browser = BrowserHeaders::read(&headers, &request_id, CONNECTION)?;
    service
        .disconnect(
            browser.request(BrowserMethod::Delete),
            connection_id,
            version,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, CONNECTION))?;
    Ok(private_no_store(StatusCode::NO_CONTENT.into_response()))
}

#[utoipa::path(post, path = ROTATE, tag = "git", security(("projectSessionCookie"=[])),
    params(("connection_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = RotateRequest, content_type = "application/json"),
    responses(
        (status = 200, body = GitConnectionView, headers(("ETag" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn rotate(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let connection_id = parse_uuid(&raw_id, "connectionId", &request_id, ROTATE)?;
    let (parts, body) = request.into_parts();
    let version = parse_connection_etag(&parts.headers, &request_id, ROTATE)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, ROTATE)?;
    let input: RotateRequest = json_body(&parts.headers, body, &request_id, ROTATE).await?;
    let view = service
        .rotate(
            browser.request(BrowserMethod::Post),
            connection_id,
            version,
            input.token.into_bytes(),
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ROTATE))?;
    connection_response(StatusCode::OK, view, request_id, ROTATE)
}

#[utoipa::path(get, path = REMOTE, tag = "git", security(("projectSessionCookie"=[])),
    params(("project_id" = String, Path)),
    responses(
        (status = 200, body = GitRemoteView, headers(("ETag" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn get_remote(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_project_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let project_id = parse_project_id(&raw_project_id, &request_id, REMOTE)?;
    let browser = BrowserHeaders::read(&headers, &request_id, REMOTE)?;
    let view = service
        .get_remote(browser.request(BrowserMethod::Get), project_id)
        .await
        .map_err(|error| map_error(error, request_id.clone(), REMOTE))?;
    remote_response(StatusCode::OK, view, request_id, REMOTE)
}

#[utoipa::path(post, path = IMPORT, tag = "git", security(("projectSessionCookie"=[])),
    params(("project_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = ImportRequest, content_type = "application/json"),
    responses(
        (status = 201, body = GitOperationView, headers(("ETag" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn import(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_project_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let project_id = parse_project_id(&raw_project_id, &request_id, IMPORT)?;
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, IMPORT)?;
    let input: ImportRequest = json_body(&parts.headers, body, &request_id, IMPORT).await?;
    let view = service
        .import(
            browser.request(BrowserMethod::Post),
            project_id,
            &input.repository_url,
            &input.branch,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), IMPORT))?;
    operation_response(StatusCode::CREATED, view, request_id, IMPORT)
}

#[utoipa::path(post, path = PULL, tag = "git", security(("projectSessionCookie"=[])),
    params(("project_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    responses(
        (status = 200, body = GitOperationView, headers(("ETag" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn pull(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_project_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let project_id = parse_project_id(&raw_project_id, &request_id, PULL)?;
    let expected_head = parse_remote_etag(&headers, &request_id, PULL)?;
    let browser = BrowserHeaders::read(&headers, &request_id, PULL)?;
    let view = service
        .pull(
            browser.request(BrowserMethod::Post),
            project_id,
            &expected_head,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), PULL))?;
    operation_response(StatusCode::OK, view, request_id, PULL)
}

#[utoipa::path(post, path = COMMIT_PUSH, tag = "git", security(("projectSessionCookie"=[])),
    params(("project_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = CommitPushRequest, content_type = "application/json"),
    responses(
        (status = 200, body = GitOperationView, headers(("ETag" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    ))]
async fn commit_push(
    State(service): State<GitHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_project_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let project_id = parse_project_id(&raw_project_id, &request_id, COMMIT_PUSH)?;
    let (parts, body) = request.into_parts();
    let expected_head = parse_remote_etag(&parts.headers, &request_id, COMMIT_PUSH)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, COMMIT_PUSH)?;
    let input: CommitPushRequest =
        json_body(&parts.headers, body, &request_id, COMMIT_PUSH).await?;
    let view = service
        .commit_and_push(
            browser.request(BrowserMethod::Post),
            project_id,
            &expected_head,
            &input.commit_message,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), COMMIT_PUSH))?;
    operation_response(StatusCode::OK, view, request_id, COMMIT_PUSH)
}

struct BrowserHeaders<'a> {
    origins: Vec<&'a str>,
    cookies: Vec<&'a str>,
    csrf: Vec<&'a str>,
}

impl<'a> BrowserHeaders<'a> {
    fn read(headers: &'a HeaderMap, request_id: &RequestId, path: &str) -> Result<Self, HttpError> {
        Ok(Self {
            origins: header_values(headers, &ORIGIN, request_id, path)?,
            cookies: header_values(headers, &COOKIE, request_id, path)?,
            csrf: header_values(headers, &CSRF, request_id, path)?,
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

fn header_values<'a>(
    headers: &'a HeaderMap,
    name: &HeaderName,
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

async fn json_body<T: DeserializeOwned>(
    headers: &HeaderMap,
    body: Body,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    if headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| !value.eq_ignore_ascii_case("application/json"))
    {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    }
    let bytes = to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| HttpError::payload_too_large(request_id.clone(), path))?;
    serde_json::from_slice(&bytes).map_err(|_| validation(request_id, path, "body"))
}

fn parse_uuid(
    value: &str,
    field: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<Uuid, HttpError> {
    Uuid::parse_str(value).map_err(|_| validation(request_id, path, field))
}

fn parse_project_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectId, HttpError> {
    ProjectId::from_str(value).map_err(|_| validation(request_id, path, "projectId"))
}

fn parse_connection_etag(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<u64, HttpError> {
    let value = single_if_match(headers, request_id, path)?;
    value
        .strip_prefix("\"git-connection-v")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))
}

fn parse_provider_etag(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<u64, HttpError> {
    single_if_match(headers, request_id, path)?
        .strip_prefix("\"git-provider-v")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))
}

fn parse_provider_kind(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<GitProviderKind, HttpError> {
    match value {
        "github" => Ok(GitProviderKind::GitHub),
        "github_enterprise" => Ok(GitProviderKind::GitHubEnterprise),
        "gitlab" => Ok(GitProviderKind::GitLab),
        "gitlab_self_managed" => Ok(GitProviderKind::GitLabSelfManaged),
        "generic" => Ok(GitProviderKind::Generic),
        _ => Err(validation(request_id, path, "kind")),
    }
}

fn parse_remote_etag(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<String, HttpError> {
    let value = single_if_match(headers, request_id, path)?;
    let sha = value
        .strip_prefix("\"git-remote-")
        .and_then(|value| value.strip_suffix('"'))
        .filter(|value| {
            matches!(value.len(), 40 | 64)
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))?;
    Ok(sha.to_owned())
}

fn single_if_match<'a>(
    headers: &'a HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<&'a str, HttpError> {
    let values: Vec<_> = headers.get_all(IF_MATCH).iter().collect();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    if values.len() != 1 {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    values[0]
        .to_str()
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))
}

fn connection_response(
    status: StatusCode,
    view: GitConnectionView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let etag = HeaderValue::from_str(&format!("\"git-connection-v{}\"", view.connection_version))
        .map_err(|_| HttpError::internal(request_id, path))?;
    let mut response = private_no_store((status, Json(view)).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

fn admin_provider_response(
    status: StatusCode,
    view: GitProviderAdminView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let etag = HeaderValue::from_str(&format!("\"git-provider-v{}\"", view.config_version))
        .map_err(|_| HttpError::internal(request_id, path))?;
    let mut response = private_no_store((status, Json(view)).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

fn remote_response(
    status: StatusCode,
    view: GitRemoteView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let etag = remote_etag(&view.remote_head_sha, request_id, path)?;
    let mut response = private_no_store((status, Json(view)).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

fn operation_response(
    status: StatusCode,
    view: GitOperationView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let etag = remote_etag(&view.remote.remote_head_sha, request_id, path)?;
    let mut response = private_no_store((status, Json(view)).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

fn remote_etag(sha: &str, request_id: RequestId, path: &str) -> Result<HeaderValue, HttpError> {
    HeaderValue::from_str(&format!("\"git-remote-{sha}\""))
        .map_err(|_| HttpError::internal(request_id, path))
}

fn private_no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

fn validation(request_id: &RequestId, path: &str, field: &str) -> HttpError {
    HttpError::validation(
        request_id.clone(),
        path,
        vec![FieldViolation::new(
            field,
            "INVALID",
            "The field is invalid.",
        )],
    )
}

fn map_error(error: GitHttpError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        GitHttpError::InvalidInput => validation(&request_id, path, "request"),
        GitHttpError::AuthenticationFailed => HttpError::authentication(request_id, path),
        GitHttpError::Forbidden => HttpError::forbidden(request_id, path),
        GitHttpError::ReauthenticationRequired => {
            HttpError::reauthentication_required(request_id, path)
        }
        GitHttpError::NotFound => HttpError::not_found(request_id, path),
        GitHttpError::AlreadyConnected | GitHttpError::Conflict => {
            HttpError::conflict(request_id, path)
        }
        GitHttpError::NonFastForward => HttpError::precondition_failed(request_id, path),
        GitHttpError::ProviderUnavailable
        | GitHttpError::CredentialUnavailable
        | GitHttpError::Unavailable => HttpError::service_unavailable(request_id, path),
        GitHttpError::TransferLimitExceeded => HttpError::payload_too_large(request_id, path),
        GitHttpError::OperationTimeout => HttpError::operation_timeout(request_id, path),
        GitHttpError::CommitOutcomeUnknown => HttpError::commit_outcome_unknown(request_id, path),
        GitHttpError::Internal => HttpError::internal(request_id, path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etags_are_strong_and_strict() {
        let request_id = RequestId::generate();
        let mut connection = HeaderMap::new();
        connection.insert(IF_MATCH, HeaderValue::from_static("\"git-connection-v7\""));
        assert_eq!(
            parse_connection_etag(&connection, &request_id, CONNECTION).unwrap(),
            7
        );

        let mut provider = HeaderMap::new();
        provider.insert(IF_MATCH, HeaderValue::from_static("\"git-provider-v11\""));
        assert_eq!(
            parse_provider_etag(&provider, &request_id, ADMIN_PROVIDER).unwrap(),
            11
        );
        for value in [
            "W/\"git-provider-v11\"",
            "\"git-provider-v0\"",
            "\"git-provider-v11\",\"git-provider-v12\"",
            "\"registry-v11\"",
        ] {
            provider.insert(IF_MATCH, HeaderValue::from_str(value).unwrap());
            assert!(parse_provider_etag(&provider, &request_id, ADMIN_PROVIDER).is_err());
        }

        let mut remote = HeaderMap::new();
        remote.insert(
            IF_MATCH,
            HeaderValue::from_static("\"git-remote-0123456789abcdef0123456789abcdef01234567\""),
        );
        assert_eq!(
            parse_remote_etag(&remote, &request_id, PULL).unwrap(),
            "0123456789abcdef0123456789abcdef01234567"
        );

        remote.insert(
            IF_MATCH,
            HeaderValue::from_static(
                "\"git-remote-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"",
            ),
        );
        assert_eq!(
            parse_remote_etag(&remote, &request_id, PULL).unwrap().len(),
            64
        );

        for value in [
            "W/\"git-remote-0123456789abcdef0123456789abcdef01234567\"",
            "\"git-remote-0123456789ABCDEF0123456789abcdef01234567\"",
            "\"git-remote-0123456789abcdef0123456789abcdef01234567\",\"other\"",
        ] {
            let mut invalid = HeaderMap::new();
            invalid.insert(IF_MATCH, HeaderValue::from_str(value).unwrap());
            assert!(parse_remote_etag(&invalid, &request_id, PULL).is_err());
        }
        let mut duplicate = HeaderMap::new();
        duplicate.append(
            IF_MATCH,
            HeaderValue::from_static("\"git-remote-0123456789abcdef0123456789abcdef01234567\""),
        );
        duplicate.append(
            IF_MATCH,
            HeaderValue::from_static("\"git-remote-89abcdef0123456789abcdef0123456789abcdef\""),
        );
        assert!(parse_remote_etag(&duplicate, &request_id, PULL).is_err());
    }

    #[tokio::test]
    async fn stale_reauthentication_has_a_stable_forbidden_problem_code() {
        let response = map_error(
            GitHttpError::ReauthenticationRequired,
            RequestId::generate(),
            CONNECTIONS,
        )
        .into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
        let problem: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(problem["code"], "REAUTHENTICATION_REQUIRED");
        assert_eq!(problem["status"], 403);
        assert_eq!(problem["instance"], CONNECTIONS);
    }
}
