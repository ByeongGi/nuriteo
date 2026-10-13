use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use uuid::Uuid;

use super::*;

#[test]
fn public_id_requires_one_canonical_256_bit_opaque_value() {
    let value = URL_SAFE_NO_PAD.encode([19_u8; 32]);
    let public_id = PublishedExamplePublicId::new(value.clone()).expect("valid public id");
    assert_eq!(public_id.as_str(), value);
    assert!(PublishedExamplePublicId::new("short".into()).is_err());
    assert!(PublishedExamplePublicId::new(format!("{}=", &value[..42])).is_err());
}

#[test]
fn generated_public_ids_are_canonical_and_do_not_debug_leak() {
    let public_id = PublishedExamplePublicId::generate().expect("system entropy");
    assert_eq!(public_id.as_str().len(), 43);
    assert_eq!(
        format!("{public_id:?}"),
        "PublishedExamplePublicId([redacted])"
    );
}

#[test]
fn example_names_are_bounded_and_exact_for_delete_confirmation() {
    assert!(PublishedExampleName::new("demo".into()).is_ok());
    assert!(PublishedExampleName::new(" demo".into()).is_err());
    assert!(PublishedExampleName::new("demo\n".into()).is_err());
    assert!(PublishedExampleName::new("x".repeat(201)).is_err());
}

#[test]
fn identifiers_reject_non_v7_values() {
    assert!(PublishedExampleId::from_uuid(Uuid::new_v4()).is_err());
    assert!(PublishedExampleVersionId::from_uuid(Uuid::nil()).is_err());
}

#[test]
fn public_page_limit_is_bounded() {
    assert_eq!(MAX_PUBLIC_EXAMPLE_PAGE_SIZE, 100);
    assert!(PublishedExampleServicePolicy::new(std::time::Duration::from_millis(99)).is_err());
    assert!(PublishedExampleServicePolicy::new(std::time::Duration::from_secs(31)).is_err());
}

#[test]
fn migration_enforces_fixed_versions_and_permanent_public_id_reservation() {
    let migration = include_str!("../../migrations/0042_published_examples.sql");
    assert!(migration.contains("published_example_versions_immutable"));
    assert!(migration.contains("published_example_tombstones"));
    assert!(migration.contains("project_version_id, project_id"));
    assert!(migration.contains("DEFERRABLE INITIALLY DEFERRED"));
    assert!(migration.contains("ON DELETE CASCADE"));
}

#[test]
fn fork_idempotency_keys_are_bounded_and_redacted() {
    let key = PublishedExampleForkKey::new("browser-request-01".into()).expect("valid key");
    assert_eq!(key.as_str(), "browser-request-01");
    assert_eq!(format!("{key:?}"), "PublishedExampleForkKey([redacted])");
    assert!(PublishedExampleForkKey::new("short".into()).is_err());
    assert!(PublishedExampleForkKey::new("contains whitespace".into()).is_err());
    assert!(PublishedExampleForkKey::new("x".repeat(129)).is_err());
}

#[test]
fn fork_migration_requires_exact_source_and_independent_destination_admission() {
    let migration = include_str!("../../migrations/0043_published_example_forks.sql");
    assert!(migration.contains("published_example_forks_actor_key_unique"));
    assert!(migration.contains("idempotency_digest bytea"));
    assert!(!migration.contains("idempotency_key text"));
    assert!(migration.contains("example.state = 'published'"));
    assert!(migration.contains("destination_bundle_id uuid NOT NULL UNIQUE"));
    assert!(migration.contains("fork.destination_bundle_id = NEW.bundle_id"));
    assert!(!migration.contains("fork.source_bundle_id = NEW.bundle_id"));
    assert!(migration.contains("source_published_example_fork_id"));
    assert!(migration.contains("project_bundle_admissions_provenance_check"));
    assert!(migration.contains("source_save_session_id IS NULL"));
    assert!(!migration.contains("REFERENCES published_example_versions"));
    let materialization =
        include_str!("../../migrations/0044_git_working_head_materializations.sql");
    assert!(materialization.contains("published_example_forks_canonical_source_fk"));
    assert!(materialization.contains("materialization.project_id = NEW.destination_project_id"));
    assert!(
        materialization
            .contains("materialization.storage_scope_id = NEW.destination_storage_scope_id")
    );
}
