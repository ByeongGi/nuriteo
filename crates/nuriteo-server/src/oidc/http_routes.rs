use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{DefaultBodyLimit, Extension, Path, Query, Request, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, SET_COOKIE,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use uuid::Uuid;

use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders, IssuedBrowserCookies};

use super::{
    OidcHttpService, OidcIdentityCollectionView, OidcLoginProviderCollectionView,
    OidcProviderCollectionView, OidcProviderError, OidcProviderView,
};

const LOGIN_PROVIDERS: &str = "/api/v1/auth/oidc/providers";
const BEGIN: &str = "/api/v1/auth/oidc/{providerId}/begin";
const CALLBACK: &str = "/api/v1/auth/oidc/{providerId}/callback";
const IDENTITIES: &str = "/api/v1/me/oidc-identities";
const IDENTITY: &str = "/api/v1/me/oidc-identities/{providerId}";
const ADMIN_PROVIDERS: &str = "/api/v1/admin/oidc/providers";
const ADMIN_PROVIDER: &str = "/api/v1/admin/oidc/providers/{providerId}";
const ADMIN_DISABLE: &str = "/api/v1/admin/oidc/providers/{providerId}/disable";
const ADMIN_ROTATE: &str = "/api/v1/admin/oidc/providers/{providerId}/rotate-secret";
const ADMIN_ACTIVATE: &str = "/api/v1/admin/oidc/providers/{providerId}/activate";
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

pub(crate) fn openapi_router(document: utoipa::openapi::OpenApi) -> OpenApiRouter<OidcHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(login_providers))
        .routes(routes!(begin))
        .routes(routes!(callback))
        .routes(routes!(identities))
        .routes(routes!(unlink))
        .routes(routes!(admin_providers))
        .routes(routes!(create_provider))
        .routes(routes!(update_provider))
        .routes(routes!(delete_provider))
        .routes(routes!(disable_provider))
        .routes(routes!(rotate_secret))
        .routes(routes!(activate_provider))
        .layer(DefaultBodyLimit::max(4 * 1024))
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateProviderRequest {
    display_name: String,
    issuer: String,
    client_id: String,
    client_secret: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateProviderRequest {
    display_name: String,
    client_id: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RotateSecretRequest {
    client_secret: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ActivateProviderRequest {
    redirect_uri: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CallbackQuery {
    iss: String,
    state: String,
    code: String,
}

#[utoipa::path(get, path=LOGIN_PROVIDERS, tag="oidc", responses((status=200, body=OidcLoginProviderCollectionView), (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")))]
async fn login_providers(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
) -> Result<Response, HttpError> {
    service
        .login_providers()
        .await
        .map(|view| no_store(Json(view).into_response()))
        .map_err(|error| map_error(error, id, LOGIN_PROVIDERS))
}

#[utoipa::path(get, path=BEGIN, tag="oidc", params(("providerId"=String,Path)), responses((status=303, description="Redirect to the validated Provider authorization endpoint"), (status=404, body=crate::openapi::ProblemDetails, content_type="application/problem+json"), (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")))]
async fn begin(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    Path(provider_id): Path<String>,
) -> Result<Response, HttpError> {
    let provider = parse_provider_id(&provider_id, &id, BEGIN)?;
    let started = service
        .begin(provider)
        .await
        .map_err(|error| map_error(error, id.clone(), BEGIN))?;
    let mut response = StatusCode::SEE_OTHER.into_response();
    response.headers_mut().insert(
        LOCATION,
        HeaderValue::from_str(&started.location)
            .map_err(|_| HttpError::internal(id.clone(), BEGIN))?,
    );
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_str(&started.binding_cookie)
            .map_err(|_| HttpError::internal(id, BEGIN))?,
    );
    Ok(no_store(response))
}

#[utoipa::path(get, path=CALLBACK, tag="oidc", params(("providerId"=String,Path),("iss"=String,Query),("state"=String,Query),("code"=String,Query)), responses((status=303, description="OIDC login completed and the browser Session was rotated"), (status=400, body=crate::openapi::ProblemDetails, content_type="application/problem+json"), (status=503, body=crate::openapi::ProblemDetails, content_type="application/problem+json")))]
async fn callback(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    Path(provider_id): Path<String>,
    Query(query): Query<CallbackQuery>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let provider = parse_provider_id(&provider_id, &id, CALLBACK)?;
    let headers = BrowserHeaders::read(&headers, &id, CALLBACK)?;
    let result = service
        .callback(
            provider,
            &query.iss,
            &query.state,
            &query.code,
            &headers.cookies,
            id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, id.clone(), CALLBACK))?;
    let mut response = StatusCode::SEE_OTHER.into_response();
    response
        .headers_mut()
        .insert(LOCATION, HeaderValue::from_static("/workspaces"));
    append_session_cookies(&mut response, result.cookies, id.clone(), CALLBACK)?;
    if let Some(cookie) = result.clear_binding_cookie {
        response.headers_mut().append(
            SET_COOKIE,
            HeaderValue::from_str(&cookie).map_err(|_| HttpError::internal(id, CALLBACK))?,
        );
    }
    Ok(no_store(response))
}

#[utoipa::path(get,path=IDENTITIES,tag="oidc",security(("projectSessionCookie"=[])),responses((status=200,body=OidcIdentityCollectionView),(status=401,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=503,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn identities(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(&headers, &id, IDENTITIES)?;
    service
        .identities(headers.request(BrowserMethod::Get))
        .await
        .map(|view| no_store(Json(view).into_response()))
        .map_err(|error| map_error(error, id, IDENTITIES))
}

#[utoipa::path(delete,path=IDENTITY,tag="oidc",security(("projectSessionCookie"=[])),params(("providerId"=String,Path),("Origin"=String,Header),("X-CSRF-Token"=String,Header)),responses((status=204,description="Identity unlinked and Session rotated"),(status=401,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=403,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=409,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=503,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn unlink(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    Path(provider_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let provider = parse_provider_id(&provider_id, &id, IDENTITY)?;
    let headers = BrowserHeaders::read(&headers, &id, IDENTITY)?;
    let result = service
        .unlink(
            headers.request(BrowserMethod::Delete),
            provider,
            id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, id.clone(), IDENTITY))?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    append_session_cookies(&mut response, result.cookies, id, IDENTITY)?;
    Ok(no_store(response))
}

