use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Extension, Path, Query, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, SET_COOKIE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Deserializer};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders, IssuedBrowserCookies, UserId};

use super::{
    MfaEnrollmentCompleteView, MfaEnrollmentStartView, MfaHttpService, MfaHttpServiceError,
    MfaIdempotencyKey, MfaPolicyImpactView, MfaPolicyView, MfaResetTargetCollectionView,
    MfaStatusView, RotatedMfaResponse,
};

const STATUS_PATH: &str = "/api/v1/mfa";
const ENROLLMENT_PATH: &str = "/api/v1/mfa/enrollment";
const CONFIRM_PATH: &str = "/api/v1/mfa/enrollment/confirm";
const CHALLENGE_PATH: &str = "/api/v1/mfa/challenge";
const RECOVERY_PATH: &str = "/api/v1/mfa/recovery";
const POLICY_PATH: &str = "/api/v1/admin/mfa-policy";
const POLICY_PREVIEW_PATH: &str = "/api/v1/admin/mfa-policy/preview";
const RESET_PATH: &str = "/api/v1/admin/users/{userId}/mfa/reset";
const RESET_TARGETS_PATH: &str = "/api/v1/admin/mfa-reset-targets";
const MAX_BODY_BYTES: usize = 2 * 1024;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");
const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");

pub(crate) fn openapi_router(document: utoipa::openapi::OpenApi) -> OpenApiRouter<MfaHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(status))
        .routes(routes!(begin_enrollment, disable))
        .routes(routes!(confirm_enrollment))
        .routes(routes!(challenge))
        .routes(routes!(recover))
        .routes(routes!(policy, update_policy))
        .routes(routes!(preview_policy))
        .routes(routes!(reset_targets))
        .routes(routes!(admin_reset))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ConfirmationRequest {
    credential_id: String,
    code: SecretInput,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct CodeRequest {
    code: SecretInput,
}

#[derive(ToSchema)]
#[schema(value_type = String)]
struct SecretInput(Zeroizing<String>);

impl SecretInput {
    fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }

    fn into_bytes(self) -> Vec<u8> {
        self.0.as_bytes().to_vec()
    }
}

impl<'de> Deserialize<'de> for SecretInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(|value| Self(Zeroizing::new(value)))
    }
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PolicyRequest {
    mode: String,
    grace_period_days: u16,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PolicyUpdateRequest {
    mode: String,
    grace_period_days: u16,
    population_proof: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResetRequest {
    credential_generation: String,
    confirmation: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetTargetQuery {
    query: String,
}

#[utoipa::path(get, path = STATUS_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
responses((status=200, body=MfaStatusView), (status=401, body=crate::openapi::ProblemDetails)))]
async fn status(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, STATUS_PATH)?;
    let view = service
        .status(headers.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, STATUS_PATH))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(post, path = ENROLLMENT_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("Idempotency-Key"=String, Header), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)),
responses((status=200, body=MfaEnrollmentStartView), (status=403, body=crate::openapi::ProblemDetails)))]
async fn begin_enrollment(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, ENROLLMENT_PATH)?;
    let idempotency_key = parse_idempotency_key(request.headers(), &request_id, ENROLLMENT_PATH)?;
    let view = service
        .begin_enrollment(
            headers.request(BrowserMethod::Post),
            &idempotency_key,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, ENROLLMENT_PATH))?;
    Ok(no_store(Json(view).into_response()))
}

#[utoipa::path(delete, path = ENROLLMENT_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("Origin"=String, Header), ("X-CSRF-Token"=String, Header)),
responses((status=204), (status=403, body=crate::openapi::ProblemDetails)))]
async fn disable(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, ENROLLMENT_PATH)?;
    let result = service
        .disable(headers.request(BrowserMethod::Delete), request_id.as_str())
        .await
        .map_err(|error| map_error(error, request_id.clone(), ENROLLMENT_PATH))?;
    rotated_empty(result, request_id, ENROLLMENT_PATH)
}

#[utoipa::path(post, path = CONFIRM_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("Idempotency-Key"=String, Header), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)), request_body(content=ConfirmationRequest), responses((status=200, body=MfaEnrollmentCompleteView), (status=422, body=crate::openapi::ProblemDetails)))]
async fn confirm_enrollment(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, CONFIRM_PATH)?;
    let idempotency_key = parse_idempotency_key(&parts.headers, &request_id, CONFIRM_PATH)?;
    let input: ConfirmationRequest =
        json_body(&parts.headers, body, &request_id, CONFIRM_PATH).await?;
    let credential_id = Uuid::parse_str(&input.credential_id)
        .map_err(|_| validation(&request_id, CONFIRM_PATH, "credentialId"))?;
    let result = service
        .confirm_enrollment(
            headers.request(BrowserMethod::Post),
            credential_id,
            input.code.as_bytes(),
            &idempotency_key,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), CONFIRM_PATH))?;
    rotated_json(result, request_id, CONFIRM_PATH)
}

