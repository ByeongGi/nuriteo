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

use super::{
    AdminAuditEventCollectionView, AdminAuditEventView, AdminAuditExportFormat,
    AdminAuditExportInput, AdminAuditListInput, AdminAuditRetentionPreview,
    AdminAuditRetentionPruneView, AdminBackupConsoleView, AdminBackupOperationCollectionView,
    AdminBackupOperationRequest, AdminBackupPolicyUpdate, AdminHttpService, AdminHttpServiceError,
    AdminMaintenanceView, AdminOperationsView, AdminSettingListView, AdminSettingView,
    AdminStatusView, AdminSupportBundleView, AdminUpdateApprovalView, AdminUpdateHistoryView,
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

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct BackupOperationsQuery {
    cursor: Option<String>,
    limit: Option<u16>,
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
pub(crate) struct PolicyCleanupPreviewQuery {
    batch_limit: Option<u16>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateHistoryQuery {
    cursor: Option<String>,
    limit: Option<u16>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AuditFilterRequest {
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

struct BrowserHeaders<'a> {
    origins: Vec<&'a str>,
    cookies: Vec<&'a str>,
    csrf: Vec<&'a str>,
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

mod console;
pub(crate) use console::*;
mod console_requests;
pub(crate) use console_requests::*;
