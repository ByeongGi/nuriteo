use super::*;

#[test]
fn operation_timeout_policy_is_bounded() {
    let cases = [
        (Duration::from_millis(99), false),
        (Duration::from_millis(100), true),
        (Duration::from_secs(5), true),
        (Duration::from_secs(30), true),
        (Duration::from_millis(30_001), false),
    ];

    for (timeout, expected) in cases {
        assert_eq!(
            OrganizationServicePolicy::new(timeout).is_ok(),
            expected,
            "timeout={timeout:?}"
        );
    }
}

#[test]
fn audit_context_debug_omits_actor_and_request_context() {
    let actor = UserId::new();
    let context = OrganizationAuditContext::new(
        AuditEventId::new(),
        actor,
        Some("Sensitive display name".into()),
        "sensitive-correlation".into(),
        Some(
            "192.0.2.1"
                .parse()
                .unwrap_or_else(|error| panic!("{error}")),
        ),
    );

    let rendered = format!("{context:?}");
    for hidden in [
        actor.to_string(),
        "Sensitive display name".into(),
        "sensitive-correlation".into(),
        "192.0.2.1".into(),
    ] {
        assert!(!rendered.contains(&hidden));
    }
}

#[test]
fn service_errors_have_stable_context_free_messages() {
    let cases = [
        (
            OrganizationServiceError::InvalidInput,
            "organization input is invalid",
        ),
        (
            OrganizationServiceError::NotFound,
            "organization was not found",
        ),
        (
            OrganizationServiceError::Unauthorized,
            "organization operation is not authorized",
        ),
        (
            OrganizationServiceError::UserUnavailable,
            "organization user is unavailable",
        ),
        (
            OrganizationServiceError::Archived,
            "organization is archived",
        ),
        (
            OrganizationServiceError::DuplicateSlug,
            "organization slug already exists",
        ),
        (
            OrganizationServiceError::MemberNotFound,
            "organization member was not found",
        ),
        (
            OrganizationServiceError::MemberLimitReached,
            "organization member limit was reached",
        ),
        (
            OrganizationServiceError::LastOwner,
            "organization must retain at least one owner",
        ),
        (
            OrganizationServiceError::StaleVersion,
            "organization version is stale",
        ),
        (
            OrganizationServiceError::AuditUnavailable,
            "organization audit persistence is unavailable",
        ),
        (
            OrganizationServiceError::DatabaseUnavailable,
            "organization persistence is unavailable",
        ),
        (
            OrganizationServiceError::OperationTimeout,
            "organization operation timed out",
        ),
        (
            OrganizationServiceError::InvariantViolation,
            "organization state is invalid",
        ),
    ];

    for (error, expected) in cases {
        assert_eq!(error.to_string(), expected);
        assert!(!error.to_string().contains("postgres"));
    }
}
