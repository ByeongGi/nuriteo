#![allow(unused_imports)]
use super::publication_requests::*;
use super::*;
use std::str::FromStr;

use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Extension, Path, Query, Request, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, StatusCode,
        header::{
            CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, RANGE,
        },
    },
    response::{IntoResponse, Response},
};

use serde::Deserialize;

use serde::de::DeserializeOwned;

use tokio_util::io::ReaderStream;

use utoipa::ToSchema;

use utoipa_axum::{router::OpenApiRouter, routes};

use uuid::Uuid;

use crate::{
    http::{FieldViolation, HttpError, RequestId},
    identity::{BrowserMethod, BrowserRequestHeaders, UserId},
    organization::OrganizationId,
    project::{ProjectId, ProjectOwner},
};

use super::super::{
    PublicPublishedExampleListView, PublicPublishedExampleView, PublishedExampleCreateView,
    PublishedExampleForkKey, PublishedExampleForkView, PublishedExampleHttpError,
    PublishedExampleHttpService, PublishedExampleId, PublishedExampleName,
    PublishedExamplePublicId, PublishedExampleVersionMutationView, PublishedExampleView,
    PublishedExampleVisibility,
};
use super::{
    ACTIVE_VERSION, AddVersionRequest, BrowserHeaders, COLLECTION, CSRF, CreateRequest,
    DEFAULT_PUBLIC_LIMIT, DeleteRequest, DestinationOwnerRequest, ForkRequest, IDEMPOTENCY_KEY,
    ITEM, MAX_BODY, ManagementItemPath, ManagementPath, ORIGIN, PREVIEW_ABUSE_KEY,
    PREVIEW_ABUSE_PROOF, PUBLIC_COLLECTION, PUBLIC_CONTENT, PUBLIC_FORKS, PUBLIC_ITEM,
    PUBLIC_VERSION, PUBLIC_VERSION_CONTENT, PUBLIC_VERSION_FORKS, PublicListQuery,
    PublishedExampleBundleBinary, REPUBLISH, SelectVersionRequest, UNPUBLISH, VERSIONS,
    VisibilityRequest,
};

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<PublishedExampleHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(create))
        .routes(routes!(set_visibility, delete))
        .routes(routes!(add_version))
        .routes(routes!(select_active_version))
        .routes(routes!(unpublish))
        .routes(routes!(republish))
        .routes(routes!(list_public))
        .routes(routes!(get_public))
        .routes(routes!(get_public_version))
        .routes(routes!(download_public_content))
        .routes(routes!(download_public_version_content))
        .routes(routes!(fork_public))
        .routes(routes!(fork_public_version))
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

#[utoipa::path(
    post, path = COLLECTION, tag = "published-examples",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = CreateRequest, content_type = "application/json"),
    responses(
        (status = 201, body = PublishedExampleCreateView),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn create(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id)): Path<ManagementPath>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, COLLECTION)?;
    let input: CreateRequest = json_body(&parts.headers, body, &request_id, COLLECTION).await?;
    let view = service
        .create(
            browser.request(BrowserMethod::Post),
            parse_owner(&owner_type, &owner_id, &request_id, COLLECTION)?,
            parse_id(&project_id, "projectId", &request_id, COLLECTION)?,
            parse_id(
                &input.project_version_id,
                "projectVersionId",
                &request_id,
                COLLECTION,
            )?,
            PublishedExampleName::new(input.name)
                .map_err(|_| validation(&request_id, COLLECTION, "name"))?,
            parse_visibility(&input.visibility, &request_id, COLLECTION)?,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), COLLECTION))?;
    let example_id = view.example.id.clone();
    let mut response = (StatusCode::CREATED, Json(view)).into_response();
    response.headers_mut().insert(
        LOCATION,
        HeaderValue::from_str(&format!(
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{}",
            example_id
        ))
        .map_err(|_| HttpError::internal(request_id.clone(), COLLECTION))?,
    );
    insert_generation_headers(&mut response, 1, &request_id, COLLECTION)?;
    Ok(response)
}

