use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};
use sqlx::{Acquire, Executor};
use tokio::time;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const USER_ONE: &str = "0199ee6c-c777-7000-8000-000000001001";
const USER_TWO: &str = "0199ee6c-c777-7000-8000-000000001002";
const USER_SCOPE_ONE: &str = "0199ee6c-c777-7000-8000-000000001011";
const USER_SCOPE_TWO: &str = "0199ee6c-c777-7000-8000-000000001012";
const ORGANIZATION_ONE: &str = "0199ee6c-c777-7000-8000-000000001021";
const ORGANIZATION_TWO: &str = "0199ee6c-c777-7000-8000-000000001022";
const ORGANIZATION_SCOPE_ONE: &str = "0199ee6c-c777-7000-8000-000000001031";
const ORGANIZATION_SCOPE_TWO: &str = "0199ee6c-c777-7000-8000-000000001032";
const USER_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001041";
const USER_TWO_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001042";
const ORGANIZATION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001043";
const ORGANIZATION_TWO_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001044";
const RECREATED_USER_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001045";
const CONCURRENT_ORGANIZATION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001046";
const MISMATCHED_TOMBSTONE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001047";
const RENAMED_NAMESPACE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001048";
const PAST_TIMESTAMP_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001049";
const FUTURE_TIMESTAMP_PROJECT: &str = "0199ee6c-c777-7000-8000-000000001050";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-project/run.sh"]
async fn project_schema_enforces_owner_scope_slug_lifecycle_and_tombstones() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Pending {
            current: None,
            target: 14
        }
    );
    let first = migrate(&pool).await;
    assert_eq!(
        first,
        MigrationReport {
            latest_version: Some(15),
            known_migrations: 15
        }
    );
    assert_eq!(migrate(&pool).await, first);
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Ready { version: 14 }
    );

    seed_owners_and_scopes(&pool).await;
    verify_valid_owners_and_slug_namespaces(&pool).await;
    verify_project_constraints(&pool).await;
    verify_project_truncate_is_rejected(&pool).await;
    verify_managed_namespace_mutation_boundary(&pool).await;
    verify_archive_and_version_contract(&pool).await;
    verify_database_owned_deletion_timestamp(&pool).await;
    verify_tombstone_reservation(&pool).await;
    verify_bare_delete_and_immutable_tombstone(&pool).await;
    verify_tombstone_identity_matching(&pool).await;
    verify_delete_validates_pre_release_mismatched_tombstone(&pool).await;
    verify_concurrent_delete_and_create(&pool).await;
    verify_transaction_rollback(&pool).await;
    verify_schema_shape(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_valid_owners_and_slug_namespaces(pool: &DatabasePool) {
    insert_user_project(
        pool,
        USER_PROJECT,
        USER_ONE,
        USER_SCOPE_ONE,
        "shared",
        "User Project",
    )
    .await;
    insert_user_project(
        pool,
        USER_TWO_PROJECT,
        USER_TWO,
        USER_SCOPE_TWO,
        "shared",
        "Other User Project",
    )
    .await;
    insert_organization_project(
        pool,
        ORGANIZATION_PROJECT,
        ORGANIZATION_ONE,
        ORGANIZATION_SCOPE_ONE,
        "shared",
        "Organization Project",
    )
    .await;
    insert_organization_project(
        pool,
        ORGANIZATION_TWO_PROJECT,
        ORGANIZATION_TWO,
        ORGANIZATION_SCOPE_TWO,
        "shared",
        "Other Organization Project",
    )
    .await;
    assert_eq!(project_count(pool).await, 4);
}

async fn verify_project_constraints(pool: &DatabasePool) {
    let cases = [
        (
            "UUIDv7 ID",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-4000-8000-000000001051', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'invalid-id', 'Invalid ID')",
        ),
        (
            "one owner required",
            "INSERT INTO projects (id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001052', '0199ee6c-c777-7000-8000-000000001011', 'no-owner', 'No Owner')",
        ),
        (
            "two owners rejected",
            "INSERT INTO projects (id, owner_user_id, owner_organization_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001053', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001021', '0199ee6c-c777-7000-8000-000000001011', 'two-owners', 'Two Owners')",
        ),
        (
            "cross-user scope",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001054', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001012', 'wrong-scope', 'Wrong Scope')",
        ),
        (
            "cross-organization scope",
            "INSERT INTO projects (id, owner_organization_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001055', '0199ee6c-c777-7000-8000-000000001021', '0199ee6c-c777-7000-8000-000000001032', 'wrong-scope', 'Wrong Scope')",
        ),
        (
            "cross-type scope",
            "INSERT INTO projects (id, owner_organization_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001056', '0199ee6c-c777-7000-8000-000000001021', '0199ee6c-c777-7000-8000-000000001011', 'wrong-type', 'Wrong Type')",
        ),
        (
            "missing scope",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001057', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001099', 'missing-scope', 'Missing Scope')",
        ),
        (
            "canonical slug",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001058', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'Uppercase', 'Bad Slug')",
        ),
        (
            "bounded slug",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001059', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', repeat('a', 64), 'Bad Slug')",
        ),
        (
            "bounded name",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001060', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'bad-name', ' Padded')",
        ),
        (
            "known state",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name, state) VALUES ('0199ee6c-c777-7000-8000-000000001061', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'bad-state', 'Bad State', 'deleted')",
        ),
        (
            "archived timestamp",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name, state) VALUES ('0199ee6c-c777-7000-8000-000000001062', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'bad-archive', 'Bad Archive', 'archived')",
        ),
        (
            "timestamp order",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name, created_at, updated_at) VALUES ('0199ee6c-c777-7000-8000-000000001063', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'bad-time', 'Bad Time', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 second')",
        ),
        (
            "positive version",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name, lock_version) VALUES ('0199ee6c-c777-7000-8000-000000001064', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'bad-version', 'Bad Version', 0)",
        ),
        (
            "User slug uniqueness",
            "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001065', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'shared', 'Duplicate')",
        ),
        (
            "Organization slug uniqueness",
            "INSERT INTO projects (id, owner_organization_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001066', '0199ee6c-c777-7000-8000-000000001021', '0199ee6c-c777-7000-8000-000000001031', 'shared', 'Duplicate')",
        ),
    ];
    for (contract, statement) in cases {
        assert_rejected(pool, statement, contract).await;
    }
}

