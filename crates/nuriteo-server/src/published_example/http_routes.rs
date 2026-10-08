use std::str::FromStr;

use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Extension, Path, Query, Request, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION},
    },
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    http::{FieldViolation, HttpError, RequestId},
    identity::{BrowserMethod, BrowserRequestHeaders, UserId},
    organization::OrganizationId,
    project::{ProjectId, ProjectOwner},
};

use super::{
    PublicPublishedExampleListView, PublicPublishedExampleView, PublishedExampleCreateView,
    PublishedExampleHttpError, PublishedExampleHttpService, PublishedExampleId,
    PublishedExampleName, PublishedExamplePublicId, PublishedExampleVersionMutationView,
    PublishedExampleView, PublishedExampleVisibility,
};

const COLLECTION: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples";
const ITEM: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}";
const VERSIONS: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}/versions";
const ACTIVE_VERSION: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}/active-version";
const UNPUBLISH: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}/unpublish";
const REPUBLISH: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/published-examples/{example_id}/republish";
const PUBLIC_COLLECTION: &str = "/api/v1/published-examples";
const PUBLIC_ITEM: &str = "/api/v1/published-examples/{public_id}";
const PUBLIC_VERSION: &str = "/api/v1/published-examples/{public_id}/versions/{version_number}";
const MAX_BODY: usize = 4096;
const DEFAULT_PUBLIC_LIMIT: u16 = 20;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

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
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    project_version_id: String,
    name: String,
    visibility: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddVersionRequest {
    project_version_id: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectVersionRequest {
    version_id: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct VisibilityRequest {
    visibility: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct DeleteRequest {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicListQuery {
    limit: Option<u16>,
}

type ManagementPath = (String, String, String);
type ManagementItemPath = (String, String, String, String);

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
async fn create(
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
async fn set_visibility(
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
async fn add_version(
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
async fn select_active_version(
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

macro_rules! publication_action {
    ($handler:ident, $path:expr, $method:ident) => {
        #[utoipa::path(
            post, path = $path, tag = "published-examples",
            security(("projectSessionCookie" = [])),
            params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header), ("If-Match" = String, Header)),
            responses(
                (status = 200, body = PublishedExampleView),
                (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
                (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
            )
        )]
        async fn $handler(
            State(service): State<PublishedExampleHttpService>,
            Extension(request_id): Extension<RequestId>,
            Path(path): Path<ManagementItemPath>,
            headers: HeaderMap,
        ) -> Result<Response, HttpError> {
            let generation = parse_if_match(&headers, &request_id, $path)?;
            let browser = BrowserHeaders::read(&headers, &request_id, $path)?;
            let (owner, project_id, example_id) = parse_management_item(path, &request_id, $path)?;
            let view = service
                .$method(
                    browser.request(BrowserMethod::Post),
                    owner,
                    project_id,
                    example_id,
                    generation,
                )
                .await
                .map_err(|error| map_error(error, request_id.clone(), $path))?;
            example_response(view, request_id, $path)
        }
    };
}

publication_action!(unpublish, UNPUBLISH, unpublish);
publication_action!(republish, REPUBLISH, republish);

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
async fn delete(
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
async fn list_public(
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
async fn get_public(
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
async fn get_public_version(
    State(service): State<PublishedExampleHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((raw_public_id, version_number)): Path<(String, i64)>,
) -> Result<Response, HttpError> {
    public_response(
        service,
        raw_public_id,
        Some(version_number),
        request_id,
        PUBLIC_VERSION,
    )
    .await
}

async fn public_response(
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

fn parse_management_item(
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

fn parse_id<T: FromStr>(
    value: &str,
    field: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    value
        .parse()
        .map_err(|_| validation(request_id, path, field))
}

fn parse_visibility(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<PublishedExampleVisibility, HttpError> {
    match value {
        "unlisted" => Ok(PublishedExampleVisibility::Unlisted),
        "public" => Ok(PublishedExampleVisibility::Public),
        _ => Err(validation(request_id, path, "visibility")),
    }
}

fn parse_if_match(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<i64, HttpError> {
    let values: Vec<_> = headers.get_all(IF_MATCH).iter().collect();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    let [value] = values.as_slice() else {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    };
    let raw = value
        .to_str()
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))?;
    let generation = raw
        .strip_prefix("\"published-example-v")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 1)
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))?;
    if raw != format!("\"published-example-v{generation}\"") {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    Ok(generation)
}

fn example_response(
    view: PublishedExampleView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let generation = view.generation;
    let mut response = (StatusCode::OK, Json(view)).into_response();
    insert_generation_headers(&mut response, generation, &request_id, path)?;
    Ok(response)
}

fn insert_generation_headers(
    response: &mut Response,
    generation: i64,
    request_id: &RequestId,
    path: &str,
) -> Result<(), HttpError> {
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"published-example-v{generation}\""))
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(())
}

fn private_no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

fn public_cache(mut response: Response) -> Response {
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=60"),
    );
    response
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

fn map_error(error: PublishedExampleHttpError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        PublishedExampleHttpError::AuthenticationFailed => {
            HttpError::authentication(request_id, path)
        }
        PublishedExampleHttpError::Forbidden | PublishedExampleHttpError::ConfirmationRequired => {
            HttpError::forbidden(request_id, path)
        }
        PublishedExampleHttpError::NotFound => HttpError::not_found(request_id, path),
        PublishedExampleHttpError::InvalidInput => validation(&request_id, path, "request"),
        PublishedExampleHttpError::Conflict => HttpError::conflict(request_id, path),
        PublishedExampleHttpError::PreconditionFailed => {
            HttpError::precondition_failed(request_id, path)
        }
        PublishedExampleHttpError::Unavailable => HttpError::service_unavailable(request_id, path),
        PublishedExampleHttpError::OperationTimeout => {
            HttpError::operation_timeout(request_id, path)
        }
        PublishedExampleHttpError::CommitOutcomeUnknown => {
            HttpError::commit_outcome_unknown(request_id, path)
        }
        PublishedExampleHttpError::Internal => HttpError::internal(request_id, path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strong_example_etag_rejects_missing_weak_duplicate_and_noncanonical_values() {
        let request_id = RequestId::generate();
        assert!(parse_if_match(&HeaderMap::new(), &request_id, ITEM).is_err());

        for raw in [
            "W/\"published-example-v1\"",
            "\"published-example-v01\"",
            "\"published-example-v+1\"",
            "\"published-example-v0\"",
            "\"project-v1\"",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(IF_MATCH, HeaderValue::from_str(raw).unwrap());
            assert!(parse_if_match(&headers, &request_id, ITEM).is_err());
        }

        let mut duplicate = HeaderMap::new();
        duplicate.append(
            IF_MATCH,
            HeaderValue::from_static("\"published-example-v1\""),
        );
        duplicate.append(
            IF_MATCH,
            HeaderValue::from_static("\"published-example-v2\""),
        );
        assert!(parse_if_match(&duplicate, &request_id, ITEM).is_err());

        let mut valid = HeaderMap::new();
        valid.insert(
            IF_MATCH,
            HeaderValue::from_static("\"published-example-v19\""),
        );
        assert_eq!(parse_if_match(&valid, &request_id, ITEM).unwrap(), 19);
    }

    #[test]
    fn public_projection_schema_contains_no_internal_identifier_fields() {
        let schema = serde_json::to_value(utoipa::openapi::schema::Schema::from(
            <PublicPublishedExampleView as utoipa::PartialSchema>::schema(),
        ))
        .unwrap();
        let serialized = schema.to_string();
        for forbidden in [
            "projectId",
            "projectVersionId",
            "bundleId",
            "userId",
            "storageId",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }
}
