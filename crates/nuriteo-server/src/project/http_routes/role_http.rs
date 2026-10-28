#![allow(unused_imports)]
use super::project_http::*;
use super::*;
use std::str::FromStr;

use axum::Json;

use axum::body::{Body, to_bytes};

use axum::extract::{Extension, Path, Request, State};

use axum::http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, RANGE,
};

use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};

use axum::response::{IntoResponse, Response};

use serde::{Deserialize, de::DeserializeOwned};

use tokio_util::io::ReaderStream;

use utoipa::ToSchema;

use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{FieldViolation, HttpError, RequestId};

use crate::identity::{BrowserMethod, BrowserRequestHeaders, UserId};

use crate::organization::OrganizationId;

use crate::save::{
    ContentDescriptor, HistoricalReferenceKind, IdempotencyKey, ProjectVersionName,
    ProjectVersionPageLimit,
};

use super::super::http_service::{
    HistoricalPromotionView, ProjectHttpError, ProjectHttpService, ProjectListView,
    ProjectRoleListView, ProjectRoleMutationView, ProjectVersionCreateView, ProjectVersionListView,
    ProjectView, RecoveryCheckpointListView, RoleOperation,
};

use super::super::{
    ProjectId, ProjectName, ProjectOwner, ProjectPageLimit, ProjectRole, ProjectRolePageLimit,
    ProjectSlug, ProjectState, ProjectTemplate, ProjectVersion,
};

use super::{
    ARCHIVE, BrowserHeaders, COLLECTION, CONTENT, CONTENT_DOWNLOAD, CSRF, ChangeRoleRequest,
    CreateProjectRequest, CreateVersionRequest, DeleteProjectRequest, GrantRoleRequest,
    HISTORY_RESTORE, IDEMPOTENCY_KEY, ITEM, ListQuery, MAX_AUTHORIZATION_BYTES, MAX_BODY,
    MAX_QUERY, ORIGIN, ProjectBundleBinary, PromoteHistoryRequest, RECOVERY_CHECKPOINTS, RESTORE,
    ROLE, ROLES, RenameProjectRequest, VERSIONS, VersionListQuery,
};
use crate::access_token::{AccessTokenScope, ApiCategory};

#[utoipa::path(patch, path = ROLE, tag = "project-roles", security(("projectSessionCookie" = [])), params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path), ("user_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)), request_body(content = ChangeRoleRequest, content_type = "application/json"), responses((status = 200, body = ProjectRoleMutationView, headers(("ETag" = String))),
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
pub(crate) async fn change_role(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id, user_id)): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let input: ChangeRoleRequest = json_body(&parts.headers, body, &request_id, ROLE).await?;
    role_mutation(
        service,
        request_id,
        (owner_type, owner_id, project_id),
        parts.headers,
        user_id,
        Some(input.role),
        RoleOperation::Change,
        BrowserMethod::Patch,
        StatusCode::OK,
        ROLE,
    )
    .await
}

#[utoipa::path(delete, path = ROLE, tag = "project-roles", security(("projectSessionCookie" = [])), params(("owner_type" = String, Path), ("owner_id" = String, Path), ("project_id" = String, Path), ("user_id" = String, Path), ("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)), responses((status = 200, body = ProjectRoleMutationView, headers(("ETag" = String))),
    (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
    (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")))]
pub(crate) async fn revoke_role(
    State(service): State<ProjectHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path((owner_type, owner_id, project_id, user_id)): Path<(String, String, String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = request.headers().clone();
    role_mutation(
        service,
        request_id,
        (owner_type, owner_id, project_id),
        headers,
        user_id,
        None,
        RoleOperation::Revoke,
        BrowserMethod::Delete,
        StatusCode::OK,
        ROLE,
    )
    .await
}

#[allow(
    clippy::too_many_arguments,
    reason = "role HTTP security inputs stay explicit"
)]
pub(crate) async fn role_mutation(
    service: ProjectHttpService,
    request_id: RequestId,
    (owner_type, owner_id, project_id): (String, String, String),
    headers: HeaderMap,
    user_id: String,
    role: Option<ProjectRole>,
    operation: RoleOperation,
    method: BrowserMethod,
    status: StatusCode,
    path: &'static str,
) -> Result<Response, HttpError> {
    let browser = BrowserHeaders::read(&headers, &request_id, path)?;
    let version = parse_if_match(&headers, &request_id, path)?;
    let view = service
        .mutate_role(
            browser.request(method),
            parse_owner(&owner_type, &owner_id, &request_id, path)?,
            parse_project_id(&project_id, &request_id, path)?,
            version,
            parse_user_id(&user_id, &request_id, path)?,
            role,
            operation,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), path))?;
    role_response(status, view, request_id, path)
}

