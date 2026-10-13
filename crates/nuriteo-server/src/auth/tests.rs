use std::time::Duration;

use super::*;

#[test]
fn policy_bounds_blocking_work_and_deadlines() {
    assert_eq!(
        AuthPolicy::default(),
        AuthPolicy::new(4, Duration::from_secs(5), Duration::from_secs(5)).unwrap()
    );
    assert_eq!(
        AuthPolicy::new(0, Duration::from_secs(1), Duration::from_secs(1)),
        Err(AuthPolicyError::InvalidBlockingConcurrency)
    );
    assert_eq!(
        AuthPolicy::new(1, Duration::from_millis(99), Duration::from_secs(1)),
        Err(AuthPolicyError::InvalidPasswordDeadline)
    );
    assert_eq!(
        AuthPolicy::new(1, Duration::from_secs(1), Duration::from_secs(31)),
        Err(AuthPolicyError::InvalidOperationDeadline)
    );
}

#[test]
fn lockout_policy_has_bounded_defaults_and_validation() {
    assert_eq!(
        LoginLockoutPolicy::default(),
        LoginLockoutPolicy::new(
            5,
            Duration::from_secs(15 * 60),
            Duration::from_secs(15 * 60),
        )
        .unwrap()
    );
    assert_eq!(
        LoginLockoutPolicy::new(2, Duration::from_secs(60), Duration::from_secs(60)),
        Err(LoginLockoutPolicyError::InvalidThreshold)
    );
    assert_eq!(
        LoginLockoutPolicy::new(21, Duration::from_secs(60), Duration::from_secs(60)),
        Err(LoginLockoutPolicyError::InvalidThreshold)
    );
    assert_eq!(
        LoginLockoutPolicy::new(5, Duration::from_secs(59), Duration::from_secs(60)),
        Err(LoginLockoutPolicyError::InvalidWindow)
    );
    assert_eq!(
        LoginLockoutPolicy::new(
            5,
            Duration::from_secs(60),
            Duration::from_secs(24 * 60 * 60 + 1),
        ),
        Err(LoginLockoutPolicyError::InvalidLockDuration)
    );
}

#[test]
fn service_errors_are_stable_and_secret_free() {
    for (error, expected) in [
        (
            AuthServiceError::AuthenticationFailed,
            "authentication failed",
        ),
        (
            AuthServiceError::RequestForbidden,
            "request security policy rejected the request",
        ),
        (
            AuthServiceError::Unavailable,
            "authentication service is unavailable",
        ),
        (
            AuthServiceError::OperationTimeout,
            "authentication operation timed out",
        ),
        (
            AuthServiceError::Internal,
            "authentication operation failed",
        ),
    ] {
        assert_eq!(error.to_string(), expected);
    }
}
