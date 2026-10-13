use axum::body::{Body, to_bytes};
use axum::extract::Extension;
use axum::http::{Method, Request, StatusCode, header::CONTENT_TYPE};
use axum::response::Response;
use axum::routing::get;
use axum::{Router, middleware};
use nuriteo_server::app::build_router;
use nuriteo_server::http::{
    FieldViolation, HttpError, REQUEST_ID_HEADER, RequestId, propagate_request_id,
};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::{Uuid, Version};

const INBOUND_REQUEST_ID: &str = "edge:trace-01";

#[tokio::test]
async fn propagates_a_valid_inbound_request_id_on_success() {
    let response = send(
        build_router(),
        Request::builder()
            .uri("/api/v1/version")
            .header(REQUEST_ID_HEADER, INBOUND_REQUEST_ID)
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(request_id(&response), INBOUND_REQUEST_ID);
    assert_eq!(json_body(response).await, json!({ "version": "0.1.0" }));
}

#[tokio::test]
async fn replaces_an_invalid_request_id_on_success() {
    let response = send(
        build_router(),
        Request::builder()
            .uri("/api/v1/version")
            .header(REQUEST_ID_HEADER, "x".repeat(129))
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    let generated = request_id(&response);
    let uuid = Uuid::try_parse(generated).unwrap();
    assert_eq!(uuid.get_version(), Some(Version::Random));
}

#[tokio::test]
async fn uses_the_generated_request_id_in_problem_headers_and_bodies() {
    let response = send(
        build_router(),
        Request::builder()
            .uri("/missing")
            .header(REQUEST_ID_HEADER, "contains/slash")
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let generated = request_id(&response).to_owned();
    assert_eq!(
        Uuid::try_parse(&generated).unwrap().get_version(),
        Some(Version::Random)
    );
    assert_eq!(json_body(response).await["request_id"], generated);
}

#[tokio::test]
async fn maps_unknown_routes_to_safe_problem_details() {
    let response = send(
        build_router(),
        Request::builder()
            .uri("/missing/private-token?access_token=do-not-leak")
            .header(REQUEST_ID_HEADER, INBOUND_REQUEST_ID)
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_problem(
        response,
        StatusCode::NOT_FOUND,
        "/docs/problems/route-not-found",
        "Resource not found",
        "ROUTE_NOT_FOUND",
        "/missing/private-token",
        &["access_token=do-not-leak"],
    )
    .await;
}

#[tokio::test]
async fn maps_unsupported_methods_to_safe_problem_details() {
    let response = send(
        build_router(),
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/version?password=do-not-leak")
            .header(REQUEST_ID_HEADER, INBOUND_REQUEST_ID)
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_problem(
        response,
        StatusCode::METHOD_NOT_ALLOWED,
        "/docs/problems/method-not-allowed",
        "Method not allowed",
        "METHOD_NOT_ALLOWED",
        "/api/v1/version",
        &["password=do-not-leak"],
    )
    .await;
}

#[tokio::test]
async fn maps_internal_failures_without_exposing_the_source() {
    async fn fail(Extension(request_id): Extension<RequestId>) -> Result<(), HttpError> {
        Err(HttpError::internal(request_id, "/fail"))
    }

    let response = send(
        Router::new()
            .route("/fail", get(fail))
            .layer(middleware::from_fn(propagate_request_id)),
        Request::builder()
            .uri("/fail?source=database-password")
            .header(REQUEST_ID_HEADER, INBOUND_REQUEST_ID)
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_problem(
        response,
        StatusCode::INTERNAL_SERVER_ERROR,
        "/docs/problems/internal-server-error",
        "Internal server error",
        "INTERNAL_SERVER_ERROR",
        "/fail",
        &["database-password", "stack", "source"],
    )
    .await;
}

#[tokio::test]
async fn bounds_validation_errors() {
    async fn fail(Extension(request_id): Extension<RequestId>) -> Result<(), HttpError> {
        let errors = (0..40).map(|index| {
            FieldViolation::new(format!("fields.{index}"), "INVALID", "Invalid field")
        });
        Err(HttpError::validation(request_id, "/validate", errors))
    }

    let response = send(
        Router::new()
            .route("/validate", get(fail))
            .layer(middleware::from_fn(propagate_request_id)),
        Request::builder()
            .uri("/validate")
            .header(REQUEST_ID_HEADER, INBOUND_REQUEST_ID)
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json_body(response).await["errors"].as_array().map(Vec::len),
        Some(32)
    );
}

async fn send(router: Router, request: Request<Body>) -> Response {
    router.oneshot(request).await.unwrap()
}

fn request_id(response: &Response) -> &str {
    response
        .headers()
        .get(&REQUEST_ID_HEADER)
        .unwrap()
        .to_str()
        .unwrap()
}

async fn json_body(response: Response) -> Value {
    let body = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn assert_problem(
    response: Response,
    expected_status: StatusCode,
    expected_type: &str,
    expected_title: &str,
    expected_code: &str,
    expected_instance: &str,
    forbidden: &[&str],
) {
    assert_eq!(response.status(), expected_status);
    assert_eq!(request_id(&response), INBOUND_REQUEST_ID);
    assert_eq!(
        response.headers().get(CONTENT_TYPE).unwrap(),
        "application/problem+json"
    );

    let body = json_body(response).await;
    let expected_detail = match expected_status {
        StatusCode::NOT_FOUND => "The requested resource does not exist.",
        StatusCode::METHOD_NOT_ALLOWED => {
            "The requested method is not supported for this resource."
        }
        StatusCode::INTERNAL_SERVER_ERROR => "The server could not complete the request.",
        _ => unreachable!(),
    };
    assert_eq!(
        body,
        json!({
            "type": expected_type,
            "title": expected_title,
            "status": expected_status.as_u16(),
            "detail": expected_detail,
            "instance": expected_instance,
            "code": expected_code,
            "request_id": INBOUND_REQUEST_ID,
            "errors": [],
        })
    );
    let serialized = body.to_string();
    for value in forbidden {
        assert!(!serialized.contains(value), "problem body leaked {value}");
    }
}