#[utoipa::path(get,path=ADMIN_PROVIDERS,tag="oidc-administration",security(("projectSessionCookie"=[])),responses((status=200,body=OidcProviderCollectionView),(status=401,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=403,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn admin_providers(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(&headers, &id, ADMIN_PROVIDERS)?;
    service
        .admin_providers(headers.request(BrowserMethod::Get))
        .await
        .map(|view| no_store(Json(view).into_response()))
        .map_err(|error| map_error(error, id, ADMIN_PROVIDERS))
}

#[utoipa::path(post,path=ADMIN_PROVIDERS,tag="oidc-administration",security(("projectSessionCookie"=[])),params(("Origin"=String,Header),("X-CSRF-Token"=String,Header)),request_body=CreateProviderRequest,responses((status=201,body=OidcProviderView),(status=401,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=403,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=413,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=415,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=422,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=503,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn create_provider(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &id, ADMIN_PROVIDERS)?;
    let input: CreateProviderRequest =
        json_body(&parts.headers, body, &id, ADMIN_PROVIDERS).await?;
    let view = service
        .create(
            headers.request(BrowserMethod::Post),
            input.display_name,
            input.issuer,
            input.client_id,
            input.client_secret.into_bytes(),
            id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, id, ADMIN_PROVIDERS))?;
    Ok(no_store((StatusCode::CREATED, Json(view)).into_response()))
}

#[utoipa::path(patch,path=ADMIN_PROVIDER,tag="oidc-administration",security(("projectSessionCookie"=[])),params(("providerId"=String,Path),("Origin"=String,Header),("X-CSRF-Token"=String,Header),("If-Match"=String,Header)),request_body=UpdateProviderRequest,responses((status=200,body=OidcProviderView),(status=401,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=403,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=412,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=428,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn update_provider(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    Path(provider_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let provider = parse_provider_id(&provider_id, &id, ADMIN_PROVIDER)?;
    let (parts, body) = request.into_parts();
    let version = version(&parts.headers, &id, ADMIN_PROVIDER)?;
    let headers = BrowserHeaders::read(&parts.headers, &id, ADMIN_PROVIDER)?;
    let input: UpdateProviderRequest = json_body(&parts.headers, body, &id, ADMIN_PROVIDER).await?;
    let view = service
        .update(
            headers.request(BrowserMethod::Patch),
            provider,
            version,
            input.display_name,
            input.client_id,
            id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, id.clone(), ADMIN_PROVIDER))?;
    provider_response(view, id, ADMIN_PROVIDER)
}

