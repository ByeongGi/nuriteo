use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Request, State};
use axum::http::header::{CONTENT_TYPE, COOKIE, SET_COOKIE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders, IssuedBrowserCookies};

use super::service::{AuthService, AuthServiceError, MeView};

const CREATE_SESSION_PATH: &str = "/api/v1/auth/sessions";
const SESSION_PATH: &str = "/api/v1/auth/session";
const ME_PATH: &str = "/api/v1/me";
const MAX_LOGIN_BODY_BYTES: usize = 4 * 1024;
const MAX_EMAIL_BYTES: usize = 320;
const MAX_PASSWORD_BYTES: usize = 1024;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

pub(crate) fn openapi_router(document: utoipa::openapi::OpenApi) -> OpenApiRouter<AuthService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(create_session))
        .routes(routes!(delete_session))
        .routes(routes!(current_user))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct LoginRequest {
    #[schema(max_length = 320, example = "admin@example.test")]
    email: String,
    #[schema(max_length = 1024, format = Password)]
    password: String,
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/sessions",
    tag = "authentication",
    request_body(content = LoginRequest, content_type = "application/json"),
    params(("Origin" = String, Header, description = "Exact configured canonical origin")),
    responses(
        (status = 204, description = "Session created; returns separate Session and CSRF Set-Cookie headers"),
        (status = 401, description = "Generic local authentication failure", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, description = "Origin security policy rejected the request", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, description = "Request body exceeds the bounded limit", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, description = "Request is not singular application/json", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, description = "Request fields are invalid", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn create_session(
    State(service): State<AuthService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    require_json(&parts.headers, &request_id, CREATE_SESSION_PATH)?;
    let origins = header_values(&parts.headers, &ORIGIN)
        .map_err(|_| HttpError::forbidden(request_id.clone(), CREATE_SESSION_PATH))?;
    let body = to_bytes(body, MAX_LOGIN_BODY_BYTES)
        .await
        .map_err(|_| HttpError::payload_too_large(request_id.clone(), CREATE_SESSION_PATH))?;
    let input: LoginRequest = serde_json::from_slice(&body).map_err(|_| {
        HttpError::validation(
            request_id.clone(),
            CREATE_SESSION_PATH,
            [FieldViolation::new(
                "body",
                "INVALID_JSON",
                "The JSON body is invalid.",
            )],
        )
    })?;
    let (email, password) = validate_login(input, &request_id)?;
    let result = service
        .login(email, password, &origins, request_id.as_str())
        .await
        .map_err(|error| map_service_error(error, request_id.clone(), CREATE_SESSION_PATH))?;
    response_with_cookies(
        StatusCode::NO_CONTENT,
        result.cookies,
        request_id,
        CREATE_SESSION_PATH,
    )
}

#[utoipa::path(
    delete,
    path = "/api/v1/auth/session",
    tag = "authentication",
    params(
        ("Origin" = String, Header, description = "Exact configured canonical origin"),
        ("X-CSRF-Token" = String, Header, description = "Exact double-submit CSRF credential")
    ),
    responses(
        (status = 204, description = "Session revoked or already inactive; returns separate deletion Set-Cookie headers"),
        (status = 403, description = "Origin, CSRF or cookie security policy rejected the request", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn delete_session(
    State(service): State<AuthService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let origins = header_values(request.headers(), &ORIGIN)
        .map_err(|_| HttpError::forbidden(request_id.clone(), SESSION_PATH))?;
    let cookies = header_values(request.headers(), &COOKIE)
        .map_err(|_| HttpError::forbidden(request_id.clone(), SESSION_PATH))?;
    let csrf = header_values(request.headers(), &CSRF)
        .map_err(|_| HttpError::forbidden(request_id.clone(), SESSION_PATH))?;
    let deletion = service
        .logout(
            BrowserRequestHeaders {
                method: BrowserMethod::Delete,
                origins: &origins,
                cookie_headers: &cookies,
                csrf_headers: &csrf,
            },
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_service_error(error, request_id.clone(), SESSION_PATH))?;
    response_with_cookies(StatusCode::NO_CONTENT, deletion, request_id, SESSION_PATH)
}

#[utoipa::path(
    get,
    path = "/api/v1/me",
    tag = "authentication",
    responses(
        (status = 200, description = "Current active User and safe Session metadata", body = MeView),
        (status = 401, description = "Session is missing, invalid, expired or revoked", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn current_user(
    State(service): State<AuthService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Json<MeView>, HttpError> {
    let cookies = header_values(request.headers(), &COOKIE)
        .map_err(|_| HttpError::authentication(request_id.clone(), ME_PATH))?;
    let view = service
        .me(BrowserRequestHeaders {
            method: BrowserMethod::Get,
            origins: &[],
            cookie_headers: &cookies,
            csrf_headers: &[],
        })
        .await
        .map_err(|error| map_service_error(error, request_id.clone(), ME_PATH))?;
    Ok(Json(view))
}

fn require_json(headers: &HeaderMap, request_id: &RequestId, path: &str) -> Result<(), HttpError> {
    let values = headers.get_all(CONTENT_TYPE).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    };
    let value = value
        .to_str()
        .map_err(|_| HttpError::unsupported_media_type(request_id.clone(), path))?;
    let media_type = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim_matches(' ');
    if !media_type.eq_ignore_ascii_case("application/json") {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    }
    Ok(())
}

fn validate_login(
    input: LoginRequest,
    request_id: &RequestId,
) -> Result<(String, Vec<u8>), HttpError> {
    let email_valid = (3..=MAX_EMAIL_BYTES).contains(&input.email.len())
        && input.email == input.email.trim_matches(' ')
        && !input.email.chars().any(char::is_control);
    let password = input.password.into_bytes();
    let password_valid = (1..=MAX_PASSWORD_BYTES).contains(&password.len());
    if email_valid && password_valid {
        return Ok((input.email.to_lowercase(), password));
    }
    let mut errors = Vec::with_capacity(2);
    if !email_valid {
        errors.push(FieldViolation::new(
            "email",
            "INVALID",
            "Email must be a bounded valid identifier.",
        ));
    }
    if !password_valid {
        errors.push(FieldViolation::new(
            "password",
            "INVALID",
            "Password length is invalid.",
        ));
    }
    Err(HttpError::validation(
        request_id.clone(),
        CREATE_SESSION_PATH,
        errors,
    ))
}

fn header_values<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<Vec<&'a str>, ()> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().map_err(|_| ()))
        .collect()
}

fn response_with_cookies(
    status: StatusCode,
    cookies: IssuedBrowserCookies,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let (session, csrf) = cookies.into_headers();
    let session = HeaderValue::from_str(session.expose())
        .map_err(|_| HttpError::internal(request_id.clone(), path))?;
    let csrf =
        HeaderValue::from_str(csrf.expose()).map_err(|_| HttpError::internal(request_id, path))?;
    let mut response = (status, Body::empty()).into_response();
    response.headers_mut().append(SET_COOKIE, session);
    response.headers_mut().append(SET_COOKIE, csrf);
    Ok(response)
}

fn map_service_error(error: AuthServiceError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        AuthServiceError::AuthenticationFailed => HttpError::authentication(request_id, path),
        AuthServiceError::RequestForbidden => HttpError::forbidden(request_id, path),
        AuthServiceError::Unavailable
        | AuthServiceError::OperationTimeout
        | AuthServiceError::Internal => HttpError::internal(request_id, path),
    }
}
