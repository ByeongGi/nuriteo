use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Query, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::future::Future;
use std::time::Duration;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use uuid::Uuid;

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders};

use super::{
    EmailDeliveryCollectionView, EmailDeliveryView, NotificationHttpService,
    NotificationHttpServiceError, NotificationInboxItemView, NotificationInboxView,
    NotificationPreferencesView,
};

const INBOX_PATH: &str = "/api/v1/notifications";
const NOTIFICATION_PATH: &str = "/api/v1/notifications/{notificationId}";
const PREFERENCES_PATH: &str = "/api/v1/notification-preferences";
const DELIVERIES_PATH: &str = "/api/v1/admin/email-deliveries";
const RETRY_PATH: &str = "/api/v1/admin/email-deliveries/{deliveryId}/retry";
const CANCEL_PATH: &str = "/api/v1/admin/email-deliveries/{deliveryId}/cancel";
const MAX_BODY_BYTES: usize = 2 * 1024;
const HTTP_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");
const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<NotificationHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(inbox))
        .routes(routes!(update_status))
        .routes(routes!(preferences, update_preferences))
        .routes(routes!(deliveries))
        .routes(routes!(retry_delivery))
        .routes(routes!(cancel_delivery))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InboxQuery {
    archived: Option<bool>,
    cursor: Option<String>,
    limit: Option<u16>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct NotificationStatusRequest {
    status: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NotificationPreferencesRequest {
    account_access: bool,
    collaboration: bool,
    operations: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryQuery {
    state: Option<String>,
    cursor: Option<String>,
    limit: Option<u16>,
}

#[utoipa::path(
    get,
    path = INBOX_PATH,
    tag = "notifications",
    security(("projectSessionCookie" = [])),
    params(
        ("archived" = Option<bool>, Query),
        ("cursor" = Option<String>, Query),
        ("limit" = Option<u16>, Query)
    ),
    responses(
        (status = 200, body = NotificationInboxView),
        (status = 401, body = crate::openapi::ProblemDetails),
        (status = 503, body = crate::openapi::ProblemDetails)
    )
)]
async fn inbox(
    State(service): State<NotificationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<InboxQuery>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, INBOX_PATH)?;
    let view = deadline(service.inbox(
        headers.request(BrowserMethod::Get),
        query.archived.unwrap_or(false),
        query.cursor.as_deref(),
        query.limit,
    ))
    .await
    .map_err(|error| map_error(error, request_id, INBOX_PATH))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(
    patch,
    path = NOTIFICATION_PATH,
    tag = "notifications",
    security(("projectSessionCookie" = [])),
    params(
        ("notificationId" = String, Path),
        ("If-Match" = String, Header),
        ("Origin" = String, Header),
        ("X-CSRF-Token" = String, Header)
    ),
    request_body(content = NotificationStatusRequest),
    responses(
        (status = 200, body = NotificationInboxItemView, headers(("ETag" = String))),
        (status = 412, body = crate::openapi::ProblemDetails)
    )
)]
async fn update_status(
    State(service): State<NotificationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, NOTIFICATION_PATH)?;
    let id = parse_uuid(&id, &request_id, NOTIFICATION_PATH, "notificationId")?;
    let version = parse_if_match(
        &parts.headers,
        "notification",
        &request_id,
        NOTIFICATION_PATH,
    )?;
    let input: NotificationStatusRequest =
        json_body(&parts.headers, body, &request_id, NOTIFICATION_PATH).await?;
    let view = deadline(service.update_status(
        headers.request(BrowserMethod::Patch),
        id,
        &input.status,
        version,
    ))
    .await
    .map_err(|error| map_error(error, request_id.clone(), NOTIFICATION_PATH))?;
    etag_json(
        view.version,
        "notification",
        view,
        request_id,
        NOTIFICATION_PATH,
    )
}

