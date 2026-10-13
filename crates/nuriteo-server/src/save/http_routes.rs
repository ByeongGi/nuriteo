use std::io;
use std::pin::Pin;
use std::str::FromStr;
use std::task::{Context, Poll};

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Request, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH,
    TRANSFER_ENCODING,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::{Buf, Bytes};
use http_body::Body as HttpBody;
use serde::{Deserialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, ReadBuf};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders, UserId};
use crate::organization::OrganizationId;
use crate::project::{ProjectId, ProjectOwner, ProjectVersion};
use crate::quota::SaveSessionId;

use super::IdempotencyKey;
use super::http_service::{
    CommitView, ReconcileView, RelayPartUploadInput, RelaySingleUploadInput, SaveCreateInput,
    SaveHttpError, SaveHttpService, SavePartInput, SaveReceiptInput, SaveSessionView,
    UploadCapabilityView,
};

const COLLECTION: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions";
const ITEM: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}";
const PARTS: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/parts";
const RECEIPTS: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/parts/receipts";
const COMPLETE: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/complete";
const RECONCILE: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/reconcile";
const SINGLE_UPLOAD: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/upload";
const PART_UPLOAD: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/upload/parts/{part_number}";
const MAX_BODY: usize = 64 * 1024;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");
const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");
const RELAY_CHECKSUM: HeaderName = HeaderName::from_static("x-nuriteo-content-sha256");
const BUNDLE_CONTENT_TYPE: &str = "application/vnd.nuriteo.project-bundle";
const MAX_RELAY_BODY_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum number of request-body bytes exposed by one `AsyncRead` poll.
///
/// Hyper owns the backing allocation for each frame. The relay retains only
/// the current frame, advances it without copying, and does not poll the next
/// frame until the current one has been consumed.
const RELAY_READ_CHUNK_BYTES: usize = 64 * 1024;

struct RelayProjectBundleBinary;

