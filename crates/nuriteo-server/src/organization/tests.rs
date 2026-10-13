use std::str::FromStr;

use serde_json::{Value, json};
use uuid::{Uuid, Variant, Version};

use super::*;
use crate::identity::{Timestamp, UserId};

const ORGANIZATION_ID: &str = "0199ee6c-c777-7000-8000-000000000701";
const USER_ID: &str = "0199ee6c-c777-7000-8000-000000000702";

#[test]
fn identifiers_are_uuid_v7_and_serialize_canonically() {
    for _ in 0..128 {
        let id = OrganizationId::new();
        assert_eq!(id.into_uuid().get_version(), Some(Version::SortRand));
        assert_eq!(id.into_uuid().get_variant(), Variant::RFC4122);
        assert_eq!(id.to_string().parse(), Ok(id));
    }
    assert_eq!(
        OrganizationId::from_uuid(Uuid::nil()),
        Err(OrganizationError::NilIdentifier)
    );
    assert_eq!(
        OrganizationId::from_uuid(Uuid::new_v4()),
        Err(OrganizationError::IdentifierMustBeVersion7)
    );
    assert_eq!(
        "invalid".parse::<OrganizationId>(),
        Err(OrganizationError::InvalidIdentifier)
    );

    let invalid = non_rfc_uuid_v7(organization_id().into_uuid());
    assert_eq!(invalid.get_version(), Some(Version::SortRand));
    assert_ne!(invalid.get_variant(), Variant::RFC4122);
    assert_eq!(
        OrganizationId::from_uuid(invalid),
        Err(OrganizationError::IdentifierMustBeVersion7)
    );
    assert_eq!(
        invalid.to_string().parse::<OrganizationId>(),
        Err(OrganizationError::IdentifierMustBeVersion7)
    );
    assert!(serde_json::from_value::<OrganizationId>(json!(invalid.to_string())).is_err());

    let id = organization_id();
    let encoded = serde_json::to_string(&id).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(encoded, format!("\"{ORGANIZATION_ID}\""));
    assert_eq!(
        serde_json::from_str::<OrganizationId>(&encoded).unwrap_or_else(|error| panic!("{error}")),
        id
    );
}

fn non_rfc_uuid_v7(value: Uuid) -> Uuid {
    let mut bytes = value.into_bytes();
    bytes[8] &= 0x3f;
    Uuid::from_bytes(bytes)
}

#[test]
fn slug_table_matches_canonical_database_grammar() {
    let cases = [
        ("a", true),
        ("team-42", true),
        (&"a".repeat(63), true),
        ("", false),
        ("A-team", false),
        ("-team", false),
        ("team-", false),
        ("team_name", false),
        ("한글", false),
        (&"a".repeat(64), false),
    ];
    for (slug, expected) in cases {
        let fields = OrganizationFields {
            slug: slug.into(),
            ..active_fields()
        };
        assert_eq!(Organization::new(fields).is_ok(), expected, "slug={slug}");
    }
}

#[test]
fn organization_lifecycle_timestamp_and_name_validation_fail_closed() {
    let valid = [
        active_fields(),
        OrganizationFields {
            status: OrganizationStatus::Archived,
            updated_at: timestamp(120),
            archived_at: Some(timestamp(110)),
            ..active_fields()
        },
    ];
    for fields in valid {
        assert!(Organization::new(fields).is_ok());
    }

    let invalid = [
        OrganizationFields {
            display_name: " Team".into(),
            ..active_fields()
        },
        OrganizationFields {
            display_name: "Team\nName".into(),
            ..active_fields()
        },
        OrganizationFields {
            status: OrganizationStatus::Archived,
            archived_at: None,
            ..active_fields()
        },
        OrganizationFields {
            updated_at: timestamp(99),
            ..active_fields()
        },
        OrganizationFields {
            status: OrganizationStatus::Archived,
            updated_at: timestamp(109),
            archived_at: Some(timestamp(110)),
            ..active_fields()
        },
    ];
    for fields in invalid {
        assert!(Organization::new(fields).is_err());
    }
}

#[test]
fn validated_serialization_and_membership_preserve_domain_invariants() {
    let organization = Organization::new(active_fields()).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(organization.id(), organization_id());
    assert_eq!(organization.slug(), "example-team");
    assert_eq!(organization.status(), OrganizationStatus::Active);
    assert_eq!(organization.lock_version().get(), 1);

    let encoded = serde_json::to_string(&organization).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        serde_json::from_str::<Organization>(&encoded).unwrap_or_else(|error| panic!("{error}")),
        organization
    );
    let mut invalid: Value =
        serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    invalid["slug"] = json!("Not-Canonical");
    assert!(serde_json::from_value::<Organization>(invalid).is_err());

    assert!(
        OrganizationMembership::new(OrganizationMembershipFields {
            organization_id: organization_id(),
            user_id: user_id(),
            role: OrganizationRole::Owner,
            created_at: timestamp(100),
            updated_at: timestamp(101),
        })
        .is_ok()
    );
    assert_eq!(
        OrganizationMembership::new(OrganizationMembershipFields {
            organization_id: organization_id(),
            user_id: user_id(),
            role: OrganizationRole::Member,
            created_at: timestamp(101),
            updated_at: timestamp(100),
        }),
        Err(OrganizationError::InvalidTimestampOrder)
    );
}

#[test]
fn lock_version_is_bounded_and_advances_explicitly() {
    assert_eq!(
        OrganizationVersion::new(0),
        Err(OrganizationError::InvalidLockVersion)
    );
    assert_eq!(
        OrganizationVersion::new(i64::MAX),
        Err(OrganizationError::InvalidLockVersion)
    );
    let first = OrganizationVersion::new(1).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(first.next().map(OrganizationVersion::get), Ok(2));
    let last = OrganizationVersion::new(i64::MAX - 1).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(last.next(), Err(OrganizationError::LockVersionExhausted));
}

fn active_fields() -> OrganizationFields {
    OrganizationFields {
        id: organization_id(),
        slug: "example-team".into(),
        display_name: "Example Team".into(),
        status: OrganizationStatus::Active,
        created_at: timestamp(100),
        updated_at: timestamp(100),
        archived_at: None,
        lock_version: OrganizationVersion::new(1).unwrap_or_else(|error| panic!("{error}")),
    }
}

fn organization_id() -> OrganizationId {
    OrganizationId::from_str(ORGANIZATION_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn user_id() -> UserId {
    UserId::from_str(USER_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn timestamp(seconds: i64) -> Timestamp {
    Timestamp::from_unix_timestamp(seconds).unwrap_or_else(|error| panic!("{error}"))
}
