use std::str::FromStr;
use std::time::Duration;

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Request, State};
use axum::http::header::{CONTENT_TYPE, COOKIE};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{ActivationInvitationId, BrowserMethod, BrowserRequestHeaders};

use super::service::{
    ActivationInput, InvitationHttpService, InvitationHttpServiceError, InvitationView,
    IssuedInvitationView,
};

const COLLECTION_PATH: &str = "/api/v1/admin/activation-invitations";
const ITEM_PATH: &str = "/api/v1/admin/activation-invitations/{invitation_id}";
const REISSUE_PATH: &str = "/api/v1/admin/activation-invitations/{invitation_id}/reissue";
const ACTIVATION_PATH: &str = "/api/v1/auth/activation";
const MAX_ADMIN_BODY_BYTES: usize = 2 * 1024;
const MAX_ACTIVATION_BODY_BYTES: usize = 4 * 1024;
const MIN_EXPIRY_SECONDS: u64 = 60 * 60;
const MAX_EXPIRY_SECONDS: u64 = 30 * 24 * 60 * 60;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<InvitationHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(issue_invitation, list_invitations))
        .routes(routes!(revoke_invitation))
        .routes(routes!(reissue_invitation))
        .routes(routes!(activate_invitation))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct IssueRequest {
    #[schema(max_length = 320, example = "member@example.test")]
    email: String,
    #[schema(minimum = 3600, maximum = 2592000, example = 604800)]
    expires_in_seconds: Option<u64>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ReissueRequest {
    #[schema(minimum = 3600, maximum = 2592000, example = 604800)]
    expires_in_seconds: Option<u64>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ActivationRequest {
    #[schema(max_length = 51, format = Password)]
    token: String,
    #[schema(max_length = 320, example = "member@example.test")]
    email: String,
    #[schema(max_length = 200, example = "Invited member")]
    display_name: String,
    #[schema(max_length = 1024, format = Password)]
    password: String,
}

#[derive(Serialize, ToSchema)]
struct InvitationListResponse {
    items: Vec<InvitationView>,
}

#[utoipa::path(
    post,
    path = "/api/v1/admin/activation-invitations",
    tag = "invitations",
    request_body(content = IssueRequest, content_type = "application/json"),
    responses(
        (status = 201, description = "Invitation issued; delivery is either a copy-once activation URL or queued email", body = IssuedInvitationView),
        (status = 401, description = "Active Session required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, description = "Instance Administrator, exact Origin and CSRF required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, description = "Invalid or conflicting invitation request", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn issue_invitation(
    State(service): State<InvitationHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = RequestHeaders::read(&parts.headers, &request_id, COLLECTION_PATH)?;
    let input: IssueRequest = json_body(
        &parts.headers,
        body,
        MAX_ADMIN_BODY_BYTES,
        &request_id,
        COLLECTION_PATH,
    )
    .await?;
    let expiry = expiry(input.expires_in_seconds, &request_id, COLLECTION_PATH)?;
    let view = service
        .issue(
            headers.browser(BrowserMethod::Post),
            input.email,
            expiry,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_service_error(error, request_id.clone(), COLLECTION_PATH))?;
    Ok((StatusCode::CREATED, Json(view)).into_response())
}

#[utoipa::path(
    get,
    path = "/api/v1/admin/activation-invitations",
    tag = "invitations",
    responses(
        (status = 200, description = "Bounded safe invitation metadata without activation credentials", body = InvitationListResponse),
        (status = 401, description = "Active Session required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, description = "Instance Administrator required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn list_invitations(
    State(service): State<InvitationHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Json<InvitationListResponse>, HttpError> {
    let headers = RequestHeaders::read(request.headers(), &request_id, COLLECTION_PATH)?;
    let items = service
        .list(headers.browser(BrowserMethod::Get))
        .await
        .map_err(|error| map_service_error(error, request_id.clone(), COLLECTION_PATH))?;
    Ok(Json(InvitationListResponse { items }))
}

#[utoipa::path(
    post,
    path = "/api/v1/admin/activation-invitations/{invitation_id}/reissue",
    tag = "invitations",
    params(("invitation_id" = String, Path, description = "UUIDv7 invitation identifier")),
    request_body(content = ReissueRequest, content_type = "application/json"),
    responses(
        (status = 200, description = "Replacement issued; delivery is either a copy-once activation URL or queued email", body = IssuedInvitationView),
        (status = 403, description = "Administrator browser security policy rejected the request", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, description = "Invitation is inactive or request is invalid", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn reissue_invitation(
    State(service): State<InvitationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Json<IssuedInvitationView>, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = RequestHeaders::read(&parts.headers, &request_id, REISSUE_PATH)?;
    let input: ReissueRequest = json_body(
        &parts.headers,
        body,
        MAX_ADMIN_BODY_BYTES,
        &request_id,
        REISSUE_PATH,
    )
    .await?;
    let id = parse_id(&id, &request_id, REISSUE_PATH)?;
    let expiry = expiry(input.expires_in_seconds, &request_id, REISSUE_PATH)?;
    let view = service
        .reissue(
            headers.browser(BrowserMethod::Post),
            id,
            expiry,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_service_error(error, request_id.clone(), REISSUE_PATH))?;
    Ok(Json(view))
}

#[utoipa::path(
    delete,
    path = "/api/v1/admin/activation-invitations/{invitation_id}",
    tag = "invitations",
    params(("invitation_id" = String, Path, description = "UUIDv7 invitation identifier")),
    responses(
        (status = 204, description = "Invitation revoked or already inactive"),
        (status = 403, description = "Administrator browser security policy rejected the request", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn revoke_invitation(
    State(service): State<InvitationHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Request,
) -> Result<StatusCode, HttpError> {
    let headers = RequestHeaders::read(request.headers(), &request_id, ITEM_PATH)?;
    let id = parse_id(&id, &request_id, ITEM_PATH)?;
    service
        .revoke(
            headers.browser(BrowserMethod::Delete),
            id,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_service_error(error, request_id, ITEM_PATH))?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/activation",
    tag = "invitations",
    request_body(content = ActivationRequest, content_type = "application/json"),
    responses(
        (status = 204, description = "Account and Personal Workspace activated; no Session is created"),
        (status = 403, description = "Exact canonical Origin required", body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, description = "Activation input or invitation is invalid", body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn activate_invitation(
    State(service): State<InvitationHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<StatusCode, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = RequestHeaders::read(&parts.headers, &request_id, ACTIVATION_PATH)?;
    let input: ActivationRequest = json_body(
        &parts.headers,
        body,
        MAX_ACTIVATION_BODY_BYTES,
        &request_id,
        ACTIVATION_PATH,
    )
    .await?;
    validate_activation(&input, &request_id)?;
    service
        .activate(
            &headers.origins,
            ActivationInput {
                token: input.token,
                email: input.email,
                display_name: input.display_name,
                password: input.password.into_bytes(),
            },
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_service_error(error, request_id, ACTIVATION_PATH))?;
    Ok(StatusCode::NO_CONTENT)
}

struct RequestHeaders<'a> {
    origins: Vec<&'a str>,
    cookies: Vec<&'a str>,
    csrf: Vec<&'a str>,
}

impl<'a> RequestHeaders<'a> {
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

    fn browser(&self, method: BrowserMethod) -> BrowserRequestHeaders<'_> {
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
    limit: usize,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    require_json(headers, request_id, path)?;
    let body = to_bytes(body, limit)
        .await
        .map_err(|_| HttpError::payload_too_large(request_id.clone(), path))?;
    serde_json::from_slice(&body).map_err(|_| {
        HttpError::validation(
            request_id.clone(),
            path,
            [FieldViolation::new(
                "body",
                "INVALID_JSON",
                "The JSON body is invalid.",
            )],
        )
    })
}

fn require_json(headers: &HeaderMap, request_id: &RequestId, path: &str) -> Result<(), HttpError> {
    let values = headers.get_all(CONTENT_TYPE).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    };
    let value = value
        .to_str()
        .map_err(|_| HttpError::unsupported_media_type(request_id.clone(), path))?;
    if !value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim_matches(' ')
        .eq_ignore_ascii_case("application/json")
    {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    }
    Ok(())
}

fn header_values<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<Vec<&'a str>, ()> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().map_err(|_| ()))
        .collect()
}

fn expiry(
    value: Option<u64>,
    request_id: &RequestId,
    path: &str,
) -> Result<Option<Duration>, HttpError> {
    let Some(seconds) = value else {
        return Ok(None);
    };
    if !(MIN_EXPIRY_SECONDS..=MAX_EXPIRY_SECONDS).contains(&seconds) {
        return Err(HttpError::validation(
            request_id.clone(),
            path,
            [FieldViolation::new(
                "expires_in_seconds",
                "OUT_OF_RANGE",
                "Expiry must be between one hour and thirty days.",
            )],
        ));
    }
    Ok(Some(Duration::from_secs(seconds)))
}

fn parse_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<ActivationInvitationId, HttpError> {
    ActivationInvitationId::from_str(value).map_err(|_| {
        HttpError::validation(
            request_id.clone(),
            path,
            [FieldViolation::new(
                "invitation_id",
                "INVALID",
                "Invitation identifier is invalid.",
            )],
        )
    })
}

fn validate_activation(input: &ActivationRequest, request_id: &RequestId) -> Result<(), HttpError> {
    let email_valid = (3..=320).contains(&input.email.chars().count())
        && input.email == input.email.trim_matches(' ')
        && !input.email.chars().any(char::is_control);
    let display_valid = (1..=200).contains(&input.display_name.trim_matches(' ').chars().count())
        && !input.display_name.chars().any(char::is_control);
    let password_valid = (1..=1024).contains(&input.password.len());
    let token_valid = input.token.len() == 51;
    if email_valid && display_valid && password_valid && token_valid {
        return Ok(());
    }
    let mut errors = Vec::new();
    if !token_valid {
        errors.push(FieldViolation::new(
            "token",
            "INVALID",
            "Activation credential is invalid.",
        ));
    }
    if !email_valid {
        errors.push(FieldViolation::new("email", "INVALID", "Email is invalid."));
    }
    if !display_valid {
        errors.push(FieldViolation::new(
            "display_name",
            "INVALID",
            "Display name is invalid.",
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
        ACTIVATION_PATH,
        errors,
    ))
}

fn map_service_error(
    error: InvitationHttpServiceError,
    request_id: RequestId,
    path: &str,
) -> HttpError {
    match error {
        InvitationHttpServiceError::AuthenticationFailed => {
            HttpError::authentication(request_id, path)
        }
        InvitationHttpServiceError::RequestForbidden => HttpError::forbidden(request_id, path),
        InvitationHttpServiceError::Conflict | InvitationHttpServiceError::InvalidInvitation => {
            HttpError::validation(
                request_id,
                path,
                [FieldViolation::new(
                    "invitation",
                    "INVALID",
                    "Invitation cannot be used.",
                )],
            )
        }
        InvitationHttpServiceError::Unavailable
        | InvitationHttpServiceError::OperationTimeout
        | InvitationHttpServiceError::Configuration
        | InvitationHttpServiceError::Internal => HttpError::internal(request_id, path),
    }
}
