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

use super::http_service::{
    HistoricalPromotionView, ProjectHttpError, ProjectHttpService, ProjectListView,
    ProjectRoleListView, ProjectRoleMutationView, ProjectVersionCreateView, ProjectVersionListView,
    ProjectView, RecoveryCheckpointListView, RoleOperation,
};

use super::{
    ProjectId, ProjectName, ProjectOwner, ProjectPageLimit, ProjectRole, ProjectRolePageLimit,
    ProjectSlug, ProjectState, ProjectTemplate, ProjectVersion,
};

use crate::access_token::{AccessTokenScope, ApiCategory};

const COLLECTION: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects";

const ITEM: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}";

const ARCHIVE: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/archive";

const RESTORE: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/restore";

const ROLES: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/roles";

const ROLE: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/roles/{user_id}";

const CONTENT: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/content";

const CONTENT_DOWNLOAD: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/content/{bundle_id}";

const VERSIONS: &str = "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/versions";

const RECOVERY_CHECKPOINTS: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/recovery-checkpoints";

const HISTORY_RESTORE: &str =
    "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/history/restore";

const MAX_BODY: usize = 4096;

const MAX_QUERY: usize = 4096;

const MAX_AUTHORIZATION_BYTES: usize = 256;

const ORIGIN: HeaderName = HeaderName::from_static("origin");

const CSRF: HeaderName = HeaderName::from_static("x-csrf-token");

const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct CreateVersionRequest {
    name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromoteHistoryRequest {
    reference_kind: String,
    reference_id: String,
}

struct ProjectBundleBinary;

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct CreateProjectRequest {
    slug: String,
    name: String,
    #[serde(rename = "templateId")]
    template: ProjectTemplate,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct RenameProjectRequest {
    name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct DeleteProjectRequest {
    name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GrantRoleRequest {
    user_id: String,
    role: ProjectRole,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ChangeRoleRequest {
    role: ProjectRole,
}

struct BrowserHeaders<'a> {
    cookies: Vec<&'a str>,
    origins: Vec<&'a str>,
    csrf: Vec<&'a str>,
}

struct ListQuery {
    state: Option<ProjectState>,
    state_supplied: bool,
    page_size: u16,
    cursor: Option<String>,
}

struct VersionListQuery {
    page_size: u16,
    cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exceptional_service_failures_have_distinct_stable_problems() {
        for (error, status, code) in [
            (
                ProjectHttpError::CommitOutcomeUnknown,
                StatusCode::SERVICE_UNAVAILABLE,
                "COMMIT_OUTCOME_UNKNOWN",
            ),
            (
                ProjectHttpError::OperationTimeout,
                StatusCode::GATEWAY_TIMEOUT,
                "OPERATION_TIMEOUT",
            ),
            (
                ProjectHttpError::AuditUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
            ),
            (
                ProjectHttpError::RateLimited,
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
            ),
        ] {
            let response = map_error(error, RequestId::generate(), ITEM).into_response();
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
            let body = to_bytes(response.into_body(), MAX_BODY).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["code"], code);
            assert!(!body.to_string().contains("postgres://"));
        }
    }

    #[test]
    fn strong_project_etag_parser_rejects_missing_weak_and_duplicate_values() {
        let request_id = RequestId::generate();
        assert!(parse_if_match(&HeaderMap::new(), &request_id, ITEM).is_err());
        let mut weak = HeaderMap::new();
        weak.insert(IF_MATCH, HeaderValue::from_static("W/\"project-v1\""));
        assert!(parse_if_match(&weak, &request_id, ITEM).is_err());
        let mut duplicate = HeaderMap::new();
        duplicate.append(IF_MATCH, HeaderValue::from_static("\"project-v1\""));
        duplicate.append(IF_MATCH, HeaderValue::from_static("\"project-v2\""));
        assert!(parse_if_match(&duplicate, &request_id, ITEM).is_err());
        for malformed in ["\"project-v+1\"", "\"project-v01\"", "\"project-v 1\""] {
            let mut headers = HeaderMap::new();
            headers.insert(IF_MATCH, HeaderValue::from_static(malformed));
            assert!(parse_if_match(&headers, &request_id, ITEM).is_err());
        }
    }

    #[test]
    fn list_query_rejects_empty_and_duplicate_cursor_pollution() {
        let request_id = RequestId::generate();
        assert!(ListQuery::parse(Some("cursor="), &request_id, COLLECTION).is_err());
        assert!(
            ListQuery::parse(
                Some("cursor=&cursor=nrt_project_cursor_value"),
                &request_id,
                COLLECTION,
            )
            .is_err()
        );
        assert!(
            ListQuery::parse(
                Some("cursor=nrt_project_cursor_one&cursor=nrt_project_cursor_two"),
                &request_id,
                COLLECTION,
            )
            .is_err()
        );
    }

    #[test]
    fn bearer_parser_rejects_ambiguous_or_non_canonical_credentials() {
        let request_id = RequestId::generate();
        let mut valid = HeaderMap::new();
        valid.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer nur_pat_token"),
        );
        assert_eq!(
            bearer_token(&valid, &request_id, ITEM).unwrap(),
            Some("nur_pat_token")
        );

        for value in ["bearer token", "Bearer", "Bearer ", "Bearer token extra"] {
            let mut headers = HeaderMap::new();
            headers.insert(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
            assert!(bearer_token(&headers, &request_id, ITEM).is_err());
        }

        valid.insert(
            COOKIE,
            HeaderValue::from_static("nuriteo_dev_session=value"),
        );
        assert!(bearer_token(&valid, &request_id, ITEM).is_err());

        let mut duplicate = HeaderMap::new();
        duplicate.append(AUTHORIZATION, HeaderValue::from_static("Bearer one"));
        duplicate.append(AUTHORIZATION, HeaderValue::from_static("Bearer two"));
        assert!(bearer_token(&duplicate, &request_id, ITEM).is_err());
    }
}

mod project_http;
pub(crate) use project_http::*;
mod role_http;
pub(crate) use role_http::*;
