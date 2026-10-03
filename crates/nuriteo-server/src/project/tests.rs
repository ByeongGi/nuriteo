use std::str::FromStr;

use serde_json::{Value, json};
use uuid::{Uuid, Variant, Version};

use super::*;
use crate::identity::{Timestamp, UserId};
use crate::organization::OrganizationId;
use crate::workspace::StorageScopeId;

const PROJECT_ID: &str = "0199ee6c-c777-7000-8000-000000002001";
const USER_ID: &str = "0199ee6c-c777-7000-8000-000000002002";
const ORGANIZATION_ID: &str = "0199ee6c-c777-7000-8000-000000002003";
const STORAGE_SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000002004";

#[test]
fn identifiers_are_uuid_v7_and_serialize_canonically() {
    for _ in 0..128 {
        let id = ProjectId::new();
        assert_eq!(id.into_uuid().get_version(), Some(Version::SortRand));
        assert_eq!(id.into_uuid().get_variant(), Variant::RFC4122);
        assert_eq!(id.to_string().parse(), Ok(id));
        assert_eq!(ProjectId::try_from(id.into_uuid()), Ok(id));
    }

    assert_eq!(
        ProjectId::from_uuid(Uuid::nil()),
        Err(ProjectError::NilIdentifier)
    );
    assert_eq!(
        ProjectId::from_uuid(Uuid::new_v4()),
        Err(ProjectError::IdentifierMustBeVersion7)
    );
    assert_eq!(
        "not-a-uuid".parse::<ProjectId>(),
        Err(ProjectError::InvalidIdentifier)
    );

    let mut non_rfc_bytes = project_id().into_uuid().into_bytes();
    non_rfc_bytes[8] &= 0x3f;
    let non_rfc = Uuid::from_bytes(non_rfc_bytes);
    assert_eq!(
        ProjectId::from_uuid(non_rfc),
        Err(ProjectError::IdentifierMustBeVersion7)
    );
    assert_eq!(
        non_rfc.to_string().parse::<ProjectId>(),
        Err(ProjectError::IdentifierMustBeVersion7)
    );
    assert!(serde_json::from_value::<ProjectId>(json!(non_rfc.to_string())).is_err());

    let encoded = serde_json::to_string(&project_id()).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(encoded, format!("\"{PROJECT_ID}\""));
    assert_eq!(
        serde_json::from_str::<ProjectId>(&encoded).unwrap_or_else(|error| panic!("{error}")),
        project_id()
    );
}

#[test]
fn project_reconstruction_rejects_non_rfc_owner_and_scope_ids() {
    let user_project = reconstruct(active_fields(ProjectOwner::User(user_id())))
        .unwrap_or_else(|error| panic!("user project fixture: {error}"));
    let mut invalid_user_owner =
        serde_json::to_value(&user_project).unwrap_or_else(|error| panic!("serialize: {error}"));
    let encoded_user_id = invalid_user_owner
        .get_mut("owner")
        .and_then(Value::as_object_mut)
        .and_then(|owner| owner.get_mut("user"))
        .expect("snake_case user owner must exist");
    assert_eq!(encoded_user_id.as_str(), Some(USER_ID));
    *encoded_user_id = json!(non_rfc_uuid_v7(USER_ID).to_string());
    assert!(serde_json::from_value::<Project>(invalid_user_owner).is_err());

    let organization_project =
        reconstruct(active_fields(ProjectOwner::Organization(organization_id())))
            .unwrap_or_else(|error| panic!("organization project fixture: {error}"));
    let mut invalid_organization_owner = serde_json::to_value(&organization_project)
        .unwrap_or_else(|error| panic!("serialize: {error}"));
    let encoded_organization_id = invalid_organization_owner
        .get_mut("owner")
        .and_then(Value::as_object_mut)
        .and_then(|owner| owner.get_mut("organization"))
        .expect("snake_case organization owner must exist");
    assert_eq!(encoded_organization_id.as_str(), Some(ORGANIZATION_ID));
    *encoded_organization_id = json!(non_rfc_uuid_v7(ORGANIZATION_ID).to_string());
    assert!(serde_json::from_value::<Project>(invalid_organization_owner).is_err());

    let mut invalid_scope =
        serde_json::to_value(&user_project).unwrap_or_else(|error| panic!("serialize: {error}"));
    let encoded_scope_id = invalid_scope
        .get_mut("storage_scope_id")
        .expect("storage_scope_id must exist");
    assert_eq!(encoded_scope_id.as_str(), Some(STORAGE_SCOPE_ID));
    *encoded_scope_id = json!(non_rfc_uuid_v7(STORAGE_SCOPE_ID).to_string());
    assert!(serde_json::from_value::<Project>(invalid_scope).is_err());
}