#[utoipa::path(delete,path=ADMIN_PROVIDER,tag="oidc-administration",security(("projectSessionCookie"=[])),params(("providerId"=String,Path),("Origin"=String,Header),("X-CSRF-Token"=String,Header),("If-Match"=String,Header)),responses((status=204,description="Provider deleted"),(status=403,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=409,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=412,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=428,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn delete_provider(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    Path(provider_id): Path<String>,
    request_headers: HeaderMap,
) -> Result<Response, HttpError> {
    let provider = parse_provider_id(&provider_id, &id, ADMIN_PROVIDER)?;
    let version = version(&request_headers, &id, ADMIN_PROVIDER)?;
    let headers = BrowserHeaders::read(&request_headers, &id, ADMIN_PROVIDER)?;
    service
        .delete(
            headers.request(BrowserMethod::Delete),
            provider,
            version,
            id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, id, ADMIN_PROVIDER))?;
    Ok(no_store(StatusCode::NO_CONTENT.into_response()))
}

#[utoipa::path(post,path=ADMIN_DISABLE,tag="oidc-administration",security(("projectSessionCookie"=[])),params(("providerId"=String,Path),("Origin"=String,Header),("X-CSRF-Token"=String,Header),("If-Match"=String,Header)),responses((status=200,body=OidcProviderView),(status=403,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=409,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=412,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=428,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn disable_provider(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    Path(provider_id): Path<String>,
    request_headers: HeaderMap,
) -> Result<Response, HttpError> {
    let provider = parse_provider_id(&provider_id, &id, ADMIN_DISABLE)?;
    let version = version(&request_headers, &id, ADMIN_DISABLE)?;
    let headers = BrowserHeaders::read(&request_headers, &id, ADMIN_DISABLE)?;
    let view = service
        .disable(
            headers.request(BrowserMethod::Post),
            provider,
            version,
            id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, id.clone(), ADMIN_DISABLE))?;
    provider_response(view, id, ADMIN_DISABLE)
}

#[utoipa::path(post,path=ADMIN_ROTATE,tag="oidc-administration",security(("projectSessionCookie"=[])),params(("providerId"=String,Path),("Origin"=String,Header),("X-CSRF-Token"=String,Header),("If-Match"=String,Header)),request_body=RotateSecretRequest,responses((status=200,body=OidcProviderView),(status=403,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=409,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=412,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=413,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=415,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=428,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn rotate_secret(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    Path(provider_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let provider = parse_provider_id(&provider_id, &id, ADMIN_ROTATE)?;
    let (parts, body) = request.into_parts();
    let version = version(&parts.headers, &id, ADMIN_ROTATE)?;
    let headers = BrowserHeaders::read(&parts.headers, &id, ADMIN_ROTATE)?;
    let input: RotateSecretRequest = json_body(&parts.headers, body, &id, ADMIN_ROTATE).await?;
    let view = service
        .rotate_secret(
            headers.request(BrowserMethod::Post),
            provider,
            version,
            input.client_secret.into_bytes(),
            id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, id.clone(), ADMIN_ROTATE))?;
    provider_response(view, id, ADMIN_ROTATE)
}

#[utoipa::path(post,path=ADMIN_ACTIVATE,tag="oidc-administration",security(("projectSessionCookie"=[])),params(("providerId"=String,Path),("Origin"=String,Header),("X-CSRF-Token"=String,Header),("If-Match"=String,Header)),request_body=ActivateProviderRequest,responses((status=200,body=OidcProviderView),(status=403,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=412,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=413,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=415,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=422,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=428,body=crate::openapi::ProblemDetails,content_type="application/problem+json"),(status=503,body=crate::openapi::ProblemDetails,content_type="application/problem+json")))]
async fn activate_provider(
    State(service): State<OidcHttpService>,
    Extension(id): Extension<RequestId>,
    Path(provider_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let provider = parse_provider_id(&provider_id, &id, ADMIN_ACTIVATE)?;
    let (parts, body) = request.into_parts();
    let version = version(&parts.headers, &id, ADMIN_ACTIVATE)?;
    let headers = BrowserHeaders::read(&parts.headers, &id, ADMIN_ACTIVATE)?;
    let input: ActivateProviderRequest =
        json_body(&parts.headers, body, &id, ADMIN_ACTIVATE).await?;
    let view = service
        .activate(
            headers.request(BrowserMethod::Post),
            provider,
            version,
            &input.redirect_uri,
            id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, id.clone(), ADMIN_ACTIVATE))?;
    provider_response(view, id, ADMIN_ACTIVATE)
}

