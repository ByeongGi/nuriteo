use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header::CONTENT_TYPE};
use axum::response::Response;
use nuriteo_server::app::build_router;
use nuriteo_server::openapi::{self, DOCS_PATH, DOCUMENT_PATH};
use serde_json::{Value, json};
use tower::ServiceExt;

const REQUEST_ID: &str = "openapi-contract-01";
const SNAPSHOT: &str = include_str!("fixtures/openapi-v1.json");

#[test]
fn versioned_document_matches_the_reviewed_snapshot() {
    let document = serde_json::to_string_pretty(&openapi::document()).unwrap();
    let document = format!("{document}\n");
    if std::env::var_os("NURITEO_UPDATE_OPENAPI_SNAPSHOT").is_some() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/openapi-v1.json");
        std::fs::write(path, &document).unwrap();
        return;
    }
    assert_eq!(document, SNAPSHOT);
}

#[test]
fn audit_api_declares_cursor_export_and_retention_security_boundaries() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let list = &document["paths"]["/api/v1/admin/audit-events"]["get"];
    let parameters = list["parameters"].as_array().unwrap();
    for name in [
        "from",
        "to",
        "actorType",
        "actorId",
        "actionCode",
        "result",
        "scopeType",
        "scopeId",
        "targetType",
        "targetId",
        "cursor",
        "limit",
    ] {
        assert!(parameters.iter().any(|parameter| parameter["name"] == name));
    }
    assert_eq!(
        list["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/AdminAuditEventCollectionView"
    );
    for path in [
        "/api/v1/admin/audit-events/export",
        "/api/v1/admin/audit-retention/prune",
    ] {
        let operation = &document["paths"][path]["post"];
        let headers = operation["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|parameter| parameter["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(headers.contains(&"Origin"));
        assert!(headers.contains(&"X-CSRF-Token"));
        assert_eq!(operation["security"][0]["projectSessionCookie"], json!([]));
    }
    assert_eq!(
        document["components"]["schemas"]["AdminAuditExportFormat"]["enum"],
        json!(["jsonl", "csv"])
    );
    let export_response =
        &document["paths"]["/api/v1/admin/audit-events/export"]["post"]["responses"]["200"];
    assert!(
        export_response["content"]
            .get("application/x-ndjson")
            .is_some()
    );
    assert!(export_response["content"].get("text/csv").is_some());
    assert!(
        export_response["content"]
            .get("application/octet-stream")
            .is_none()
    );
    assert!(
        export_response["headers"]
            .get("Content-Disposition")
            .is_some()
    );
    assert!(
        export_response["headers"]
            .get("X-Nuriteo-Next-Cursor")
            .is_some()
    );
}

#[test]
fn operations_dashboard_is_admin_only_and_uses_safe_aggregate_schema() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let operation = &document["paths"]["/api/v1/admin/operations"]["get"];
    assert_eq!(operation["security"][0]["projectSessionCookie"], json!([]));
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/AdminOperationsView"
    );
    let usage = &document["components"]["schemas"]["AdminUsageView"]["properties"];
    for name in [
        "activeUsers",
        "activeOrganizations",
        "activeProjects",
        "verifiedBundles",
        "trackedPhysicalBytes",
        "reservedBytes",
    ] {
        assert!(usage.get(name).is_some());
    }
    for forbidden in ["objectKey", "endpoint", "credential", "error", "sql"] {
        assert!(usage.get(forbidden).is_none());
    }
}