#[test]
fn owner_is_exactly_one_typed_identity() {
    let user = user_id();
    let organization = organization_id();
    assert_eq!(
        ProjectOwner::from_nullable_ids(Some(user), None),
        Ok(ProjectOwner::User(user))
    );
    assert_eq!(
        ProjectOwner::from_nullable_ids(None, Some(organization)),
        Ok(ProjectOwner::Organization(organization))
    );
    assert_eq!(
        ProjectOwner::from_nullable_ids(None, None),
        Err(ProjectError::InvalidOwner)
    );
    assert_eq!(
        ProjectOwner::from_nullable_ids(Some(user), Some(organization)),
        Err(ProjectError::InvalidOwner)
    );

    for owner in [
        ProjectOwner::User(user),
        ProjectOwner::Organization(organization),
    ] {
        let encoded = serde_json::to_string(&owner).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            serde_json::from_str::<ProjectOwner>(&encoded)
                .unwrap_or_else(|error| panic!("{error}")),
            owner
        );
    }
}

#[test]
fn page_limits_match_the_public_api_policy() {
    assert_eq!(ProjectPageLimit::default().get(), DEFAULT_PROJECT_PAGE_SIZE);
    assert_eq!(ProjectPageLimit::new(1).map(ProjectPageLimit::get), Ok(1));
    assert_eq!(
        ProjectPageLimit::new(MAX_PROJECT_PAGE_SIZE).map(ProjectPageLimit::get),
        Ok(MAX_PROJECT_PAGE_SIZE)
    );
    assert_eq!(
        ProjectPageLimit::new(0),
        Err(ProjectRepositoryError::InvalidPageLimit)
    );
    assert_eq!(
        ProjectPageLimit::new(MAX_PROJECT_PAGE_SIZE + 1),
        Err(ProjectRepositoryError::InvalidPageLimit)
    );
}

#[test]
fn slug_rules_match_the_database_grammar() {
    let cases = [
        ("a".to_owned(), true),
        ("project-42".to_owned(), true),
        ("a".repeat(63), true),
        (String::new(), false),
        ("A-project".to_owned(), false),
        ("-project".to_owned(), false),
        ("project-".to_owned(), false),
        ("project_name".to_owned(), false),
        ("project.name".to_owned(), false),
        ("한글".to_owned(), false),
        ("a".repeat(64), false),
    ];
    for (slug, expected) in cases {
        assert_eq!(ProjectSlug::new(slug.clone()).is_ok(), expected, "{slug:?}");
    }

    for byte in 0_u8..=127 {
        let candidate = String::from_utf8(vec![b'a', byte, b'z'])
            .unwrap_or_else(|error| panic!("ASCII matrix must be UTF-8: {error}"));
        let expected = byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-';
        assert_eq!(
            ProjectSlug::new(candidate.clone()).is_ok(),
            expected,
            "middle byte {byte:#04x} in {candidate:?}"
        );
    }

    let slug = ProjectSlug::from_str("project-42").unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(slug.as_str(), "project-42");
    assert_eq!(slug.clone().into_string(), "project-42");
    assert_eq!(slug.to_string(), "project-42");
}

#[test]
fn name_rules_match_database_character_and_padding_bounds() {
    let cases = [
        ("Project".to_owned(), true),
        ("프로젝트 🚀".to_owned(), true),
        ("가".repeat(200), true),
        (String::new(), false),
        (" Project".to_owned(), false),
        ("Project ".to_owned(), false),
        ("Project\nName".to_owned(), false),
        ("Project\tName".to_owned(), false),
        ("가".repeat(201), false),
    ];
    for (name, expected) in cases {
        assert_eq!(ProjectName::new(name.clone()).is_ok(), expected, "{name:?}");
    }

    let name = ProjectName::new("Project".to_owned()).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(name.as_str(), "Project");
    assert_eq!(name.into_string(), "Project");
}

#[test]
fn lifecycle_and_timestamp_reconstruction_fail_closed() {
    assert!(reconstruct(active_fields(ProjectOwner::User(user_id()))).is_ok());
    assert!(
        reconstruct(ProjectFields {
            state: ProjectState::Archived,
            updated_at: timestamp(120),
            archived_at: Some(timestamp(110)),
            ..active_fields(ProjectOwner::Organization(organization_id()))
        })
        .is_ok()
    );

    let invalid = [
        ProjectFields {
            state: ProjectState::Archived,
            archived_at: None,
            ..active_fields(ProjectOwner::User(user_id()))
        },
        ProjectFields {
            archived_at: Some(timestamp(100)),
            ..active_fields(ProjectOwner::User(user_id()))
        },
        ProjectFields {
            updated_at: timestamp(99),
            ..active_fields(ProjectOwner::User(user_id()))
        },
        ProjectFields {
            state: ProjectState::Archived,
            updated_at: timestamp(109),
            archived_at: Some(timestamp(110)),
            ..active_fields(ProjectOwner::User(user_id()))
        },
        ProjectFields {
            state: ProjectState::Archived,
            updated_at: timestamp(120),
            archived_at: Some(timestamp(99)),
            ..active_fields(ProjectOwner::User(user_id()))
        },
    ];
    let expected = [
        ProjectError::InvalidLifecycle,
        ProjectError::InvalidLifecycle,
        ProjectError::InvalidTimestampOrder,
        ProjectError::InvalidTimestampOrder,
        ProjectError::InvalidTimestampOrder,
    ];
    for (fields, expected) in invalid.into_iter().zip(expected) {
        assert_eq!(reconstruct(fields), Err(expected));
    }
}

