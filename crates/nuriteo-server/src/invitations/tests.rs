use std::time::Duration;

use super::service::{InvitationDeliveryView, InvitationView, IssuedInvitationView};
use super::{InvitationHttpPolicy, InvitationHttpServiceError};

#[test]
fn policy_bounds_password_work_and_deadlines() {
    assert!(
        InvitationHttpPolicy::new(Duration::from_millis(100), Duration::from_secs(30), 64).is_ok()
    );
    for invalid in [
        InvitationHttpPolicy::new(Duration::from_millis(99), Duration::from_secs(5), 1),
        InvitationHttpPolicy::new(Duration::from_secs(5), Duration::from_secs(31), 1),
        InvitationHttpPolicy::new(Duration::from_secs(5), Duration::from_secs(5), 0),
        InvitationHttpPolicy::new(Duration::from_secs(5), Duration::from_secs(5), 65),
    ] {
        assert_eq!(invalid, Err(InvitationHttpServiceError::Configuration));
    }
}

#[test]
fn one_time_url_debug_and_errors_are_secret_free() {
    let secret = "nrt_inv_a-secret-that-must-never-enter-diagnostics";
    let view = IssuedInvitationView {
        invitation: InvitationView {
            id: "0199ee6c-c777-7000-8000-000000000901".into(),
            email: "member@example.test".into(),
            status: "pending".into(),
            created_at: "2026-10-04T00:00:00Z".into(),
            expires_at: "2026-10-11T00:00:00Z".into(),
            accepted_at: None,
            revoked_at: None,
            superseded_at: None,
            replacement_id: None,
        },
        delivery: InvitationDeliveryView::CopyOnce,
        activation_url: Some(format!("https://example.test/activate?token={secret}")),
    };
    assert!(!format!("{view:?}").contains(secret));
    for error in [
        InvitationHttpServiceError::AuthenticationFailed,
        InvitationHttpServiceError::RequestForbidden,
        InvitationHttpServiceError::Conflict,
        InvitationHttpServiceError::InvalidInvitation,
        InvitationHttpServiceError::Unavailable,
        InvitationHttpServiceError::OperationTimeout,
        InvitationHttpServiceError::Configuration,
        InvitationHttpServiceError::Internal,
    ] {
        let rendered = format!("{error:?}: {error}");
        assert!(!rendered.contains(secret));
        assert!(!rendered.contains("postgres://"));
    }
}
