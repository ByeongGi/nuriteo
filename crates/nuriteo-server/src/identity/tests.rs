use std::str::FromStr;

use serde_json::{Value, json};
use uuid::{Uuid, Variant, Version};

use super::{
    ActivationInvitationId, IdentityError, Session, SessionFields, SessionId, Timestamp, User,
    UserFields, UserId, UserStatus,
};

const USER_ID: &str = "01890f3e-0000-7000-8000-000000000001";
const SESSION_ID: &str = "01890f3e-0000-7000-8000-000000000101";
const REPLACEMENT_SESSION_ID: &str = "01890f3e-0001-7000-8000-000000000102";

#[test]
fn generated_and_parsed_identifiers_are_non_nil_version_7() {
    for _ in 0..256 {
        let user_id = UserId::new();
        assert!(!user_id.into_uuid().is_nil());
        assert_eq!(user_id.into_uuid().get_version(), Some(Version::SortRand));
        assert_eq!(user_id.into_uuid().get_variant(), Variant::RFC4122);
        assert_eq!(
            UserId::from_str(&user_id.to_string()).unwrap_or_else(|error| panic!("{error}")),
            user_id
        );
    }

    assert_eq!(
        UserId::from_uuid(Uuid::nil()),
        Err(IdentityError::NilIdentifier)
    );
    assert_eq!(
        UserId::from_uuid(Uuid::new_v4()),
        Err(IdentityError::IdentifierMustBeVersion7)
    );
    assert_eq!(
        UserId::from_str("not-a-uuid"),
        Err(IdentityError::InvalidIdentifier)
    );
}

#[test]
fn persisted_identity_ids_reject_non_rfc_uuid_v7_at_every_input_boundary() {
    for generated in [
        UserId::new().into_uuid(),
        SessionId::new().into_uuid(),
        ActivationInvitationId::new().into_uuid(),
    ] {
        assert_eq!(generated.get_version(), Some(Version::SortRand));
        assert_eq!(generated.get_variant(), Variant::RFC4122);
    }

    let invalid = non_rfc_uuid_v7(USER_ID);
    assert_eq!(invalid.get_version(), Some(Version::SortRand));
    assert_ne!(invalid.get_variant(), Variant::RFC4122);

    macro_rules! assert_rejected {
        ($id:ty) => {
            assert_eq!(
                <$id>::from_uuid(invalid),
                Err(IdentityError::IdentifierMustBeVersion7)
            );
            assert_eq!(
                invalid.to_string().parse::<$id>(),
                Err(IdentityError::IdentifierMustBeVersion7)
            );
            assert!(serde_json::from_value::<$id>(json!(invalid.to_string())).is_err());
        };
    }

    assert_rejected!(UserId);
    assert_rejected!(SessionId);
    assert_rejected!(ActivationInvitationId);
}

#[test]
fn uuid_v7_identifiers_preserve_time_order_and_stable_json() {
    let earlier = UserId::from_str(USER_ID).unwrap_or_else(|error| panic!("{error}"));
    let later = UserId::from_str("01890f3e-0001-7000-8000-000000000001")
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(earlier < later);

    let encoded = serde_json::to_string(&earlier).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(encoded, format!("\"{USER_ID}\""));
    let decoded: UserId = serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(decoded, earlier);

    for invalid in [
        json!("00000000-0000-0000-0000-000000000000"),
        json!(Uuid::new_v4().to_string()),
    ] {
        assert!(serde_json::from_value::<UserId>(invalid).is_err());
    }
}

#[test]
fn timestamps_are_canonical_utc_and_round_trip() {
    let timestamp = Timestamp::from_str("2026-10-04T12:34:56.123456+09:00")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(timestamp.to_string(), "2026-10-04T03:34:56.123456Z");

    let encoded = serde_json::to_string(&timestamp).unwrap_or_else(|error| panic!("{error}"));
    let decoded: Timestamp =
        serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(decoded, timestamp);
    assert_eq!(
        Timestamp::from_unix_timestamp(i64::MAX),
        Err(IdentityError::TimestampOutOfRange)
    );
    assert_eq!(
        Timestamp::from_str("not-a-timestamp"),
        Err(IdentityError::TimestampOutOfRange)
    );
}

