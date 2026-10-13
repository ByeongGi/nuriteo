use super::*;

#[test]
fn readiness_summaries_are_stable_and_machine_safe() {
    let cases = [
        (
            SchemaReadiness::Ready { version: 4 },
            "schema=ready version=4",
        ),
        (
            SchemaReadiness::Pending {
                current: None,
                target: 4,
            },
            "schema=pending current=none target=4",
        ),
        (
            SchemaReadiness::Pending {
                current: Some(2),
                target: 4,
            },
            "schema=pending current=2 target=4",
        ),
        (
            SchemaReadiness::Dirty { version: 2 },
            "schema=dirty version=2",
        ),
        (
            SchemaReadiness::ChecksumMismatch { version: 2 },
            "schema=checksum-mismatch version=2",
        ),
        (
            SchemaReadiness::Unsupported { version: 9 },
            "schema=unsupported version=9",
        ),
    ];

    for (readiness, expected) in cases {
        assert_eq!(readiness.summary(), expected);
    }
}

#[test]
fn only_ready_and_pending_allow_the_migration_runner() {
    assert!(SchemaReadiness::Ready { version: 1 }.allows_migration());
    assert!(
        SchemaReadiness::Pending {
            current: None,
            target: 1
        }
        .allows_migration()
    );
    for blocked in [
        SchemaReadiness::Dirty { version: 1 },
        SchemaReadiness::ChecksumMismatch { version: 1 },
        SchemaReadiness::Unsupported { version: 2 },
    ] {
        assert!(!blocked.allows_migration());
    }
}