async fn verify_project_truncate_is_rejected(pool: &DatabasePool) {
    let before = project_count(pool).await;
    assert_rejected(pool, "TRUNCATE TABLE projects", "Project truncation").await;
    assert_eq!(
        project_count(pool).await,
        before,
        "rejected TRUNCATE must preserve every live Project row"
    );
}

async fn verify_managed_namespace_mutation_boundary(pool: &DatabasePool) {
    let cases = [
        (
            "slug",
            "UPDATE projects SET slug = 'attempted-slug', updated_at = CURRENT_TIMESTAMP, \
             lock_version = lock_version + 1 \
             WHERE id = '0199ee6c-c777-7000-8000-000000001041'::uuid",
        ),
        (
            "storage scope",
            "UPDATE projects SET storage_scope_id = \
             '0199ee6c-c777-7000-8000-000000001012'::uuid, \
             updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1 \
             WHERE id = '0199ee6c-c777-7000-8000-000000001041'::uuid",
        ),
        (
            "User owner",
            "UPDATE projects SET owner_user_id = \
             '0199ee6c-c777-7000-8000-000000001002'::uuid, storage_scope_id = \
             '0199ee6c-c777-7000-8000-000000001012'::uuid, \
             updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1 \
             WHERE id = '0199ee6c-c777-7000-8000-000000001041'::uuid",
        ),
        (
            "Organization owner",
            "UPDATE projects SET owner_user_id = NULL, owner_organization_id = \
             '0199ee6c-c777-7000-8000-000000001022'::uuid, storage_scope_id = \
             '0199ee6c-c777-7000-8000-000000001032'::uuid, \
             updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1 \
             WHERE id = '0199ee6c-c777-7000-8000-000000001041'::uuid",
        ),
    ];
    for (contract, statement) in cases {
        assert_rejected(pool, statement, contract).await;
        assert_eq!(
            project_namespace(pool, USER_PROJECT).await,
            (
                Some(USER_ONE.to_owned()),
                None,
                USER_SCOPE_ONE.to_owned(),
                "shared".to_owned(),
                1,
            ),
            "rejected {contract} mutation must preserve the complete old namespace"
        );
    }

    assert_rejected(
        pool,
        "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) \
         VALUES ('0199ee6c-c777-7000-8000-000000001051', \
                 '0199ee6c-c777-7000-8000-000000001001', \
                 '0199ee6c-c777-7000-8000-000000001011', 'shared', 'Old Namespace')",
        "old namespace after rejected mutation",
    )
    .await;
    insert_user_project(
        pool,
        RENAMED_NAMESPACE_PROJECT,
        USER_ONE,
        USER_SCOPE_ONE,
        "attempted-slug",
        "Independent Project",
    )
    .await;
    assert!(project_exists(pool, RENAMED_NAMESPACE_PROJECT).await);
}

