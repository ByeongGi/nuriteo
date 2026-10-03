use axum::body::{Body, to_bytes};
use axum::extract::Extension;
use axum::http::{Method, Request, StatusCode, header::CONTENT_TYPE};
use axum::response::Response;
use axum::routing::get;
use axum::{Router, middleware};
use nuriteo_server::app::build_router;
use nuriteo_server::http::{HttpError, REQUEST_ID_HEADER, RequestId, propagate_request_id};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::{Uuid, Version};

const INBOUND_REQUEST_ID: &str = "018f47a2-9d3c-7b21-a848-123456789abc";

#[tokio::test]
async fn propagates_a_valid_inbound_request_id_on_success() {
    let response = send(
        build_router(),
        Request::builder()
            .uri("/health/live")
            .header(REQUEST_ID_HEADER, INBOUND_REQUEST_ID)
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(request_id(&response), INBOUND_REQUEST_ID);
    assert_eq!(json_body(response).await, json!({ "status": "ok" }));
}

#[tokio::test]
async fn replaces_an_invalid_request_id_on_success() {
    let response = send(
        build_router(),
        Request::builder()
            .uri("/health/live")
            .header(REQUEST_ID_HEADER, "attacker-controlled")
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
            .header(REQUEST_ID_HEADER, "attacker-controlled")
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let generated = request_id(&response).to_owned();
    let uuid = Uuid::try_parse(&generated).unwrap();
    assert_eq!(uuid.get_version(), Some(Version::Random));

    let body = json_body(response).await;
    assert_eq!(body["requestId"], generated);
}

#[tokio::test]
async fn maps_unknown_routes_to_safe_problem_details() {
    let secret_path = "/missing/private-token";
    let secret_query = "access_token=do-not-leak";
    let response = send(
        build_router(),
        Request::builder()
            .uri(format!("{secret_path}?{secret_query}"))
            .header(REQUEST_ID_HEADER, INBOUND_REQUEST_ID)
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_problem(
        response,
        StatusCode::NOT_FOUND,
        "urn:nuriteo:problem:not-found",
        "Resource not found",
        "not_found",
        &[secret_path, secret_query],
    )
    .await;
}

#[tokio::test]
async fn maps_unsupported_methods_to_safe_problem_details() {
    let response = send(
        build_router(),
        Request::builder()
            .method(Method::POST)
            .uri("/health/live?password=do-not-leak")
            .header(REQUEST_ID_HEADER, INBOUND_REQUEST_ID)
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_problem(
        response,
        StatusCode::METHOD_NOT_ALLOWED,
        "urn:nuriteo:problem:method-not-allowed",
        "Method not allowed",
        "method_not_allowed",
        &["/health/live", "password=do-not-leak"],
    )
    .await;
}

#[tokio::test]
async fn maps_internal_failures_without_exposing_the_source() {
    async fn fail(Extension(request_id): Extension<RequestId>) -> Result<(), HttpError> {
        Err(HttpError::internal(request_id))
    }

    let router = Router::new()
        .route("/fail", get(fail))
        .layer(middleware::from_fn(propagate_request_id));
    let response = send(
        router,
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
        "urn:nuriteo:problem:internal",
        "Internal server error",
        "internal_error",
        &["database-password", "stack", "source"],
    )
    .await;
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
    forbidden: &[&str],
) {
    assert_eq!(response.status(), expected_status);
    assert_eq!(request_id(&response), INBOUND_REQUEST_ID);
    assert_eq!(
        response.headers().get(CONTENT_TYPE).unwrap(),
        "application/problem+json"
    );

    let body = json_body(response).await;
    assert_eq!(
        body,
        json!({
            "type": expected_type,
            "title": expected_title,
            "status": expected_status.as_u16(),
            "code": expected_code,
            "requestId": INBOUND_REQUEST_ID,
        })
    );
    let serialized = body.to_string();
    for value in forbidden {
        assert!(!serialized.contains(value), "problem body leaked {value}");
    }
}