struct BrowserHeaders<'a> {
    origins: Vec<&'a str>,
    cookies: Vec<&'a str>,
    csrf: Vec<&'a str>,
}
impl<'a> BrowserHeaders<'a> {
    fn read(headers: &'a HeaderMap, id: &RequestId, path: &str) -> Result<Self, HttpError> {
        Ok(Self {
            origins: values(headers, &ORIGIN, id, path)?,
            cookies: values(headers, &COOKIE, id, path)?,
            csrf: values(headers, &CSRF, id, path)?,
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
    id: &RequestId,
    path: &str,
) -> Result<Vec<&'a str>, HttpError> {
    headers
        .get_all(name)
        .iter()
        .map(|value| {
            value
                .to_str()
                .map_err(|_| HttpError::validation(id.clone(), path, vec![]))
        })
        .collect()
}
async fn json_body<T: DeserializeOwned>(
    headers: &HeaderMap,
    body: Body,
    id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    if headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| !v.eq_ignore_ascii_case("application/json"))
    {
        return Err(HttpError::unsupported_media_type(id.clone(), path));
    }
    let bytes = to_bytes(body, 4096)
        .await
        .map_err(|_| HttpError::payload_too_large(id.clone(), path))?;
    serde_json::from_slice(&bytes).map_err(|_| {
        HttpError::validation(
            id.clone(),
            path,
            vec![FieldViolation::new(
                "body",
                "INVALID",
                "The JSON body is invalid.",
            )],
        )
    })
}
fn parse_provider_id(value: &str, id: &RequestId, path: &str) -> Result<Uuid, HttpError> {
    Uuid::parse_str(value)
        .ok()
        .filter(|v| v.get_version() == Some(uuid::Version::SortRand) && !v.is_nil())
        .ok_or_else(|| HttpError::validation(id.clone(), path, vec![]))
}
fn version(headers: &HeaderMap, id: &RequestId, path: &str) -> Result<u64, HttpError> {
    let value = headers
        .get(IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| HttpError::precondition_required(id.clone(), path))?;
    let raw = value
        .strip_prefix("\"oidc-provider-v")
        .and_then(|v| v.strip_suffix('"'))
        .ok_or_else(|| HttpError::precondition_required(id.clone(), path))?;
    raw.parse()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| HttpError::precondition_required(id.clone(), path))
}
fn provider_response(
    view: OidcProviderView,
    id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let etag = HeaderValue::from_str(&format!("\"oidc-provider-v{}\"", view.config_version))
        .map_err(|_| HttpError::internal(id, path))?;
    let mut response = no_store(Json(view).into_response());
    response.headers_mut().insert(ETAG, etag);
    Ok(response)
}
fn append_session_cookies(
    response: &mut Response,
    cookies: IssuedBrowserCookies,
    id: RequestId,
    path: &str,
) -> Result<(), HttpError> {
    let (session, csrf) = cookies.into_headers();
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_str(session.expose())
            .map_err(|_| HttpError::internal(id.clone(), path))?,
    );
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_str(csrf.expose()).map_err(|_| HttpError::internal(id, path))?,
    );
    Ok(())
}
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}
fn map_error(error: OidcProviderError, id: RequestId, path: &str) -> HttpError {
    match error {
        OidcProviderError::AuthenticationFailed => HttpError::authentication(id, path),
        OidcProviderError::Forbidden | OidcProviderError::ReauthenticationRequired => {
            HttpError::forbidden(id, path)
        }
        OidcProviderError::NotFound | OidcProviderError::Disabled => HttpError::not_found(id, path),
        OidcProviderError::InvalidInput
        | OidcProviderError::NetworkDenied
        | OidcProviderError::ValidationFailed => HttpError::validation(id, path, vec![]),
        OidcProviderError::Conflict
        | OidcProviderError::MustDisable
        | OidcProviderError::LinkedIdentities => HttpError::conflict(id, path),
        OidcProviderError::CredentialUnavailable | OidcProviderError::Unavailable => {
            HttpError::service_unavailable(id, path)
        }
    }
}