#[utoipa::path(
    patch, path = ITEM, tag = "published-examples",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header), ("If-Match" = String, Header)),
    request_body(content = VisibilityRequest, content_type = "application/json"),
    responses(
        (status = 200, body = PublishedExampleView),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn set_visibility(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<ManagementItemPath>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let generation = parse_if_match(&parts.headers, &request_id, ITEM)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, ITEM)?;
    let input: VisibilityRequest = json_body(&parts.headers, body, &request_id, ITEM).await?;
    let (owner, project_id, example_id) = parse_management_item(path, &request_id, ITEM)?;
    let view = service
        .set_visibility(
            browser.request(BrowserMethod::Patch),
            owner,
            project_id,
            example_id,
            parse_visibility(&input.visibility, &request_id, ITEM)?,
            generation,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ITEM))?;
    example_response(view, request_id, ITEM)
}

#[utoipa::path(
    post, path = VERSIONS, tag = "published-examples",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header), ("If-Match" = String, Header)),
    request_body(content = AddVersionRequest, content_type = "application/json"),
    responses(
        (status = 201, body = PublishedExampleVersionMutationView),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn add_version(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<ManagementItemPath>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let generation = parse_if_match(&parts.headers, &request_id, VERSIONS)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, VERSIONS)?;
    let input: AddVersionRequest = json_body(&parts.headers, body, &request_id, VERSIONS).await?;
    let (owner, project_id, example_id) = parse_management_item(path, &request_id, VERSIONS)?;
    let view = service
        .add_version(
            browser.request(BrowserMethod::Post),
            owner,
            project_id,
            example_id,
            parse_id(
                &input.project_version_id,
                "projectVersionId",
                &request_id,
                VERSIONS,
            )?,
            generation,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), VERSIONS))?;
    let next_generation = view.generation;
    let mut response = (StatusCode::CREATED, Json(view)).into_response();
    insert_generation_headers(&mut response, next_generation, &request_id, VERSIONS)?;
    Ok(response)
}

#[utoipa::path(
    post, path = ACTIVE_VERSION, tag = "published-examples",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header), ("If-Match" = String, Header)),
    request_body(content = SelectVersionRequest, content_type = "application/json"),
    responses(
        (status = 200, body = PublishedExampleView),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn select_active_version(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<ManagementItemPath>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let generation = parse_if_match(&parts.headers, &request_id, ACTIVE_VERSION)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, ACTIVE_VERSION)?;
    let input: SelectVersionRequest =
        json_body(&parts.headers, body, &request_id, ACTIVE_VERSION).await?;
    let (owner, project_id, example_id) = parse_management_item(path, &request_id, ACTIVE_VERSION)?;
    let view = service
        .select_active_version(
            browser.request(BrowserMethod::Post),
            owner,
            project_id,
            example_id,
            parse_id(&input.version_id, "versionId", &request_id, ACTIVE_VERSION)?,
            generation,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ACTIVE_VERSION))?;
    example_response(view, request_id, ACTIVE_VERSION)
}