#[utoipa::path(
    get,
    path = PREFERENCES_PATH,
    tag = "notifications",
    security(("projectSessionCookie" = [])),
    responses((status = 200, body = NotificationPreferencesView, headers(("ETag" = String))))
)]
async fn preferences(
    State(service): State<NotificationHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, PREFERENCES_PATH)?;
    let view = deadline(service.preferences(headers.request(BrowserMethod::Get)))
        .await
        .map_err(|error| map_error(error, request_id.clone(), PREFERENCES_PATH))?;
    etag_json(
        view.version,
        "notification-preferences",
        view,
        request_id,
        PREFERENCES_PATH,
    )
}

#[utoipa::path(
    patch,
    path = PREFERENCES_PATH,
    tag = "notifications",
    security(("projectSessionCookie" = [])),
    params(
        ("If-Match" = String, Header),
        ("Origin" = String, Header),
        ("X-CSRF-Token" = String, Header)
    ),
    request_body(content = NotificationPreferencesRequest),
    responses(
        (status = 200, body = NotificationPreferencesView, headers(("ETag" = String))),
        (status = 412, body = crate::openapi::ProblemDetails)
    )
)]
async fn update_preferences(
    State(service): State<NotificationHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, PREFERENCES_PATH)?;
    let version = parse_if_match(
        &parts.headers,
        "notification-preferences",
        &request_id,
        PREFERENCES_PATH,
    )?;
    let input: NotificationPreferencesRequest =
        json_body(&parts.headers, body, &request_id, PREFERENCES_PATH).await?;
    let view = deadline(service.update_preferences(
        headers.request(BrowserMethod::Patch),
        input.account_access,
        input.collaboration,
        input.operations,
        version,
    ))
    .await
    .map_err(|error| map_error(error, request_id.clone(), PREFERENCES_PATH))?;
    etag_json(
        view.version,
        "notification-preferences",
        view,
        request_id,
        PREFERENCES_PATH,
    )
}

#[utoipa::path(
    get,
    path = DELIVERIES_PATH,
    tag = "notifications",
    security(("projectSessionCookie" = [])),
    params(
        ("state" = Option<String>, Query),
        ("cursor" = Option<String>, Query),
        ("limit" = Option<u16>, Query)
    ),
    responses(
        (status = 200, body = EmailDeliveryCollectionView),
        (status = 403, body = crate::openapi::ProblemDetails)
    )
)]
async fn deliveries(
    State(service): State<NotificationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<DeliveryQuery>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, DELIVERIES_PATH)?;
    let view = deadline(service.deliveries(
        headers.request(BrowserMethod::Get),
        query.state.as_deref(),
        query.cursor.as_deref(),
        query.limit,
    ))
    .await
    .map_err(|error| map_error(error, request_id, DELIVERIES_PATH))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(
    post,
    path = RETRY_PATH,
    tag = "notifications",
    security(("projectSessionCookie" = [])),
    params(
        ("deliveryId" = String, Path),
        ("If-Match" = String, Header),
        ("Idempotency-Key" = String, Header),
        ("Origin" = String, Header),
        ("X-CSRF-Token" = String, Header)
    ),
    responses((status = 200, body = EmailDeliveryView, headers(("ETag" = String))))
)]
async fn retry_delivery(
    State(service): State<NotificationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    delivery_mutation(service, request_id, id, request, true).await
}

#[utoipa::path(
    post,
    path = CANCEL_PATH,
    tag = "notifications",
    security(("projectSessionCookie" = [])),
    params(
        ("deliveryId" = String, Path),
        ("If-Match" = String, Header),
        ("Idempotency-Key" = String, Header),
        ("Origin" = String, Header),
        ("X-CSRF-Token" = String, Header)
    ),
    responses((status = 200, body = EmailDeliveryView, headers(("ETag" = String))))
)]
async fn cancel_delivery(
    State(service): State<NotificationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    delivery_mutation(service, request_id, id, request, false).await
}

