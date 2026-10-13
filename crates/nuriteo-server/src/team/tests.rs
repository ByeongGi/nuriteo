use std::str::FromStr;

use serde_json::{Value, json};
use uuid::{Uuid, Variant, Version};

use super::*;
use crate::identity::{Timestamp, UserId};
use crate::organization::{OrganizationId, OrganizationRole, OrganizationStatus};
use crate::project::{ProjectId, ProjectRole};

const TEAM_ID: &str = "0199ee6c-c777-7000-8000-000000007001";
const ORGANIZATION_ID: &str = "0199ee6c-c777-7000-8000-000000007002";
const USER_ID: &str = "0199ee6c-c777-7000-8000-000000007003";
const PROJECT_ID: &str = "0199ee6c-c777-7000-8000-000000007004";

#[test]
fn identifiers_are_uuid_v7_and_serialize_canonically() {
    for _ in 0..128 {
        let id = TeamId::new();
        assert_eq!(id.into_uuid().get_version(), Some(Version::SortRand));
        assert_eq!(id.into_uuid().get_variant(), Variant::RFC4122);
        assert_eq!(id.to_string().parse(), Ok(id));
        assert_eq!(TeamId::try_from(id.into_uuid()), Ok(id));
    }

    assert_eq!(
        TeamId::from_uuid(Uuid::nil()),
        Err(TeamError::NilIdentifier)
    );
    assert_eq!(
        TeamId::from_uuid(Uuid::new_v4()),
        Err(TeamError::IdentifierMustBeVersion7)
    );
    assert_eq!(
        "not-a-uuid".parse::<TeamId>(),
        Err(TeamError::InvalidIdentifier)
    );

    let mut bytes = team_id().into_uuid().into_bytes();
    bytes[8] &= 0x3f;
    let non_rfc = Uuid::from_bytes(bytes);
    assert_eq!(
        TeamId::from_uuid(non_rfc),
        Err(TeamError::IdentifierMustBeVersion7)
    );
    assert!(serde_json::from_value::<TeamId>(json!(non_rfc.to_string())).is_err());

    let encoded = serde_json::to_string(&team_id()).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(encoded, format!("\"{TEAM_ID}\""));
    assert_eq!(
        serde_json::from_str::<TeamId>(&encoded).unwrap_or_else(|error| panic!("{error}")),
        team_id()
    );
}

#[test]
fn slug_and_display_name_tables_enforce_canonical_values() {
    let slug_cases = [
        ("a".to_owned(), true),
        ("platform-42".to_owned(), true),
        ("a".repeat(63), true),
        (String::new(), false),
        ("Platform".to_owned(), false),
        ("-platform".to_owned(), false),
        ("platform-".to_owned(), false),
        ("platform_team".to_owned(), false),
        ("한글".to_owned(), false),
        ("a".repeat(64), false),
    ];
    for (value, expected) in slug_cases {
        assert_eq!(TeamSlug::new(value.clone()).is_ok(), expected, "{value:?}");
    }

    let name_cases = [
        ("Platform".to_owned(), true),
        ("플랫폼 🚀".to_owned(), true),
        ("가".repeat(200), true),
        (String::new(), false),
        (" Platform".to_owned(), false),
        ("Platform ".to_owned(), false),
        ("Platform\nTeam".to_owned(), false),
        ("Platform\tTeam".to_owned(), false),
        ("가".repeat(201), false),
    ];
    for (value, expected) in name_cases {
        assert_eq!(
            TeamDisplayName::new(value.clone()).is_ok(),
            expected,
            "{value:?}"
        );
    }

    let slug = TeamSlug::from_str("platform-42").unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(slug.as_str(), "platform-42");
    assert_eq!(slug.clone().into_string(), "platform-42");
    assert_eq!(slug.to_string(), "platform-42");

    let name = TeamDisplayName::new("Platform".into()).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(name.as_str(), "Platform");
    assert_eq!(name.into_string(), "Platform");
}

#[test]
fn team_is_directly_scoped_to_one_organization() {
    let team = valid_team();
    assert_eq!(team.organization_id(), organization_id());
    assert_eq!(team.slug().as_str(), "platform");
    assert_eq!(team.display_name().as_str(), "Platform");

    let value = serde_json::to_value(&team).unwrap_or_else(|error| panic!("{error}"));
    let object = value.as_object().expect("team serializes as an object");
    assert_eq!(object.get("organization_id"), Some(&json!(ORGANIZATION_ID)));
    assert_eq!(object.get("display_name"), Some(&json!("Platform")));
    assert!(!object.contains_key("owner_project_id"));
    assert!(!object.contains_key("parent_team_id"));
}

