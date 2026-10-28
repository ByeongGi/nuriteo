#![allow(unused_imports)]
use super::*;
use super::console_requests::*;
use axum::Json;

use axum::body::{Body, to_bytes};

use axum::extract::{Extension, Path, Query, Request, State};

use axum::http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH,
};

use axum::http::{HeaderMap, HeaderName, HeaderValue, Uri};

use axum::response::{IntoResponse, Response};

use serde::Deserialize;

use serde::de::DeserializeOwned;

use serde_json::Value;

use utoipa::ToSchema;

use utoipa_axum::{router::OpenApiRouter, routes};

use uuid::Uuid;


use crate::audit::AuditEventId;

use crate::http::{FieldViolation, HttpError, RequestId};

use crate::identity::{BrowserMethod, BrowserRequestHeaders};

use crate::policy::{PolicyCleanupPreview, PolicyImpactPreview};


use super::super::{
    AdminAuditEventCollectionView, AdminAuditEventView, AdminAuditExportFormat,
    AdminAuditExportInput, AdminAuditListInput, AdminAuditRetentionPreview,
    AdminAuditRetentionPruneView, AdminBackupConsoleView, AdminBackupOperationCollectionView,
    AdminBackupOperationRequest, AdminBackupPolicyUpdate, AdminHttpService, AdminHttpServiceError,
    AdminMaintenanceView, AdminOperationsView, AdminSettingListView, AdminSettingView,
    AdminStatusView, AdminSupportBundleView, AdminUpdateApprovalView, AdminUpdateHistoryView,
    AdminUpdateReadinessView,
};
use super::{SETTINGS, SETTING, SETTING_IMPACT, POLICY_CLEANUP_PREVIEW, STATUS, OPERATIONS, SUPPORT_BUNDLE, AUDIT_EVENTS, AUDIT_EVENT, AUDIT_EXPORT, AUDIT_RETENTION_PREVIEW, AUDIT_RETENTION_PRUNE, UPDATE_READINESS, UPDATE_HISTORY, UPDATE_APPROVAL, MAINTENANCE, BACKUPS, BACKUP_POLICY, BACKUP_OPERATIONS, MAX_BODY_BYTES, ORIGIN, CSRF, BackupOperationsQuery, UpdateSettingRequest, PolicyImpactRequest, PolicyCleanupPreviewQuery, UpdateHistoryQuery, AuditFilterRequest, AuditExportRequest, AuditRetentionPreviewQuery, AuditRetentionPruneRequest, UpdateApprovalRequest, MaintenanceRequest, BrowserHeaders};



pub(crate) fn openapi_router(
    document: utoipa::openapi::OpenApi,
) -> OpenApiRouter<AdminHttpService> {
    OpenApiRouter::with_openapi(document)
        .routes(routes!(list_settings))
        .routes(routes!(update_setting))
        .routes(routes!(preview_policy_change))
        .routes(routes!(preview_policy_cleanup))
        .routes(routes!(admin_status))
        .routes(routes!(admin_operations))
        .routes(routes!(support_bundle))
        .routes(routes!(list_audit_events))
        .routes(routes!(get_audit_event))
        .routes(routes!(export_audit_events))
        .routes(routes!(preview_audit_retention))
        .routes(routes!(prune_audit_retention))
        .routes(routes!(update_readiness))
        .routes(routes!(update_history))
        .routes(routes!(approve_update))
        .routes(routes!(maintenance_status, set_maintenance))
        .routes(routes!(backup_console))
        .routes(routes!(update_backup_policy))
        .routes(routes!(list_backup_operations, enqueue_backup_operation))
}


