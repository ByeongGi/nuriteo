use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::repository::SetupStatusRepositoryError;
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