#[tokio::test]
async fn serves_the_versioned_document_from_the_application_router() {
    let response = get(build_router(), DOCUMENT_PATH).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/json");
    let document = json_body(response).await;
    assert_eq!(document["openapi"], "3.1.0");
    assert_eq!(document["info"]["version"], "1.0.0");
    assert_eq!(
        document["paths"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec![
            "/api/v1/access-tokens",
            "/api/v1/access-tokens/{tokenId}",
            "/api/v1/access-tokens/{tokenId}/rotate",
            "/api/v1/admin/activation-invitations",
            "/api/v1/admin/activation-invitations/{invitation_id}",
            "/api/v1/admin/activation-invitations/{invitation_id}/reissue",
            "/api/v1/admin/audit-events",
            "/api/v1/admin/audit-events/export",
            "/api/v1/admin/audit-events/{eventId}",
            "/api/v1/admin/audit-retention/preview",
            "/api/v1/admin/audit-retention/prune",
            "/api/v1/admin/email-deliveries",
            "/api/v1/admin/email-deliveries/{deliveryId}/cancel",
            "/api/v1/admin/email-deliveries/{deliveryId}/retry",
            "/api/v1/admin/mfa-policy",
            "/api/v1/admin/mfa-policy/preview",
            "/api/v1/admin/mfa-reset-targets",
            "/api/v1/admin/oidc/providers",
            "/api/v1/admin/oidc/providers/{providerId}",
            "/api/v1/admin/oidc/providers/{providerId}/activate",
            "/api/v1/admin/oidc/providers/{providerId}/disable",
            "/api/v1/admin/oidc/providers/{providerId}/rotate-secret",
            "/api/v1/admin/operations",
            "/api/v1/admin/policy-cleanup/preview",
            "/api/v1/admin/settings",
            "/api/v1/admin/settings/{key}",
            "/api/v1/admin/settings/{key}/impact",
            "/api/v1/admin/status",
            "/api/v1/admin/users/{userId}/mfa/reset",
            "/api/v1/auth/activation",
            "/api/v1/auth/oidc/providers",
            "/api/v1/auth/oidc/{providerId}/begin",
            "/api/v1/auth/oidc/{providerId}/callback",
            "/api/v1/auth/session",
            "/api/v1/auth/sessions",
            "/api/v1/me",
            "/api/v1/me/oidc-identities",
            "/api/v1/me/oidc-identities/{providerId}",
            "/api/v1/me/organization-invitations/accept",
            "/api/v1/me/organization-invitations/decline",
            "/api/v1/me/workspaces",
            "/api/v1/mfa",
            "/api/v1/mfa/challenge",
            "/api/v1/mfa/enrollment",
            "/api/v1/mfa/enrollment/confirm",
            "/api/v1/mfa/recovery",
            "/api/v1/notification-preferences",
            "/api/v1/notifications",
            "/api/v1/notifications/{notificationId}",
            "/api/v1/organizations",
            "/api/v1/organizations/{organization_id}",
            "/api/v1/organizations/{organization_id}/archive",
            "/api/v1/organizations/{organization_id}/invitations",
            "/api/v1/organizations/{organization_id}/invitations/{invitation_id}",
            "/api/v1/organizations/{organization_id}/invitations/{invitation_id}/reissue",
            "/api/v1/organizations/{organization_id}/members",
            "/api/v1/organizations/{organization_id}/members/{user_id}",
            "/api/v1/organizations/{organization_id}/teams",
            "/api/v1/organizations/{organization_id}/teams/{team_id}",
            "/api/v1/organizations/{organization_id}/teams/{team_id}/members",
            "/api/v1/organizations/{organization_id}/teams/{team_id}/members/{user_id}",
            "/api/v1/organizations/{organization_id}/teams/{team_id}/project-roles",
            "/api/v1/organizations/{organization_id}/teams/{team_id}/project-roles/{project_id}",
            "/api/v1/projects/{projectId}/access-tokens",
            "/api/v1/projects/{projectId}/access-tokens/{tokenId}",
            "/api/v1/projects/{projectId}/access-tokens/{tokenId}/rotate",
            "/api/v1/setup/status",
            "/api/v1/version",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/archive",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/content",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/content/{bundle_id}",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/history/restore",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/recovery-checkpoints",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/restore",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/roles",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/roles/{user_id}",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/complete",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/parts",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/parts/receipts",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/reconcile",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/upload",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/upload/parts/{part_number}",
            "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/versions"
        ]
    );
    assert_eq!(
        document["paths"]["/api/v1/me/workspaces"]["get"]["responses"]["200"]["content"]["application/json"]
            ["schema"]["$ref"],
        "#/components/schemas/WorkspaceCollectionView"
    );
    let setup = &document["paths"]["/api/v1/setup/status"]["get"];
    assert!(setup.get("security").is_none());
    assert_eq!(
        setup["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/SetupStatus"
    );
    assert_eq!(
        setup["responses"]["200"]["headers"]["cache-control"]["description"],
        "Always no-store"
    );
    assert_eq!(
        document["components"]["schemas"]["SetupStatus"]["required"],
        json!(["bootstrapRequired"])
    );
    assert_eq!(
        document["components"]["schemas"]["SetupStatus"]["properties"]
            .as_object()
            .expect("setup properties must be an object")
            .keys()
            .collect::<Vec<_>>(),
        vec!["bootstrapRequired"]
    );
}

#[test]
fn team_api_declares_session_csrf_etag_and_no_store_contracts() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    for path in [
        "/api/v1/organizations/{organization_id}/teams",
        "/api/v1/organizations/{organization_id}/teams/{team_id}",
        "/api/v1/organizations/{organization_id}/teams/{team_id}/members",
        "/api/v1/organizations/{organization_id}/teams/{team_id}/members/{user_id}",
        "/api/v1/organizations/{organization_id}/teams/{team_id}/project-roles",
        "/api/v1/organizations/{organization_id}/teams/{team_id}/project-roles/{project_id}",
    ] {
        for (method, operation) in document["paths"][path].as_object().unwrap() {
            assert_eq!(
                operation["security"],
                json!([{"projectSessionCookie": []}]),
                "{method} {path} must require a browser Session"
            );
            let parameters = operation["parameters"].as_array().unwrap();
            if method != "get" {
                for header in ["Origin", "X-CSRF-Token"] {
                    assert!(parameters.iter().any(|item| item["name"] == header));
                }
            }
            for status in ["401", "403", "404", "422", "503", "504"] {
                assert!(
                    operation["responses"].get(status).is_some(),
                    "{method} {path} must document runtime status {status}"
                );
            }
            if operation.get("requestBody").is_some() {
                for status in ["413", "415"] {
                    assert!(
                        operation["responses"].get(status).is_some(),
                        "{method} {path} JSON body must document {status}"
                    );
                }
            }
            if method != "get" {
                assert!(operation["responses"].get("409").is_some());
            }
            for response in operation["responses"].as_object().unwrap().values() {
                if let Some(schema) = response
                    .get("content")
                    .and_then(|content| content.get("application/problem+json"))
                {
                    assert_eq!(
                        schema["schema"]["$ref"],
                        "#/components/schemas/ProblemDetails"
                    );
                }
            }
        }
    }

    for (path, method) in [
        (
            "/api/v1/organizations/{organization_id}/teams/{team_id}",
            "patch",
        ),
        (
            "/api/v1/organizations/{organization_id}/teams/{team_id}/members/{user_id}",
            "patch",
        ),
        (
            "/api/v1/organizations/{organization_id}/teams/{team_id}/project-roles/{project_id}",
            "patch",
        ),
    ] {
        let operation = &document["paths"][path][method];
        assert!(
            operation["parameters"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["name"] == "If-Match")
        );
        assert!(operation["responses"].get("412").is_some());
        assert!(operation["responses"].get("428").is_some());
    }
}

#[tokio::test]
async fn problem_schema_tracks_the_actual_safe_error_shape() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let schema = &document["components"]["schemas"]["ProblemDetails"];
    assert_eq!(
        schema["required"],
        json!([
            "type",
            "title",
            "status",
            "detail",
            "instance",
            "code",
            "request_id",
            "errors"
        ])
    );

    let response = get(build_router(), "/missing/private?access_token=do-not-leak").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let problem = json_body(response).await;
    assert_eq!(
        sorted_keys(&problem),
        vec![
            "code",
            "detail",
            "errors",
            "instance",
            "request_id",
            "status",
            "title",
            "type"
        ]
    );
    let serialized = problem.to_string();
    for secret in ["access_token", "do-not-leak", "/private/", "stack trace"] {
        assert!(
            !serialized.contains(secret),
            "problem response leaked {secret}"
        );
    }
}