impl<'a> BrowserHeaders<'a> {
    pub(crate) fn read(
        headers: &'a HeaderMap,
        request_id: &RequestId,
        path: &str,
    ) -> Result<Self, HttpError> {
        pub(crate) fn values<'a>(
            headers: &'a HeaderMap,
            name: HeaderName,
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
        Ok(Self {
            cookies: values(headers, COOKIE, request_id, path)?,
            origins: values(headers, ORIGIN, request_id, path)?,
            csrf: values(headers, CSRF, request_id, path)?,
        })
    }
    pub(crate) fn request(&self, method: BrowserMethod) -> BrowserRequestHeaders<'_> {
        BrowserRequestHeaders {
            method,
            origins: &self.origins,
            cookie_headers: &self.cookies,
            csrf_headers: &self.csrf,
        }
    }
}

pub(crate) fn bearer_token<'a>(
    headers: &'a HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<Option<&'a str>, HttpError> {
    let values = headers.get_all(AUTHORIZATION).iter().collect::<Vec<_>>();
    if values.is_empty() {
        return Ok(None);
    }
    if values.len() != 1 || headers.contains_key(COOKIE) {
        return Err(HttpError::authentication(request_id.clone(), path));
    }
    let raw = values[0]
        .to_str()
        .map_err(|_| HttpError::authentication(request_id.clone(), path))?;
    let token = raw
        .strip_prefix("Bearer ")
        .filter(|token| {
            !token.is_empty()
                && raw.len() <= MAX_AUTHORIZATION_BYTES
                && !token.chars().any(char::is_whitespace)
                && !token.chars().any(char::is_control)
        })
        .ok_or_else(|| HttpError::authentication(request_id.clone(), path))?;
    Ok(Some(token))
}

impl ListQuery {
    pub(crate) fn parse(
        raw: Option<&str>,
        request_id: &RequestId,
        path: &str,
    ) -> Result<Self, HttpError> {
        let raw = raw.unwrap_or_default();
        if raw.len() > MAX_QUERY {
            return Err(validation(request_id, path, "query"));
        }
        let mut state = None;
        let mut state_seen = false;
        let mut page_size = None;
        let mut cursor = None;
        let mut cursor_seen = false;
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "state" if !state_seen => {
                    state_seen = true;
                    state = Some(match value.as_ref() {
                        "active" => ProjectState::Active,
                        "archived" => ProjectState::Archived,
                        "all" => {
                            continue;
                        }
                        _ => return Err(validation(request_id, path, "state")),
                    })
                }
                "pageSize" if page_size.is_none() => {
                    page_size = Some(
                        value
                            .parse::<u16>()
                            .map_err(|_| validation(request_id, path, "pageSize"))?,
                    )
                }
                "cursor" if !cursor_seen && !value.is_empty() => {
                    cursor_seen = true;
                    cursor = Some(value.into_owned())
                }
                _ => return Err(validation(request_id, path, "query")),
            }
        }
        Ok(Self {
            state,
            state_supplied: state_seen,
            page_size: page_size.unwrap_or(50),
            cursor,
        })
    }
    pub(crate) fn project_limit(
        &self,
        request_id: &RequestId,
        path: &str,
    ) -> Result<ProjectPageLimit, HttpError> {
        ProjectPageLimit::new(self.page_size).map_err(|_| {
            HttpError::validation(
                request_id.clone(),
                path,
                [FieldViolation::new(
                    "pageSize",
                    "INVALID",
                    "The value is invalid.",
                )],
            )
        })
    }
    pub(crate) fn role_limit(
        &self,
        request_id: &RequestId,
        path: &str,
    ) -> Result<ProjectRolePageLimit, HttpError> {
        ProjectRolePageLimit::new(self.page_size).map_err(|_| {
            HttpError::validation(
                request_id.clone(),
                path,
                [FieldViolation::new(
                    "pageSize",
                    "INVALID",
                    "The value is invalid.",
                )],
            )
        })
    }
}