async fn verify_archive_and_version_contract(pool: &DatabasePool) {
    assert_rejected(pool, "UPDATE projects SET name = 'Unversioned' WHERE id = '0199ee6c-c777-7000-8000-000000001041'::uuid", "version advance").await;
    execute(pool, "UPDATE projects SET state = 'archived', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1 WHERE id = '0199ee6c-c777-7000-8000-000000001041'::uuid").await;
    assert_rejected(pool, "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001067', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'shared', 'Archived Collision')", "archived slug reservation").await;
}

async fn verify_database_owned_deletion_timestamp(pool: &DatabasePool) {
    for (project_id, slug, supplied_deleted_at) in [
        (PAST_TIMESTAMP_PROJECT, "timestamp-past", 0_i64),
        (
            FUTURE_TIMESTAMP_PROJECT,
            "timestamp-future",
            4_102_444_800_i64,
        ),
    ] {
        insert_user_project(
            pool,
            project_id,
            USER_ONE,
            USER_SCOPE_ONE,
            slug,
            "Timestamp Project",
        )
        .await;

        let mut connection = acquire(pool).await;
        let mut transaction = connection.begin().await.unwrap();
        let transaction_time: ::time::OffsetDateTime =
            sqlx::query_scalar("SELECT transaction_timestamp()")
                .fetch_one(&mut *transaction)
                .await
                .unwrap();
        let supplied_deleted_at =
            ::time::OffsetDateTime::from_unix_timestamp(supplied_deleted_at).unwrap();
        sqlx::query(
            "INSERT INTO project_tombstones \
             (former_project_id, owner_user_id, slug, deleted_at) \
             VALUES ($1::uuid, $2::uuid, $3, $4)",
        )
        .bind(project_id)
        .bind(USER_ONE)
        .bind(slug)
        .bind(supplied_deleted_at)
        .execute(&mut *transaction)
        .await
        .unwrap();

        let normalized_deleted_at: ::time::OffsetDateTime = sqlx::query_scalar(
            "SELECT deleted_at FROM project_tombstones WHERE former_project_id = $1::uuid",
        )
        .bind(project_id)
        .fetch_one(&mut *transaction)
        .await
        .unwrap();
        let project_updated_at: ::time::OffsetDateTime =
            sqlx::query_scalar("SELECT updated_at FROM projects WHERE id = $1::uuid")
                .bind(project_id)
                .fetch_one(&mut *transaction)
                .await
                .unwrap();
        assert_eq!(normalized_deleted_at, transaction_time);
        assert!(normalized_deleted_at >= project_updated_at);
        assert_ne!(normalized_deleted_at, supplied_deleted_at);

        sqlx::query("DELETE FROM projects WHERE id = $1::uuid")
            .bind(project_id)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
    }
}

