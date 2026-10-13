use std::str::FromStr;

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Request, State};
use axum::http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, RANGE,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, de::DeserializeOwned};
use tokio_util::io::ReaderStream;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders, UserId};
use crate::organization::OrganizationId;
use crate::save::{
    ContentDescriptor, HistoricalReferenceKind, IdempotencyKey, ProjectVersionName,
    ProjectVersionPageLimit,
};

use super::http_service::{
    HistoricalPromotionView, ProjectHttpError, ProjectHttpService, ProjectListView,
    ProjectRoleListView, ProjectRoleMutationView, ProjectVersionCreateView, ProjectVersionListView,
    ProjectView, RecoveryCheckpointListView, RoleOperation,
};
use super::{
    ProjectId, ProjectName, ProjectOwner, ProjectPageLimit, ProjectRole, ProjectRolePageLimit,
    ProjectSlug, ProjectState, ProjectVersion,
};
use crate::access_token::{AccessTokenScope, ApiCategory};

const COLLECTION: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects";
const ITEM: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}";
const ARCHIVE: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/archive";
const RESTORE: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/restore";
const ROLES: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/roles";
const ROLE: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/roles/{user_id}";
const CONTENT: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/content";
const CONTENT_DOWNLOAD: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/content/{bundle_id}";
const VERSIONS: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/versions";
const RECOVERY_CHECKPOINTS: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/recovery-checkpoints";
const HISTORY_RESTORE: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/history/restore";
const MAX_BODY: usize = 4096;
const MAX_QUERY: usize = 4096;
const MAX_AUTHORIZATION_BYTES: usize = 256;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");
const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<ProjectHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(create_project, list_projects))
        .routes(routes!(get_project, rename_project, delete_project))
        .routes(routes!(archive_project))
        .routes(routes!(restore_project))
        .routes(routes!(list_roles, grant_role))
        .routes(routes!(change_role, revoke_role))
        .routes(routes!(get_content_descriptor))
        .routes(routes!(download_content))
        .routes(routes!(create_version, list_versions))
        .routes(routes!(list_recovery_checkpoints))
        .routes(routes!(promote_history, reconcile_history))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct CreateVersionRequest {
    name: String,
}

#[utoipa::path(post, path = VERSIONS, tag = "project-versions",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("If-Match" = String, Header), ("Idempotency-Key" = String, Header),
      ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = CreateVersionRequest, content_type = "application/json"),
    responses((status = 201, body = ProjectVersionCreateView, headers(("Cache-Control" = String))),
      (status = 200, description = "Idempotent replay", body = ProjectVersionCreateView, headers(("Cache-Control" = String))),
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
async fn create_version(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, VERSIONS)?;
    let expected_version = parse_if_match(&parts.headers, &request_id, VERSIONS)?;
    let idempotency_key = parse_idempotency_key(&parts.headers, &request_id, VERSIONS)?;
    let input: CreateVersionRequest =
        json_body(&parts.headers, body, &request_id, VERSIONS).await?;
    let view = service
        .create_version(
            browser.request(BrowserMethod::Post),
            parse_owner(&owner_type, &owner_id, &request_id, VERSIONS)?,
            parse_project_id(&project_id, &request_id, VERSIONS)?,
            expected_version,
            ProjectVersionName::new(input.name)
                .map_err(|_| validation(&request_id, VERSIONS, "name"))?,
            idempotency_key,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), VERSIONS))?;
    let status = if view.idempotent_retry {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    let mut response = (status, Json(view)).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(response)
}