#[test]
fn timestamps_fail_closed_for_team_membership_and_project_role() {
    assert_eq!(valid_team().created_at(), timestamp(100));
    assert_eq!(valid_team().updated_at(), timestamp(100));
    assert_eq!(valid_team().lock_version().get(), 1);
    assert_eq!(
        Team::reconstruct(
            team_id(),
            organization_id(),
            TeamSlug::new("platform".into()).unwrap_or_else(|error| panic!("{error}")),
            TeamDisplayName::new("Platform".into()).unwrap_or_else(|error| panic!("{error}")),
            timestamp(101),
            timestamp(100),
            version(),
        ),
        Err(TeamError::InvalidTimestampOrder)
    );

    let membership = TeamMembership::reconstruct(
        team_id(),
        organization_id(),
        user_id(),
        TeamRole::Maintainer,
        timestamp(100),
        timestamp(101),
        membership_version(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(membership.team_id(), team_id());
    assert_eq!(membership.organization_id(), organization_id());
    assert_eq!(membership.user_id(), user_id());
    assert_eq!(membership.role(), TeamRole::Maintainer);
    assert_eq!(membership.created_at(), timestamp(100));
    assert_eq!(membership.updated_at(), timestamp(101));
    assert_eq!(membership.lock_version().get(), 1);
    assert_eq!(
        TeamMembership::reconstruct(
            team_id(),
            organization_id(),
            user_id(),
            TeamRole::Member,
            timestamp(101),
            timestamp(100),
            membership_version(),
        ),
        Err(TeamError::InvalidTimestampOrder)
    );

    let grant = TeamProjectRoleGrant::reconstruct(
        team_id(),
        organization_id(),
        project_id(),
        ProjectRole::Write,
        timestamp(100),
        timestamp(101),
        project_role_version(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(grant.team_id(), team_id());
    assert_eq!(grant.organization_id(), organization_id());
    assert_eq!(grant.project_id(), project_id());
    assert_eq!(grant.role(), ProjectRole::Write);
    assert_eq!(grant.created_at(), timestamp(100));
    assert_eq!(grant.updated_at(), timestamp(101));
    assert_eq!(grant.lock_version().get(), 1);
    assert_eq!(
        TeamProjectRoleGrant::reconstruct(
            team_id(),
            organization_id(),
            project_id(),
            ProjectRole::Read,
            timestamp(101),
            timestamp(100),
            project_role_version(),
        ),
        Err(TeamError::InvalidTimestampOrder)
    );
}

#[test]
fn validated_deserialization_preserves_domain_invariants() {
    let team = valid_team();
    let encoded = serde_json::to_string(&team).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        serde_json::from_str::<Team>(&encoded).unwrap_or_else(|error| panic!("{error}")),
        team
    );

    let mut invalid: Value =
        serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    invalid["slug"] = json!("Not-Canonical");
    assert!(serde_json::from_value::<Team>(invalid).is_err());

    let mut invalid: Value =
        serde_json::from_str(&encoded).unwrap_or_else(|error| panic!("{error}"));
    invalid["updated_at"] = json!(timestamp(99).to_string());
    assert!(serde_json::from_value::<Team>(invalid).is_err());
}

#[test]
fn lock_version_is_bounded_and_advances_explicitly() {
    assert_eq!(TeamVersion::new(0), Err(TeamError::InvalidLockVersion));
    assert_eq!(
        TeamVersion::new(i64::MAX),
        Err(TeamError::InvalidLockVersion)
    );
    assert_eq!(version().next().map(TeamVersion::get), Ok(2));
    let last = TeamVersion::new(i64::MAX - 1).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(last.next(), Err(TeamError::LockVersionExhausted));

    assert_eq!(
        TeamMembershipVersion::new(0),
        Err(TeamError::InvalidLockVersion)
    );
    assert_eq!(
        membership_version().next().map(TeamMembershipVersion::get),
        Ok(2)
    );

    assert_eq!(
        TeamProjectRoleVersion::new(0),
        Err(TeamError::InvalidLockVersion)
    );
    assert_eq!(
        project_role_version()
            .next()
            .map(TeamProjectRoleVersion::get),
        Ok(2)
    );
    let last = TeamProjectRoleVersion::new(i64::MAX - 1).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(last.next(), Err(TeamError::LockVersionExhausted));
}

#[test]
fn authorization_matrix_matches_organization_and_team_policy() {
    let actions = [
        TeamAction::Create,
        TeamAction::View,
        TeamAction::Rename,
        TeamAction::ManageMembers,
        TeamAction::ManageProjectRoles,
        TeamAction::Delete,
    ];
    let cases = [
        (
            "organization owner",
            authorization(active_membership(OrganizationRole::Owner), None),
            [true, true, true, true, true, true],
        ),
        (
            "team maintainer",
            authorization(
                active_membership(OrganizationRole::Member),
                Some(TeamRole::Maintainer),
            ),
            [false, true, true, true, false, false],
        ),
        (
            "team member",
            authorization(
                active_membership(OrganizationRole::Member),
                Some(TeamRole::Member),
            ),
            [false, true, false, false, false, false],
        ),
        (
            "organization member outside team",
            authorization(active_membership(OrganizationRole::Member), None),
            [false, false, false, false, false, false],
        ),
        (
            "inactive organization owner",
            authorization(
                TeamOrganizationMembership::Inactive {
                    organization_id: organization_id(),
                    role: OrganizationRole::Owner,
                },
                Some(TeamRole::Maintainer),
            ),
            [false, false, false, false, false, false],
        ),
        (
            "nonmember with stale team role",
            authorization(TeamOrganizationMembership::None, Some(TeamRole::Maintainer)),
            [false, false, false, false, false, false],
        ),
        (
            "owner of another organization",
            authorization(
                TeamOrganizationMembership::Active {
                    organization_id: other_organization_id(),
                    role: OrganizationRole::Owner,
                },
                None,
            ),
            [false, false, false, false, false, false],
        ),
        (
            "instance administrator",
            TeamAuthorization::new(
                organization_id(),
                OrganizationStatus::Active,
                TeamAuthorizationPrincipal::InstanceAdministrator,
            ),
            [true, true, true, true, true, true],
        ),
    ];

    for (principal, authorization, expected) in cases {
        for (action, expected) in actions.into_iter().zip(expected) {
            assert_eq!(
                authorization.allows(action),
                expected,
                "principal={principal}, action={action:?}"
            );
        }
    }

    let archived_organization = TeamAuthorization::new(
        organization_id(),
        OrganizationStatus::Archived,
        TeamAuthorizationPrincipal::User {
            organization_membership: active_membership(OrganizationRole::Owner),
            team_role: Some(TeamRole::Maintainer),
        },
    );
    for action in actions {
        assert!(!archived_organization.allows(action), "action={action:?}");
    }

    let archived_administrator = TeamAuthorization::new(
        organization_id(),
        OrganizationStatus::Archived,
        TeamAuthorizationPrincipal::InstanceAdministrator,
    );
    for action in actions {
        assert_eq!(
            archived_administrator.allows(action),
            action == TeamAction::View,
            "action={action:?}"
        );
    }
}

#[test]
fn effective_project_role_composes_only_active_project_grants() {
    use crate::organization::OrganizationStatus;
    use crate::project::{EffectiveProjectRole, ProjectOwner};

    assert_eq!(
        effective_project_role(
            ProjectOwner::Organization(organization_id()),
            user_id(),
            true,
            Some(OrganizationStatus::Active),
            active_membership(OrganizationRole::Owner),
            None,
            &[],
        ),
        EffectiveProjectRole::Admin
    );
    assert_eq!(
        effective_project_role(
            ProjectOwner::Organization(organization_id()),
            user_id(),
            true,
            Some(OrganizationStatus::Active),
            active_membership(OrganizationRole::Member),
            Some(ProjectRole::Read),
            &[ProjectRole::Write, ProjectRole::Read],
        ),
        EffectiveProjectRole::Write
    );

    for membership in [
        TeamOrganizationMembership::None,
        TeamOrganizationMembership::Inactive {
            organization_id: organization_id(),
            role: OrganizationRole::Member,
        },
        TeamOrganizationMembership::Active {
            organization_id: other_organization_id(),
            role: OrganizationRole::Owner,
        },
    ] {
        assert_eq!(
            effective_project_role(
                ProjectOwner::Organization(organization_id()),
                user_id(),
                true,
                Some(OrganizationStatus::Active),
                membership,
                Some(ProjectRole::Admin),
                &[ProjectRole::Admin],
            ),
            EffectiveProjectRole::None
        );
    }

    assert_eq!(
        effective_project_role(
            ProjectOwner::Organization(organization_id()),
            user_id(),
            true,
            Some(OrganizationStatus::Archived),
            active_membership(OrganizationRole::Owner),
            Some(ProjectRole::Admin),
            &[ProjectRole::Admin],
        ),
        EffectiveProjectRole::None
    );

    assert_eq!(
        effective_project_role(
            ProjectOwner::User(user_id()),
            user_id(),
            true,
            None,
            active_membership(OrganizationRole::Member),
            None,
            &[ProjectRole::Admin],
        ),
        EffectiveProjectRole::Admin
    );
    assert_eq!(
        effective_project_role(
            ProjectOwner::User(other_user_id()),
            user_id(),
            true,
            None,
            active_membership(OrganizationRole::Member),
            Some(ProjectRole::Admin),
            &[ProjectRole::Admin],
        ),
        EffectiveProjectRole::None
    );

    // A Team role controls Team administration; without a Project binding it
    // contributes no Project authority.
    assert!(
        authorization(
            active_membership(OrganizationRole::Member),
            Some(TeamRole::Maintainer)
        )
        .allows(TeamAction::View)
    );
    assert_eq!(
        effective_project_role(
            ProjectOwner::Organization(organization_id()),
            user_id(),
            true,
            Some(OrganizationStatus::Active),
            active_membership(OrganizationRole::Member),
            None,
            &[],
        ),
        EffectiveProjectRole::None
    );

    assert_eq!(
        effective_project_role(
            ProjectOwner::User(user_id()),
            user_id(),
            false,
            None,
            TeamOrganizationMembership::None,
            Some(ProjectRole::Admin),
            &[ProjectRole::Admin],
        ),
        EffectiveProjectRole::None
    );
}

fn valid_team() -> Team {
    Team::reconstruct(
        team_id(),
        organization_id(),
        TeamSlug::new("platform".into()).unwrap_or_else(|error| panic!("{error}")),
        TeamDisplayName::new("Platform".into()).unwrap_or_else(|error| panic!("{error}")),
        timestamp(100),
        timestamp(100),
        version(),
    )
    .unwrap_or_else(|error| panic!("{error}"))
}

fn team_id() -> TeamId {
    TeamId::from_str(TEAM_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn organization_id() -> OrganizationId {
    OrganizationId::from_str(ORGANIZATION_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn other_organization_id() -> OrganizationId {
    OrganizationId::from_str("0199ee6c-c777-7000-8000-000000007005")
        .unwrap_or_else(|error| panic!("{error}"))
}

fn user_id() -> UserId {
    UserId::from_str(USER_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn other_user_id() -> UserId {
    UserId::from_str("0199ee6c-c777-7000-8000-000000007006")
        .unwrap_or_else(|error| panic!("{error}"))
}

fn project_id() -> ProjectId {
    ProjectId::from_str(PROJECT_ID).unwrap_or_else(|error| panic!("{error}"))
}

fn timestamp(seconds: i64) -> Timestamp {
    Timestamp::from_unix_timestamp(seconds).unwrap_or_else(|error| panic!("{error}"))
}

fn version() -> TeamVersion {
    TeamVersion::new(1).unwrap_or_else(|error| panic!("{error}"))
}

fn project_role_version() -> TeamProjectRoleVersion {
    TeamProjectRoleVersion::new(1).unwrap_or_else(|error| panic!("{error}"))
}

fn active_membership(role: OrganizationRole) -> TeamOrganizationMembership {
    TeamOrganizationMembership::Active {
        organization_id: organization_id(),
        role,
    }
}

fn authorization(
    organization_membership: TeamOrganizationMembership,
    team_role: Option<TeamRole>,
) -> TeamAuthorization {
    TeamAuthorization::new(
        organization_id(),
        OrganizationStatus::Active,
        TeamAuthorizationPrincipal::User {
            organization_membership,
            team_role,
        },
    )
}

fn membership_version() -> TeamMembershipVersion {
    TeamMembershipVersion::new(1).unwrap_or_else(|error| panic!("{error}"))
}