async fn delivery_mutation(
    service: NotificationHttpService,
    request_id: RequestId,
    id: String,
    request: Request,
    retry: bool,
) -> Result<Response, HttpError> {
    let path = if retry { RETRY_PATH } else { CANCEL_PATH };
    let headers = BrowserHeaders::read(request.headers(), &request_id, path)?;
    let id = parse_uuid(&id, &request_id, path, "deliveryId")?;
    let version = parse_if_match(request.headers(), "email-delivery", &request_id, path)?;
    let idempotency_key = single_header(
        request.headers(),
        &IDEMPOTENCY_KEY,
        &request_id,
        path,
        "Idempotency-Key",
    )?;
    let view = if retry {
        deadline(service.retry_delivery(
            headers.request(BrowserMethod::Post),
            id,
            version,
            idempotency_key,
            request_id.as_str(),
        ))
        .await
    } else {
        deadline(service.cancel_delivery(
            headers.request(BrowserMethod::Post),
            id,
            version,
            idempotency_key,
            request_id.as_str(),
        ))
        .await
    }
    .map_err(|error| map_error(error, request_id.clone(), path))?;
    etag_json(view.version, "email-delivery", view, request_id, path)
}

async fn deadline<F, T>(future: F) -> Result<T, NotificationHttpServiceError>
where
    F: Future<Output = Result<T, NotificationHttpServiceError>>,
{
    tokio::time::timeout(HTTP_OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| NotificationHttpServiceError::Unavailable)
        .and_then(|result| result)
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
                .map_err(|()| HttpError::forbidden(request_id.clone(), path))?,
            cookies: header_values(headers, &COOKIE)
                .map_err(|()| HttpError::forbidden(request_id.clone(), path))?,
            csrf: header_values(headers, &CSRF)
                .map_err(|()| HttpError::forbidden(request_id.clone(), path))?,
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

fn header_values<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<Vec<&'a str>, ()> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().map_err(|_| ()))
        .collect()
}

fn single_header<'a>(
    headers: &'a HeaderMap,
    name: &HeaderName,
    request_id: &RequestId,
    path: &str,
    field: &str,
) -> Result<&'a str, HttpError> {
    let values = headers.get_all(name).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(validation(request_id, path, field));
    };
    value
        .to_str()
        .map_err(|_| validation(request_id, path, field))
}

fn parse_if_match(
    headers: &HeaderMap,
    resource: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<u64, HttpError> {
    let value = single_header(headers, &IF_MATCH, request_id, path, "If-Match")
        .map_err(|_| HttpError::precondition_required(request_id.clone(), path))?;
    let prefix = format!("\"{resource}-v");
    let version = value
        .strip_prefix(&prefix)
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|version| *version > 0 && *version < i64::MAX as u64)
        .ok_or_else(|| HttpError::precondition_required(request_id.clone(), path))?;
    (value == format!("\"{resource}-v{version}\""))
        .then_some(version)
        .ok_or_else(|| HttpError::precondition_required(request_id.clone(), path))
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

fn parse_uuid(
    value: &str,
    request_id: &RequestId,
    path: &str,
    field: &str,
) -> Result<Uuid, HttpError> {
    Uuid::parse_str(value).map_err(|_| validation(request_id, path, field))
}

fn etag_json<T: serde::Serialize>(
    version: u64,
    resource: &str,
    view: T,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let etag = HeaderValue::from_str(&format!("\"{resource}-v{version}\""))
        .map_err(|_| HttpError::internal(request_id, path))?;
    let mut response = no_store(Json(view).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
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

fn map_error(error: NotificationHttpServiceError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        NotificationHttpServiceError::AuthenticationFailed => {
            HttpError::authentication(request_id, path)
        }
        NotificationHttpServiceError::Forbidden
        | NotificationHttpServiceError::ReauthenticationRequired => {
            HttpError::forbidden(request_id, path)
        }
        NotificationHttpServiceError::InvalidInput => validation(&request_id, path, "body"),
        NotificationHttpServiceError::NotFound => HttpError::not_found(request_id, path),
        NotificationHttpServiceError::Conflict => HttpError::conflict(request_id, path),
        NotificationHttpServiceError::PreconditionFailed => {
            HttpError::precondition_failed(request_id, path)
        }
        NotificationHttpServiceError::CommitOutcomeUnknown => {
            HttpError::commit_outcome_unknown(request_id, path)
        }
        NotificationHttpServiceError::Unavailable => {
            HttpError::service_unavailable(request_id, path)
        }
        NotificationHttpServiceError::Internal => HttpError::internal(request_id, path),
    }
}