#[utoipa::path(
    delete, path = ITEM, tag = "published-examples",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header), ("If-Match" = String, Header)),
    request_body(content = DeleteRequest, content_type = "application/json"),
    responses(
        (status = 204),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn delete(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<ManagementItemPath>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let generation = parse_if_match(&parts.headers, &request_id, ITEM)?;
    let browser = BrowserHeaders::read(&parts.headers, &request_id, ITEM)?;
    let input: DeleteRequest = json_body(&parts.headers, body, &request_id, ITEM).await?;
    let (owner, project_id, example_id) = parse_management_item(path, &request_id, ITEM)?;
    service
        .delete(
            browser.request(BrowserMethod::Delete),
            owner,
            project_id,
            example_id,
            generation,
            PublishedExampleName::new(input.name)
                .map_err(|_| validation(&request_id, ITEM, "name"))?,
        )
        .await
        .map_err(|error| map_error(error, request_id, ITEM))?;
    Ok(private_no_store(StatusCode::NO_CONTENT.into_response()))
}

#[utoipa::path(
    get, path = PUBLIC_COLLECTION, tag = "published-examples",
    params(("limit" = Option<u16>, Query, minimum = 1, maximum = 100)),
    responses(
        (status = 200, body = PublicPublishedExampleListView),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_public(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<PublicListQuery>,
) -> Result<Response, HttpError> {
    let view = service
        .list_public(query.limit.unwrap_or(DEFAULT_PUBLIC_LIMIT))
        .await
        .map_err(|error| map_error(error, request_id, PUBLIC_COLLECTION))?;
    Ok(public_cache(Json(view).into_response()))
}

#[utoipa::path(
    get, path = PUBLIC_ITEM, tag = "published-examples",
    params(("public_id" = String, Path)),
    responses(
        (status = 200, body = PublicPublishedExampleView),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_public(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_public_id): Path<String>,
) -> Result<Response, HttpError> {
    public_response(service, raw_public_id, None, request_id, PUBLIC_ITEM).await
}

#[utoipa::path(
    get, path = PUBLIC_VERSION, tag = "published-examples",
    params(("public_id" = String, Path), ("version_number" = i64, Path, minimum = 1)),
    responses(
        (status = 200, body = PublicPublishedExampleView),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_public_version(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((raw_public_id, version_number)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let public_id = PublishedExamplePublicId::from_str(&raw_public_id)
        .map_err(|_| validation(&request_id, PUBLIC_VERSION, "publicId"))?;
    if version_number < 1 {
        return Err(validation(&request_id, PUBLIC_VERSION, "versionNumber"));
    }
    let abuse_key = headers.get(&PREVIEW_ABUSE_KEY);
    let abuse_proof = headers.get(&PREVIEW_ABUSE_PROOF);
    if abuse_key.is_some() || abuse_proof.is_some() {
        let abuse_key = abuse_key
            .and_then(|value| value.to_str().ok())
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| validation(&request_id, PUBLIC_VERSION, "previewAbuseKey"))?;
        let proof = abuse_proof
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() == 43)
            .ok_or_else(|| validation(&request_id, PUBLIC_VERSION, "previewAbuseProof"))?;
        let view = service
            .resolve_public(&public_id, Some(version_number))
            .await
            .map_err(|error| map_error(error, request_id.clone(), PUBLIC_VERSION))?;
        service
            .charge_public_preview_binding(&public_id, abuse_key, version_number, proof)
            .await
            .map_err(|error| map_error(error, request_id, PUBLIC_VERSION))?;
        return Ok(public_cache(Json(view).into_response()));
    }
    let view = service
        .resolve_public(&public_id, Some(version_number))
        .await
        .map_err(|error| map_error(error, request_id, PUBLIC_VERSION))?;
    Ok(public_cache(Json(view).into_response()))
}

impl utoipa::PartialSchema for PublishedExampleBundleBinary {
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

impl ToSchema for PublishedExampleBundleBinary {}

#[utoipa::path(
    get, path = PUBLIC_CONTENT, tag = "published-examples",
    params(("public_id" = String, Path)),
    responses(
        (status = 200, body = inline(PublishedExampleBundleBinary), content_type = "application/vnd.nuriteo.published-project-bundle", headers(("ETag" = String), ("Content-Length" = u64), ("Cache-Control" = String))),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 416, description = "Byte ranges are deliberately unsupported for Project Bundles", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 500, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn download_public_content(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_public_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    public_content_response(
        service,
        raw_public_id,
        None,
        request.headers().contains_key(RANGE),
        request_id,
        PUBLIC_CONTENT,
    )
    .await
}

#[utoipa::path(
    get, path = PUBLIC_VERSION_CONTENT, tag = "published-examples",
    params(("public_id" = String, Path), ("version_number" = i64, Path, minimum = 1)),
    responses(
        (status = 200, body = inline(PublishedExampleBundleBinary), content_type = "application/vnd.nuriteo.published-project-bundle", headers(("ETag" = String), ("Content-Length" = u64), ("Cache-Control" = String))),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 416, description = "Byte ranges are deliberately unsupported for Project Bundles", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 500, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn download_public_version_content(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((raw_public_id, version_number)): Path<(String, i64)>,
    request: Request,
) -> Result<Response, HttpError> {
    public_content_response(
        service,
        raw_public_id,
        Some(version_number),
        request.headers().contains_key(RANGE),
        request_id,
        PUBLIC_VERSION_CONTENT,
    )
    .await
}

#[utoipa::path(
    post, path = PUBLIC_FORKS, tag = "published-examples",
    security(("projectSessionCookie" = [])),
    params(
        ("public_id" = String, Path),
        ("Idempotency-Key" = String, Header),
        ("Origin" = String, Header),
        ("X-CSRF-Token" = String, Header)
    ),
    request_body(content = ForkRequest, content_type = "application/json"),
    responses(
        (status = 201, body = PublishedExampleForkView, headers(("Location" = String), ("Cache-Control" = String))),
        (status = 200, description = "Idempotent replay", body = PublishedExampleForkView, headers(("Location" = String), ("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn fork_public(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(raw_public_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    fork_response(
        service,
        raw_public_id,
        None,
        request_id,
        request,
        PUBLIC_FORKS,
    )
    .await
}

#[utoipa::path(
    post, path = PUBLIC_VERSION_FORKS, tag = "published-examples",
    security(("projectSessionCookie" = [])),
    params(
        ("public_id" = String, Path),
        ("version_number" = i64, Path, minimum = 1),
        ("Idempotency-Key" = String, Header),
        ("Origin" = String, Header),
        ("X-CSRF-Token" = String, Header)
    ),
    request_body(content = ForkRequest, content_type = "application/json"),
    responses(
        (status = 201, body = PublishedExampleForkView, headers(("Location" = String), ("Cache-Control" = String))),
        (status = 200, description = "Idempotent replay", body = PublishedExampleForkView, headers(("Location" = String), ("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn fork_public_version(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((raw_public_id, version_number)): Path<(String, i64)>,
    request: Request,
) -> Result<Response, HttpError> {
    fork_response(
        service,
        raw_public_id,
        Some(version_number),
        request_id,
        request,
        PUBLIC_VERSION_FORKS,
    )
    .await
}

pub(crate) async fn fork_response(
    service: PublishedExampleHttpService,
    raw_public_id: String,
    version_number: Option<i64>,
    request_id: RequestId,
    request: Request,
    path: &'static str,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, path)?;
    let idempotency_key = parse_idempotency_key(&parts.headers, &request_id, path)?;
    let input: ForkRequest = json_body(&parts.headers, body, &request_id, path).await?;
    let public_id = PublishedExamplePublicId::from_str(&raw_public_id)
        .map_err(|_| validation(&request_id, path, "publicId"))?;
    if version_number.is_some_and(|value| value < 1) {
        return Err(validation(&request_id, path, "versionNumber"));
    }
    let destination_owner = parse_destination_owner(
        &input.destination_owner.owner_type,
        &input.destination_owner.owner_id,
        &request_id,
        path,
    )?;
    let view = service
        .fork_public(
            browser.request(BrowserMethod::Post),
            public_id,
            version_number,
            destination_owner,
            crate::project::ProjectSlug::new(input.slug)
                .map_err(|_| validation(&request_id, path, "slug"))?,
            crate::project::ProjectName::new(input.name)
                .map_err(|_| validation(&request_id, path, "name"))?,
            idempotency_key,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), path))?;
    fork_created_response(view, request_id, path)
}

pub(crate) fn fork_created_response(
    view: PublishedExampleForkView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let status = if view.idempotent_retry {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    let owner_segment = match view.project.owner_type {
        "user" => "users",
        "organization" => "organizations",
        _ => return Err(HttpError::internal(request_id, path)),
    };
    let location = format!(
        "/api/v1/workspaces/{owner_segment}/{}/projects/{}",
        view.project.owner_id, view.project.id
    );
    let mut response = (status, Json(view)).into_response();
    response.headers_mut().insert(
        LOCATION,
        HeaderValue::from_str(&location)
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(response)
}

pub(crate) async fn public_content_response(
    service: PublishedExampleHttpService,
    raw_public_id: String,
    version_number: Option<i64>,
    range_requested: bool,
    request_id: RequestId,
    path: &'static str,
) -> Result<Response, HttpError> {
    let public_id = PublishedExamplePublicId::from_str(&raw_public_id)
        .map_err(|_| validation(&request_id, path, "publicId"))?;
    if version_number.is_some_and(|value| value < 1) {
        return Err(validation(&request_id, path, "versionNumber"));
    }
    if range_requested {
        return Err(HttpError::range_not_satisfiable(request_id, path));
    }
    let download = service
        .download_public_content(&public_id, version_number)
        .await
        .map_err(|error| map_error(error, request_id.clone(), path))?;
    let (descriptor, reader) = download.into_parts();
    let mut response = Response::new(Body::from_stream(ReaderStream::new(reader)));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.nuriteo.published-project-bundle"),
    );
    response.headers_mut().insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&descriptor.physical_bytes().to_string())
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&descriptor.etag())
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        axum::http::header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"nuriteo-published-example.tar\""),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    Ok(response)
}

pub(crate) async fn public_response(
    service: PublishedExampleHttpService,
    raw_public_id: String,
    version_number: Option<i64>,
    request_id: RequestId,
    path: &'static str,
) -> Result<Response, HttpError> {
    let public_id = PublishedExamplePublicId::from_str(&raw_public_id)
        .map_err(|_| validation(&request_id, path, "publicId"))?;
    if version_number.is_some_and(|value| value < 1) {
        return Err(validation(&request_id, path, "versionNumber"));
    }
    let view = service
        .resolve_public(&public_id, version_number)
        .await
        .map_err(|error| map_error(error, request_id, path))?;
    Ok(public_cache(Json(view).into_response()))
}

impl<'a> BrowserHeaders<'a> {
    pub(crate) fn read(
        headers: &'a HeaderMap,
        request_id: &RequestId,
        path: &str,
    ) -> Result<Self, HttpError> {
        Ok(Self {
            origins: header_values(headers, &ORIGIN, request_id, path)?,
            cookies: header_values(headers, &COOKIE, request_id, path)?,
            csrf: header_values(headers, &CSRF, request_id, path)?,
        })
    }

    pub(crate) fn request(&self, method: BrowserMethod) -> BrowserRequestHeaders<'_> {
        BrowserRequestHeaders {
            method,
            origins: &self.origins,
            cookie_headers: &self.cookies,
            csrf_headers: &self.csrf,
        }
    }
}

pub(crate) fn header_values<'a>(
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

pub(crate) async fn json_body<T: DeserializeOwned>(
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

pub(crate) fn parse_management_item(
    (owner_type, owner_id, project_id, example_id): ManagementItemPath,
    request_id: &RequestId,
    path: &str,
) -> Result<(ProjectOwner, ProjectId, PublishedExampleId), HttpError> {
    Ok((
        parse_owner(&owner_type, &owner_id, request_id, path)?,
        parse_id(&project_id, "projectId", request_id, path)?,
        parse_id(&example_id, "exampleId", request_id, path)?,
    ))
}

pub(crate) fn parse_owner(
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

pub(crate) fn parse_destination_owner(
    owner_type: &str,
    owner_id: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectOwner, HttpError> {
    match owner_type {
        "user" => UserId::from_str(owner_id)
            .map(ProjectOwner::User)
            .map_err(|_| validation(request_id, path, "ownerId")),
        "organization" => OrganizationId::from_str(owner_id)
            .map(ProjectOwner::Organization)
            .map_err(|_| validation(request_id, path, "ownerId")),
        _ => Err(validation(request_id, path, "ownerType")),
    }
}
