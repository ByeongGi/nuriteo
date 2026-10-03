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
    assert_eq!(format!("{document}\n"), SNAPSHOT);
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
        vec!["/api/v1/version"]
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
