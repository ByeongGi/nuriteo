use std::time::Duration;

use crate::project::ProjectId;
use crate::workspace::StorageScopeId;

use super::service::map_commit_error;
use super::{
    EffectiveQuota, QuotaProjection, QuotaServiceError, QuotaServicePolicy, ReservationRequest,
    SaveSessionId,
};

#[test]
fn effective_quota_is_explicit_and_validated() {
    assert_eq!(EffectiveQuota::unlimited().limit_bytes(), None);
    assert_eq!(EffectiveQuota::limited(1).unwrap().limit_bytes(), Some(1));
    assert_eq!(
        EffectiveQuota::limited(0),
        Err(QuotaServiceError::InvalidInput)
    );
    assert_eq!(
        EffectiveQuota::limited(u64::MAX),
        Err(QuotaServiceError::InvalidInput)
    );
}

#[test]
fn reservation_size_is_bounded() {
    let request = |requested_bytes| ReservationRequest {
        storage_scope_id: StorageScopeId::new(),
        project_id: ProjectId::new(),
        save_session_id: SaveSessionId::new(),
        requested_bytes,
        effective_quota: EffectiveQuota::unlimited(),
    };
    assert_eq!(request(0).validate(), Err(QuotaServiceError::InvalidInput));
    assert!(request(2 * 1024 * 1024 * 1024).validate().is_ok());
    assert_eq!(
        request(2 * 1024 * 1024 * 1024 + 1).validate(),
        Err(QuotaServiceError::InvalidInput)
    );
}

#[test]
fn accounting_overflow_fails_closed() {
    assert_eq!(
        QuotaProjection::new(
            StorageScopeId::new(),
            u64::MAX,
            1,
            EffectiveQuota::unlimited(),
        ),
        Err(QuotaServiceError::ArithmeticOverflow)
    );
}

#[test]
fn service_timeout_is_bounded() {
    assert!(QuotaServicePolicy::new(Duration::from_millis(100)).is_ok());
    assert_eq!(
        QuotaServicePolicy::new(Duration::from_millis(99)),
        Err(QuotaServiceError::InvalidInput)
    );
    assert_eq!(
        QuotaServicePolicy::new(Duration::from_secs(31)),
        Err(QuotaServiceError::InvalidInput)
    );
}

#[test]
fn terminal_transition_commit_response_loss_is_reported_as_unknown() {
    let error = sqlx::Error::Io(std::io::Error::new(
        std::io::ErrorKind::ConnectionReset,
        "connection closed after commit request",
    ));

    assert_eq!(
        map_commit_error(error),
        QuotaServiceError::CommitOutcomeUnknown
    );
}
