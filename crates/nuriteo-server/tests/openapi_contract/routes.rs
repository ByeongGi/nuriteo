#![allow(unused_imports)]
use super::*;
use super::document::*;
use axum::Router;

use axum::body::{Body, to_bytes};

use axum::http::{Request, StatusCode, header::CONTENT_TYPE};

use axum::response::Response;

use nuriteo_server::app::build_router;

use nuriteo_server::openapi::{self, DOCS_PATH, DOCUMENT_PATH};

use serde_json::{Value, json};

use tower::ServiceExt;
use super::{REQUEST_ID, SNAPSHOT};



#[test]
pub(crate) fn organization_invitation_issue_is_email_addressed_and_enumeration_safe() {    let document = serde_json::to_value(openapi::document()).unwrap();
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
pub(crate) fn explicit_project_versions_expose_bounded_immutable_contract() {    let document = serde_json::to_value(openapi::document()).unwrap();
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
pub(crate) fn project_history_exposes_recovery_list_promotion_and_reconcile() {    let document = serde_json::to_value(openapi::document()).unwrap();
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
pub(crate) fn save_http_exposes_bounded_restart_safe_workflow() {    let document = serde_json::to_value(openapi::document()).unwrap();
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
pub(crate) async fn swagger_ui_is_self_contained_and_loads_only_vendored_assets() {    let redirect = get(build_router(), DOCS_PATH).await;
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


pub(crate) async fn get(router: Router, uri: &str) -> Response {    router
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


pub(crate) async fn body(response: Response) -> Vec<u8> {    to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec()
}


pub(crate) async fn text_body(response: Response) -> String {    String::from_utf8(body(response).await).unwrap()
}


pub(crate) async fn json_body(response: Response) -> Value {    serde_json::from_slice(&body(response).await).unwrap()
}


pub(crate) fn sorted_keys(value: &Value) -> Vec<&str> {    let mut keys = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys
}