#[utoipa::path(get, path = VERSIONS, tag = "project-versions",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("pageSize" = Option<u16>, Query, minimum = 1, maximum = 100),
      ("cursor" = Option<String>, Query)),
    responses((status = 200, body = ProjectVersionListView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_versions(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(request.headers(), &request_id, VERSIONS)?;
    let query = VersionListQuery::parse(request.uri().query(), &request_id, VERSIONS)?;
    let view = service
        .list_versions(
            browser.request(BrowserMethod::Get),
            parse_owner(&owner_type, &owner_id, &request_id, VERSIONS)?,
            parse_project_id(&project_id, &request_id, VERSIONS)?,
            query.limit(&request_id, VERSIONS)?,
            query.cursor.as_deref(),
        )
        .await
        .map_err(|error| map_error(error, request_id, VERSIONS))?;
    let mut response = (StatusCode::OK, Json(view)).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(response)
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromoteHistoryRequest {
    reference_kind: String,
    reference_id: String,
}

#[utoipa::path(get, path = RECOVERY_CHECKPOINTS, tag = "project-history",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path)),
    responses((status = 200, body = RecoveryCheckpointListView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_recovery_checkpoints(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(request.headers(), &request_id, RECOVERY_CHECKPOINTS)?;
    let view = service
        .list_recovery_checkpoints(
            browser.request(BrowserMethod::Get),
            parse_owner(&owner_type, &owner_id, &request_id, RECOVERY_CHECKPOINTS)?,
            parse_project_id(&project_id, &request_id, RECOVERY_CHECKPOINTS)?,
        )
        .await
        .map_err(|error| map_error(error, request_id, RECOVERY_CHECKPOINTS))?;
    Ok(private_no_store(Json(view).into_response()))
}

#[utoipa::path(post, path = HISTORY_RESTORE, tag = "project-history",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("If-Match" = String, Header), ("Idempotency-Key" = String, Header),
      ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = PromoteHistoryRequest, content_type = "application/json"),
    responses((status = 200, body = HistoricalPromotionView, headers(("ETag" = String), ("Cache-Control" = String))),
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
async fn promote_history(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, HISTORY_RESTORE)?;
    let expected = parse_if_match(&parts.headers, &request_id, HISTORY_RESTORE)?;
    let key = parse_idempotency_key(&parts.headers, &request_id, HISTORY_RESTORE)?;
    let input: PromoteHistoryRequest =
        json_body(&parts.headers, body, &request_id, HISTORY_RESTORE).await?;
    let reference_kind = input
        .reference_kind
        .parse::<HistoricalReferenceKind>()
        .map_err(|_| validation(&request_id, HISTORY_RESTORE, "referenceKind"))?;
    let reference_id = uuid::Uuid::parse_str(&input.reference_id)
        .map_err(|_| validation(&request_id, HISTORY_RESTORE, "referenceId"))?;
    let view = service
        .promote_history(
            browser.request(BrowserMethod::Post),
            parse_owner(&owner_type, &owner_id, &request_id, HISTORY_RESTORE)?,
            parse_project_id(&project_id, &request_id, HISTORY_RESTORE)?,
            expected,
            reference_kind,
            reference_id,
            key,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), HISTORY_RESTORE))?;
    let etag = HeaderValue::from_str(&format!("\"project-v{}\"", view.project_version))
        .map_err(|_| HttpError::internal(request_id, HISTORY_RESTORE))?;
    let mut response = private_no_store(Json(view).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

#[utoipa::path(get, path = HISTORY_RESTORE, tag = "project-history",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("Idempotency-Key" = String, Header)),
    responses((status = 200, body = HistoricalPromotionView, headers(("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn reconcile_history(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(request.headers(), &request_id, HISTORY_RESTORE)?;
    let key = parse_idempotency_key(request.headers(), &request_id, HISTORY_RESTORE)?;
    let view = service
        .reconcile_history(
            browser.request(BrowserMethod::Get),
            parse_owner(&owner_type, &owner_id, &request_id, HISTORY_RESTORE)?,
            parse_project_id(&project_id, &request_id, HISTORY_RESTORE)?,
            &key,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), HISTORY_RESTORE))?;
    let etag = HeaderValue::from_str(&format!("\"project-v{}\"", view.project_version))
        .map_err(|_| HttpError::internal(request_id, HISTORY_RESTORE))?;
    let mut response = private_no_store(Json(view).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

#[utoipa::path(get, path = CONTENT, tag = "projects",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path)),
    responses((status = 200, body = ContentDescriptor, headers(("ETag" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn get_content_descriptor(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, CONTENT)?;
    let descriptor = service
        .content_descriptor(
            headers.request(BrowserMethod::Get),
            parse_owner(&owner_type, &owner_id, &request_id, CONTENT)?,
            parse_project_id(&project_id, &request_id, CONTENT)?,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), CONTENT))?;
    let etag = HeaderValue::from_str(descriptor.etag())
        .map_err(|_| HttpError::internal(request_id.clone(), CONTENT))?;
    let mut response = (StatusCode::OK, Json(descriptor)).into_response();
    response.headers_mut().insert(ETAG, etag);
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(response)
}

#[utoipa::path(get, path = CONTENT_DOWNLOAD, tag = "projects",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("bundle_id" = String, Path), ("If-Match" = String, Header)),
    responses((status = 200, description = "Same-origin bounded verified Project Bundle stream", body = inline(ProjectBundleBinary), content_type = "application/octet-stream", headers(("ETag" = String), ("Content-Length" = String), ("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 416, description = "Byte ranges are deliberately unsupported for Alpha Project Bundles", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn download_content(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id, bundle_id)): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, CONTENT_DOWNLOAD)?;
    let range_requested = request.headers().contains_key(RANGE);
    let etag = parse_content_if_match(request.headers(), &request_id, CONTENT_DOWNLOAD)?;
    let download = service
        .download_content(
            headers.request(BrowserMethod::Get),
            parse_owner(&owner_type, &owner_id, &request_id, CONTENT_DOWNLOAD)?,
            parse_project_id(&project_id, &request_id, CONTENT_DOWNLOAD)?,
            &bundle_id,
            &etag,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), CONTENT_DOWNLOAD))?;
    if range_requested {
        // Authorization and every Project/Working-Head fence above still run before
        // an unsupported Range is rejected. Dropping an unpolled ContentDownload
        // drops the SDK byte stream immediately; no background buffer is retained.
        drop(download);
        return Err(HttpError::range_not_satisfiable(
            request_id,
            CONTENT_DOWNLOAD,
        ));
    }
    let (descriptor, reader) = download.into_parts();
    let mut response = Response::new(Body::from_stream(ReaderStream::new(reader)));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        axum::http::header::CONTENT_LENGTH,
        HeaderValue::from_str(&descriptor.physical_bytes().to_string())
            .map_err(|_| HttpError::internal(request_id.clone(), CONTENT_DOWNLOAD))?,
    );
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(descriptor.etag())
            .map_err(|_| HttpError::internal(request_id.clone(), CONTENT_DOWNLOAD))?,
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response.headers_mut().insert(
        axum::http::header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"nuriteo-project-bundle.tar\""),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn parse_content_if_match(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<String, HttpError> {
    let values = headers.get_all(IF_MATCH).iter().collect::<Vec<_>>();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    if values.len() != 1 {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    let value = values[0]
        .to_str()
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))?;
    if value.len() > 128
        || !value.starts_with("\"content-v")
        || !value.ends_with('"')
        || value.chars().any(char::is_control)
    {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    Ok(value.to_owned())
}

struct ProjectBundleBinary;

impl utoipa::PartialSchema for ProjectBundleBinary {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        use utoipa::openapi::schema::{KnownFormat, ObjectBuilder, Schema, SchemaFormat, Type};

        utoipa::openapi::RefOr::T(Schema::Object(
            ObjectBuilder::new()
                .schema_type(Type::String)
                .format(Some(SchemaFormat::KnownFormat(KnownFormat::Binary)))
                .build(),
        ))
    }
}

impl ToSchema for ProjectBundleBinary {}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct CreateProjectRequest {
    slug: String,
    name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct RenameProjectRequest {
    name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct DeleteProjectRequest {
    name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GrantRoleRequest {
    user_id: String,
    role: ProjectRole,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ChangeRoleRequest {
    role: ProjectRole,
}

#[utoipa::path(post, path = COLLECTION, tag = "projects",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path),
      ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = CreateProjectRequest, content_type = "application/json"),
    responses((status = 201, body = ProjectView, headers(("Location" = String), ("ETag" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn create_project(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, COLLECTION)?;
    let input: CreateProjectRequest =
        json_body(&parts.headers, body, &request_id, COLLECTION).await?;
    let view = service
        .create(
            headers.request(BrowserMethod::Post),
            parse_owner(&owner_type, &owner_id, &request_id, COLLECTION)?,
            ProjectSlug::new(input.slug)
                .map_err(|_| validation(&request_id, COLLECTION, "slug"))?,
            ProjectName::new(input.name)
                .map_err(|_| validation(&request_id, COLLECTION, "name"))?,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), COLLECTION))?;
    project_response(StatusCode::CREATED, view, true, request_id, COLLECTION)
}

#[utoipa::path(get, path = COLLECTION, tag = "projects",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path),
      ("state" = Option<String>, Query), ("pageSize" = Option<u16>, Query), ("cursor" = Option<String>, Query)),
    responses((status = 200, body = ProjectListView),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_projects(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id)): Path<(String, String)>,
    request: Request,
) -> Result<Json<ProjectListView>, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, COLLECTION)?;
    let query = ListQuery::parse(request.uri().query(), &request_id, COLLECTION)?;
    let view = service
        .list(
            headers.request(BrowserMethod::Get),
            parse_owner(&owner_type, &owner_id, &request_id, COLLECTION)?,
            query.state,
            query.project_limit(&request_id, COLLECTION)?,
            query.cursor.as_deref(),
        )
        .await
        .map_err(|error| map_error(error, request_id, COLLECTION))?;
    Ok(Json(view))
}

#[utoipa::path(get, path = ITEM, tag = "projects",
    description = "Reads one Project with either a browser Session, a project:read Personal Access Token intersected with the user's live Project role, or a project:read Project Automation Token bound to this exact Project.",
    security(("projectSessionCookie" = []), ("accessTokenBearer" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path)),
    responses((status = 200, body = ProjectView, headers(("ETag" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 429, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn get_project(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let owner = parse_owner(&owner_type, &owner_id, &request_id, ITEM)?;
    let project_id = parse_project_id(&project_id, &request_id, ITEM)?;
    let view = if let Some(bearer) = bearer_token(request.headers(), &request_id, ITEM)? {
        let identity = service
            .authenticate_access_token(
                bearer,
                AccessTokenScope::ProjectRead,
                project_id,
                ApiCategory::Read,
            )
            .await
            .map_err(|error| map_error(error, request_id.clone(), ITEM))?;
        service
            .get_as_access_token(&identity, owner, project_id)
            .await
            .map_err(|error| map_error(error, request_id.clone(), ITEM))?
    } else {
        let headers = BrowserHeaders::read(request.headers(), &request_id, ITEM)?;
        service
            .get(headers.request(BrowserMethod::Get), owner, project_id)
            .await
            .map_err(|error| map_error(error, request_id.clone(), ITEM))?
    };
    project_response(StatusCode::OK, view, false, request_id, ITEM)
}

#[utoipa::path(patch, path = ITEM, tag = "projects",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = RenameProjectRequest, content_type = "application/json"),
    responses((status = 200, body = ProjectView, headers(("ETag" = String))),
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
async fn rename_project(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, ITEM)?;
    let version = parse_if_match(&parts.headers, &request_id, ITEM)?;
    let input: RenameProjectRequest = json_body(&parts.headers, body, &request_id, ITEM).await?;
    let view = service
        .rename(
            headers.request(BrowserMethod::Patch),
            parse_owner(&owner_type, &owner_id, &request_id, ITEM)?,
            parse_project_id(&project_id, &request_id, ITEM)?,
            version,
            ProjectName::new(input.name).map_err(|_| validation(&request_id, ITEM, "name"))?,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ITEM))?;
    project_response(StatusCode::OK, view, false, request_id, ITEM)
}

#[utoipa::path(delete, path = ITEM, tag = "projects",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = DeleteProjectRequest, content_type = "application/json"),
    responses((status = 204),
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
async fn delete_project(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<StatusCode, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, ITEM)?;
    let version = parse_if_match(&parts.headers, &request_id, ITEM)?;
    let input: DeleteProjectRequest = json_body(&parts.headers, body, &request_id, ITEM).await?;
    service
        .delete(
            headers.request(BrowserMethod::Delete),
            parse_owner(&owner_type, &owner_id, &request_id, ITEM)?,
            parse_project_id(&project_id, &request_id, ITEM)?,
            version,
            ProjectName::new(input.name).map_err(|_| validation(&request_id, ITEM, "name"))?,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, ITEM))?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = ARCHIVE, tag = "projects", description = "Archives a Project with a browser Session or a project:write Personal Access Token. Origin and X-CSRF-Token are required for browser Session authentication and ignored for non-ambient Bearer authentication. Project Automation Tokens cannot perform lifecycle mutations because audit requires a live human actor.", security(("projectSessionCookie" = []), ("accessTokenBearer" = [])), params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path), ("If-Match" = String, Header), ("Origin" = Option<String>, Header), ("X-CSRF-Token" = Option<String>, Header)), responses((status = 200, body = ProjectView, headers(("ETag" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 429, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn archive_project(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    lifecycle(service, request_id, path, request, false, ARCHIVE).await
}

#[utoipa::path(post, path = RESTORE, tag = "projects", description = "Restores a Project with a browser Session or a project:write Personal Access Token. Origin and X-CSRF-Token are required for browser Session authentication and ignored for non-ambient Bearer authentication. Project Automation Tokens cannot perform lifecycle mutations because audit requires a live human actor.", security(("projectSessionCookie" = []), ("accessTokenBearer" = [])), params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path), ("If-Match" = String, Header), ("Origin" = Option<String>, Header), ("X-CSRF-Token" = Option<String>, Header)), responses((status = 200, body = ProjectView, headers(("ETag" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 429, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn restore_project(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    lifecycle(service, request_id, path, request, true, RESTORE).await
}

async fn lifecycle(
    service: ProjectHttpService,
    request_id: RequestId,
    (owner_type, owner_id, project_id): (String, String, String),
    request: Request,
    restore: bool,
    path: &'static str,
) -> Result<Response, HttpError> {
    let owner = parse_owner(&owner_type, &owner_id, &request_id, path)?;
    let project_id = parse_project_id(&project_id, &request_id, path)?;
    if let Some(bearer) = bearer_token(request.headers(), &request_id, path)? {
        // Authenticate scope before parsing mutation preconditions so a
        // read-only token cannot use validation differences as an oracle.
        let identity = service
            .authenticate_access_token(
                bearer,
                AccessTokenScope::ProjectWrite,
                project_id,
                ApiCategory::Write,
            )
            .await
            .map_err(|error| map_error(error, request_id.clone(), path))?;
        if !identity.is_human_actor() {
            return Err(HttpError::forbidden(request_id, path));
        }
        let version = parse_if_match(request.headers(), &request_id, path)?;
        let view = service
            .archive_or_restore_as_access_token(
                &identity,
                owner,
                project_id,
                version,
                restore,
                request_id.as_str(),
            )
            .await
            .map_err(|error| map_error(error, request_id.clone(), path))?;
        return project_response(StatusCode::OK, view, false, request_id, path);
    }
    let headers = BrowserHeaders::read(request.headers(), &request_id, path)?;
    let version = parse_if_match(request.headers(), &request_id, path)?;
    let view = service
        .archive_or_restore(
            headers.request(BrowserMethod::Post),
            owner,
            project_id,
            version,
            restore,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), path))?;
    project_response(StatusCode::OK, view, false, request_id, path)
}

#[utoipa::path(get, path = ROLES, tag = "project-roles", security(("projectSessionCookie" = [])), params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path), ("pageSize" = Option<u16>, Query), ("cursor" = Option<String>, Query)), responses((status = 200, body = ProjectRoleListView),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn list_roles(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<Json<ProjectRoleListView>, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, ROLES)?;
    let query = ListQuery::parse(request.uri().query(), &request_id, ROLES)?;
    if query.state_supplied {
        return Err(validation(&request_id, ROLES, "state"));
    }
    let view = service
        .list_roles(
            headers.request(BrowserMethod::Get),
            parse_owner(&owner_type, &owner_id, &request_id, ROLES)?,
            parse_project_id(&project_id, &request_id, ROLES)?,
            query.role_limit(&request_id, ROLES)?,
            query.cursor.as_deref(),
        )
        .await
        .map_err(|error| map_error(error, request_id, ROLES))?;
    Ok(Json(view))
}

#[utoipa::path(post, path = ROLES, tag = "project-roles", security(("projectSessionCookie" = [])), params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)), request_body(content = GrantRoleRequest, content_type = "application/json"), responses((status = 201, body = ProjectRoleMutationView, headers(("ETag" = String))),
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
async fn grant_role(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let input: GrantRoleRequest = json_body(&parts.headers, body, &request_id, ROLES).await?;
    role_mutation(
        service,
        request_id,
        path,
        parts.headers,
        input.user_id,
        Some(input.role),
        RoleOperation::Grant,
        BrowserMethod::Post,
        StatusCode::CREATED,
        ROLES,
    )
    .await
}

#[utoipa::path(patch, path = ROLE, tag = "project-roles", security(("projectSessionCookie" = [])), params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path), ("user_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)), request_body(content = ChangeRoleRequest, content_type = "application/json"), responses((status = 200, body = ProjectRoleMutationView, headers(("ETag" = String))),
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
async fn change_role(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id, user_id)): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let input: ChangeRoleRequest = json_body(&parts.headers, body, &request_id, ROLE).await?;
    role_mutation(
        service,
        request_id,
        (owner_type, owner_id, project_id),
        parts.headers,
        user_id,
        Some(input.role),
        RoleOperation::Change,
        BrowserMethod::Patch,
        StatusCode::OK,
        ROLE,
    )
    .await
}

#[utoipa::path(delete, path = ROLE, tag = "project-roles", security(("projectSessionCookie" = [])), params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path), ("user_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)), responses((status = 200, body = ProjectRoleMutationView, headers(("ETag" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn revoke_role(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id, user_id)): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = request.headers().clone();
    role_mutation(
        service,
        request_id,
        (owner_type, owner_id, project_id),
        headers,
        user_id,
        None,
        RoleOperation::Revoke,
        BrowserMethod::Delete,
        StatusCode::OK,
        ROLE,
    )
    .await
}

#[allow(
    clippy::too_many_arguments,
    reason = "role HTTP security inputs stay explicit"
)]
async fn role_mutation(
    service: ProjectHttpService,
    request_id: RequestId,
    (owner_type, owner_id, project_id): (String, String, String),
    headers: HeaderMap,
    user_id: String,
    role: Option<ProjectRole>,
    operation: RoleOperation,
    method: BrowserMethod,
    status: StatusCode,
    path: &'static str,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(&headers, &request_id, path)?;
    let version = parse_if_match(&headers, &request_id, path)?;
    let view = service
        .mutate_role(
            browser.request(method),
            parse_owner(&owner_type, &owner_id, &request_id, path)?,
            parse_project_id(&project_id, &request_id, path)?,
            version,
            parse_user_id(&user_id, &request_id, path)?,
            role,
            operation,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), path))?;
    role_response(status, view, request_id, path)
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

fn bearer_token<'a>(
    headers: &'a HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<Option<&'a str>, HttpError> {
    let values = headers.get_all(AUTHORIZATION).iter().collect::<Vec<_>>();
    if values.is_empty() {
        return Ok(None);
    }
    if values.len() != 1 || headers.contains_key(COOKIE) {
        return Err(HttpError::authentication(request_id.clone(), path));
    }
    let raw = values[0]
        .to_str()
        .map_err(|_| HttpError::authentication(request_id.clone(), path))?;
    let token = raw
        .strip_prefix("Bearer ")
        .filter(|token| {
            !token.is_empty()
                && raw.len() <= MAX_AUTHORIZATION_BYTES
                && !token.chars().any(char::is_whitespace)
                && !token.chars().any(char::is_control)
        })
        .ok_or_else(|| HttpError::authentication(request_id.clone(), path))?;
    Ok(Some(token))
}

struct ListQuery {
    state: Option<ProjectState>,
    state_supplied: bool,
    page_size: u16,
    cursor: Option<String>,
}
impl ListQuery {
    fn parse(raw: Option<&str>, request_id: &RequestId, path: &str) -> Result<Self, HttpError> {
        let raw = raw.unwrap_or_default();
        if raw.len() > MAX_QUERY {
            return Err(validation(request_id, path, "query"));
        }
        let mut state = None;
        let mut state_seen = false;
        let mut page_size = None;
        let mut cursor = None;
        let mut cursor_seen = false;
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "state" if !state_seen => {
                    state_seen = true;
                    state = Some(match value.as_ref() {
                        "active" => ProjectState::Active,
                        "archived" => ProjectState::Archived,
                        "all" => {
                            continue;
                        }
                        _ => return Err(validation(request_id, path, "state")),
                    })
                }
                "pageSize" if page_size.is_none() => {
                    page_size = Some(
                        value
                            .parse::<u16>()
                            .map_err(|_| validation(request_id, path, "pageSize"))?,
                    )
                }
                "cursor" if !cursor_seen && !value.is_empty() => {
                    cursor_seen = true;
                    cursor = Some(value.into_owned())
                }
                _ => return Err(validation(request_id, path, "query")),
            }
        }
        Ok(Self {
            state,
            state_supplied: state_seen,
            page_size: page_size.unwrap_or(50),
            cursor,
        })
    }
    fn project_limit(
        &self,
        request_id: &RequestId,
        path: &str,
    ) -> Result<ProjectPageLimit, HttpError> {
        ProjectPageLimit::new(self.page_size).map_err(|_| {
            HttpError::validation(
                request_id.clone(),
                path,
                [FieldViolation::new(
                    "pageSize",
                    "INVALID",
                    "The value is invalid.",
                )],
            )
        })
    }
    fn role_limit(
        &self,
        request_id: &RequestId,
        path: &str,
    ) -> Result<ProjectRolePageLimit, HttpError> {
        ProjectRolePageLimit::new(self.page_size).map_err(|_| {
            HttpError::validation(
                request_id.clone(),
                path,
                [FieldViolation::new(
                    "pageSize",
                    "INVALID",
                    "The value is invalid.",
                )],
            )
        })
    }
}

struct VersionListQuery {
    page_size: u16,
    cursor: Option<String>,
}

impl VersionListQuery {
    fn parse(raw: Option<&str>, request_id: &RequestId, path: &str) -> Result<Self, HttpError> {
        let raw = raw.unwrap_or_default();
        if raw.len() > MAX_QUERY {
            return Err(validation(request_id, path, "query"));
        }
        let mut page_size = None;
        let mut cursor = None;
        let mut cursor_seen = false;
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "pageSize" if page_size.is_none() => {
                    page_size = Some(
                        value
                            .parse::<u16>()
                            .map_err(|_| validation(request_id, path, "pageSize"))?,
                    );
                }
                "cursor" if !cursor_seen && !value.is_empty() => {
                    cursor_seen = true;
                    cursor = Some(value.into_owned());
                }
                _ => return Err(validation(request_id, path, "query")),
            }
        }
        Ok(Self {
            page_size: page_size.unwrap_or(crate::save::DEFAULT_PROJECT_VERSION_PAGE_SIZE),
            cursor,
        })
    }

    fn limit(
        &self,
        request_id: &RequestId,
        path: &str,
    ) -> Result<ProjectVersionPageLimit, HttpError> {
        ProjectVersionPageLimit::new(self.page_size).map_err(|_| {
            HttpError::validation(
                request_id.clone(),
                path,
                [FieldViolation::new(
                    "pageSize",
                    "INVALID",
                    "The value is invalid.",
                )],
            )
        })
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
            .and_then(|value| value.split(';').next())
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

fn parse_owner(
    owner_type: &str,
    owner_id: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectOwner, HttpError> {
    match owner_type {
        "users" => UserId::from_str(owner_id)
            .map(ProjectOwner::User)
            .map_err(|_| validation(request_id, path, "ownerId")),
        "organizations" => OrganizationId::from_str(owner_id)
            .map(ProjectOwner::Organization)
            .map_err(|_| validation(request_id, path, "ownerId")),
        _ => Err(validation(request_id, path, "ownerType")),
    }
}
fn parse_project_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectId, HttpError> {
    value
        .parse()
        .map_err(|_| validation(request_id, path, "projectId"))
}
fn parse_user_id(value: &str, request_id: &RequestId, path: &str) -> Result<UserId, HttpError> {
    value
        .parse()
        .map_err(|_| validation(request_id, path, "userId"))
}

fn parse_if_match(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectVersion, HttpError> {
    let values: Vec<_> = headers.get_all(IF_MATCH).iter().collect();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    if values.len() != 1 {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    let raw = values[0]
        .to_str()
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))?;
    let number = raw
        .strip_prefix("\"project-v")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))?;
    let version = ProjectVersion::new(number)
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))?;
    if raw != format!("\"project-v{}\"", version.get()) {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    Ok(version)
}