async fn verify_tombstone_reservation(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query("INSERT INTO project_tombstones (former_project_id, owner_user_id, slug) VALUES ($1::uuid, $2::uuid, 'shared')")
        .bind(USER_PROJECT).bind(USER_ONE).execute(&mut *transaction).await.unwrap();
    sqlx::query("DELETE FROM projects WHERE id = $1::uuid")
        .bind(USER_PROJECT)
        .execute(&mut *transaction)
        .await
        .unwrap();
    transaction.commit().await.unwrap();

    assert_rejected(pool, "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001068', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001011', 'shared', 'Hijack')", "tombstone URL reservation").await;
    assert_rejected(pool, "UPDATE project_tombstones SET slug = 'changed' WHERE former_project_id = '0199ee6c-c777-7000-8000-000000001041'::uuid", "immutable tombstone").await;
    assert_rejected(pool, "INSERT INTO project_tombstones (former_project_id, owner_user_id, slug) VALUES ('0199ee6c-c777-4000-8000-000000001069', '0199ee6c-c777-7000-8000-000000001001', 'bad-id')", "tombstone UUIDv7").await;
    assert_rejected(pool, "INSERT INTO project_tombstones (former_project_id, owner_user_id, owner_organization_id, slug) VALUES ('0199ee6c-c777-7000-8000-000000001070', '0199ee6c-c777-7000-8000-000000001001', '0199ee6c-c777-7000-8000-000000001021', 'two-owners')", "tombstone exactly one owner").await;
    assert_rejected(pool, "INSERT INTO project_tombstones (former_project_id, slug) VALUES ('0199ee6c-c777-7000-8000-000000001073', 'no-owner')", "tombstone requires an owner").await;
    assert_rejected(pool, "INSERT INTO project_tombstones (former_project_id, owner_user_id, slug) VALUES ('0199ee6c-c777-7000-8000-000000001074', '0199ee6c-c777-7000-8000-000000001099', 'missing-owner')", "tombstone owner FK").await;
    assert_rejected(pool, "INSERT INTO project_tombstones (former_project_id, owner_user_id, slug) VALUES ('0199ee6c-c777-7000-8000-000000001075', '0199ee6c-c777-7000-8000-000000001001', 'Uppercase')", "tombstone canonical slug").await;

    let mut connection = acquire(pool).await;
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query("INSERT INTO project_tombstones (former_project_id, owner_organization_id, slug) VALUES ($1::uuid, $2::uuid, 'shared')")
        .bind(ORGANIZATION_PROJECT).bind(ORGANIZATION_ONE)
        .execute(&mut *transaction).await.unwrap();
    assert!(
        transaction.commit().await.is_err(),
        "live Project must reject tombstone commit"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM project_tombstones WHERE former_project_id = $1::uuid",
    )
    .bind(ORGANIZATION_PROJECT)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

async fn verify_bare_delete_and_immutable_tombstone(pool: &DatabasePool) {
    sqlx::query("DELETE FROM projects WHERE id = $1::uuid")
        .bind(USER_TWO_PROJECT)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();

    assert!(
        tombstone_matches(pool, USER_TWO_PROJECT, Some(USER_TWO), None, "shared").await,
        "bare delete must create the exact immutable tombstone"
    );
    assert_rejected(
        pool,
        "DELETE FROM project_tombstones WHERE former_project_id = '0199ee6c-c777-7000-8000-000000001042'::uuid",
        "tombstone deletion",
    )
    .await;
    assert_rejected(
        pool,
        "TRUNCATE TABLE project_tombstones",
        "tombstone truncation",
    )
    .await;

    let recreate = sqlx::query(
        "INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) \
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'shared', 'Recreated Project')",
    )
    .bind(RECREATED_USER_PROJECT)
    .bind(USER_TWO)
    .bind(USER_SCOPE_TWO)
    .execute(&mut *acquire(pool).await)
    .await;
    assert!(
        recreate.is_err(),
        "bare delete must permanently reserve the URL"
    );
}

async fn verify_tombstone_identity_matching(pool: &DatabasePool) {
    let cases = [
        (
            "former Project ID",
            "INSERT INTO project_tombstones (former_project_id, owner_organization_id, slug) \
             VALUES ('0199ee6c-c777-7000-8000-000000001047', \
                     '0199ee6c-c777-7000-8000-000000001022', 'shared')",
        ),
        (
            "former owner",
            "INSERT INTO project_tombstones (former_project_id, owner_organization_id, slug) \
             VALUES ('0199ee6c-c777-7000-8000-000000001044', \
                     '0199ee6c-c777-7000-8000-000000001021', 'shared')",
        ),
        (
            "former slug",
            "INSERT INTO project_tombstones (former_project_id, owner_organization_id, slug) \
             VALUES ('0199ee6c-c777-7000-8000-000000001044', \
                     '0199ee6c-c777-7000-8000-000000001022', 'mismatched')",
        ),
    ];
    for (contract, statement) in cases {
        assert_rejected(pool, statement, contract).await;
    }

    assert!(
        project_exists(pool, ORGANIZATION_TWO_PROJECT).await,
        "mismatched tombstones must not mutate the live Project"
    );
    assert!(
        !tombstone_exists(pool, MISMATCHED_TOMBSTONE_PROJECT).await,
        "mismatched former identity must not persist"
    );
}

async fn verify_delete_validates_pre_release_mismatched_tombstone(pool: &DatabasePool) {
    execute(
        pool,
        "ALTER TABLE project_tombstones \
         DISABLE TRIGGER project_tombstones_slug_reservation",
    )
    .await;
    sqlx::query(
        "INSERT INTO project_tombstones \
         (former_project_id, owner_organization_id, slug) \
         VALUES ($1::uuid, $2::uuid, 'pre-release-mismatch')",
    )
    .bind(ORGANIZATION_TWO_PROJECT)
    .bind(ORGANIZATION_ONE)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    execute(
        pool,
        "ALTER TABLE project_tombstones \
         ENABLE TRIGGER project_tombstones_slug_reservation",
    )
    .await;

    let delete = sqlx::query("DELETE FROM projects WHERE id = $1::uuid")
        .bind(ORGANIZATION_TWO_PROJECT)
        .execute(&mut *acquire(pool).await)
        .await;
    assert!(
        delete.is_err(),
        "delete must reject a pre-existing tombstone with mismatched owner or slug"
    );
    assert!(project_exists(pool, ORGANIZATION_TWO_PROJECT).await);
}

async fn verify_concurrent_delete_and_create(pool: &DatabasePool) {
    let mut delete_connection = acquire(pool).await;
    let mut delete_transaction = delete_connection.begin().await.unwrap();
    sqlx::query("DELETE FROM projects WHERE id = $1::uuid")
        .bind(ORGANIZATION_PROJECT)
        .execute(&mut *delete_transaction)
        .await
        .unwrap();

    let create_pool = pool.clone();
    let concurrent_create = tokio::spawn(async move {
        let mut connection = create_pool.acquire().await.unwrap();
        sqlx::query(
            "INSERT INTO projects \
             (id, owner_organization_id, storage_scope_id, slug, name) \
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'shared', 'Concurrent Hijack')",
        )
        .bind(CONCURRENT_ORGANIZATION_PROJECT)
        .bind(ORGANIZATION_ONE)
        .bind(ORGANIZATION_SCOPE_ONE)
        .execute(&mut *connection)
        .await
    });

    time::sleep(Duration::from_millis(150)).await;
    assert!(
        !concurrent_create.is_finished(),
        "same owner/slug create must wait for the deleting transaction"
    );
    delete_transaction.commit().await.unwrap();

    let create_result = time::timeout(Duration::from_secs(2), concurrent_create)
        .await
        .expect("concurrent create must finish after the delete commits")
        .expect("concurrent create task must join");
    assert!(
        create_result.is_err(),
        "concurrent create must observe the committed tombstone and fail closed"
    );
    assert!(
        tombstone_matches(
            pool,
            ORGANIZATION_PROJECT,
            None,
            Some(ORGANIZATION_ONE),
            "shared"
        )
        .await
    );
    assert!(!project_exists(pool, CONCURRENT_ORGANIZATION_PROJECT).await);
}

async fn verify_transaction_rollback(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query("INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001071', $1::uuid, $2::uuid, 'rollback-ok', 'Rollback')")
        .bind(USER_ONE).bind(USER_SCOPE_ONE).execute(&mut *transaction).await.unwrap();
    let invalid = sqlx::query("INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ('0199ee6c-c777-7000-8000-000000001072', $1::uuid, $2::uuid, 'Uppercase', 'Rollback')")
        .bind(USER_ONE).bind(USER_SCOPE_ONE).execute(&mut *transaction).await;
    assert!(invalid.is_err());
    transaction.rollback().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE slug = 'rollback-ok'")
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

async fn verify_schema_shape(pool: &DatabasePool) {
    let working_head: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'working_head_bundle_id')",
    ).fetch_one(&mut *acquire(pool).await).await.unwrap();
    assert!(working_head);
    for constraint in [
        "projects_exactly_one_owner_check",
        "projects_user_scope_fk",
        "projects_organization_scope_fk",
        "projects_user_slug_unique",
        "projects_organization_slug_unique",
        "project_tombstones_exactly_one_owner_check",
    ] {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1)")
                .bind(constraint)
                .fetch_one(&mut *acquire(pool).await)
                .await
                .unwrap();
        assert!(exists, "missing constraint {constraint}");
    }
}