#[test]
fn project_openapi_declares_every_error_as_problem_json() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let scheme = &document["components"]["securitySchemes"]["projectSessionCookie"];
    assert_eq!(scheme["type"], "apiKey");
    assert_eq!(scheme["in"], "cookie");
    assert_eq!(scheme["name"], "__Host-nuriteo_session");
    for (path, item) in document["paths"].as_object().unwrap() {
        if !path.contains("/projects") {
            continue;
        }
        for (method, operation) in item.as_object().unwrap() {
            assert_eq!(
                operation["security"],
                json!([{"projectSessionCookie": []}]),
                "{path} must require the production host-only Session cookie"
            );
            if operation.get("requestBody").is_some() {
                for status in ["413", "415"] {
                    assert!(
                        operation["responses"].get(status).is_some(),
                        "{path} JSON-body operation must document {status}"
                    );
                }
            }
            let required_headers = operation["parameters"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|parameter| parameter["in"] == "header")
                .map(|parameter| {
                    assert_eq!(parameter["required"], true);
                    parameter["name"].as_str().unwrap()
                })
                .collect::<Vec<_>>();
            if method == "get" {
                assert!(!required_headers.contains(&"Origin"));
                assert!(!required_headers.contains(&"X-CSRF-Token"));
            } else {
                assert!(
                    required_headers.contains(&"Origin"),
                    "{method} {path} must require Origin"
                );
                assert!(
                    required_headers.contains(&"X-CSRF-Token"),
                    "{method} {path} must require X-CSRF-Token"
                );
            }
            for (status, response) in operation["responses"].as_object().unwrap() {
                if status.starts_with('2') {
                    continue;
                }
                let content = response["content"].as_object().unwrap_or_else(|| {
                    panic!("{path} response {status} must declare Problem content")
                });
                assert_eq!(
                    content.keys().collect::<Vec<_>>(),
                    vec!["application/problem+json"],
                    "{path} response {status} must be RFC 9457"
                );
                assert_eq!(
                    content["application/problem+json"]["schema"]["$ref"],
                    "#/components/schemas/ProblemDetails"
                );
            }
        }
    }
}