#[utoipa::path(post, path = CHALLENGE_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("Idempotency-Key"=String, Header), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)), request_body(content=CodeRequest), responses((status=204), (status=401, body=crate::openapi::ProblemDetails)))]
async fn challenge(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    code_mutation(service, request_id, request, CHALLENGE_PATH, false).await
}

#[utoipa::path(post, path = RECOVERY_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("Idempotency-Key"=String, Header), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)), request_body(content=CodeRequest), responses((status=204), (status=401, body=crate::openapi::ProblemDetails)))]
async fn recover(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    code_mutation(service, request_id, request, RECOVERY_PATH, true).await
}

async fn code_mutation(
    service: MfaHttpService,
    request_id: RequestId,
    request: Request,
    path: &'static str,
    recovery: bool,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, path)?;
    let idempotency_key = parse_idempotency_key(&parts.headers, &request_id, path)?;
    let input: CodeRequest = json_body(&parts.headers, body, &request_id, path).await?;
    let result = if recovery {
        service
            .recover(
                headers.request(BrowserMethod::Post),
                input.code.into_bytes(),
                &idempotency_key,
                request_id.as_str(),
            )
            .await
    } else {
        service
            .challenge(
                headers.request(BrowserMethod::Post),
                input.code.as_bytes(),
                &idempotency_key,
                request_id.as_str(),
            )
            .await
    }
    .map_err(|error| map_error(error, request_id.clone(), path))?;
    rotated_empty(result, request_id, path)
}

#[utoipa::path(get, path = POLICY_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
responses((status=200, body=MfaPolicyView, headers(("ETag"=String), ("Cache-Control"=String))), (status=403, body=crate::openapi::ProblemDetails)))]
async fn policy(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, POLICY_PATH)?;
    let view = service
        .policy(headers.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id.clone(), POLICY_PATH))?;
    policy_json(view, request_id, POLICY_PATH)
}

#[utoipa::path(patch, path = POLICY_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("If-Match"=String, Header), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)),
request_body(content=PolicyUpdateRequest), responses((status=200, body=MfaPolicyView, headers(("ETag"=String), ("Cache-Control"=String))), (status=412, body=crate::openapi::ProblemDetails)))]
async fn update_policy(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, POLICY_PATH)?;
    let expected = parse_if_match(&parts.headers, &request_id, POLICY_PATH)?;
    let input: PolicyUpdateRequest =
        json_body(&parts.headers, body, &request_id, POLICY_PATH).await?;
    let view = service
        .update_policy(
            headers.request(BrowserMethod::Patch),
            &input.mode,
            input.grace_period_days,
            expected,
            &input.population_proof,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), POLICY_PATH))?;
    policy_json(view, request_id, POLICY_PATH)
}

#[utoipa::path(post, path = POLICY_PREVIEW_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("If-Match"=String, Header), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)),
request_body(content=PolicyRequest), responses((status=200, body=MfaPolicyImpactView, headers(("ETag"=String), ("Cache-Control"=String))), (status=412, body=crate::openapi::ProblemDetails)))]
async fn preview_policy(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, POLICY_PREVIEW_PATH)?;
    let expected = parse_if_match(&parts.headers, &request_id, POLICY_PREVIEW_PATH)?;
    let input: PolicyRequest =
        json_body(&parts.headers, body, &request_id, POLICY_PREVIEW_PATH).await?;
    let view = service
        .preview_policy(
            headers.request(BrowserMethod::Post),
            &input.mode,
            input.grace_period_days,
            expected,
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), POLICY_PREVIEW_PATH))?;
    impact_json(view, request_id, POLICY_PREVIEW_PATH)
}

#[utoipa::path(post, path = RESET_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("userId"=String, Path), ("Origin"=String, Header), ("X-CSRF-Token"=String, Header)), request_body(content=ResetRequest), responses((status=204), (status=403, body=crate::openapi::ProblemDetails), (status=412, body=crate::openapi::ProblemDetails)))]
async fn admin_reset(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(user_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, RESET_PATH)?;
    let input: ResetRequest = json_body(&parts.headers, body, &request_id, RESET_PATH).await?;
    let target = user_id
        .parse::<UserId>()
        .map_err(|_| validation(&request_id, RESET_PATH, "userId"))?;
    let generation = Uuid::parse_str(&input.credential_generation)
        .map_err(|_| validation(&request_id, RESET_PATH, "credentialGeneration"))?;
    service
        .admin_reset(
            headers.request(BrowserMethod::Post),
            target,
            generation,
            &input.confirmation,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, RESET_PATH))?;
    Ok(no_store(StatusCode::NO_CONTENT.into_response()))
}

