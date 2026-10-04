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
            "/api/v1/admin/activation-invitations",
            "/api/v1/admin/activation-invitations/{invitation_id}",
            "/api/v1/admin/activation-invitations/{invitation_id}/reissue",
            "/api/v1/auth/activation",
            "/api/v1/auth/session",
            "/api/v1/auth/sessions",
            "/api/v1/me",
            "/api/v1/me/organization-invitations/accept",
            "/api/v1/me/organization-invitations/decline",
            "/api/v1/me/workspaces",
            "/api/v1/organizations",
            "/api/v1/organizations/{organization_id}",
            "/api/v1/organizations/{organization_id}/archive",
            "/api/v1/organizations/{organization_id}/invitations",
            "/api/v1/organizations/{organization_id}/invitations/{invitation_id}",
            "/api/v1/organizations/{organization_id}/invitations/{invitation_id}/reissue",
            "/api/v1/organizations/{organization_id}/members",
            "/api/v1/organizations/{organization_id}/members/{user_id}",
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
    assert_eq!(
        document["components"]["schemas"]["UploadCapabilityView"]["required"],
        json!(["method", "url", "headers", "expectedBytes"])
    );
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