#[test]
fn project_content_download_is_declared_as_binary_octets() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let response = &document["paths"]["/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/content/{bundle_id}"]
        ["get"]["responses"]["200"];
    assert_eq!(
        response["content"]["application/octet-stream"]["schema"],
        json!({"type": "string", "format": "binary"})
    );
    assert!(
        response["content"].get("text/plain").is_none(),
        "Project Bundle bytes must never be modeled as text"
    );
}

#[test]
fn organization_invitation_issue_is_email_addressed_and_enumeration_safe() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let operation =
        &document["paths"]["/api/v1/organizations/{organization_id}/invitations"]["post"];
    assert_eq!(
        operation["requestBody"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/IssueInvitationRequest"
    );
    let schema = &document["components"]["schemas"]["IssueInvitationRequest"];
    assert_eq!(schema["required"], json!(["email", "role"]));
    assert_eq!(schema["properties"]["email"]["type"], "string");
    assert_eq!(schema["properties"]["email"]["maxLength"], 320);
    assert!(schema["properties"].get("inviteeUserId").is_none());
    assert_eq!(
        operation["responses"]["404"]["content"]["application/problem+json"]["schema"]["$ref"],
        "#/components/schemas/ProblemDetails"
    );
}

#[test]
fn explicit_project_versions_expose_bounded_immutable_contract() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let operation = &document["paths"]["/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/versions"];
    assert_eq!(
        operation["post"]["responses"]["201"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/ProjectVersionCreateView"
    );
    assert_eq!(
        operation["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/ProjectVersionListView"
    );
    let page_size = operation["get"]["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|parameter| parameter["name"] == "pageSize")
        .expect("Version pageSize query parameter must be declared");
    assert_eq!(page_size["schema"]["minimum"], 1);
    assert_eq!(page_size["schema"]["maximum"], 100);
    let post_headers = operation["post"]["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|parameter| parameter["in"] == "header")
        .map(|parameter| parameter["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    for required in ["If-Match", "Idempotency-Key", "Origin", "X-CSRF-Token"] {
        assert!(post_headers.contains(&required));
    }
    assert_eq!(
        document["components"]["schemas"]["ProjectVersionView"]["required"],
        json!([
            "id",
            "projectId",
            "bundleId",
            "name",
            "createdByUserId",
            "sourceProjectVersion",
            "createdAt",
            "sha256",
            "physicalBytes",
            "logicalBytes",
            "fileCount",
            "format"
        ])
    );
}

#[test]
fn project_history_exposes_recovery_list_promotion_and_reconcile() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let recoveries = &document["paths"]["/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/recovery-checkpoints"];
    assert_eq!(
        recoveries["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/RecoveryCheckpointListView"
    );
    assert!(recoveries.get("post").is_none());

    let history = &document["paths"]["/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/history/restore"];
    assert_eq!(
        history["post"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/HistoricalPromotionView"
    );
    assert_eq!(
        history["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/HistoricalPromotionView"
    );
    let post_headers = history["post"]["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|parameter| parameter["in"] == "header")
        .map(|parameter| parameter["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    for required in ["If-Match", "Idempotency-Key", "Origin", "X-CSRF-Token"] {
        assert!(post_headers.contains(&required));
    }
    let reconcile_headers = history["get"]["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|parameter| parameter["in"] == "header")
        .map(|parameter| parameter["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(reconcile_headers.contains(&"Idempotency-Key"));
    assert_eq!(
        document["components"]["schemas"]["HistoricalPromotionView"]["required"],
        json!([
            "operationId",
            "referenceKind",
            "referenceId",
            "bundleId",
            "projectVersion",
            "changed",
            "idempotentRetry"
        ])
    );
}

#[test]
fn save_http_exposes_bounded_restart_safe_workflow() {
    let document = serde_json::to_value(openapi::document()).unwrap();
    let collection = &document["paths"]["/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions"]
        ["post"];
    assert_eq!(
        collection["responses"]["201"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/SaveSessionView"
    );
    assert_eq!(
        collection["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/SaveSessionView"
    );
    let required_headers = collection["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|parameter| parameter["in"] == "header")
        .map(|parameter| parameter["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    for header in ["If-Match", "Idempotency-Key", "Origin", "X-CSRF-Token"] {
        assert!(required_headers.contains(&header));
    }
    let capabilities = document["components"]["schemas"]["UploadCapabilityView"]["oneOf"]
        .as_array()
        .unwrap();
    assert_eq!(capabilities.len(), 2);
    assert_eq!(
        capabilities[0]["required"],
        json!(["method", "url", "headers", "expectedBytes", "transport"])
    );
    assert_eq!(
        capabilities[0]["properties"]["transport"]["enum"],
        json!(["direct"])
    );
    assert_eq!(
        capabilities[1]["required"],
        json!(["method", "path", "headers", "expectedBytes", "transport"])
    );
    assert_eq!(
        capabilities[1]["properties"]["transport"]["enum"],
        json!(["relay"])
    );
    assert!(capabilities[1]["properties"].get("url").is_none());
    for path in [
        "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/upload",
        "/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions/{session_id}/upload/parts/{part_number}",
    ] {
        let operation = &document["paths"][path]["put"];
        assert_eq!(
            operation["requestBody"]["content"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            vec!["application/vnd.nuriteo.project-bundle"]
        );
        assert_eq!(
            operation["requestBody"]["content"]["application/vnd.nuriteo.project-bundle"]["schema"],
            json!({"type": "string", "format": "binary"})
        );
        let headers = operation["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|parameter| parameter["in"] == "header")
            .map(|parameter| parameter["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        for required in [
            "Content-Length",
            "X-Nuriteo-Content-SHA256",
            "Origin",
            "X-CSRF-Token",
        ] {
            assert!(headers.contains(&required));
        }
    }
    assert_eq!(
        document["components"]["schemas"]["ReconcileView"]["oneOf"][0]["required"],
        json!(["bundleId", "projectVersion", "state"])
    );
}

#[tokio::test]
async fn swagger_ui_is_self_contained_and_loads_only_vendored_assets() {
    let redirect = get(build_router(), DOCS_PATH).await;
    assert!(redirect.status().is_redirection());

    let response = get(build_router(), "/api/docs/").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[CONTENT_TYPE], "text/html");
    let html = text_body(response).await;

    let initializer =
        text_body(get(build_router(), "/api/docs/swagger-initializer.js").await).await;
    assert!(initializer.contains(DOCUMENT_PATH));
    assert!(initializer.contains("\"validatorUrl\": \"none\""));
    let delivered_ui = format!("{html}\n{initializer}");
    for remote in ["https://", "http://", "//cdn", "validator.swagger.io"] {
        assert!(
            !delivered_ui.contains(remote),
            "Swagger UI references {remote}"
        );
    }

    for asset in [
        "/api/docs/swagger-ui.css",
        "/api/docs/swagger-ui-bundle.js",
        "/api/docs/swagger-ui-standalone-preset.js",
        "/api/docs/swagger-initializer.js",
        "/api/docs/favicon-32x32.png",
    ] {
        let response = get(build_router(), asset).await;
        assert_eq!(response.status(), StatusCode::OK, "missing {asset}");
        assert!(!body(response).await.is_empty(), "empty {asset}");
    }
}

async fn get(router: Router, uri: &str) -> Response {
    router
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("x-request-id", REQUEST_ID)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn body(response: Response) -> Vec<u8> {
    to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec()
}

async fn text_body(response: Response) -> String {
    String::from_utf8(body(response).await).unwrap()
}

async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&body(response).await).unwrap()
}

fn sorted_keys(value: &Value) -> Vec<&str> {
    let mut keys = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys
}