impl VersionListQuery {
    pub(crate) fn parse(
        raw: Option<&str>,
        request_id: &RequestId,
        path: &str,
    ) -> Result<Self, HttpError> {
        let raw = raw.unwrap_or_default();
        if raw.len() > MAX_QUERY {
            return Err(validation(request_id, path, "query"));
        }
        let mut page_size = None;
        let mut cursor = None;
        let mut cursor_seen = false;
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "pageSize" if page_size.is_none() => {
                    page_size = Some(
                        value
                            .parse::<u16>()
                            .map_err(|_| validation(request_id, path, "pageSize"))?,
                    );
                }
                "cursor" if !cursor_seen && !value.is_empty() => {
                    cursor_seen = true;
                    cursor = Some(value.into_owned());
                }
                _ => return Err(validation(request_id, path, "query")),
            }
        }
        Ok(Self {
            page_size: page_size.unwrap_or(crate::save::DEFAULT_PROJECT_VERSION_PAGE_SIZE),
            cursor,
        })
    }

    pub(crate) fn limit(
        &self,
        request_id: &RequestId,
        path: &str,
    ) -> Result<ProjectVersionPageLimit, HttpError> {
        ProjectVersionPageLimit::new(self.page_size).map_err(|_| {
            HttpError::validation(
                request_id.clone(),
                path,
                [FieldViolation::new(
                    "pageSize",
                    "INVALID",
                    "The value is invalid.",
                )],
            )
        })
    }
}

pub(crate) async fn json_body<T: DeserializeOwned>(
    headers: &HeaderMap,
    body: Body,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    let content_types: Vec<_> = headers.get_all(CONTENT_TYPE).iter().collect();
    if content_types.len() != 1
        || content_types[0]
            .to_str()
            .ok()
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            != Some("application/json")
    {
        return Err(HttpError::unsupported_media_type(request_id.clone(), path));
    }
    let bytes = to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| HttpError::payload_too_large(request_id.clone(), path))?;
    serde_json::from_slice(&bytes).map_err(|_| validation(request_id, path, "body"))
}

pub(crate) fn parse_owner(
    owner_type: &str,
    owner_id: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectOwner, HttpError> {
    match owner_type {
        "users" => UserId::from_str(owner_id)
            .map(ProjectOwner::User)
            .map_err(|_| validation(request_id, path, "ownerId")),
        "organizations" => OrganizationId::from_str(owner_id)
            .map(ProjectOwner::Organization)
            .map_err(|_| validation(request_id, path, "ownerId")),
        _ => Err(validation(request_id, path, "ownerType")),
    }
}

pub(crate) fn parse_project_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectId, HttpError> {
    value
        .parse()
        .map_err(|_| validation(request_id, path, "projectId"))
}

pub(crate) fn parse_user_id(
    value: &str,
    request_id: &RequestId,
    path: &str,
) -> Result<UserId, HttpError> {
    value
        .parse()
        .map_err(|_| validation(request_id, path, "userId"))
}

pub(crate) fn parse_if_match(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<ProjectVersion, HttpError> {
    let values: Vec<_> = headers.get_all(IF_MATCH).iter().collect();
    if values.is_empty() {
        return Err(HttpError::precondition_required(request_id.clone(), path));
    }
    if values.len() != 1 {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    let raw = values[0]
        .to_str()
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))?;
    let number = raw
        .strip_prefix("\"project-v")
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))?;
    let version = ProjectVersion::new(number)
        .map_err(|_| HttpError::precondition_failed(request_id.clone(), path))?;
    if raw != format!("\"project-v{}\"", version.get()) {
        return Err(HttpError::precondition_failed(request_id.clone(), path));
    }
    Ok(version)
}

