use super::*;

#[test]
fn operation_timeout_policy_is_bounded() {
    for (timeout, expected) in [
        (Duration::from_millis(99), false),
        (Duration::from_millis(100), true),
        (Duration::from_secs(5), true),
        (Duration::from_secs(30), true),
        (Duration::from_millis(30_001), false),
    ] {
        assert_eq!(ProjectServicePolicy::new(timeout).is_ok(), expected);
    }

    assert!(ProjectRolePageLimit::new(0).is_err());
    assert_eq!(ProjectRolePageLimit::default().get(), 50);
    assert_eq!(ProjectRolePageLimit::new(100).unwrap().get(), 100);
    assert!(ProjectRolePageLimit::new(101).is_err());
    assert_eq!(postgres_timeout(Duration::from_millis(100)), "75ms");
    assert_eq!(postgres_timeout(Duration::from_millis(10)), "1ms");
}

#[test]
fn audit_context_debug_redacts_request_and_actor_context() {
    let actor = UserId::new();
    let context = ProjectAuditContext::new(
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
fn service_errors_are_context_free_and_audit_reasons_are_closed() {
    let cases = [
        (
            ProjectServiceError::InvalidInput,
            "project input is invalid",
        ),
        (ProjectServiceError::NotFound, "project was not found"),
        (
            ProjectServiceError::Unauthorized,
            "project operation is not authorized",
        ),
        (ProjectServiceError::Archived, "project is archived"),
        (
            ProjectServiceError::NamespaceUnavailable,
            "project namespace is unavailable",
        ),
        (
            ProjectServiceError::StaleVersion,
            "project version is stale",
        ),
        (
            ProjectServiceError::ConfirmationRequired,
            "project deletion confirmation is required",
        ),
        (
            ProjectServiceError::DatabaseUnavailable,
            "project persistence is unavailable",
        ),
        (
            ProjectServiceError::CommitOutcomeUnknown,
            "project commit outcome is unknown",
        ),
    ];
    for (error, message) in cases {
        assert_eq!(error.to_string(), message);
        assert!(!error.to_string().contains("postgres"));
        assert!(
            error
                .reason_code()
                .bytes()
                .all(|byte| { byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_' })
        );
    }
}

#[tokio::test]
async fn commit_resolution_is_bounded_and_never_claims_rollback() {
    let started = tokio_time::Instant::now();
    let result = resolve_commit(
        std::future::pending::<Result<(), sqlx::Error>>(),
        Duration::from_millis(10),
    )
    .await;

    assert_eq!(result, Err(ProjectServiceError::CommitOutcomeUnknown));
    assert!(started.elapsed() < Duration::from_millis(100));
    assert_eq!(
        resolve_commit(std::future::ready(Ok(())), Duration::from_secs(1)).await,
        Ok(())
    );
}