fn parse_idempotency_key(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<IdempotencyKey, HttpError> {
    let values: Vec<_> = headers.get_all(IDEMPOTENCY_KEY).iter().collect();
    if values.len() != 1 {
        return Err(validation(request_id, path, "Idempotency-Key"));
    }
    let value = values[0]
        .to_str()
        .map_err(|_| validation(request_id, path, "Idempotency-Key"))?;
    IdempotencyKey::new(value.to_owned())
        .map_err(|_| validation(request_id, path, "Idempotency-Key"))
}

fn project_response(
    status: StatusCode,
    view: ProjectView,
    location: bool,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let mut response = (status, Json(view.clone())).into_response();
    insert_etag(response.headers_mut(), view.version, &request_id, path)?;
    if location {
        response.headers_mut().insert(
            LOCATION,
            HeaderValue::from_str(&format!(
                "/api/v1/workspaces/{}/{}/projects/{}",
                if view.owner_type == "user" {
                    "users"
                } else {
                    "organizations"
                },
                view.owner_id,
                view.id
            ))
            .map_err(|_| HttpError::internal(request_id, path))?,
        );
    }
    Ok(response)
}

fn private_no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}
fn role_response(
    status: StatusCode,
    view: ProjectRoleMutationView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let version = view.project_version;
    let mut response = (status, Json(view)).into_response();
    insert_etag(response.headers_mut(), version, &request_id, path)?;
    Ok(response)
}
fn insert_etag(
    headers: &mut HeaderMap,
    version: i64,
    request_id: &RequestId,
    path: &str,
) -> Result<(), HttpError> {
    headers.insert(
        ETAG,
        HeaderValue::from_str(&format!("\"project-v{version}\""))
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    Ok(())
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
fn map_error(error: ProjectHttpError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        ProjectHttpError::AuthenticationFailed => HttpError::authentication(request_id, path),
        ProjectHttpError::Forbidden | ProjectHttpError::ConfirmationRequired => {
            HttpError::forbidden(request_id, path)
        }
        ProjectHttpError::NotFound => HttpError::not_found(request_id, path),
        ProjectHttpError::InvalidInput => validation(&request_id, path, "request"),
        ProjectHttpError::Conflict => HttpError::conflict(request_id, path),
        ProjectHttpError::PreconditionFailed => HttpError::precondition_failed(request_id, path),
        ProjectHttpError::AuditUnavailable | ProjectHttpError::Unavailable => {
            HttpError::service_unavailable(request_id, path)
        }
        ProjectHttpError::RateLimited => HttpError::rate_limited(request_id, path),
        ProjectHttpError::OperationTimeout => HttpError::operation_timeout(request_id, path),
        ProjectHttpError::CommitOutcomeUnknown => {
            HttpError::commit_outcome_unknown(request_id, path)
        }
        ProjectHttpError::Internal => HttpError::internal(request_id, path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exceptional_service_failures_have_distinct_stable_problems() {
        for (error, status, code) in [
            (
                ProjectHttpError::CommitOutcomeUnknown,
                StatusCode::SERVICE_UNAVAILABLE,
                "COMMIT_OUTCOME_UNKNOWN",
            ),
            (
                ProjectHttpError::OperationTimeout,
                StatusCode::GATEWAY_TIMEOUT,
                "OPERATION_TIMEOUT",
            ),
            (
                ProjectHttpError::AuditUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
            ),
            (
                ProjectHttpError::RateLimited,
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
            ),
        ] {
            let response = map_error(error, RequestId::generate(), ITEM).into_response();
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
            let body = to_bytes(response.into_body(), MAX_BODY).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["code"], code);
            assert!(!body.to_string().contains("postgres://"));
        }
    }

    #[test]
    fn strong_project_etag_parser_rejects_missing_weak_and_duplicate_values() {
        let request_id = RequestId::generate();
        assert!(parse_if_match(&HeaderMap::new(), &request_id, ITEM).is_err());
        let mut weak = HeaderMap::new();
        weak.insert(IF_MATCH, HeaderValue::from_static("W/\"project-v1\""));
        assert!(parse_if_match(&weak, &request_id, ITEM).is_err());
        let mut duplicate = HeaderMap::new();
        duplicate.append(IF_MATCH, HeaderValue::from_static("\"project-v1\""));
        duplicate.append(IF_MATCH, HeaderValue::from_static("\"project-v2\""));
        assert!(parse_if_match(&duplicate, &request_id, ITEM).is_err());
        for malformed in ["\"project-v+1\"", "\"project-v01\"", "\"project-v 1\""] {
            let mut headers = HeaderMap::new();
            headers.insert(IF_MATCH, HeaderValue::from_static(malformed));
            assert!(parse_if_match(&headers, &request_id, ITEM).is_err());
        }
    }

    #[test]
    fn list_query_rejects_empty_and_duplicate_cursor_pollution() {
        let request_id = RequestId::generate();
        assert!(ListQuery::parse(Some("cursor="), &request_id, COLLECTION).is_err());
        assert!(
            ListQuery::parse(
                Some("cursor=&cursor=nrt_project_cursor_value"),
                &request_id,
                COLLECTION,
            )
            .is_err()
        );
        assert!(
            ListQuery::parse(
                Some("cursor=nrt_project_cursor_one&cursor=nrt_project_cursor_two"),
                &request_id,
                COLLECTION,
            )
            .is_err()
        );
    }

    #[test]
    fn bearer_parser_rejects_ambiguous_or_non_canonical_credentials() {
        let request_id = RequestId::generate();
        let mut valid = HeaderMap::new();
        valid.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer nur_pat_token"),
        );
        assert_eq!(
            bearer_token(&valid, &request_id, ITEM).unwrap(),
            Some("nur_pat_token")
        );

        for value in ["bearer token", "Bearer", "Bearer ", "Bearer token extra"] {
            let mut headers = HeaderMap::new();
            headers.insert(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
            assert!(bearer_token(&headers, &request_id, ITEM).is_err());
        }

        valid.insert(
            COOKIE,
            HeaderValue::from_static("nuriteo_dev_session=value"),
        );
        assert!(bearer_token(&valid, &request_id, ITEM).is_err());

        let mut duplicate = HeaderMap::new();
        duplicate.append(AUTHORIZATION, HeaderValue::from_static("Bearer one"));
        duplicate.append(AUTHORIZATION, HeaderValue::from_static("Bearer two"));
        assert!(bearer_token(&duplicate, &request_id, ITEM).is_err());
    }
}