pub(crate) fn parse_idempotency_key(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
) -> Result<IdempotencyKey, HttpError> {
    let values: Vec<_> = headers.get_all(IDEMPOTENCY_KEY).iter().collect();
    if values.len() != 1 {
        return Err(validation(request_id, path, "Idempotency-Key"));
    }
    let value = values[0]
        .to_str()
        .map_err(|_| validation(request_id, path, "Idempotency-Key"))?;
    IdempotencyKey::new(value.to_owned())
        .map_err(|_| validation(request_id, path, "Idempotency-Key"))
}

pub(crate) fn project_response(
    status: StatusCode,
    view: ProjectView,
    location: bool,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let mut response = (status, Json(view.clone())).into_response();
    insert_etag(response.headers_mut(), view.version, &request_id, path)?;
    if location {
        response.headers_mut().insert(
            LOCATION,
            HeaderValue::from_str(&format!(
                "/api/v1/workspaces/{}/{}/projects/{}",
                if view.owner_type == "user" {
                    "users"
                } else {
                    "organizations"
                },
                view.owner_id,
                view.id
            ))
            .map_err(|_| HttpError::internal(request_id, path))?,
        );
    }
    Ok(response)
}

pub(crate) fn private_no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

pub(crate) fn role_response(
    status: StatusCode,
    view: ProjectRoleMutationView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let version = view.project_version;
    let mut response = (status, Json(view)).into_response();
    insert_etag(response.headers_mut(), version, &request_id, path)?;
    Ok(response)
}

pub(crate) fn insert_etag(
    headers: &mut HeaderMap,
    version: i64,
    request_id: &RequestId,
    path: &str,
) -> Result<(), HttpError> {
    headers.insert(
        ETAG,
        HeaderValue::from_str(&format!("\"project-v{version}\""))
            .map_err(|_| HttpError::internal(request_id.clone(), path))?,
    );
    Ok(())
}

pub(crate) fn validation(request_id: &RequestId, path: &str, field: &str) -> HttpError {
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

pub(crate) fn map_error(error: ProjectHttpError, request_id: RequestId, path: &str) -> HttpError {
    match error {
        ProjectHttpError::AuthenticationFailed => HttpError::authentication(request_id, path),
        ProjectHttpError::Forbidden => HttpError::forbidden(request_id, path),
        ProjectHttpError::ConfirmationRequired => validation(&request_id, path, "name"),
        ProjectHttpError::NotFound => HttpError::not_found(request_id, path),
        ProjectHttpError::InvalidInput => validation(&request_id, path, "request"),
        ProjectHttpError::Conflict => HttpError::conflict(request_id, path),
        ProjectHttpError::PreconditionFailed => HttpError::precondition_failed(request_id, path),
        ProjectHttpError::AuditUnavailable | ProjectHttpError::Unavailable => {
            HttpError::service_unavailable(request_id, path)
        }
        ProjectHttpError::RateLimited => HttpError::rate_limited(request_id, path),
        ProjectHttpError::OperationTimeout => HttpError::operation_timeout(request_id, path),
        ProjectHttpError::CommitOutcomeUnknown => {
            HttpError::commit_outcome_unknown(request_id, path)
        }
        ProjectHttpError::Internal => HttpError::internal(request_id, path),
    }
}
