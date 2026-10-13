use std::str::FromStr;

use serde_json::json;
use uuid::{Uuid, Variant, Version};

use crate::identity::{Timestamp, UserId};
use crate::organization::OrganizationId;

use super::{
    OrganizationStorageScope, OrganizationWorkspace, PersonalStorageScope, PersonalWorkspace,
    StorageScopeId, WorkspaceDomainError, WorkspaceOwnerType,
};

#[test]
fn storage_scope_identifiers_are_uuid_v7_and_serialize_stably() {
    let id = StorageScopeId::new();
    assert_eq!(id.into_uuid().get_version_num(), 7);
    assert_eq!(id.into_uuid().get_variant(), Variant::RFC4122);
    let json = serde_json::to_string(&id).expect("scope ID must serialize");
    assert_eq!(
        serde_json::from_str::<StorageScopeId>(&json).expect("scope ID must deserialize"),
        id
    );
    assert_eq!(
        StorageScopeId::from_str("00000000-0000-0000-0000-000000000000"),
        Err(WorkspaceDomainError::NilIdentifier)
    );
    assert_eq!(
        StorageScopeId::from_uuid(Uuid::new_v4()),
        Err(WorkspaceDomainError::IdentifierMustBeVersion7)
    );

    let invalid = non_rfc_uuid_v7(id.into_uuid());
    assert_eq!(invalid.get_version(), Some(Version::SortRand));
    assert_ne!(invalid.get_variant(), Variant::RFC4122);
    assert_eq!(
        StorageScopeId::from_uuid(invalid),
        Err(WorkspaceDomainError::IdentifierMustBeVersion7)
    );
    assert_eq!(
        invalid.to_string().parse::<StorageScopeId>(),
        Err(WorkspaceDomainError::IdentifierMustBeVersion7)
    );
    assert!(serde_json::from_value::<StorageScopeId>(json!(invalid.to_string())).is_err());
}

fn non_rfc_uuid_v7(value: Uuid) -> Uuid {
    let mut bytes = value.into_bytes();
    bytes[8] &= 0x3f;
    Uuid::from_bytes(bytes)
}

#[test]
fn organization_scope_and_projection_enforce_safe_boundaries() {
    let owner = OrganizationId::new();
    let scope_id = StorageScopeId::new();
    let created = Timestamp::from_unix_timestamp(1_700_000_000).expect("timestamp must parse");
    let earlier = Timestamp::from_unix_timestamp(1_699_999_999).expect("timestamp must parse");
    assert_eq!(
        OrganizationStorageScope::new(scope_id, owner, created, earlier),
        Err(WorkspaceDomainError::InvalidTimestampOrder)
    );
    let scope = OrganizationStorageScope::new(scope_id, owner, created, created)
        .expect("valid organization scope must construct");
    assert_eq!(scope.id(), scope_id);
    assert_eq!(scope.owner_organization_id(), owner);

    let projection = OrganizationWorkspace::new(owner, "Platform Team".into(), scope_id)
        .expect("valid organization projection must construct");
    assert_eq!(projection.owner_type(), WorkspaceOwnerType::Organization);
    assert_eq!(projection.owner_id(), owner);
    assert_eq!(projection.storage_scope_id(), scope_id);
    assert_eq!(
        serde_json::to_value(&projection).expect("projection must serialize"),
        json!({
            "ownerType": "organization",
            "ownerId": owner.to_string(),
            "displayLabel": "Platform Team",
            "storageScopeId": scope_id.to_string()
        })
    );
}

#[test]
fn personal_scope_and_projection_enforce_safe_boundaries() {
    let owner = UserId::new();
    let scope_id = StorageScopeId::new();
    let created = Timestamp::from_unix_timestamp(1_700_000_000).expect("timestamp must parse");
    let earlier = Timestamp::from_unix_timestamp(1_699_999_999).expect("timestamp must parse");
    assert_eq!(
        PersonalStorageScope::new(scope_id, owner, created, earlier),
        Err(WorkspaceDomainError::InvalidTimestampOrder)
    );

    let projection = PersonalWorkspace::new(owner, "Ada Lovelace".into(), scope_id)
        .expect("valid projection must construct");
    assert_eq!(projection.owner_type(), WorkspaceOwnerType::User);
    assert_eq!(projection.owner_id(), owner);
    assert_eq!(projection.storage_scope_id(), scope_id);
    assert_eq!(
        serde_json::to_value(&projection).expect("projection must serialize"),
        json!({
            "ownerType": "user",
            "ownerId": owner.to_string(),
            "displayLabel": "Ada Lovelace",
            "storageScopeId": scope_id.to_string()
        })
    );
    for invalid in ["", " padded", "padded ", "control\nlabel"] {
        assert_eq!(
            PersonalWorkspace::new(owner, invalid.into(), scope_id),
            Err(WorkspaceDomainError::InvalidDisplayLabel)
        );
    }
}
