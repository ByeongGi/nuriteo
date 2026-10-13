use super::*;

#[test]
fn policy_bounds_are_explicit() {
    let expiry = InvitationExpiryPolicy::default();
    let cases = [
        (Duration::from_millis(99), Duration::from_secs(60), false),
        (Duration::from_millis(100), Duration::from_secs(60), true),
        (Duration::from_secs(30), Duration::from_secs(3600), true),
        (Duration::from_secs(31), Duration::from_secs(60), false),
        (Duration::from_secs(5), Duration::from_secs(59), false),
        (Duration::from_secs(5), Duration::from_secs(3601), false),
    ];
    for (timeout, reauthentication_age, expected) in cases {
        assert_eq!(
            OrganizationInvitationPolicy::new(expiry, timeout, reauthentication_age).is_ok(),
            expected,
            "timeout={timeout:?}, reauthentication_age={reauthentication_age:?}"
        );
    }
}

#[test]
fn audit_context_and_errors_do_not_expose_request_context() {
    let actor = UserId::new();
    let context = OrganizationInvitationAuditContext::new(
        AuditEventId::new(),
        actor,
        Some("Sensitive actor".into()),
        "sensitive-correlation".into(),
        Some(
            "192.0.2.10"
                .parse()
                .unwrap_or_else(|error| panic!("{error}")),
        ),
    );
    let rendered = format!("{context:?}");
    for secret in [
        actor.to_string(),
        "Sensitive actor".into(),
        "sensitive-correlation".into(),
        "192.0.2.10".into(),
    ] {
        assert!(!rendered.contains(&secret));
    }

    let errors = [
        OrganizationInvitationServiceError::InvalidInput,
        OrganizationInvitationServiceError::AlreadyPending,
        OrganizationInvitationServiceError::AlreadyMember,
        OrganizationInvitationServiceError::MemberLimitReached,
        OrganizationInvitationServiceError::NotFound,
        OrganizationInvitationServiceError::Unauthorized,
        OrganizationInvitationServiceError::ReauthenticationRequired,
        OrganizationInvitationServiceError::InviteeUnavailable,
        OrganizationInvitationServiceError::InvalidInvitation,
        OrganizationInvitationServiceError::InvitationNotPending,
        OrganizationInvitationServiceError::EntropyUnavailable,
        OrganizationInvitationServiceError::InvalidAuditContext,
        OrganizationInvitationServiceError::AuditUnavailable,
        OrganizationInvitationServiceError::DatabaseUnavailable,
        OrganizationInvitationServiceError::OperationTimeout,
        OrganizationInvitationServiceError::InvariantViolation,
    ];
    for error in errors {
        let message = error.to_string();
        assert!(!message.contains("postgres"));
        assert!(!message.contains("token"));
        assert!(!message.contains("email"));
    }
}