#[utoipa::path(get, path = RESET_TARGETS_PATH, tag = "mfa", security(("projectSessionCookie" = [])),
params(("query"=String, Query)), responses((status=200, body=MfaResetTargetCollectionView), (status=403, body=crate::openapi::ProblemDetails)))]
async fn reset_targets(
    State(service): State<MfaHttpService>,
    Extension(request_id): Extension<RequestId>,
    Query(input): Query<ResetTargetQuery>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, RESET_TARGETS_PATH)?;
    let view = service
        .reset_targets(headers.request(BrowserMethod::Get), &input.query)
        .await
        .map_err(|error| map_error(error, request_id, RESET_TARGETS_PATH))?;
    Ok(no_store(Json(view).into_response()))
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

fn header_values<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Result<Vec<&'a str>, ()> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().map_err(|_| ()))
        .collect()
}

fn parse_if_match(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<u64, HttpError> {
    let values = headers.get_all(IF_MATCH).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    };
    let value = value
        .to_str()
        .map_err(|_| HttpError::precondition_required(request_id.clone(), path))?;
    let version = value
        .strip_prefix("\"mfa-policy-v")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|version| *version > 0 && *version < i64::MAX as u64)
        .ok_or_else(|| HttpError::precondition_required(request_id.clone(), path))?;
    if value == format!("\"mfa-policy-v{version}\"") {
        Ok(version)
    } else {
        Err(HttpError::precondition_required(request_id.clone(), path))
    }
}

fn parse_idempotency_key(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<MfaIdempotencyKey, HttpError> {
    let values = headers.get_all(&IDEMPOTENCY_KEY).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(validation(request_id, path, "Idempotency-Key"));
    };
    let value = value
        .to_str()
        .map_err(|_| validation(request_id, path, "Idempotency-Key"))?;
    MfaIdempotencyKey::new(value.to_owned())
        .map_err(|_| validation(request_id, path, "Idempotency-Key"))
}

fn rotated_json<T: serde::Serialize>(
    result: RotatedMfaResponse<T>,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let mut response = no_store(Json(result.view).into_response());
    append_cookies(&mut response, result.cookies, request_id, path)?;
    Ok(response)
}

fn rotated_empty(
    result: RotatedMfaResponse<()>,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let mut response = no_store(StatusCode::NO_CONTENT.into_response());
    append_cookies(&mut response, result.cookies, request_id, path)?;
    Ok(response)
}

fn policy_json(
    view: MfaPolicyView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let etag = HeaderValue::from_str(&format!("\"mfa-policy-v{}\"", view.version))
        .map_err(|_| HttpError::internal(request_id, path))?;
    let mut response = no_store(Json(view).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

fn impact_json(
    view: MfaPolicyImpactView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let etag = HeaderValue::from_str(&format!("\"mfa-policy-v{}\"", view.policy_version))
        .map_err(|_| HttpError::internal(request_id, path))?;
    let mut response = no_store(Json(view).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}

fn append_cookies(
    response: &mut Response,
    cookies: IssuedBrowserCookies,
    request_id: RequestId,
    path: &str,
) -> Result<(), HttpError> {
    let (session, csrf) = cookies.into_headers();
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_str(session.expose())
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_str(csrf.expose()).map_err(|_| HttpError::internal(request_id, path))?,
    );
    Ok(())
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

fn map_error(error: MfaHttpServiceError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        MfaHttpServiceError::AuthenticationFailed | MfaHttpServiceError::ChallengeFailed => {
            HttpError::authentication(request_id, path)
        }
        MfaHttpServiceError::Forbidden => HttpError::forbidden(request_id, path),
        MfaHttpServiceError::ReauthenticationRequired => HttpError::forbidden(request_id, path),
        MfaHttpServiceError::InvalidInput => validation(&request_id, path, "body"),
        MfaHttpServiceError::NotActive => HttpError::conflict(request_id, path),
        MfaHttpServiceError::Conflict => HttpError::precondition_failed(request_id, path),
        MfaHttpServiceError::PreconditionFailed => HttpError::precondition_failed(request_id, path),
        MfaHttpServiceError::Unavailable => HttpError::service_unavailable(request_id, path),
        MfaHttpServiceError::Internal => HttpError::internal(request_id, path),
    }
}
