use super::{RegistryAdminView, RegistryCollectionView, RegistryError, RegistryHttpService};
use crate::{
    http::{FieldViolation, HttpError, RequestId},
    identity::{BrowserMethod, BrowserRequestHeaders},
};
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
use serde::de::DeserializeOwned;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use uuid::Uuid;
const COLLECTION: &str = "/api/v1/admin/registries";
const ITEM: &str = "/api/v1/admin/registries/{registryId}";
const ROTATE: &str = "/api/v1/admin/registries/{registryId}/rotate-token";
const ACTIVATE: &str = "/api/v1/admin/registries/{registryId}/activate";
const DISABLE: &str = "/api/v1/admin/registries/{registryId}/disable";
const DEFAULT: &str = "/api/v1/admin/registries/{registryId}/default";
const SCOPES: &str = "/api/v1/admin/registry-scopes";
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");
pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<RegistryHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(list, create))
        .routes(routes!(rename, delete))
        .routes(routes!(rotate))
        .routes(routes!(activate))
        .routes(routes!(disable))
        .routes(routes!(set_default))
        .routes(routes!(map_scope))
        .layer(DefaultBodyLimit::max(4096))
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Create {
    display_name: String,
    base_url: String,
    token: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Rename {
    display_name: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct Rotate {
    token: String,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Scope {
    scope: String,
    connection_id: String,
}
#[utoipa::path(get,path=COLLECTION,tag="registry-administration",security(("projectSessionCookie"=[])),responses((status=200,body=RegistryCollectionView)))]
async fn list(
    State(s): State<RegistryHttpService>,
    Extension(id): Extension<RequestId>,
    h: HeaderMap,
) -> Result<Response, HttpError> {
    let b = Headers::read(&h, &id, COLLECTION)?;
    s.list(b.request(BrowserMethod::Get))
        .await
        .map(|v| no_store(Json(v).into_response()))
        .map_err(|e| map_error(e, id, COLLECTION))
}
#[utoipa::path(post,path=COLLECTION,tag="registry-administration",security(("projectSessionCookie"=[])),request_body=Create,responses((status=200,body=RegistryAdminView)))]
async fn create(
    State(s): State<RegistryHttpService>,
    Extension(id): Extension<RequestId>,
    r: Request,
) -> Result<Response, HttpError> {
    let (p, b) = r.into_parts();
    let h = Headers::read(&p.headers, &id, COLLECTION)?;
    let v: Create = json(&p.headers, b, &id, COLLECTION).await?;
    let out = s
        .create(
            h.request(BrowserMethod::Post),
            v.display_name,
            v.base_url,
            v.token.into_bytes(),
            id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, id.clone(), COLLECTION))?;
    response(out, id, COLLECTION)
}
#[utoipa::path(patch,path=ITEM,tag="registry-administration",security(("projectSessionCookie"=[])),request_body=Rename,responses((status=200,body=RegistryAdminView)))]
async fn rename(
    State(s): State<RegistryHttpService>,
    Extension(id): Extension<RequestId>,
    Path(raw): Path<String>,
    r: Request,
) -> Result<Response, HttpError> {
    let uid = uuid(&raw, &id, ITEM)?;
    let (p, b) = r.into_parts();
    let vrs = version(&p.headers, &id, ITEM)?;
    let h = Headers::read(&p.headers, &id, ITEM)?;
    let v: Rename = json(&p.headers, b, &id, ITEM).await?;
    let out = s
        .rename(
            h.request(BrowserMethod::Patch),
            uid,
            vrs,
            &v.display_name,
            id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, id.clone(), ITEM))?;
    response(out, id, ITEM)
}
#[utoipa::path(delete,path=ITEM,tag="registry-administration",security(("projectSessionCookie"=[])),responses((status=204)))]
async fn delete(
    State(s): State<RegistryHttpService>,
    Extension(id): Extension<RequestId>,
    Path(raw): Path<String>,
    h: HeaderMap,
) -> Result<Response, HttpError> {
    let uid = uuid(&raw, &id, ITEM)?;
    let v = version(&h, &id, ITEM)?;
    let b = Headers::read(&h, &id, ITEM)?;
    s.delete(b.request(BrowserMethod::Delete), uid, v, id.as_str())
        .await
        .map_err(|e| map_error(e, id, ITEM))?;
    Ok(no_store(StatusCode::NO_CONTENT.into_response()))
}
#[utoipa::path(post,path=ROTATE,tag="registry-administration",security(("projectSessionCookie"=[])),request_body=Rotate,responses((status=200,body=RegistryAdminView)))]
async fn rotate(
    State(s): State<RegistryHttpService>,
    Extension(id): Extension<RequestId>,
    Path(raw): Path<String>,
    r: Request,
) -> Result<Response, HttpError> {
    let uid = uuid(&raw, &id, ROTATE)?;
    let (p, b) = r.into_parts();
    let vrs = version(&p.headers, &id, ROTATE)?;
    let h = Headers::read(&p.headers, &id, ROTATE)?;
    let v: Rotate = json(&p.headers, b, &id, ROTATE).await?;
    let out = s
        .rotate(
            h.request(BrowserMethod::Post),
            uid,
            vrs,
            v.token.into_bytes(),
            id.as_str(),
        )
        .await
        .map_err(|e| map_error(e, id.clone(), ROTATE))?;
    response(out, id, ROTATE)
}
macro_rules! action{($name:ident,$path:expr,$method:expr,$call:ident)=>{#[utoipa::path(post,path=$path,tag="registry-administration",security(("projectSessionCookie"=[])),responses((status=200,body=RegistryAdminView)))]async fn $name(State(s):State<RegistryHttpService>,Extension(id):Extension<RequestId>,Path(raw):Path<String>,h:HeaderMap)->Result<Response,HttpError>{let uid=uuid(&raw,&id,$path)?;let v=version(&h,&id,$path)?;let b=Headers::read(&h,&id,$path)?;let out=s.$call(b.request($method),uid,v,id.as_str()).await.map_err(|e|map_error(e,id.clone(),$path))?;response(out,id,$path)}}}
action!(activate, ACTIVATE, BrowserMethod::Post, activate);
action!(disable, DISABLE, BrowserMethod::Post, disable);
action!(set_default, DEFAULT, BrowserMethod::Post, set_default);
#[utoipa::path(post,path=SCOPES,tag="registry-administration",security(("projectSessionCookie"=[])),request_body=Scope,responses((status=204)))]
async fn map_scope(
    State(s): State<RegistryHttpService>,
    Extension(id): Extension<RequestId>,
    r: Request,
) -> Result<Response, HttpError> {
    let (p, b) = r.into_parts();
    let h = Headers::read(&p.headers, &id, SCOPES)?;
    let v: Scope = json(&p.headers, b, &id, SCOPES).await?;
    let uid = uuid(&v.connection_id, &id, SCOPES)?;
    s.map_scope(h.request(BrowserMethod::Post), &v.scope, uid, id.as_str())
        .await
        .map_err(|e| map_error(e, id, SCOPES))?;
    Ok(no_store(StatusCode::NO_CONTENT.into_response()))
}
struct Headers<'a> {
    o: Vec<&'a str>,
    c: Vec<&'a str>,
    x: Vec<&'a str>,
}
impl<'a> Headers<'a> {
    fn read(h: &'a HeaderMap, id: &RequestId, p: &str) -> Result<Self, HttpError> {
        Ok(Self {
            o: vals(h, &ORIGIN, id, p)?,
            c: vals(h, &COOKIE, id, p)?,
            x: vals(h, &CSRF, id, p)?,
        })
    }
    fn request(&self, m: BrowserMethod) -> BrowserRequestHeaders<'_> {
        BrowserRequestHeaders {
            method: m,
            origins: &self.o,
            cookie_headers: &self.c,
            csrf_headers: &self.x,
        }
    }
}
fn vals<'a>(
    h: &'a HeaderMap,
    n: &HeaderName,
    id: &RequestId,
    p: &str,
) -> Result<Vec<&'a str>, HttpError> {
    h.get_all(n)
        .iter()
        .map(|v| {
            v.to_str()
                .map_err(|_| HttpError::validation(id.clone(), p, vec![]))
        })
        .collect()
}
async fn json<T: DeserializeOwned>(
    h: &HeaderMap,
    b: Body,
    id: &RequestId,
    p: &str,
) -> Result<T, HttpError> {
    if h.get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| !v.eq_ignore_ascii_case("application/json"))
    {
        return Err(HttpError::unsupported_media_type(id.clone(), p));
    }
    let b = to_bytes(b, 4096)
        .await
        .map_err(|_| HttpError::payload_too_large(id.clone(), p))?;
    serde_json::from_slice(&b).map_err(|_| {
        HttpError::validation(
            id.clone(),
            p,
            vec![FieldViolation::new(
                "body",
                "INVALID",
                "The JSON body is invalid.",
            )],
        )
    })
}
fn uuid(v: &str, id: &RequestId, p: &str) -> Result<Uuid, HttpError> {
    Uuid::parse_str(v)
        .ok()
        .filter(|v| v.get_version() == Some(uuid::Version::SortRand) && !v.is_nil())
        .ok_or_else(|| HttpError::validation(id.clone(), p, vec![]))
}
fn version(h: &HeaderMap, id: &RequestId, p: &str) -> Result<u64, HttpError> {
    let values = h.get_all(IF_MATCH).iter().collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(HttpError::precondition_required(id.clone(), p));
    };
    let value = value
        .to_str()
        .map_err(|_| HttpError::precondition_required(id.clone(), p))?;
    let parsed = value
        .strip_prefix("\"registry-v")
        .and_then(|v| v.strip_suffix('"'))
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0 && *v < i64::MAX as u64)
        .ok_or_else(|| HttpError::precondition_required(id.clone(), p))?;
    if value == format!("\"registry-v{parsed}\"") {
        Ok(parsed)
    } else {
        Err(HttpError::precondition_required(id.clone(), p))
    }
}
fn response(v: RegistryAdminView, id: RequestId, p: &str) -> Result<Response, HttpError> {
    let e = HeaderValue::from_str(&format!("\"registry-v{}\"", v.config_version))
        .map_err(|_| HttpError::internal(id, p))?;
    let mut r = no_store(Json(v).into_response());
    r.headers_mut().insert(ETAG, e);
    Ok(r)
}
fn no_store(mut r: Response) -> Response {
    r.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    r
}
fn map_error(e: RegistryError, id: RequestId, p: &str) -> HttpError {
    match e {
        RegistryError::AuthenticationFailed => HttpError::authentication(id, p),
        RegistryError::Forbidden | RegistryError::ReauthenticationRequired => {
            HttpError::forbidden(id, p)
        }
        RegistryError::NotFound => HttpError::not_found(id, p),
        RegistryError::InvalidInput
        | RegistryError::InvalidPackage
        | RegistryError::NetworkDenied
        | RegistryError::ValidationFailed => HttpError::validation(id, p, vec![]),
        RegistryError::Disabled
        | RegistryError::MustDisable
        | RegistryError::Conflict
        | RegistryError::RouteUnavailable => HttpError::conflict(id, p),
        RegistryError::CredentialUnavailable
        | RegistryError::UpstreamNotFound { .. }
        | RegistryError::UpstreamAuthentication { .. }
        | RegistryError::UpstreamUnavailable { .. }
        | RegistryError::Unavailable => HttpError::service_unavailable(id, p),
    }
}
