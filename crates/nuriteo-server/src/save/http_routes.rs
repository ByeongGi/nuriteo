use std::str::FromStr;

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, de::DeserializeOwned};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders, UserId};
use crate::organization::OrganizationId;
use crate::project::{ProjectId, ProjectOwner, ProjectVersion};
use crate::quota::SaveSessionId;

use super::IdempotencyKey;
use super::http_service::{
    CommitView, ReconcileView, SaveCreateInput, SaveHttpError, SaveHttpService, SavePartInput,
    SaveReceiptInput, SaveSessionView, UploadCapabilityView,
};

const COLLECTION: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions";
const ITEM: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}";
const PARTS: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/parts";
const RECEIPTS: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/parts/receipts";
const COMPLETE: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/complete";
const RECONCILE: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/reconcile";
const MAX_BODY: usize = 64 * 1024;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");
const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");

pub(crate) fn openapi_router(document: utoipa::openapi::OpenApi) -> OpenApiRouter<SaveHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(create_session))
        .routes(routes!(issue_parts))
        .routes(routes!(record_receipts))
        .routes(routes!(complete_session))
        .routes(routes!(reconcile_session))
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
