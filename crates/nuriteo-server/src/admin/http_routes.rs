use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::Value;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders};

use super::{
    AdminHttpService, AdminHttpServiceError, AdminSettingListView, AdminSettingView,
    AdminStatusView,
};

const SETTINGS: &str = "/api/v1/admin/settings";
const SETTING: &str = "/api/v1/admin/settings/{key}";
const STATUS: &str = "/api/v1/admin/status";
const MAX_BODY_BYTES: usize = 2 * 1024;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<AdminHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(list_settings))
        .routes(routes!(update_setting))
        .routes(routes!(admin_status))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct UpdateSettingRequest {
    value: Value,
}

#[utoipa::path(
    get,
    path = SETTINGS,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    responses(
        (status = 200, body = AdminSettingListView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn list_settings(
    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, SETTINGS)?;
    let view = service
        .list_settings(headers.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, SETTINGS))?;
    Ok(private_no_store(Json(view).into_response()))
}

#[utoipa::path(
    patch,
    path = SETTING,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(
        ("key" = String, Path),
        ("If-Match" = String, Header),
        ("Origin" = String, Header),
        ("X-CSRF-Token" = String, Header)
    ),
    request_body(content = UpdateSettingRequest, content_type = "application/json"),
    responses(
        (status = 200, body = AdminSettingView, headers(("ETag" = String), ("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn update_setting(
    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(key): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, SETTING)?;
    let expected = parse_if_match(&parts.headers, &request_id, SETTING)?;
    let input: UpdateSettingRequest = json_body(&parts.headers, body, &request_id, SETTING).await?;
    let view = service
        .update_setting(
            headers.request(BrowserMethod::Patch),
            &key,
            input.value,
            expected,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), SETTING))?;
    setting_response(view, request_id, SETTING)
}

#[utoipa::path(
    get,
    path = STATUS,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    responses(
        (status = 200, body = AdminStatusView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn admin_status(
    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, STATUS)?;
    let view = service
        .status(headers.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, STATUS))?;
    Ok(private_no_store(Json(view).into_response()))
}

struct BrowserHeaders<'a> {
    origins: Vec<&'a str>,
    cookies: Vec<&'a str>,
    csrf: Vec<&'a str>,
}

impl<'a> BrowserHeaders<'a> {
    fn read(headers: &'a HeaderMap, request_id: &RequestId, path: &str) -> Result<Self, HttpError> {
        Ok(Self {
            origins: header_values(headers, &ORIGIN)
                .map_err(|_| HttpError::forbidden(request_id.clone(), path))?,
            cookies: header_values(headers, &COOKIE)
                .map_err(|_| HttpError::forbidden(request_id.clone(), path))?,
            csrf: header_values(headers, &CSRF)
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

async fn json_body<T: for<'de> Deserialize<'de>>(
    headers: &HeaderMap,
    body: Body,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    let content_types = headers.get_all(CONTENT_TYPE).iter().collect::<Vec<_>>();
    let [content_type] = content_types.as_slice() else {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    };
    if !content_type
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

fn parse_if_match(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<u64, HttpError> {
    let values = headers.get_all(IF_MATCH).iter().collect::<Vec<_>>();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    let [value] = values.as_slice() else {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    };
    value
        .to_str()
        .ok()
        .and_then(|value| value.strip_prefix("\"setting-v"))
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))
}

fn setting_response(
    view: AdminSettingView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let version = view.version;
    let mut response = private_no_store(Json(view).into_response());
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"setting-v{version}\""))
            .map_err(|_| HttpError::internal(request_id, path))?,
    );
    Ok(response)
}

fn private_no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

fn header_values<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<Vec<&'a str>, ()> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().map_err(|_| ()))
        .collect()
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

fn map_error(error: AdminHttpServiceError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        AdminHttpServiceError::AuthenticationFailed => HttpError::authentication(request_id, path),
        AdminHttpServiceError::Forbidden | AdminHttpServiceError::ReauthenticationRequired => {
            HttpError::forbidden(request_id, path)
        }
        AdminHttpServiceError::InvalidSetting => validation(&request_id, path, "value"),
        AdminHttpServiceError::SettingNotFound => HttpError::not_found(request_id, path),
        AdminHttpServiceError::PreconditionFailed => {
            HttpError::precondition_failed(request_id, path)
        }
        AdminHttpServiceError::OperationTimeout => HttpError::operation_timeout(request_id, path),
        AdminHttpServiceError::AuditUnavailable | AdminHttpServiceError::Unavailable => {
            HttpError::service_unavailable(request_id, path)
        }
        AdminHttpServiceError::Configuration | AdminHttpServiceError::Internal => {
            HttpError::internal(request_id, path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_etag_is_strong_exact_and_positive() {
        let request_id = RequestId::generate();
        let mut headers = HeaderMap::new();
        headers.insert(IF_MATCH, HeaderValue::from_static("\"setting-v7\""));
        assert_eq!(parse_if_match(&headers, &request_id, SETTING).unwrap(), 7);
        for invalid in ["*", "W/\"setting-v7\"", "\"setting-v0\"", "\"setting-vx\""] {
            headers.insert(IF_MATCH, HeaderValue::from_str(invalid).unwrap());
            assert!(parse_if_match(&headers, &request_id, SETTING).is_err());
        }
    }
}