async fn seed_owners_and_scopes(pool: &DatabasePool) {
    execute(pool, "INSERT INTO users (id, email, normalized_email, display_name) VALUES ('0199ee6c-c777-7000-8000-000000001001', 'one@example.test', 'one@example.test', 'User One'), ('0199ee6c-c777-7000-8000-000000001002', 'two@example.test', 'two@example.test', 'User Two')").await;
    execute(pool, "INSERT INTO organizations (id, slug, display_name) VALUES ('0199ee6c-c777-7000-8000-000000001021', 'org-one', 'Organization One'), ('0199ee6c-c777-7000-8000-000000001022', 'org-two', 'Organization Two')").await;
    for (scope, owner) in [(USER_SCOPE_ONE, USER_ONE), (USER_SCOPE_TWO, USER_TWO)] {
        sqlx::query("INSERT INTO storage_scopes (id, owner_user_id) VALUES ($1::uuid, $2::uuid)")
            .bind(scope)
            .bind(owner)
            .execute(&mut *acquire(pool).await)
            .await
            .unwrap();
    }
    for (scope, owner) in [
        (ORGANIZATION_SCOPE_ONE, ORGANIZATION_ONE),
        (ORGANIZATION_SCOPE_TWO, ORGANIZATION_TWO),
    ] {
        sqlx::query(
            "INSERT INTO storage_scopes (id, owner_organization_id) VALUES ($1::uuid, $2::uuid)",
        )
        .bind(scope)
        .bind(owner)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    }
}

