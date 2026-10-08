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