#[utoipa::path(
    get,
    path = BACKUPS,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    responses(
        (status = 200, body = AdminBackupConsoleView, headers(("ETag" = String), ("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn backup_console(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, BACKUPS)?;
    let view = service
        .backup_console(headers.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id.clone(), BACKUPS))?;
    backup_response(view, request_id, BACKUPS)
}


#[utoipa::path(
    put,
    path = BACKUP_POLICY,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("If-Match" = String, Header), ("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = AdminBackupPolicyUpdate, content_type = "application/json"),
    responses(
        (status = 200, body = AdminBackupConsoleView, headers(("ETag" = String), ("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 412, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 428, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn update_backup_policy(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, BACKUP_POLICY)?;
    let expected = parse_version_etag(
        &parts.headers,
        &request_id,
        BACKUP_POLICY,
        "backup-policy-v",
    )?;
    let input: AdminBackupPolicyUpdate =
        json_body(&parts.headers, body, &request_id, BACKUP_POLICY).await?;
    let view = service
        .update_backup_policy(
            headers.request(BrowserMethod::Put),
            input,
            expected,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), BACKUP_POLICY))?;
    backup_response(view, request_id, BACKUP_POLICY)
}


#[utoipa::path(
    post,
    path = BACKUP_OPERATIONS,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = AdminBackupOperationRequest, content_type = "application/json"),
    responses(
        (status = 202, body = AdminBackupConsoleView, headers(("ETag" = String), ("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn enqueue_backup_operation(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, BACKUP_OPERATIONS)?;
    let input: AdminBackupOperationRequest =
        json_body(&parts.headers, body, &request_id, BACKUP_OPERATIONS).await?;
    let view = service
        .enqueue_backup_operation(
            headers.request(BrowserMethod::Post),
            input,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), BACKUP_OPERATIONS))?;
    let mut response = backup_response(view, request_id, BACKUP_OPERATIONS)?;
    *response.status_mut() = axum::http::StatusCode::ACCEPTED;
    Ok(response)
}


#[utoipa::path(
    get,
    path = BACKUP_OPERATIONS,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("cursor" = Option<String>, Query), ("limit" = Option<u16>, Query, minimum = 1, maximum = 100)),
    responses(
        (status = 200, body = AdminBackupOperationCollectionView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_backup_operations(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<BackupOperationsQuery>,
    request: Request,
) -> Result<Response, HttpError> {
    let limit = query.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(validation(&request_id, BACKUP_OPERATIONS, "limit"));
    }
    let cursor = query
        .cursor
        .map(|value| {
            Uuid::parse_str(&value)
                .map_err(|_| validation(&request_id, BACKUP_OPERATIONS, "cursor"))
        })
        .transpose()?;
    let headers = BrowserHeaders::read(request.headers(), &request_id, BACKUP_OPERATIONS)?;
    let view = service
        .backup_operations(headers.request(BrowserMethod::Get), cursor, limit)
        .await
        .map_err(|error| map_error(error, request_id.clone(), BACKUP_OPERATIONS))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    get,
    path = MAINTENANCE,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    responses(
        (status = 200, body = AdminMaintenanceView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn maintenance_status(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, MAINTENANCE)?;
    let view = service
        .maintenance_status(headers.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, MAINTENANCE))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    put,
    path = MAINTENANCE,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = MaintenanceRequest, content_type = "application/json"),
    responses(
        (status = 200, body = AdminMaintenanceView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn set_maintenance(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, MAINTENANCE)?;
    let input: MaintenanceRequest =
        json_body(&parts.headers, body, &request_id, MAINTENANCE).await?;
    let view = service
        .set_maintenance(
            headers.request(BrowserMethod::Put),
            input.enabled,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, MAINTENANCE))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    get,
    path = UPDATE_READINESS,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    responses(
        (status = 200, body = AdminUpdateReadinessView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn update_readiness(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, UPDATE_READINESS)?;
    let view = service
        .update_readiness(headers.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, UPDATE_READINESS))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    get,
    path = UPDATE_HISTORY,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("cursor" = Option<String>, Query), ("limit" = Option<u16>, Query, minimum = 1, maximum = 100)),
    responses(
        (status = 200, body = AdminUpdateHistoryView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn update_history(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let query = parse_query::<UpdateHistoryQuery>(request.uri(), &request_id, UPDATE_HISTORY)?;
    let limit = query.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(validation(&request_id, UPDATE_HISTORY, "limit"));
    }
    let cursor = query
        .cursor
        .map(|value| value.parse::<AuditEventId>().map(|id| id.to_string()))
        .transpose()
        .map_err(|_| validation(&request_id, UPDATE_HISTORY, "cursor"))?;
    let headers = BrowserHeaders::read(request.headers(), &request_id, UPDATE_HISTORY)?;
    let view = service
        .update_history(headers.request(BrowserMethod::Get), cursor, limit)
        .await
        .map_err(|error| map_error(error, request_id, UPDATE_HISTORY))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    post,
    path = UPDATE_APPROVAL,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = UpdateApprovalRequest, content_type = "application/json"),
    responses(
        (status = 201, body = AdminUpdateApprovalView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn approve_update(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, UPDATE_APPROVAL)?;
    let input: UpdateApprovalRequest =
        json_body(&parts.headers, body, &request_id, UPDATE_APPROVAL).await?;
    let view = service
        .approve_update(
            headers.request(BrowserMethod::Post),
            &input.target_release,
            input.acknowledged,
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, UPDATE_APPROVAL))?;
    let mut response = private_no_store(Json(view).into_response());
    *response.status_mut() = axum::http::StatusCode::CREATED;
    Ok(response)
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
pub(crate) async fn list_settings(    State(service): State<AdminHttpService>,
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
pub(crate) async fn update_setting(    State(service): State<AdminHttpService>,
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
    post,
    path = SETTING_IMPACT,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("key" = String, Path)),
    request_body(content = PolicyImpactRequest, content_type = "application/json"),
    responses(
        (status = 200, body = PolicyImpactPreview, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn preview_policy_change(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(key): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, SETTING_IMPACT)?;
    let input: PolicyImpactRequest =
        json_body(&parts.headers, body, &request_id, SETTING_IMPACT).await?;
    let view = service
        .preview_policy_change(headers.request(BrowserMethod::Post), &key, input.value)
        .await
        .map_err(|error| map_error(error, request_id, SETTING_IMPACT))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    get,
    path = POLICY_CLEANUP_PREVIEW,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("batchLimit" = Option<u16>, Query, minimum = 1, maximum = 100)),
    responses(
        (status = 200, body = PolicyCleanupPreview, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn preview_policy_cleanup(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    Query(query): Query<PolicyCleanupPreviewQuery>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, POLICY_CLEANUP_PREVIEW)?;
    let view = service
        .preview_policy_cleanup(
            headers.request(BrowserMethod::Get),
            query.batch_limit.unwrap_or(100),
        )
        .await
        .map_err(|error| map_error(error, request_id, POLICY_CLEANUP_PREVIEW))?;
    Ok(private_no_store(Json(view).into_response()))
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
pub(crate) async fn admin_status(    State(service): State<AdminHttpService>,
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


#[utoipa::path(
    get,
    path = OPERATIONS,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    responses(
        (status = 200, body = AdminOperationsView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn admin_operations(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, OPERATIONS)?;
    let view = service
        .operations(headers.request(BrowserMethod::Get))
        .await
        .map_err(|error| map_error(error, request_id, OPERATIONS))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    get,
    path = SUPPORT_BUNDLE,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    responses(
        (status = 200, body = AdminSupportBundleView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn support_bundle(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, SUPPORT_BUNDLE)?;
    let view = service
        .support_bundle(headers.request(BrowserMethod::Get), request_id.as_str())
        .await
        .map_err(|error| map_error(error, request_id, SUPPORT_BUNDLE))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    get,
    path = AUDIT_EVENTS,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(
        ("from" = Option<String>, Query),
        ("to" = Option<String>, Query),
        ("actorType" = Option<String>, Query),
        ("actorId" = Option<String>, Query),
        ("actionCode" = Option<String>, Query),
        ("result" = Option<String>, Query),
        ("scopeType" = Option<String>, Query),
        ("scopeId" = Option<String>, Query),
        ("targetType" = Option<String>, Query),
        ("targetId" = Option<String>, Query),
        ("cursor" = Option<String>, Query),
        ("limit" = Option<u16>, Query)
    ),
    responses(
        (status = 200, body = AdminAuditEventCollectionView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_audit_events(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let query = parse_query::<AuditFilterRequest>(request.uri(), &request_id, AUDIT_EVENTS)?;
    let headers = BrowserHeaders::read(request.headers(), &request_id, AUDIT_EVENTS)?;
    let input = audit_list_input(query, &request_id, AUDIT_EVENTS)?;
    let view = service
        .list_audit_events(headers.request(BrowserMethod::Get), input)
        .await
        .map_err(|error| map_error(error, request_id, AUDIT_EVENTS))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    get,
    path = AUDIT_EVENT,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("eventId" = String, Path)),
    responses(
        (status = 200, body = AdminAuditEventView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_audit_event(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    Path(event_id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, AUDIT_EVENT)?;
    let event_id = event_id
        .parse::<AuditEventId>()
        .map_err(|_| validation(&request_id, AUDIT_EVENT, "eventId"))?;
    let view = service
        .get_audit_event(headers.request(BrowserMethod::Get), event_id)
        .await
        .map_err(|error| map_error(error, request_id, AUDIT_EVENT))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    post,
    path = AUDIT_EXPORT,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = AuditExportRequest, content_type = "application/json"),
    responses(
        (status = 200, description = "Bounded audit export page", content(
            (String = "application/x-ndjson"),
            (String = "text/csv")
        ), headers(
            ("Content-Disposition" = String),
            ("X-Nuriteo-Next-Cursor" = String)
        )),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 413, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn export_audit_events(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, AUDIT_EXPORT)?;
    let input: AuditExportRequest =
        json_body(&parts.headers, body, &request_id, AUDIT_EXPORT).await?;
    let query = audit_list_input(input.filters, &request_id, AUDIT_EXPORT)?;
    let export = service
        .export_audit_events(
            headers.request(BrowserMethod::Post),
            AdminAuditExportInput {
                query,
                format: input.format,
            },
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id.clone(), AUDIT_EXPORT))?;
    export_response(export, request_id)
}


#[utoipa::path(
    get,
    path = AUDIT_RETENTION_PREVIEW,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("retentionDays" = String, Query, description = "30..3650 or unlimited")),
    responses(
        (status = 200, body = AdminAuditRetentionPreview, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn preview_audit_retention(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let query = parse_query::<AuditRetentionPreviewQuery>(
        request.uri(),
        &request_id,
        AUDIT_RETENTION_PREVIEW,
    )?;
    let retention_days = if query.retention_days == "unlimited" {
        None
    } else {
        Some(
            query
                .retention_days
                .parse::<u16>()
                .map_err(|_| validation(&request_id, AUDIT_RETENTION_PREVIEW, "retentionDays"))?,
        )
    };
    let headers = BrowserHeaders::read(request.headers(), &request_id, AUDIT_RETENTION_PREVIEW)?;
    let view = service
        .preview_audit_retention(headers.request(BrowserMethod::Get), retention_days)
        .await
        .map_err(|error| map_error(error, request_id, AUDIT_RETENTION_PREVIEW))?;
    Ok(private_no_store(Json(view).into_response()))
}


#[utoipa::path(
    post,
    path = AUDIT_RETENTION_PRUNE,
    tag = "administration",
    security(("projectSessionCookie" = [])),
    params(("Origin" = String, Header), ("X-CSRF-Token" = String, Header)),
    request_body(content = AuditRetentionPruneRequest, content_type = "application/json"),
    responses(
        (status = 200, body = AdminAuditRetentionPruneView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 415, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
pub(crate) async fn prune_audit_retention(    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let (parts, body) = request.into_parts();
    let headers = BrowserHeaders::read(&parts.headers, &request_id, AUDIT_RETENTION_PRUNE)?;
    let input: AuditRetentionPruneRequest =
        json_body(&parts.headers, body, &request_id, AUDIT_RETENTION_PRUNE).await?;
    let view = service
        .prune_audit_retention(
            headers.request(BrowserMethod::Post),
            input.limit.unwrap_or(500),
            request_id.as_str(),
        )
        .await
        .map_err(|error| map_error(error, request_id, AUDIT_RETENTION_PRUNE))?;
    Ok(private_no_store(Json(view).into_response()))
}
