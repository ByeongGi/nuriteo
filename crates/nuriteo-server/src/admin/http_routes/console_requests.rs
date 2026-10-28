#![allow(unused_imports)]
use super::console::*;
use super::*;
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
use super::{
    AUDIT_EVENT, AUDIT_EVENTS, AUDIT_EXPORT, AUDIT_RETENTION_PREVIEW, AUDIT_RETENTION_PRUNE,
    AuditExportRequest, AuditFilterRequest, AuditRetentionPreviewQuery, AuditRetentionPruneRequest,
    BACKUP_OPERATIONS, BACKUP_POLICY, BACKUPS, BackupOperationsQuery, BrowserHeaders, CSRF,
    MAINTENANCE, MAX_BODY_BYTES, MaintenanceRequest, OPERATIONS, ORIGIN, POLICY_CLEANUP_PREVIEW,
    PolicyCleanupPreviewQuery, PolicyImpactRequest, SETTING, SETTING_IMPACT, SETTINGS, STATUS,
    SUPPORT_BUNDLE, UPDATE_APPROVAL, UPDATE_HISTORY, UPDATE_READINESS, UpdateApprovalRequest,
    UpdateHistoryQuery, UpdateSettingRequest,
};

pub(crate) fn parse_query<T: DeserializeOwned>(
    uri: &Uri,
    request_id: &RequestId,
    path: &str,
) -> Result<T, HttpError> {
    Query::<T>::try_from_uri(uri)
        .map(|query| query.0)
        .map_err(|_| validation(request_id, path, "query"))
}

pub(crate) fn audit_list_input(
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

pub(crate) fn export_response(
    export: super::super::AdminAuditExportView,
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

impl<'a> BrowserHeaders<'a> {
    pub(crate) fn read(
        headers: &'a HeaderMap,
        request_id: &RequestId,
        path: &str,
    ) -> Result<Self, HttpError> {
        Ok(Self {
            origins: header_values(headers, &ORIGIN)
                .map_err(|_| HttpError::forbidden(request_id.clone(), path))?,
            cookies: header_values(headers, &COOKIE)
                .map_err(|_| HttpError::forbidden(request_id.clone(), path))?,
            csrf: header_values(headers, &CSRF)
                .map_err(|_| HttpError::forbidden(request_id.clone(), path))?,
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

pub(crate) async fn json_body<T: for<'de> Deserialize<'de>>(
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

pub(crate) fn parse_if_match(
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

pub(crate) fn parse_version_etag(
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

pub(crate) fn backup_response(
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

pub(crate) fn setting_response(
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

pub(crate) fn private_no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

pub(crate) fn header_values<'a>(
    headers: &'a HeaderMap,
    name: &HeaderName,
) -> Result<Vec<&'a str>, ()> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().map_err(|_| ()))
        .collect()
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

pub(crate) fn map_error(
    error: AdminHttpServiceError,
    request_id: RequestId,
    path: &str,
) -> HttpError {
    match error {
        AdminHttpServiceError::AuthenticationFailed => HttpError::authentication(request_id, path),
        AdminHttpServiceError::Forbidden => HttpError::forbidden(request_id, path),
        AdminHttpServiceError::ReauthenticationRequired => {
            HttpError::reauthentication_required(request_id, path)
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
