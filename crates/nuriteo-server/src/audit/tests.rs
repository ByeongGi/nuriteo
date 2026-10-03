use std::net::{IpAddr, Ipv4Addr};
use std::str::FromStr;

use serde_json::json;
use uuid::{Uuid, Variant, Version};

use super::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditValidationError, ScopeType,
};
use crate::identity::{Timestamp, UserId};

const EVENT_ID: &str = "01890f3e-0000-7000-8000-000000000301";
const USER_ID: &str = "01890f3e-0000-7000-8000-000000000001";

#[test]
fn event_identifiers_require_non_nil_uuid_v7() {
    let generated = AuditEventId::new().into_uuid();
    assert_eq!(generated.get_version(), Some(Version::SortRand));
    assert_eq!(generated.get_variant(), Variant::RFC4122);
    assert_eq!(
        AuditEventId::from_uuid(Uuid::nil()),
        Err(AuditValidationError::InvalidIdentifier)
    );
    assert_eq!(
        AuditEventId::from_uuid(Uuid::new_v4()),
        Err(AuditValidationError::InvalidIdentifier)
    );
    assert_eq!(
        AuditEventId::from_str("not-a-uuid"),
        Err(AuditValidationError::InvalidIdentifier)
    );

    let mut bytes = generated.into_bytes();
    bytes[8] &= 0x3f;
    let invalid = Uuid::from_bytes(bytes);
    assert_eq!(invalid.get_version(), Some(Version::SortRand));
    assert_ne!(invalid.get_variant(), Variant::RFC4122);
    assert_eq!(
        AuditEventId::from_uuid(invalid),
        Err(AuditValidationError::InvalidIdentifier)
    );
    assert_eq!(
        AuditEventId::from_str(&invalid.to_string()),
        Err(AuditValidationError::InvalidIdentifier)
    );
}

#[test]
fn metadata_rejects_sensitive_nested_keys_and_values() {
    let sensitive_values = [
        json!({"outer": {"password": "redacted-fixture-value"}}),
        json!({"outer": [{"summary": "bearer redacted-fixture-value"}]}),
        json!({"outer": {"summary": "postgres://fixture.invalid/database"}}),
        json!({"outer": {"summary": "https://storage.invalid/x?X-Amz-Signature=value"}}),
        json!({"outer": {"cookie_jar": "not-recorded"}}),
        json!({"outer": {"summary": ".env contents changed"}}),
    ];
    for value in sensitive_values {
        let error =
            AuditMetadata::new(value).expect_err("sensitive nested metadata must be rejected");
        assert_eq!(error, AuditValidationError::SensitiveMetadata);
        for formatted in [error.to_string(), format!("{error:?}")] {
            assert!(!formatted.contains("redacted-fixture-value"));
            assert!(!formatted.contains("postgres://"));
            assert!(!formatted.contains("X-Amz-Signature"));
        }
    }
}

#[test]
fn metadata_is_bounded_by_shape_depth_nodes_and_encoded_size() {
    assert_eq!(
        AuditMetadata::new(json!(["not", "an", "object"])),
        Err(AuditValidationError::InvalidMetadata)
    );

    let mut deep = json!({"leaf": true});
    for _ in 0..10 {
        deep = json!({"child": deep});
    }
    assert_eq!(
        AuditMetadata::new(deep),
        Err(AuditValidationError::InvalidMetadata)
    );
    assert_eq!(
        AuditMetadata::new(json!({"items": vec![true; 256]})),
        Err(AuditValidationError::InvalidMetadata)
    );
    assert_eq!(
        AuditMetadata::new(json!({"unsafe\nkey": "value"})),
        Err(AuditValidationError::InvalidMetadata)
    );
    assert_eq!(
        AuditMetadata::new(json!({"summary": "unsafe\nvalue"})),
        Err(AuditValidationError::InvalidMetadata)
    );
    assert_eq!(
        AuditMetadata::new(json!({"summary": "x".repeat(16_384)})),
        Err(AuditValidationError::MetadataTooLarge)
    );
    assert!(AuditMetadata::new(json!({"summary": "lifecycle changed"})).is_ok());
}

#[test]
fn event_validation_is_table_driven_and_fail_closed() {
    let mut cases = Vec::new();

    let mut invalid = valid_fields();
    invalid.actor.id = "different-user".into();
    cases.push(invalid);

    let mut invalid = valid_fields();
    invalid.action_code = "Invalid Action".into();
    cases.push(invalid);

    let mut invalid = valid_fields();
    invalid.target.kind = "Uppercase".into();
    cases.push(invalid);

    let mut invalid = valid_fields();
    invalid.scope.id = " ".into();
    cases.push(invalid);

    let mut invalid = valid_fields();
    invalid.reason_code = Some("lowercase".into());
    cases.push(invalid);

    let mut invalid = valid_fields();
    invalid.correlation_id = "unsafe correlation".into();
    cases.push(invalid);

    let mut invalid = valid_fields();
    invalid.schema_version = 0;
    cases.push(invalid);

    let mut invalid = valid_fields();
    invalid.changed_fields = vec!["status".into(), "status".into()];
    cases.push(invalid);

    let mut invalid = valid_fields();
    invalid.changed_fields = vec!["field".into(); 65];
    cases.push(invalid);

    for fields in cases {
        assert!(AuditEvent::new(fields).is_err());
    }
}

#[test]
fn safe_event_debug_omits_metadata_actor_context_and_ip() {
    let event = AuditEvent::new(valid_fields()).expect("fixture event must be valid");
    let debug = format!("{event:?}");
    assert!(debug.contains("user.disabled"));
    assert!(!debug.contains("Fixture actor"));
    assert!(!debug.contains("lifecycle changed"));
    assert!(!debug.contains("192.0.2.10"));
}

fn valid_fields() -> AuditEventFields {
    let user_id = UserId::from_str(USER_ID).expect("fixture user ID must be valid");
    AuditEventFields {
        id: AuditEventId::from_str(EVENT_ID).expect("fixture event ID must be valid"),
        occurred_at: Timestamp::from_unix_timestamp(1_759_564_496)
            .expect("fixture timestamp must be valid"),
        actor: AuditActor {
            kind: ActorType::User,
            id: user_id.to_string(),
            user_id: Some(user_id),
            display_name: Some("Fixture actor".into()),
        },
        action_code: "user.disabled".into(),
        target: AuditTarget {
            kind: "user".into(),
            id: USER_ID.into(),
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: "primary".into(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: "request:fixture-01".into(),
        source_ip: Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        schema_version: 1,
        changed_fields: vec!["status".into()],
        metadata: AuditMetadata::new(json!({"summary": "lifecycle changed"}))
            .expect("fixture metadata must be safe"),
    }
}
