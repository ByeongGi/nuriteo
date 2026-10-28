#![allow(unused_imports)]
use super::role_http::*;
use super::*;
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

use super::super::http_service::{
    HistoricalPromotionView, ProjectHttpError, ProjectHttpService, ProjectListView,
    ProjectRoleListView, ProjectRoleMutationView, ProjectVersionCreateView, ProjectVersionListView,
    ProjectView, RecoveryCheckpointListView, RoleOperation,
};

use super::super::{
    ProjectId, ProjectName, ProjectOwner, ProjectPageLimit, ProjectRole, ProjectRolePageLimit,
    ProjectSlug, ProjectState, ProjectTemplate, ProjectVersion,
};

use super::{
    ARCHIVE, BrowserHeaders, COLLECTION, CONTENT, CONTENT_DOWNLOAD, CSRF, ChangeRoleRequest,
    CreateProjectRequest, CreateVersionRequest, DeleteProjectRequest, GrantRoleRequest,
    HISTORY_RESTORE, IDEMPOTENCY_KEY, ITEM, ListQuery, MAX_AUTHORIZATION_BYTES, MAX_BODY,
    MAX_QUERY, ORIGIN, ProjectBundleBinary, PromoteHistoryRequest, RECOVERY_CHECKPOINTS, RESTORE,
    ROLE, ROLES, RenameProjectRequest, VERSIONS, VersionListQuery,
};
use crate::access_token::{AccessTokenScope, ApiCategory};

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
pub(crate) async fn create_version(
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
pub(crate) async fn list_versions(
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

#[utoipa::path(get, path = RECOVERY_CHECKPOINTS, tag = "project-history",
    security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path)),
    responses((status = 200, body = RecoveryCheckpointListView, headers(("Cache-Control" = String))),
      (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
      (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
pub(crate) async fn list_recovery_checkpoints(
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
pub(crate) async fn promote_history(
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
pub(crate) async fn reconcile_history(
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
pub(crate) async fn get_content_descriptor(
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
pub(crate) async fn download_content(
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

pub(crate) fn parse_content_if_match(
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
pub(crate) async fn create_project(
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
            input.template,
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
pub(crate) async fn list_projects(
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
pub(crate) async fn get_project(
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
pub(crate) async fn rename_project(
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
pub(crate) async fn delete_project(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<(String, String, String)>,
    request: Request,
) -> Result<StatusCode, HttpError> {
    let (parts, body) = request.into_parts();
    let instance = parts.uri.path().to_owned();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, &instance)?;
    let version = parse_if_match(&parts.headers, &request_id, &instance)?;
    let input: DeleteProjectRequest =
        json_body(&parts.headers, body, &request_id, &instance).await?;
    service
        .delete(
            headers.request(BrowserMethod::Delete),
            parse_owner(&owner_type, &owner_id, &request_id, &instance)?,
            parse_project_id(&project_id, &request_id, &instance)?,
            version,
            ProjectName::new(input.name).map_err(|_| validation(&request_id, &instance, "name"))?,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, &instance))?;
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
pub(crate) async fn archive_project(
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
pub(crate) async fn restore_project(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    lifecycle(service, request_id, path, request, true, RESTORE).await
}

pub(crate) async fn lifecycle(
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
pub(crate) async fn list_roles(
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
pub(crate) async fn grant_role(
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