impl utoipa::PartialSchema for RelayProjectBundleBinary {
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

impl ToSchema for RelayProjectBundleBinary {}

pub(crate) fn openapi_router(document: utoipa::openapi::OpenApi) -> OpenApiRouter<SaveHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(create_session))
        .routes(routes!(issue_parts))
        .routes(routes!(record_receipts))
        .routes(routes!(complete_session))
        .routes(routes!(reconcile_session))
        .routes(routes!(relay_single_upload))
        .routes(routes!(relay_part_upload))
        .routes(routes!(abort_session))
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    physical_bytes: u64,
    logical_bytes: u64,
    file_count: u32,
    sha256: String,
    #[serde(default)]
    parts: Vec<PartRequest>,
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PartRequest {
    part_number: u16,
    expected_bytes: u64,
    sha256: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct PartsRequest {
    parts: Vec<PartRequest>,
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptRequest {
    part_number: u16,
    expected_bytes: u64,
    sha256: String,
    etag: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ReceiptsRequest {
    receipts: Vec<ReceiptRequest>,
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteRequest {
    upload_mode: UploadMode,
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
enum UploadMode {
    Single,
    Multipart,
}

#[derive(Debug, Clone, Copy)]
struct RelayBodyMetadata {
    length: u64,
    checksum: [u8; 32],
}

#[utoipa::path(post, path = COLLECTION, tag = "save", security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("If-Match" = String, Header), ("Idempotency-Key" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = CreateRequest, content_type = "application/json"),
    responses(
      (status = 201, body = SaveSessionView, headers(("Cache-Control" = String))),
      (status = 200, description = "Idempotent replay", body = SaveSessionView, headers(("Cache-Control" = String))),
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
async fn create_session(
    State(service): State<SaveHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, COLLECTION)?;
    let version = parse_if_match(&parts.headers, &request_id, COLLECTION)?;
    let key = parse_idempotency(&parts.headers, &request_id, COLLECTION)?;
    let input: CreateRequest = json_body(&parts.headers, body, &request_id, COLLECTION).await?;
    let view = service
        .create(
            browser.request(BrowserMethod::Post),
            parse_owner(&path.0, &path.1, &request_id, COLLECTION)?,
            parse_project(&path.2, &request_id, COLLECTION)?,
            version,
            key,
            create_input(input, &request_id, COLLECTION)?,
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), COLLECTION))?;
    let status = if view.idempotent_retry {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok(private_response((status, Json(view)).into_response()))
}

#[utoipa::path(post, path = PARTS, tag = "save", security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("session_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = PartsRequest, content_type = "application/json"), responses(
    (status = 200, body = Vec<UploadCapabilityView>, headers(("Cache-Control" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn issue_parts(
    State(service): State<SaveHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (head, body) = request.into_parts();
    let browser = BrowserHeaders::read(&head.headers, &request_id, PARTS)?;
    let input: PartsRequest = json_body(&head.headers, body, &request_id, PARTS).await?;
    let parts = input
        .parts
        .into_iter()
        .map(|p| part_input(p, &request_id, PARTS))
        .collect::<Result<Vec<_>, _>>()?;
    let view = service
        .issue_parts(
            browser.request(BrowserMethod::Post),
            parse_owner(&path.0, &path.1, &request_id, PARTS)?,
            parse_project(&path.2, &request_id, PARTS)?,
            parse_session(&path.3, &request_id, PARTS)?,
            parts,
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), PARTS))?;
    Ok(private_response(Json(view).into_response()))
}

#[utoipa::path(post, path = RECEIPTS, tag = "save", security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("session_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = ReceiptsRequest, content_type = "application/json"), responses(
    (status = 204, headers(("Cache-Control" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn record_receipts(
    State(service): State<SaveHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    service
        .require_direct_receipts()
        .map_err(|error| map_error(error, request_id.clone(), RECEIPTS))?;
    let (head, body) = request.into_parts();
    let browser = BrowserHeaders::read(&head.headers, &request_id, RECEIPTS)?;
    let input: ReceiptsRequest = json_body(&head.headers, body, &request_id, RECEIPTS).await?;
    let receipts = input
        .receipts
        .into_iter()
        .map(|r| receipt_input(r, &request_id, RECEIPTS))
        .collect::<Result<Vec<_>, _>>()?;
    service
        .record_receipts(
            browser.request(BrowserMethod::Post),
            parse_owner(&path.0, &path.1, &request_id, RECEIPTS)?,
            parse_project(&path.2, &request_id, RECEIPTS)?,
            parse_session(&path.3, &request_id, RECEIPTS)?,
            receipts,
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), RECEIPTS))?;
    Ok(private_response(StatusCode::NO_CONTENT.into_response()))
}

#[utoipa::path(put, path = SINGLE_UPLOAD, tag = "save", security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("session_id" = String, Path), ("Content-Length" = u64, Header),
      ("X-Nuriteo-Content-SHA256" = String, Header), ("Origin" = String, Header),
      ("X-CSRF-Token" = String, Header)),
    request_body(content = inline(RelayProjectBundleBinary), content_type = "application/vnd.nuriteo.project-bundle"),
    responses((status = 204, headers(("Cache-Control" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn relay_single_upload(
    State(service): State<SaveHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (head, body) = request.into_parts();
    let browser = BrowserHeaders::read(&head.headers, &request_id, SINGLE_UPLOAD)?;
    let metadata = relay_body_metadata(&head.headers, &request_id, SINGLE_UPLOAD)?;
    service
        .relay_single_upload(RelaySingleUploadInput {
            browser: browser.request(BrowserMethod::Put),
            owner: parse_owner(&path.0, &path.1, &request_id, SINGLE_UPLOAD)?,
            project_id: parse_project(&path.2, &request_id, SINGLE_UPLOAD)?,
            session_id: parse_session(&path.3, &request_id, SINGLE_UPLOAD)?,
            declared_bytes: metadata.length,
            checksum: crate::object_storage::Sha256Checksum::from_bytes(metadata.checksum),
            reader: RequestBodyReader::new(body),
        })
        .await
        .map_err(|error| map_error(error, request_id, SINGLE_UPLOAD))?;
    Ok(private_response(StatusCode::NO_CONTENT.into_response()))
}

#[utoipa::path(put, path = PART_UPLOAD, tag = "save", security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("session_id" = String, Path), ("part_number" = u16, Path),
      ("Content-Length" = u64, Header), ("X-Nuriteo-Content-SHA256" = String, Header),
      ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = inline(RelayProjectBundleBinary), content_type = "application/vnd.nuriteo.project-bundle"),
    responses((status = 204, headers(("Cache-Control" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn relay_part_upload(
    State(service): State<SaveHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (head, body) = request.into_parts();
    let browser = BrowserHeaders::read(&head.headers, &request_id, PART_UPLOAD)?;
    let metadata = relay_body_metadata(&head.headers, &request_id, PART_UPLOAD)?;
    let part_number = path
        .4
        .parse::<u16>()
        .ok()
        .filter(|part| *part != 0)
        .ok_or_else(|| validation(&request_id, PART_UPLOAD, "partNumber"))?;
    service
        .relay_part_upload(RelayPartUploadInput {
            browser: browser.request(BrowserMethod::Put),
            owner: parse_owner(&path.0, &path.1, &request_id, PART_UPLOAD)?,
            project_id: parse_project(&path.2, &request_id, PART_UPLOAD)?,
            session_id: parse_session(&path.3, &request_id, PART_UPLOAD)?,
            part_number,
            declared_bytes: metadata.length,
            checksum: crate::object_storage::Sha256Checksum::from_bytes(metadata.checksum),
            reader: RequestBodyReader::new(body),
        })
        .await
        .map_err(|error| map_error(error, request_id, PART_UPLOAD))?;
    Ok(private_response(StatusCode::NO_CONTENT.into_response()))
}

#[utoipa::path(post, path = COMPLETE, tag = "save", security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("session_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = CompleteRequest, content_type = "application/json"), responses(
    (status = 200, body = CommitView, headers(("ETag" = String), ("Cache-Control" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn complete_session(
    State(service): State<SaveHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (head, body) = request.into_parts();
    let browser = BrowserHeaders::read(&head.headers, &request_id, COMPLETE)?;
    let input: CompleteRequest = json_body(&head.headers, body, &request_id, COMPLETE).await?;
    let view = service
        .complete(
            browser.request(BrowserMethod::Post),
            parse_owner(&path.0, &path.1, &request_id, COMPLETE)?,
            parse_project(&path.2, &request_id, COMPLETE)?,
            parse_session(&path.3, &request_id, COMPLETE)?,
            matches!(input.upload_mode, UploadMode::Multipart),
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), COMPLETE))?;
    let mut response = Json(view.clone()).into_response();
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"project-v{}\"", view.project_version))
            .map_err(|_| HttpError::internal(request_id, COMPLETE))?,
    );
    Ok(private_response(response))
}

#[utoipa::path(post, path = RECONCILE, tag = "save", security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("session_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    responses((status = 200, body = ReconcileView, headers(("Cache-Control" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn reconcile_session(
    State(service): State<SaveHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(request.headers(), &request_id, RECONCILE)?;
    let view = service
        .reconcile_commit(
            browser.request(BrowserMethod::Post),
            parse_owner(&path.0, &path.1, &request_id, RECONCILE)?,
            parse_project(&path.2, &request_id, RECONCILE)?,
            parse_session(&path.3, &request_id, RECONCILE)?,
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), RECONCILE))?;
    Ok(private_response(Json(view).into_response()))
}

#[utoipa::path(delete, path = ITEM, tag = "save", security(("projectSessionCookie" = [])),
    params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path),
      ("session_id" = String, Path), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    responses((status = 204, headers(("Cache-Control" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
async fn abort_session(
    State(service): State<SaveHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(path): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(request.headers(), &request_id, ITEM)?;
    service
        .abort(
            browser.request(BrowserMethod::Delete),
            parse_owner(&path.0, &path.1, &request_id, ITEM)?,
            parse_project(&path.2, &request_id, ITEM)?,
            parse_session(&path.3, &request_id, ITEM)?,
        )
        .await
        .map_err(|e| map_error(e, request_id.clone(), ITEM))?;
    Ok(private_response(StatusCode::NO_CONTENT.into_response()))
}

fn private_response(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

struct BrowserHeaders<'a> {
    cookies: Vec<&'a str>,
    origins: Vec<&'a str>,
    csrf: Vec<&'a str>,
}
impl<'a> BrowserHeaders<'a> {
    fn read(h: &'a HeaderMap, id: &RequestId, path: &str) -> Result<Self, HttpError> {
        fn values<'a>(
            h: &'a HeaderMap,
            n: HeaderName,
            id: &RequestId,
            path: &str,
        ) -> Result<Vec<&'a str>, HttpError> {
            h.get_all(n)
                .iter()
                .map(|v| v.to_str().map_err(|_| validation(id, path, "headers")))
                .collect()
        }
        Ok(Self {
            cookies: values(h, COOKIE, id, path)?,
            origins: values(h, ORIGIN, id, path)?,
            csrf: values(h, CSRF, id, path)?,
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
    id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    if headers.get_all(CONTENT_TYPE).iter().count() != 1
        || headers
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::trim)
            != Some("application/json")
    {
        return Err(HttpError::unsupported_media_type(id.clone(), path));
    }
    let bytes = to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| HttpError::payload_too_large(id.clone(), path))?;
    serde_json::from_slice(&bytes).map_err(|_| validation(id, path, "body"))
}

fn relay_body_metadata(
    headers: &HeaderMap,
    id: &RequestId,
    path: &str,
) -> Result<RelayBodyMetadata, HttpError> {
    if headers.get_all(CONTENT_TYPE).iter().count() != 1
        || headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            != Some(BUNDLE_CONTENT_TYPE)
        || headers.get_all(CONTENT_ENCODING).iter().next().is_some()
        || headers.get_all(TRANSFER_ENCODING).iter().next().is_some()
    {
        return Err(HttpError::unsupported_media_type(id.clone(), path));
    }
    let lengths = headers.get_all(CONTENT_LENGTH).iter().collect::<Vec<_>>();
    if lengths.len() != 1 {
        return Err(validation(id, path, "contentLength"));
    }
    let raw_length = lengths[0]
        .to_str()
        .map_err(|_| validation(id, path, "contentLength"))?;
    let length = raw_length
        .parse::<u64>()
        .ok()
        .filter(|value| *value != 0 && value.to_string() == raw_length)
        .ok_or_else(|| validation(id, path, "contentLength"))?;
    if length > MAX_RELAY_BODY_BYTES {
        return Err(HttpError::payload_too_large(id.clone(), path));
    }
    let checksums = headers.get_all(RELAY_CHECKSUM).iter().collect::<Vec<_>>();
    if checksums.len() != 1 {
        return Err(validation(id, path, "checksum"));
    }
    let raw_checksum = checksums[0]
        .to_str()
        .map_err(|_| validation(id, path, "checksum"))?;
    let decoded = BASE64
        .decode(raw_checksum)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .filter(|bytes| BASE64.encode(bytes) == raw_checksum)
        .ok_or_else(|| validation(id, path, "checksum"))?;
    Ok(RelayBodyMetadata {
        length,
        checksum: decoded,
    })
}

struct RequestBodyReader {
    body: Pin<Box<Body>>,
    current: Bytes,
    complete: bool,
}

impl RequestBodyReader {
    fn new(body: Body) -> Self {
        Self {
            body: Box::pin(body),
            current: Bytes::new(),
            complete: false,
        }
    }
}

impl AsyncRead for RequestBodyReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.complete || output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            if !self.current.is_empty() {
                let count = self
                    .current
                    .len()
                    .min(output.remaining())
                    .min(RELAY_READ_CHUNK_BYTES);
                output.put_slice(&self.current[..count]);
                self.current.advance(count);
                return Poll::Ready(Ok(()));
            }
            match self.body.as_mut().poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => {
                    self.complete = true;
                    return Poll::Ready(Ok(()));
                }
                Poll::Ready(Some(Err(_))) => {
                    self.complete = true;
                    return Poll::Ready(Err(io::Error::other("request body stream failed")));
                }
                Poll::Ready(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        self.current = data;
                    }
                }
            }
        }
    }
}
fn parse_owner(t: &str, raw: &str, id: &RequestId, path: &str) -> Result<ProjectOwner, HttpError> {
    match t {
        "users" => UserId::from_str(raw)
            .map(ProjectOwner::User)
            .map_err(|_| validation(id, path, "ownerId")),
        "organizations" => OrganizationId::from_str(raw)
            .map(ProjectOwner::Organization)
            .map_err(|_| validation(id, path, "ownerId")),
        _ => Err(validation(id, path, "ownerType")),
    }
}
fn parse_project(raw: &str, id: &RequestId, path: &str) -> Result<ProjectId, HttpError> {
    raw.parse().map_err(|_| validation(id, path, "projectId"))
}
fn parse_session(raw: &str, id: &RequestId, path: &str) -> Result<SaveSessionId, HttpError> {
    raw.parse::<uuid::Uuid>()
        .map_err(|_| validation(id, path, "sessionId"))
        .and_then(|value| {
            SaveSessionId::from_uuid(value).map_err(|_| validation(id, path, "sessionId"))
        })
}
fn parse_if_match(h: &HeaderMap, id: &RequestId, path: &str) -> Result<ProjectVersion, HttpError> {
    let v = h.get_all(IF_MATCH).iter().collect::<Vec<_>>();
    if v.is_empty() {
        return Err(HttpError::precondition_required(id.clone(), path));
    }
    if v.len() != 1 {
        return Err(HttpError::precondition_failed(id.clone(), path));
    }
    let raw = v[0]
        .to_str()
        .map_err(|_| HttpError::precondition_failed(id.clone(), path))?;
    let n = raw
        .strip_prefix("\"project-v")
        .and_then(|s| s.strip_suffix('"'))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| HttpError::precondition_failed(id.clone(), path))?;
    let version =
        ProjectVersion::new(n).map_err(|_| HttpError::precondition_failed(id.clone(), path))?;
    if raw != format!("\"project-v{}\"", version.get()) {
        return Err(HttpError::precondition_failed(id.clone(), path));
    }
    Ok(version)
}
fn parse_idempotency(
    h: &HeaderMap,
    id: &RequestId,
    path: &str,
) -> Result<IdempotencyKey, HttpError> {
    let v = h.get_all(IDEMPOTENCY_KEY).iter().collect::<Vec<_>>();
    if v.len() != 1 {
        return Err(validation(id, path, "idempotencyKey"));
    }
    IdempotencyKey::new(
        v[0].to_str()
            .map_err(|_| validation(id, path, "idempotencyKey"))?
            .to_owned(),
    )
    .map_err(|_| validation(id, path, "idempotencyKey"))
}
fn checksum(raw: &str, id: &RequestId, path: &str) -> Result<[u8; 32], HttpError> {
    BASE64
        .decode(raw)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| validation(id, path, "sha256"))
}
fn part_input(p: PartRequest, id: &RequestId, path: &str) -> Result<SavePartInput, HttpError> {
    Ok(SavePartInput {
        part_number: p.part_number,
        expected_bytes: p.expected_bytes,
        sha256: checksum(&p.sha256, id, path)?,
    })
}
fn receipt_input(
    r: ReceiptRequest,
    id: &RequestId,
    path: &str,
) -> Result<SaveReceiptInput, HttpError> {
    Ok(SaveReceiptInput {
        part_number: r.part_number,
        expected_bytes: r.expected_bytes,
        sha256: checksum(&r.sha256, id, path)?,
        etag: r.etag,
    })
}
fn create_input(
    r: CreateRequest,
    id: &RequestId,
    path: &str,
) -> Result<SaveCreateInput, HttpError> {
    Ok(SaveCreateInput {
        physical_bytes: r.physical_bytes,
        logical_bytes: r.logical_bytes,
        file_count: r.file_count,
        sha256: checksum(&r.sha256, id, path)?,
        parts: r
            .parts
            .into_iter()
            .map(|p| part_input(p, id, path))
            .collect::<Result<_, _>>()?,
    })
}
fn validation(id: &RequestId, path: &str, field: &str) -> HttpError {
    HttpError::validation(
        id.clone(),
        path,
        [FieldViolation::new(
            field,
            "INVALID",
            "The value is invalid.",
        )],
    )
}
fn map_error(e: SaveHttpError, id: RequestId, path: &str) -> HttpError {
    match e {
        SaveHttpError::AuthenticationFailed => HttpError::authentication(id, path),
        SaveHttpError::Forbidden => HttpError::forbidden(id, path),
        SaveHttpError::NotFound => HttpError::not_found(id, path),
        SaveHttpError::InvalidInput => validation(&id, path, "request"),
        SaveHttpError::Conflict | SaveHttpError::SessionExpired => HttpError::conflict(id, path),
        SaveHttpError::StaleProjectVersion => HttpError::precondition_failed(id, path),
        SaveHttpError::QuotaExceeded => HttpError::quota_exceeded(id, path),
        SaveHttpError::ReconciliationRequired => HttpError::reconciliation_required(id, path),
        SaveHttpError::CommitOutcomeUnknown => HttpError::commit_outcome_unknown(id, path),
        SaveHttpError::OperationTimeout => HttpError::operation_timeout(id, path),
        SaveHttpError::Unavailable => HttpError::service_unavailable(id, path),
        SaveHttpError::Internal => HttpError::internal(id, path),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::convert::Infallible;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use tokio::io::AsyncReadExt;

    struct ObservedFrames {
        frames: VecDeque<Bytes>,
        polls: Arc<AtomicUsize>,
    }

    impl HttpBody for ObservedFrames {
        type Data = Bytes;
        type Error = Infallible;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
            self.polls.fetch_add(1, Ordering::SeqCst);
            Poll::Ready(
                self.frames
                    .pop_front()
                    .map(|data| Ok(http_body::Frame::data(data))),
            )
        }
    }

    fn valid_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(BUNDLE_CONTENT_TYPE));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("1024"));
        headers.insert(
            &RELAY_CHECKSUM,
            HeaderValue::from_str(&BASE64.encode([0x42; 32])).unwrap(),
        );
        headers
    }

    fn status(headers: &HeaderMap) -> StatusCode {
        relay_body_metadata(headers, &RequestId::generate(), SINGLE_UPLOAD)
            .unwrap_err()
            .into_response()
            .status()
    }

    #[test]
    fn relay_headers_are_exact_and_bounded_before_body_admission() {
        let valid = valid_headers();
        let metadata = relay_body_metadata(&valid, &RequestId::generate(), SINGLE_UPLOAD).unwrap();
        assert_eq!(metadata.length, 1024);
        assert_eq!(metadata.checksum, [0x42; 32]);

        let mut cases = Vec::new();
        let mut missing_length = valid.clone();
        missing_length.remove(CONTENT_LENGTH);
        cases.push((missing_length, StatusCode::UNPROCESSABLE_ENTITY));
        let mut duplicate_length = valid.clone();
        duplicate_length.append(CONTENT_LENGTH, HeaderValue::from_static("1024"));
        cases.push((duplicate_length, StatusCode::UNPROCESSABLE_ENTITY));
        let mut leading_zero_length = valid.clone();
        leading_zero_length.insert(CONTENT_LENGTH, HeaderValue::from_static("01024"));
        cases.push((leading_zero_length, StatusCode::UNPROCESSABLE_ENTITY));
        let mut oversized = valid.clone();
        oversized.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&(MAX_RELAY_BODY_BYTES + 1).to_string()).unwrap(),
        );
        cases.push((oversized, StatusCode::PAYLOAD_TOO_LARGE));
        let mut encoded = valid.clone();
        encoded.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        cases.push((encoded, StatusCode::UNSUPPORTED_MEDIA_TYPE));
        let mut chunked = valid.clone();
        chunked.insert(TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
        cases.push((chunked, StatusCode::UNSUPPORTED_MEDIA_TYPE));
        let mut wrong_type = valid.clone();
        wrong_type.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        cases.push((wrong_type, StatusCode::UNSUPPORTED_MEDIA_TYPE));
        let mut malformed_checksum = valid.clone();
        malformed_checksum.insert(&RELAY_CHECKSUM, HeaderValue::from_static("not-base64"));
        cases.push((malformed_checksum, StatusCode::UNPROCESSABLE_ENTITY));
        let mut duplicate_checksum = valid;
        duplicate_checksum.append(
            &RELAY_CHECKSUM,
            HeaderValue::from_str(&BASE64.encode([0x42; 32])).unwrap(),
        );
        cases.push((duplicate_checksum, StatusCode::UNPROCESSABLE_ENTITY));

        for (headers, expected) in cases {
            assert_eq!(status(&headers), expected);
        }
    }

    #[tokio::test]
    async fn relay_reader_slices_one_large_upstream_frame_without_rejecting_it() {
        const FRAME_BYTES: usize = 16 * 1024 * 1024;

        let polls = Arc::new(AtomicUsize::new(0));
        let body = Body::new(ObservedFrames {
            frames: VecDeque::from([
                Bytes::from(vec![0x5a; FRAME_BYTES]),
                Bytes::from_static(b"tail"),
            ]),
            polls: Arc::clone(&polls),
        });
        let mut reader = RequestBodyReader::new(body);
        let mut output = vec![0; RELAY_READ_CHUNK_BYTES * 2];
        let mut total = 0;
        let mut reads = 0;
        while total < FRAME_BYTES {
            let count = reader.read(&mut output).await.unwrap();
            assert!(count <= RELAY_READ_CHUNK_BYTES);
            assert!(output[..count].iter().all(|byte| *byte == 0x5a));
            total += count;
            reads += 1;
            assert_eq!(polls.load(Ordering::SeqCst), 1);
        }
        assert_eq!(total, FRAME_BYTES);
        assert_eq!(reads, FRAME_BYTES / RELAY_READ_CHUNK_BYTES);

        let count = reader.read(&mut output).await.unwrap();
        assert_eq!(&output[..count], b"tail");
        assert_eq!(polls.load(Ordering::SeqCst), 2);
        assert_eq!(reader.read(&mut output).await.unwrap(), 0);
        assert_eq!(polls.load(Ordering::SeqCst), 3);
    }
}
