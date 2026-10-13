use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;

struct FakeDatabase {
    result: Result<SchemaReadiness, ()>,
    delay: Duration,
    calls: Arc<AtomicUsize>,
}

impl DatabaseProbe for FakeDatabase {
    fn readiness(&self) -> ProbeFuture<'_, SchemaReadiness> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            time::sleep(self.delay).await;
            self.result
        })
    }
}

struct FakeStorage {
    result: Result<(), ()>,
    delay: Duration,
    calls: Arc<AtomicUsize>,
}

impl StorageProbe for FakeStorage {
    fn readiness(&self) -> ProbeFuture<'_, ()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            time::sleep(self.delay).await;
            self.result
        })
    }
}

fn service(
    database: Result<SchemaReadiness, ()>,
    storage: Result<(), ()>,
    database_delay: Duration,
    storage_delay: Duration,
    policy: HealthPolicy,
) -> (HealthService, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let database_calls = Arc::new(AtomicUsize::new(0));
    let storage_calls = Arc::new(AtomicUsize::new(0));
    let service = HealthService::from_parts(
        Some(Arc::new(FakeDatabase {
            result: database,
            delay: database_delay,
            calls: database_calls.clone(),
        })),
        Some(Arc::new(FakeStorage {
            result: storage,
            delay: storage_delay,
            calls: storage_calls.clone(),
        })),
        policy,
    );
    (service, database_calls, storage_calls)
}

#[tokio::test]
async fn liveness_never_calls_dependencies_and_unconfigured_readiness_fails_closed() {
    let response = HealthService::unconfigured()
        .router()
        .oneshot(Request::get("/health/live").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await, json!({"status": "live"}));

    let response = HealthService::unconfigured()
        .router()
        .oneshot(Request::get("/health/ready").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json_body(response).await,
        json!({"status": "unavailable", "category": "configuration"})
    );
}

#[tokio::test]
async fn readiness_maps_schema_and_dependency_states_without_diagnostics() {
    let policy = HealthPolicy::default();
    let cases = [
        (
            Ok(SchemaReadiness::Ready { version: 1 }),
            Ok(()),
            ReadinessState::Ready,
        ),
        (
            Ok(SchemaReadiness::Pending {
                current: None,
                target: 1,
            }),
            Ok(()),
            ReadinessState::Unavailable(UnavailableCategory::SchemaPending),
        ),
        (
            Ok(SchemaReadiness::Dirty { version: 1 }),
            Ok(()),
            ReadinessState::Unavailable(UnavailableCategory::SchemaDirty),
        ),
        (
            Ok(SchemaReadiness::ChecksumMismatch { version: 1 }),
            Ok(()),
            ReadinessState::Unavailable(UnavailableCategory::SchemaChecksumMismatch),
        ),
        (
            Ok(SchemaReadiness::Unsupported { version: 9 }),
            Ok(()),
            ReadinessState::Unavailable(UnavailableCategory::SchemaUnsupported),
        ),
        (
            Err(()),
            Ok(()),
            ReadinessState::Unavailable(UnavailableCategory::Database),
        ),
        (
            Ok(SchemaReadiness::Ready { version: 1 }),
            Err(()),
            ReadinessState::Unavailable(UnavailableCategory::Storage),
        ),
    ];
    for (database, storage, expected) in cases {
        let (service, _, _) = service(database, storage, Duration::ZERO, Duration::ZERO, policy);
        assert_eq!(service.readiness().await, expected);
    }
}

#[tokio::test]
async fn readiness_enforces_overall_deadline_and_concurrency_without_probe_storms() {
    let policy = HealthPolicy::new(
        Duration::from_secs(2),
        Duration::from_secs(2),
        Duration::from_millis(100),
        1,
    )
    .unwrap();
    let (service, database_calls, storage_calls) = service(
        Ok(SchemaReadiness::Ready { version: 1 }),
        Ok(()),
        Duration::from_secs(5),
        Duration::from_secs(5),
        policy,
    );

    let first_service = service.clone();
    let first = tokio::spawn(async move { first_service.readiness().await });
    time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        service.readiness().await,
        ReadinessState::Unavailable(UnavailableCategory::Capacity)
    );
    assert_eq!(
        first.await.unwrap(),
        ReadinessState::Unavailable(UnavailableCategory::Deadline)
    );
    assert_eq!(database_calls.load(Ordering::SeqCst), 1);
    assert_eq!(storage_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dependency_timeouts_are_distinct_and_bounded() {
    let policy = HealthPolicy::new(
        Duration::from_millis(100),
        Duration::from_secs(1),
        Duration::from_secs(2),
        2,
    )
    .unwrap();
    let (database_timeout_service, _, _) = service(
        Ok(SchemaReadiness::Ready { version: 1 }),
        Ok(()),
        Duration::from_secs(5),
        Duration::ZERO,
        policy,
    );
    assert_eq!(
        database_timeout_service.readiness().await,
        ReadinessState::Unavailable(UnavailableCategory::DatabaseTimeout)
    );

    let policy = HealthPolicy::new(
        Duration::from_secs(1),
        Duration::from_millis(100),
        Duration::from_secs(2),
        2,
    )
    .unwrap();
    let (service, _, _) = service(
        Ok(SchemaReadiness::Ready { version: 1 }),
        Ok(()),
        Duration::ZERO,
        Duration::from_secs(5),
        policy,
    );
    assert_eq!(
        service.readiness().await,
        ReadinessState::Unavailable(UnavailableCategory::StorageTimeout)
    );
}

async fn json_body(response: axum::response::Response) -> Value {
    let body = to_bytes(response.into_body(), 1_024).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}
