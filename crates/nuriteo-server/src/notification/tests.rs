use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::identity::{NormalizedEmail, Timestamp, UserId};

fn notification(classification: NotificationClassification) -> Notification {
    Notification::new(NotificationFields {
        id: NotificationId::new(),
        recipient_user_id: UserId::from_uuid(
            Uuid::parse_str("0199ee6c-c777-7000-8000-000000003001").expect("fixture UUID"),
        )
        .expect("UUIDv7 user ID"),
        classification,
        event_code: "identity.password.changed".to_owned(),
        template_id: "identity.password_changed".to_owned(),
        locale: "ko-KR".to_owned(),
        resource_type: "user".to_owned(),
        resource_id: "0199ee6c-c777-7000-8000-000000003001".to_owned(),
        rendering_data: NotificationPayload::new(json!({
            "actorDisplayName": "Administrator",
            "occurredAt": "2026-10-07T00:00:00Z"
        }))
        .expect("safe rendering data"),
        requires_action: false,
        occurred_at: Timestamp::from_unix_timestamp(1_759_795_200).expect("fixture timestamp"),
    })
    .expect("valid notification")
}

#[test]
fn classification_matrix_matches_the_notification_policy() {
    use EmailChannelPreference::{Default, Disabled, Enabled};
    use NotificationClassification::{AccountAccess, Collaboration, CriticalSecurity, Operations};

    let cases = [
        (CriticalSecurity, Default, true),
        (CriticalSecurity, Enabled, true),
        (CriticalSecurity, Disabled, true),
        (AccountAccess, Default, true),
        (AccountAccess, Enabled, true),
        (AccountAccess, Disabled, false),
        (Collaboration, Default, false),
        (Collaboration, Enabled, true),
        (Collaboration, Disabled, false),
        (Operations, Default, false),
        (Operations, Enabled, true),
        (Operations, Disabled, false),
    ];
    for (classification, preference, expected) in cases {
        assert_eq!(
            classification.should_enqueue_email(true, preference),
            expected,
            "classification={classification:?}, preference={preference:?}"
        );
        assert!(!classification.should_enqueue_email(false, preference));
    }
    assert!(CriticalSecurity.is_delete_protected());
    assert!(AccountAccess.is_delete_protected());
    assert!(Operations.is_delete_protected());
    assert!(!Collaboration.is_delete_protected());
}

#[test]
fn delivery_requires_exactly_the_email_job_selected_by_policy() {
    let email = NormalizedEmail::from_email("member@example.test").expect("fixture email");
    let critical = notification(NotificationClassification::CriticalSecurity);
    assert_eq!(
        NotificationDelivery::new(
            critical.clone(),
            true,
            EmailChannelPreference::Disabled,
            None,
            None,
        ),
        Err(NotificationValidationError::EmailChannelMismatch)
    );
    let delivery = NotificationDelivery::new(
        critical,
        true,
        EmailChannelPreference::Disabled,
        Some(EmailOutboxId::new()),
        Some(email.clone()),
    )
    .expect("critical email cannot be disabled");
    assert!(delivery.has_email());

    let collaboration = notification(NotificationClassification::Collaboration);
    assert_eq!(
        NotificationDelivery::new(
            collaboration.clone(),
            true,
            EmailChannelPreference::Default,
            Some(EmailOutboxId::new()),
            Some(email),
        ),
        Err(NotificationValidationError::EmailChannelMismatch)
    );
    assert!(
        !NotificationDelivery::new(
            collaboration,
            true,
            EmailChannelPreference::Default,
            None,
            None,
        )
        .expect("collaboration email defaults off")
        .has_email()
    );
}

#[test]
fn rendering_data_rejects_secret_and_token_shaped_keys_recursively() {
    for payload in [
        json!({"token": "raw"}),
        json!({"nested": {"session_token": "raw"}}),
        json!({"items": [{"recoveryCodes": ["raw"]}]}),
        json!({"activation-url": "https://example.test/raw"}),
        json!({"smtpCredential": "raw"}),
    ] {
        assert_eq!(
            NotificationPayload::new(payload),
            Err(NotificationValidationError::SensitivePayload)
        );
    }
}

#[test]
fn debug_output_redacts_rendering_data_and_recipient_email() {
    let email = NormalizedEmail::from_email("private@example.test").expect("fixture email");
    let delivery = NotificationDelivery::new(
        notification(NotificationClassification::AccountAccess),
        true,
        EmailChannelPreference::Default,
        Some(EmailOutboxId::new()),
        Some(email),
    )
    .expect("default account email");
    let rendered = format!("{delivery:?}");
    assert!(!rendered.contains("private@example.test"));
    assert!(!rendered.contains("Administrator"));
    assert!(rendered.contains("[REDACTED]"));
}

#[test]
fn action_and_outbox_transition_tables_are_terminal_safe() {
    use EmailOutboxState::{
        Canceled as MailCanceled, DeadLetter, Pending as MailPending, RetryWait, Sending, Sent,
    };
    use NotificationActionState::{Canceled, None, Pending, Resolved};

    assert!(None.can_transition_to(Pending));
    assert!(Pending.can_transition_to(Resolved));
    assert!(Pending.can_transition_to(Canceled));
    assert!(!Resolved.can_transition_to(Pending));
    assert!(!Canceled.can_transition_to(Resolved));
    assert!(Resolved.is_terminal());

    assert!(MailPending.can_transition_to(Sending));
    assert!(Sending.can_transition_to(RetryWait));
    assert!(RetryWait.can_transition_to(Sending));
    assert!(Sending.can_transition_to(Sent));
    assert!(RetryWait.can_transition_to(DeadLetter));
    assert!(MailPending.can_transition_to(MailCanceled));
    for terminal in [Sent, DeadLetter, MailCanceled] {
        assert!(terminal.is_terminal());
        assert!(terminal.permits_notification_retention());
        assert!(!terminal.can_transition_to(MailPending));
        assert!(!terminal.can_transition_to(Sending));
    }
}