#[test]
fn validated_project_round_trips_and_rejects_tampered_json() {
    for fields in [
        active_fields(ProjectOwner::User(user_id())),
        ProjectFields {
            state: ProjectState::Archived,
            updated_at: timestamp(120),
            archived_at: Some(timestamp(110)),
            ..active_fields(ProjectOwner::Organization(organization_id()))
        },
    ] {
        let project = reconstruct(fields).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(project.id(), project_id());
        assert_eq!(project.storage_scope_id(), storage_scope_id());
        assert_eq!(project.slug().as_str(), "example-project");
        assert_eq!(project.name().as_str(), "Example Project");
        assert_eq!(project.created_at(), timestamp(100));
        assert_eq!(project.lock_version().get(), 1);

        let encoded = serde_json::to_string(&project).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            serde_json::from_str::<Project>(&encoded).unwrap_or_else(|error| panic!("{error}")),
            project
        );
        assert_eq!(
            reconstruct(project.clone().into_fields()).unwrap_or_else(|error| panic!("{error}")),
            project
        );

        for mutation in [
            ("slug", json!("Not-Canonical")),
            ("name", json!(" Padded")),
            ("id", json!(Uuid::new_v4().to_string())),
            ("lock_version", json!(0)),
        ] {
            let mut invalid: Value =
                serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
            invalid[mutation.0] = mutation.1;
            assert!(
                serde_json::from_value::<Project>(invalid).is_err(),
                "tampered {} must fail",
                mutation.0
            );
        }

        let mut invalid_lifecycle: Value =
            serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
        invalid_lifecycle["state"] = json!("archived");
        invalid_lifecycle["archived_at"] = Value::Null;
        assert!(serde_json::from_value::<Project>(invalid_lifecycle).is_err());
    }
}

#[test]
fn lock_version_is_bounded_and_advances_without_wraparound() {
    for invalid in [i64::MIN, -1, 0, i64::MAX] {
        assert_eq!(
            ProjectVersion::new(invalid),
            Err(ProjectError::InvalidLockVersion)
        );
    }
    let first = ProjectVersion::new(1).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(first.next().map(ProjectVersion::get), Ok(2));
    let last = ProjectVersion::new(i64::MAX - 1).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(last.next(), Err(ProjectError::LockVersionExhausted));

    let encoded = serde_json::to_string(&first).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(encoded, "1");
    assert_eq!(
        serde_json::from_str::<ProjectVersion>(&encoded).unwrap_or_else(|error| panic!("{error}")),
        first
    );
    assert!(serde_json::from_str::<ProjectVersion>("0").is_err());
}

#[test]
fn errors_are_stable_and_do_not_capture_rejected_input() {
    let rejected = "credential-shaped-project-name";
    let error =
        ProjectName::new(format!(" {rejected}")).expect_err("padded project name must be rejected");
    let rendered = format!("{error:?} {error}");
    assert!(!rendered.contains(rejected));
    assert_eq!(error, ProjectError::InvalidName);
}

fn active_fields(owner: ProjectOwner) -> ProjectFields {
    ProjectFields {
        id: project_id(),
        owner,
        storage_scope_id: storage_scope_id(),
        slug: ProjectSlug::new("example-project".to_owned())
            .unwrap_or_else(|error| panic!("{error}")),
        name: ProjectName::new("Example Project".to_owned())
            .unwrap_or_else(|error| panic!("{error}")),
        state: ProjectState::Active,
        created_at: timestamp(100),
        updated_at: timestamp(100),
        archived_at: None,
        lock_version: ProjectVersion::new(1).unwrap_or_else(|error| panic!("{error}")),
    }
}

fn reconstruct(fields: ProjectFields) -> Result<Project, ProjectError> {
    Project::reconstruct(
        fields.id,
        fields.owner,
        fields.storage_scope_id,
        fields.slug,
        fields.name,
        fields.state,
        fields.created_at,
        fields.updated_at,
        fields.archived_at,
        fields.lock_version,
    )
}

fn project_id() -> ProjectId {
    ProjectId::from_str(PROJECT_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn user_id() -> UserId {
    UserId::from_str(USER_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn organization_id() -> OrganizationId {
    OrganizationId::from_str(ORGANIZATION_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn storage_scope_id() -> StorageScopeId {
    StorageScopeId::from_str(STORAGE_SCOPE_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn non_rfc_uuid_v7(value: &str) -> Uuid {
    let mut bytes = Uuid::parse_str(value)
        .unwrap_or_else(|error| panic!("UUID fixture: {error}"))
        .into_bytes();
    bytes[8] &= 0x3f;
    Uuid::from_bytes(bytes)
}

fn timestamp(seconds: i64) -> Timestamp {
    Timestamp::from_unix_timestamp(seconds).unwrap_or_else(|error| panic!("{error}"))
}