#[test]
fn user_constructor_enforces_schema_equivalent_invariants() {
    let valid_cases = [
        active_user_fields(),
        UserFields {
            status: UserStatus::Disabled,
            updated_at: timestamp(120),
            disabled_at: Some(timestamp(110)),
            ..active_user_fields()
        },
    ];
    for fields in valid_cases {
        assert!(User::new(fields).is_ok());
    }

    let invalid_cases = [
        UserFields {
            email: " Admin@example.test".into(),
            normalized_email: "admin@example.test".into(),
            ..active_user_fields()
        },
        UserFields {
            normalized_email: "Admin@example.test".into(),
            ..active_user_fields()
        },
        UserFields {
            display_name: " ".repeat(201),
            ..active_user_fields()
        },
        UserFields {
            status: UserStatus::Disabled,
            disabled_at: None,
            ..active_user_fields()
        },
        UserFields {
            updated_at: timestamp(99),
            ..active_user_fields()
        },
        UserFields {
            status: UserStatus::Disabled,
            updated_at: timestamp(109),
            disabled_at: Some(timestamp(110)),
            ..active_user_fields()
        },
    ];
    for fields in invalid_cases {
        assert!(User::new(fields).is_err());
    }
}

#[test]
fn user_serialization_round_trip_cannot_bypass_validation() {
    let user = User::new(active_user_fields()).unwrap_or_else(|error| panic!("{error}"));
    assert!(user.is_active());
    assert_eq!(user.status(), UserStatus::Active);
    assert_eq!(user.id(), user_id());

    let encoded = serde_json::to_string(&user).unwrap_or_else(|error| panic!("{error}"));
    let decoded: User = serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(decoded, user);

    let mut invalid: Value =
        serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    invalid["status"] = json!("disabled");
    assert!(serde_json::from_value::<User>(invalid).is_err());
}

#[test]
fn session_timestamp_table_matches_database_constraints() {
    for last_seen in [99, 100, 101] {
        for idle_expiry in [100, 101, 200, 301] {
            for absolute_expiry in [100, 101, 200, 300] {
                let fields = SessionFields {
                    last_seen_at: timestamp(last_seen),
                    idle_expires_at: timestamp(idle_expiry),
                    absolute_expires_at: timestamp(absolute_expiry),
                    last_reauthenticated_at: None,
                    ..active_session_fields()
                };
                let expected = last_seen >= 100
                    && idle_expiry > last_seen
                    && absolute_expiry > 100
                    && idle_expiry <= absolute_expiry;
                assert_eq!(
                    Session::new(fields).is_ok(),
                    expected,
                    "last_seen={last_seen} idle={idle_expiry} absolute={absolute_expiry}"
                );
            }
        }
    }
}