async fn insert_user_project(
    pool: &DatabasePool,
    id: &str,
    owner: &str,
    scope: &str,
    slug: &str,
    name: &str,
) {
    sqlx::query("INSERT INTO projects (id, owner_user_id, storage_scope_id, slug, name) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)")
        .bind(id).bind(owner).bind(scope).bind(slug).bind(name)
        .execute(&mut *acquire(pool).await).await.unwrap();
}

async fn insert_organization_project(
    pool: &DatabasePool,
    id: &str,
    owner: &str,
    scope: &str,
    slug: &str,
    name: &str,
) {
    sqlx::query("INSERT INTO projects (id, owner_organization_id, storage_scope_id, slug, name) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)")
        .bind(id).bind(owner).bind(scope).bind(slug).bind(name)
        .execute(&mut *acquire(pool).await).await.unwrap();
}

async fn project_count(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn project_namespace(
    pool: &DatabasePool,
    project_id: &str,
) -> (Option<String>, Option<String>, String, String, i64) {
    sqlx::query_as(
        "SELECT owner_user_id::text, owner_organization_id::text, \
                storage_scope_id::text, slug, lock_version \
         FROM projects WHERE id = $1::uuid",
    )
    .bind(project_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap()
}

async fn project_exists(pool: &DatabasePool, project_id: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1::uuid)")
        .bind(project_id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn tombstone_exists(pool: &DatabasePool, project_id: &str) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM project_tombstones WHERE former_project_id = $1::uuid)",
    )
    .bind(project_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap()
}

async fn tombstone_matches(
    pool: &DatabasePool,
    project_id: &str,
    owner_user_id: Option<&str>,
    owner_organization_id: Option<&str>,
    slug: &str,
) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS (\
             SELECT 1 FROM project_tombstones \
             WHERE former_project_id = $1::uuid \
               AND owner_user_id IS NOT DISTINCT FROM $2::uuid \
               AND owner_organization_id IS NOT DISTINCT FROM $3::uuid \
               AND slug = $4\
         )",
    )
    .bind(project_id)
    .bind(owner_user_id)
    .bind(owner_organization_id)
    .bind(slug)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap()
}

async fn assert_rejected(pool: &DatabasePool, statement: &'static str, contract: &str) {
    assert!(
        sqlx::query(statement)
            .execute(&mut *acquire(pool).await)
            .await
            .is_err(),
        "{contract} must reject invalid state"
    );
}

async fn execute(pool: &DatabasePool, statement: &'static str) {
    sqlx::query(statement)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
}

async fn migrate(pool: &DatabasePool) -> MigrationReport {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap()
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            database_url,
            0,
            8,
            Duration::from_secs(5),
            Duration::from_secs(2),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire().await.unwrap()
}
