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
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use uuid::Uuid;

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders};

use super::http_service::IntegrationCaHttpError;
use super::{IntegrationCaCollectionView, IntegrationCaHttpService, IntegrationCaView};

const COLLECTION: &str = "/api/v1/admin/integrations/{integrationType}/{integrationId}/ca";
const CANDIDATES: &str =
    "/api/v1/admin/integrations/{integrationType}/{integrationId}/ca/candidates";
const ACTIVATE: &str = "/api/v1/admin/integrations/{integrationType}/{integrationId}/ca/candidates/{candidateId}/activate";
const MAX_BODY_BYTES: usize = 1_100_000;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");
const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<IntegrationCaHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(list))
        .routes(routes!(stage))
        .routes(routes!(activate))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct StageRequest {
    #[schema(max_length = 1048576)]
    pem: String,
}

#[utoipa::path(get, path=COLLECTION, tag="integration-ca-administration", security(("projectSessionCookie"=[])), responses((status=200, body=IntegrationCaCollectionView)))]
async fn list(
    State(service): State<IntegrationCaHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((integration_type, integration_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(&headers, &request_id, COLLECTION)?;
    let value = service
        .list(
            browser.request(BrowserMethod::Get),
            &integration_type,
            &integration_id,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), COLLECTION))?;
    response(
        StatusCode::OK,
        value.version,
        Json(value).into_response(),
        request_id,
        COLLECTION,
    )
}

#[utoipa::path(post, path=CANDIDATES, tag="integration-ca-administration", security(("projectSessionCookie"=[])), params(
    ("if-match" = String, Header, description = "Strong integration CA version validator"),
    ("idempotency-key" = String, Header, description = "Replay-safe mutation key"),
    ("x-csrf-token" = String, Header, description = "Browser CSRF credential"),
    ("origin" = String, Header, description = "Exact configured browser origin")
), request_body=StageRequest, responses((status=201, body=IntegrationCaView)))]
async fn stage(
    State(service): State<IntegrationCaHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((integration_type, integration_id)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let browser = BrowserHeaders::read(&parts.headers, &request_id, CANDIDATES)?;
    let version = version(&parts.headers, &request_id, CANDIDATES)?;
    let idempotency = idempotency_key(&parts.headers, &request_id, CANDIDATES)?;
    let value: StageRequest = json(&parts.headers, body, &request_id, CANDIDATES).await?;
    let output = service
        .stage(
            browser.request(BrowserMethod::Post),
            &integration_type,
            &integration_id,
            version,
            value.pem.into_bytes(),
            idempotency,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), CANDIDATES))?;
    response(
        StatusCode::CREATED,
        output.version,
        Json(output).into_response(),
        request_id,
        CANDIDATES,
    )
}

#[utoipa::path(post, path=ACTIVATE, tag="integration-ca-administration", security(("projectSessionCookie"=[])), params(
    ("if-match" = String, Header, description = "Strong integration CA candidate version validator"),
    ("idempotency-key" = String, Header, description = "Replay-safe mutation key"),
    ("x-csrf-token" = String, Header, description = "Browser CSRF credential"),
    ("origin" = String, Header, description = "Exact configured browser origin")
), responses((status=200, body=IntegrationCaView)))]
async fn activate(
    State(service): State<IntegrationCaHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((integration_type, integration_id, raw_candidate)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(&headers, &request_id, ACTIVATE)?;
    let version = version(&headers, &request_id, ACTIVATE)?;
    let idempotency = idempotency_key(&headers, &request_id, ACTIVATE)?;
    let candidate_id = Uuid::parse_str(&raw_candidate)
        .ok()
        .filter(|value| value.get_version_num() == 7 && !value.is_nil())
        .ok_or_else(|| validation(&request_id, ACTIVATE, "candidateId"))?;
    let output = service
        .activate(
            browser.request(BrowserMethod::Post),
            &integration_type,
            &integration_id,
            candidate_id,
            version,
            idempotency,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), ACTIVATE))?;
    response(
        StatusCode::OK,
        output.version,
        Json(output).into_response(),
        request_id,
        ACTIVATE,
    )
}

struct BrowserHeaders<'a> {
    origins: Vec<&'a str>,
    cookies: Vec<&'a str>,
    csrf: Vec<&'a str>,
}

impl<'a> BrowserHeaders<'a> {
    fn read(headers: &'a HeaderMap, request_id: &RequestId, path: &str) -> Result<Self, HttpError> {
        Ok(Self {
            origins: values(headers, &ORIGIN, request_id, path)?,
            cookies: values(headers, &COOKIE, request_id, path)?,
            csrf: values(headers, &CSRF, request_id, path)?,
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

fn values<'a>(
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

async fn json<T: serde::de::DeserializeOwned>(
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

fn version(headers: &HeaderMap, request_id: &RequestId, path: &str) -> Result<u64, HttpError> {
    let values = headers.get_all(IF_MATCH).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    };
    let value = value
        .to_str()
        .map_err(|_| HttpError::precondition_required(request_id.clone(), path))?;
    let parsed = value
        .strip_prefix("\"integration-ca-v")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value < i64::MAX as u64)
        .ok_or_else(|| HttpError::precondition_required(request_id.clone(), path))?;
    if value == format!("\"integration-ca-v{parsed}\"") {
        Ok(parsed)
    } else {
        Err(HttpError::precondition_required(request_id.clone(), path))
    }
}

fn idempotency_key<'a>(
    headers: &'a HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<&'a str, HttpError> {
    let values = headers.get_all(&IDEMPOTENCY_KEY).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(validation(request_id, path, "idempotency-key"));
    };
    value
        .to_str()
        .ok()
        .filter(|value| {
            (16..=128).contains(&value.len())
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                })
        })
        .ok_or_else(|| validation(request_id, path, "idempotency-key"))
}

fn response(
    status: StatusCode,
    version: u64,
    mut response: Response,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"integration-ca-v{version}\""))
            .map_err(|_| HttpError::internal(request_id, path))?,
    );
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

fn map_error(error: IntegrationCaHttpError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        IntegrationCaHttpError::AuthenticationFailed => HttpError::authentication(request_id, path),
        IntegrationCaHttpError::Forbidden => HttpError::forbidden(request_id, path),
        IntegrationCaHttpError::ReauthenticationRequired => {
            HttpError::reauthentication_required(request_id, path)
        }
        IntegrationCaHttpError::InvalidInput | IntegrationCaHttpError::PreflightFailed => {
            HttpError::validation(request_id, path, [])
        }
        IntegrationCaHttpError::NotFound => HttpError::not_found(request_id, path),
        IntegrationCaHttpError::Conflict => HttpError::precondition_failed(request_id, path),
        IntegrationCaHttpError::Unavailable => HttpError::service_unavailable(request_id, path),
    }
}
