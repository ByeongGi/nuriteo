use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{Request, StatusCode};
use axum::middleware;
use serde_json::json;
use tower::ServiceExt;

use crate::http::{REQUEST_ID_HEADER, propagate_request_id};

use super::repository::SetupStatusRepositoryError;
use super::routes::openapi_router;
use super::service::{RepositoryFuture, SetupStatusReader};
use super::{
    SetupStatusPolicy, SetupStatusPolicyError, SetupStatusService, SetupStatusServiceError,
};

struct FixedReader(Result<bool, SetupStatusRepositoryError>);

impl SetupStatusReader for FixedReader {
    fn active_instance_administrator_exists(&self) -> RepositoryFuture<'_> {
        Box::pin(std::future::ready(self.0))
    }
}

struct PendingReader;

impl SetupStatusReader for PendingReader {
    fn active_instance_administrator_exists(&self) -> RepositoryFuture<'_> {
        Box::pin(std::future::pending())
    }
}

#[tokio::test]
async fn status_is_the_inverse_of_active_instance_administrator_presence() {
    for (administrator_exists, bootstrap_required) in [(false, true), (true, false)] {
        let service = SetupStatusService::from_reader(
            Arc::new(FixedReader(Ok(administrator_exists))),
            SetupStatusPolicy::default(),
        );
        let status = service.status().await.expect("status must resolve");
        assert_eq!(status.bootstrap_required(), bootstrap_required);
        assert_eq!(
            serde_json::to_value(status).expect("status must serialize"),
            json!({"bootstrapRequired": bootstrap_required})
        );
    }
}

#[tokio::test]
async fn repository_failures_and_deadlines_are_stable_and_context_free() {
    for (repository_error, expected) in [
        (
            SetupStatusRepositoryError::Unavailable,
            SetupStatusServiceError::Unavailable,
        ),
        (
            SetupStatusRepositoryError::InvalidPersistedState,
            SetupStatusServiceError::Internal,
        ),
    ] {
        let service = SetupStatusService::from_reader(
            Arc::new(FixedReader(Err(repository_error))),
            SetupStatusPolicy::default(),
        );
        let error = service.status().await.expect_err("status must fail closed");
        assert_eq!(error, expected);
        assert!(!format!("{error:?}: {error}").contains("SELECT"));
    }

    let service = SetupStatusService::from_reader(
        Arc::new(PendingReader),
        SetupStatusPolicy::new(Duration::from_millis(100)).expect("policy must be valid"),
    );
    assert_eq!(
        service.status().await,
        Err(SetupStatusServiceError::OperationTimeout)
    );
}

#[test]
fn policy_and_unconfigured_service_fail_closed() {
    for timeout in [Duration::ZERO, Duration::from_secs(31)] {
        assert_eq!(
            SetupStatusPolicy::new(timeout),
            Err(SetupStatusPolicyError::InvalidOperationTimeout)
        );
    }
    let service = SetupStatusService::unconfigured();
    assert_eq!(
        format!("{service:?}"),
        "SetupStatusService { configured: false, policy: SetupStatusPolicy { operation_timeout: 2s } }"
    );
}

#[tokio::test]
async fn public_route_is_exact_secret_free_and_never_cacheable() {
    let service = SetupStatusService::from_reader(
        Arc::new(FixedReader(Ok(false))),
        SetupStatusPolicy::default(),
    );
    let (router, _) = openapi_router(utoipa::openapi::OpenApi::default())
        .with_state::<()>(service)
        .split_for_parts();
    let response = router
        .layer(middleware::from_fn(propagate_request_id))
        .oneshot(
            Request::builder()
                .uri("/api/v1/setup/status")
                .header(REQUEST_ID_HEADER, "setup-route-test")
                .body(Body::empty())
                .expect("request must build"),
        )
        .await
        .expect("route must respond");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[REQUEST_ID_HEADER], "setup-route-test");
    let body = to_bytes(response.into_body(), 1024)
        .await
        .expect("body must be bounded");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).expect("body must be JSON"),
        json!({"bootstrapRequired": true})
    );
}

#[tokio::test]
async fn public_route_maps_repository_failure_to_safe_no_store_problem() {
    let service = SetupStatusService::from_reader(
        Arc::new(FixedReader(Err(SetupStatusRepositoryError::Unavailable))),
        SetupStatusPolicy::default(),
    );
    let (router, _) = openapi_router(utoipa::openapi::OpenApi::default())
        .with_state::<()>(service)
        .split_for_parts();
    let response = router
        .layer(middleware::from_fn(propagate_request_id))
        .oneshot(
            Request::builder()
                .uri("/api/v1/setup/status?database=must-not-escape")
                .body(Body::empty())
                .expect("request must build"),
        )
        .await
        .expect("route must respond");

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    let body = to_bytes(response.into_body(), 4096)
        .await
        .expect("body must be bounded");
    let serialized = String::from_utf8(body.to_vec()).expect("body must be UTF-8");
    assert!(!serialized.contains("database"));
    assert!(!serialized.contains("must-not-escape"));
    assert!(!serialized.contains("SELECT"));
}