#[test]
fn session_reauthentication_revocation_and_rotation_fail_closed() {
    let invalid_cases = [
        SessionFields {
            last_reauthenticated_at: Some(timestamp(99)),
            ..active_session_fields()
        },
        SessionFields {
            last_reauthenticated_at: Some(timestamp(111)),
            ..active_session_fields()
        },
        SessionFields {
            revoked_at: Some(timestamp(120)),
            revocation_reason: None,
            ..active_session_fields()
        },
        SessionFields {
            revoked_at: None,
            revocation_reason: Some("logout".into()),
            ..active_session_fields()
        },
        SessionFields {
            revoked_at: Some(timestamp(99)),
            revocation_reason: Some("logout".into()),
            ..active_session_fields()
        },
        SessionFields {
            revoked_at: Some(timestamp(120)),
            revocation_reason: Some("Invalid Reason".into()),
            ..active_session_fields()
        },
        SessionFields {
            rotated_at: Some(timestamp(120)),
            replaced_by_session_id: Some(replacement_session_id()),
            ..active_session_fields()
        },
        SessionFields {
            revoked_at: Some(timestamp(120)),
            revocation_reason: Some("rotated".into()),
            rotated_at: Some(timestamp(99)),
            replaced_by_session_id: Some(replacement_session_id()),
            ..active_session_fields()
        },
        SessionFields {
            revoked_at: Some(timestamp(120)),
            revocation_reason: Some("rotated".into()),
            rotated_at: Some(timestamp(120)),
            replaced_by_session_id: Some(session_id()),
            ..active_session_fields()
        },
    ];
    for fields in invalid_cases {
        assert!(Session::new(fields).is_err());
    }

    let revoked = Session::new(SessionFields {
        revoked_at: Some(timestamp(120)),
        revocation_reason: Some("user_logout".into()),
        ..active_session_fields()
    });
    assert!(revoked.is_ok());

    let rotated = Session::new(SessionFields {
        revoked_at: Some(timestamp(120)),
        revocation_reason: Some("rotated".into()),
        rotated_at: Some(timestamp(120)),
        replaced_by_session_id: Some(replacement_session_id()),
        ..active_session_fields()
    });
    assert!(rotated.is_ok());
}

#[test]
fn safe_session_serialization_round_trips_without_a_credential_field() {
    let session = Session::new(active_session_fields()).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(session.id(), session_id());
    assert_eq!(session.user_id(), user_id());
    assert!(!session.is_active_at(timestamp(99)));
    assert!(session.is_active_at(timestamp(100)));
    assert!(session.is_active_at(timestamp(150)));
    assert!(!session.is_active_at(timestamp(200)));

    let absolute_boundary = Session::new(SessionFields {
        idle_expires_at: timestamp(300),
        ..active_session_fields()
    })
    .unwrap_or_else(|error| panic!("{error}"));
    assert!(absolute_boundary.is_active_at(timestamp(299)));
    assert!(!absolute_boundary.is_active_at(timestamp(300)));

    let encoded = serde_json::to_string(&session).unwrap_or_else(|error| panic!("{error}"));
    for forbidden in ["token", "hash", "secret", "credential"] {
        assert!(
            !encoded.contains(forbidden),
            "serialized session exposed forbidden field fragment: {forbidden}"
        );
    }
    let decoded: Session = serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(decoded, session);

    let mut invalid: Value =
        serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    invalid["idle_expires_at"] = json!("1970-01-01T00:01:40Z");
    assert!(serde_json::from_value::<Session>(invalid).is_err());
}

fn active_user_fields() -> UserFields {
    UserFields {
        id: user_id(),
        email: "Admin@Example.test".into(),
        normalized_email: "admin@example.test".into(),
        display_name: "Instance Administrator".into(),
        status: UserStatus::Active,
        is_instance_admin: true,
        created_at: timestamp(100),
        updated_at: timestamp(100),
        disabled_at: None,
    }
}

fn active_session_fields() -> SessionFields {
    SessionFields {
        id: session_id(),
        user_id: user_id(),
        created_at: timestamp(100),
        last_seen_at: timestamp(110),
        idle_expires_at: timestamp(200),
        absolute_expires_at: timestamp(300),
        last_reauthenticated_at: Some(timestamp(105)),
        rotated_at: None,
        revoked_at: None,
        revocation_reason: None,
        replaced_by_session_id: None,
    }
}

fn timestamp(seconds: i64) -> Timestamp {
    Timestamp::from_unix_timestamp(seconds).unwrap_or_else(|error| panic!("{error}"))
}

fn user_id() -> UserId {
    UserId::from_str(USER_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn session_id() -> SessionId {
    SessionId::from_str(SESSION_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn replacement_session_id() -> SessionId {
    SessionId::from_str(REPLACEMENT_SESSION_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn non_rfc_uuid_v7(value: &str) -> Uuid {
    let mut bytes = Uuid::parse_str(value)
        .unwrap_or_else(|error| panic!("UUID fixture: {error}"))
        .into_bytes();
    bytes[8] &= 0x3f;
    Uuid::from_bytes(bytes)
}
