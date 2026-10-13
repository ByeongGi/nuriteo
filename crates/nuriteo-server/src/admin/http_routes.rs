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

use crate::audit::AuditEventId;
use crate::http::{FieldViolation, HttpError, RequestId};
use crate::identity::{BrowserMethod, BrowserRequestHeaders};
use crate::policy::{PolicyCleanupPreview, PolicyImpactPreview};

use super::{
    AdminAuditEventCollectionView, AdminAuditEventView, AdminAuditExportFormat,
    AdminAuditExportInput, AdminAuditListInput, AdminAuditRetentionPreview,
    AdminAuditRetentionPruneView, AdminBackupConsoleView, AdminBackupOperationRequest,
    AdminBackupPolicyUpdate, AdminHttpService, AdminHttpServiceError, AdminMaintenanceView,
    AdminOperationsView, AdminSettingListView, AdminSettingView, AdminStatusView,
    AdminSupportBundleView, AdminUpdateApprovalView, AdminUpdateHistoryView,
    AdminUpdateReadinessView,
};

const SETTINGS: &str = "/api/v1/admin/settings";
const SETTING: &str = "/api/v1/admin/settings/{key}";
const SETTING_IMPACT: &str = "/api/v1/admin/settings/{key}/impact";
const POLICY_CLEANUP_PREVIEW: &str = "/api/v1/admin/policy-cleanup/preview";
const STATUS: &str = "/api/v1/admin/status";
const OPERATIONS: &str = "/api/v1/admin/operations";
const SUPPORT_BUNDLE: &str = "/api/v1/admin/support-bundle";
const AUDIT_EVENTS: &str = "/api/v1/admin/audit-events";
const AUDIT_EVENT: &str = "/api/v1/admin/audit-events/{eventId}";
const AUDIT_EXPORT: &str = "/api/v1/admin/audit-events/export";
const AUDIT_RETENTION_PREVIEW: &str = "/api/v1/admin/audit-retention/preview";
const AUDIT_RETENTION_PRUNE: &str = "/api/v1/admin/audit-retention/prune";
const UPDATE_READINESS: &str = "/api/v1/admin/updates/readiness";
const UPDATE_HISTORY: &str = "/api/v1/admin/updates/history";
const UPDATE_APPROVAL: &str = "/api/v1/admin/updates/approval";
const MAINTENANCE: &str = "/api/v1/admin/maintenance";
const BACKUPS: &str = "/api/v1/admin/backups";
const BACKUP_POLICY: &str = "/api/v1/admin/backups/policy";
const BACKUP_OPERATIONS: &str = "/api/v1/admin/backups/operations";
const MAX_BODY_BYTES: usize = 2 * 1024;
const ORIGIN: HeaderName = HeaderName::from_static("origin");
const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

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
        .routes(routes!(enqueue_backup_operation))
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
async fn backup_console(
    State(service): State<AdminHttpService>,
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
async fn update_backup_policy(
    State(service): State<AdminHttpService>,
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
async fn enqueue_backup_operation(
    State(service): State<AdminHttpService>,
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

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct UpdateSettingRequest {
    value: Value,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct PolicyImpactRequest {
    value: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PolicyCleanupPreviewQuery {
    batch_limit: Option<u16>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuditFilterRequest {
    from: Option<String>,
    to: Option<String>,
    actor_type: Option<String>,
    actor_id: Option<String>,
    action_code: Option<String>,
    result: Option<String>,
    scope_type: Option<String>,
    scope_id: Option<String>,
    target_type: Option<String>,
    target_id: Option<String>,
    cursor: Option<String>,
    limit: Option<u16>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuditExportRequest {
    #[serde(flatten)]
    filters: AuditFilterRequest,
    format: AdminAuditExportFormat,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuditRetentionPreviewQuery {
    retention_days: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct AuditRetentionPruneRequest {
    limit: Option<u16>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateApprovalRequest {
    target_release: String,
    acknowledged: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct MaintenanceRequest {
    enabled: bool,
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
async fn maintenance_status(
    State(service): State<AdminHttpService>,
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
async fn set_maintenance(
    State(service): State<AdminHttpService>,
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
async fn update_readiness(
    State(service): State<AdminHttpService>,
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
    responses(
        (status = 200, body = AdminUpdateHistoryView, headers(("Cache-Control" = String))),
        (status = 401, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 403, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::openapi::ProblemDetails, content_type = "application/problem+json"),
        (status = 504, body = crate::openapi::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn update_history(
    State(service): State<AdminHttpService>,
    Extension(request_id): Extension<RequestId>,
    request: Request,
) -> Result<Response, HttpError> {
    let headers = BrowserHeaders::read(request.headers(), &request_id, UPDATE_HISTORY)?;
    let view = service
        .update_history(headers.request(BrowserMethod::Get))
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
async fn approve_update(
    State(service): State<AdminHttpService>,
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
async fn preview_policy_change(
    State(service): State<AdminHttpService>,
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
async fn preview_policy_cleanup(
    State(service): State<AdminHttpService>,
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
async fn admin_operations(
    State(service): State<AdminHttpService>,
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
async fn support_bundle(
    State(service): State<AdminHttpService>,
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
async fn list_audit_events(
    State(service): State<AdminHttpService>,
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
async fn get_audit_event(
    State(service): State<AdminHttpService>,
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
async fn export_audit_events(
    State(service): State<AdminHttpService>,
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
async fn preview_audit_retention(
    State(service): State<AdminHttpService>,
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
async fn prune_audit_retention(
    State(service): State<AdminHttpService>,
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

fn parse_query<T: DeserializeOwned>(
    uri: &Uri,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    Query::<T>::try_from_uri(uri)
        .map(|query| query.0)
        .map_err(|_| validation(request_id, path, "query"))
}

fn audit_list_input(
    request: AuditFilterRequest,
    request_id: &RequestId,
    path: &str,
) -> Result<AdminAuditListInput, HttpError> {
    let from = request
        .from
        .as_deref()
        .map(str::parse)
        .transpose()
        .map_err(|_| validation(request_id, path, "from"))?;
    let to = request
        .to
        .as_deref()
        .map(str::parse)
        .transpose()
        .map_err(|_| validation(request_id, path, "to"))?;
    Ok(AdminAuditListInput {
        from,
        to,
        actor_type: request.actor_type,
        actor_id: request.actor_id,
        action_code: request.action_code,
        result: request.result,
        scope_type: request.scope_type,
        scope_id: request.scope_id,
        target_type: request.target_type,
        target_id: request.target_id,
        cursor: request.cursor,
        limit: request.limit.unwrap_or(50),
    })
}

fn export_response(
    export: super::AdminAuditExportView,
    request_id: RequestId,
) -> Result<Response, HttpError> {
    let disposition =
        HeaderValue::from_str(&format!("attachment; filename=\"{}\"", export.filename))
            .map_err(|_| HttpError::internal(request_id.clone(), AUDIT_EXPORT))?;
    let content_type = HeaderValue::from_str(export.content_type)
        .map_err(|_| HttpError::internal(request_id.clone(), AUDIT_EXPORT))?;
    let mut response = Response::new(Body::from(export.bytes));
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response.headers_mut().insert(CONTENT_TYPE, content_type);
    response
        .headers_mut()
        .insert(CONTENT_DISPOSITION, disposition);
    response.headers_mut().insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    if let Some(cursor) = export.next_cursor {
        response.headers_mut().insert(
            HeaderName::from_static("x-nuriteo-next-cursor"),
            HeaderValue::from_str(&cursor)
                .map_err(|_| HttpError::internal(request_id, AUDIT_EXPORT))?,
        );
    }
    Ok(response)
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

fn parse_version_etag(
    headers: &HeaderMap,
    request_id: &RequestId,
    path: &str,
    prefix: &str,
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
        .and_then(|value| value.strip_prefix(&format!("\"{prefix}")))
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| HttpError::precondition_failed(request_id.clone(), path))
}

fn backup_response(
    view: AdminBackupConsoleView,
    request_id: RequestId,
    path: &str,
) -> Result<Response, HttpError> {
    let version = view.policy.version;
    let mut response = private_no_store(Json(view).into_response());
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"backup-policy-v{version}\""))
            .map_err(|_| HttpError::internal(request_id, path))?,
    );
    Ok(response)
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
        AdminHttpServiceError::InvalidBackupPolicy => validation(&request_id, path, "policy"),
        AdminHttpServiceError::InvalidBackupOperation => validation(&request_id, path, "operation"),
        AdminHttpServiceError::InvalidAuditQuery => validation(&request_id, path, "query"),
        AdminHttpServiceError::InvalidUpdateApproval => validation(&request_id, path, "approval"),
        AdminHttpServiceError::SettingNotFound
        | AdminHttpServiceError::AuditEventNotFound
        | AdminHttpServiceError::BackupNotFound => HttpError::not_found(request_id, path),
        AdminHttpServiceError::PreconditionFailed => {
            HttpError::precondition_failed(request_id, path)
        }
        AdminHttpServiceError::OperationTimeout => HttpError::operation_timeout(request_id, path),
        AdminHttpServiceError::AuditExportTooLarge => {
            HttpError::payload_too_large(request_id, path)
        }
        AdminHttpServiceError::AuditUnavailable | AdminHttpServiceError::Unavailable => {
            HttpError::service_unavailable(request_id, path)
        }
        AdminHttpServiceError::UpdateBlocked | AdminHttpServiceError::BackupOperationActive => {
            HttpError::conflict(request_id, path)
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
