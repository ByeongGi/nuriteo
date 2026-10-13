use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, SchemaReadiness,
    check_schema_readiness, run_embedded_migrations,
};
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const OWNER_ID: &str = "0199ee6c-c777-7000-8000-000000000711";
const MEMBER_ID: &str = "0199ee6c-c777-7000-8000-000000000712";
const ORGANIZATION_ID: &str = "0199ee6c-c777-7000-8000-000000000721";
const EMPTY_ORGANIZATION_ID: &str = "0199ee6c-c777-7000-8000-000000000722";
const CAPACITY_ORGANIZATION_ID: &str = "0199ee6c-c777-7000-8000-000000000723";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-organization/run.sh"]
async fn organization_schema_enforces_identity_lifecycle_and_membership() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;

    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Pending {
            current: None,
            target: 36
        }
    );
    let first_report = migrate(&pool).await;
    assert_eq!(first_report.latest_version, Some(40));
    assert_eq!(first_report.known_migrations, 40);
    assert_eq!(migrate(&pool).await, first_report);
    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Ready { version: 33 }
    );

    insert_users(&pool).await;
    verify_organization_constraints(&pool).await;
    verify_slug_immutability_and_no_reuse(&pool).await;
    verify_optimistic_lock_shape(&pool).await;
    verify_membership_constraints_and_preservation(&pool).await;
    verify_member_limit(&pool).await;
    verify_schema_objects(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("organization fixture pool must close"));
}

async fn verify_organization_constraints(pool: &DatabasePool) {
    let cases = [
        (
            "UUIDv7 identifier",
            "INSERT INTO organizations (id, slug, display_name) VALUES \
             ('0199ee6c-c777-4000-8000-000000000731', 'uuid-invalid', 'UUID Invalid')",
        ),
        (
            "canonical lowercase slug",
            "INSERT INTO organizations (id, slug, display_name) VALUES \
             ('0199ee6c-c777-7000-8000-000000000732', 'Uppercase', 'Uppercase')",
        ),
        (
            "bounded slug",
            "INSERT INTO organizations (id, slug, display_name) VALUES \
             ('0199ee6c-c777-7000-8000-000000000733', repeat('a', 64), 'Long Slug')",
        ),
        (
            "trimmed display name",
            "INSERT INTO organizations (id, slug, display_name) VALUES \
             ('0199ee6c-c777-7000-8000-000000000734', 'display-name', ' Display Name')",
        ),
        (
            "lifecycle timestamp pairing",
            "INSERT INTO organizations (id, slug, display_name, status) VALUES \
             ('0199ee6c-c777-7000-8000-000000000735', 'bad-lifecycle', 'Bad Lifecycle', 'archived')",
        ),
        (
            "timestamp order",
            "INSERT INTO organizations \
             (id, slug, display_name, created_at, updated_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000736', 'bad-time', 'Bad Time', \
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 second')",
        ),
        (
            "positive lock version",
            "INSERT INTO organizations (id, slug, display_name, lock_version) VALUES \
             ('0199ee6c-c777-7000-8000-000000000737', 'zero-version', 'Zero Version', 0)",
        ),
        (
            "bounded lock version",
            "INSERT INTO organizations (id, slug, display_name, lock_version) VALUES \
             ('0199ee6c-c777-7000-8000-000000000738', 'max-version', 'Max Version', \
              9223372036854775807)",
        ),
    ];
    for (contract, statement) in cases {
        assert_rejected(pool, statement, contract).await;
    }

    execute(
        pool,
        "INSERT INTO organizations (id, slug, display_name) VALUES \
         ('0199ee6c-c777-7000-8000-000000000739', 'owner-later', 'Owner Later')",
        "organization persistence must not pretend to enforce a last-owner transaction",
    )
    .await;
}

async fn verify_slug_immutability_and_no_reuse(pool: &DatabasePool) {
    insert_organization(pool, ORGANIZATION_ID, "example-team", "Example Team").await;
    assert_rejected(
        pool,
        "UPDATE organizations SET slug = 'renamed-team' \
         WHERE id = '0199ee6c-c777-7000-8000-000000000721'::uuid",
        "immutable slug",
    )
    .await;

    execute(
        pool,
        "UPDATE organizations SET status = 'archived', archived_at = CURRENT_TIMESTAMP, \
         updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1 \
         WHERE id = '0199ee6c-c777-7000-8000-000000000721'::uuid",
        "archive transition",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO organizations (id, slug, display_name) VALUES \
         ('0199ee6c-c777-7000-8000-000000000741', 'example-team', 'Reused Slug')",
        "archived slug cannot be reused",
    )
    .await;
}

async fn verify_optimistic_lock_shape(pool: &DatabasePool) {
    insert_organization(pool, EMPTY_ORGANIZATION_ID, "empty-team", "Empty Team").await;
    assert_rejected(
        pool,
        "UPDATE organizations SET display_name = 'Unversioned Team' \
         WHERE id = '0199ee6c-c777-7000-8000-000000000722'::uuid",
        "organization mutation without version advance",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE organizations SET display_name = 'Skipped Team', lock_version = lock_version + 2 \
         WHERE id = '0199ee6c-c777-7000-8000-000000000722'::uuid",
        "organization mutation with skipped version",
    )
    .await;
    let first = sqlx::query(
        "UPDATE organizations SET display_name = 'Updated Team', \
         updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1 \
         WHERE id = $1::uuid AND lock_version = 1",
    )
    .bind(EMPTY_ORGANIZATION_ID)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("matching organization version must update"));
    assert_eq!(first.rows_affected(), 1);

    let stale = sqlx::query(
        "UPDATE organizations SET display_name = 'Stale Team', \
         updated_at = CURRENT_TIMESTAMP, lock_version = lock_version + 1 \
         WHERE id = $1::uuid AND lock_version = 1",
    )
    .bind(EMPTY_ORGANIZATION_ID)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("stale organization update must remain a safe query"));
    assert_eq!(stale.rows_affected(), 0);
}

async fn verify_membership_constraints_and_preservation(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES \
         ('0199ee6c-c777-7000-8000-000000000721'::uuid, \
          '0199ee6c-c777-7000-8000-000000000711'::uuid, 'owner'), \
         ('0199ee6c-c777-7000-8000-000000000721'::uuid, \
          '0199ee6c-c777-7000-8000-000000000712'::uuid, 'member')",
        "valid owner and member rows",
    )
    .await;

    let cases = [
        (
            "one membership per organization and user",
            "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES \
             ('0199ee6c-c777-7000-8000-000000000721'::uuid, \
              '0199ee6c-c777-7000-8000-000000000711'::uuid, 'member')",
        ),
        (
            "bounded role",
            "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES \
             ('0199ee6c-c777-7000-8000-000000000722'::uuid, \
              '0199ee6c-c777-7000-8000-000000000711'::uuid, 'admin')",
        ),
        (
            "membership timestamp order",
            "INSERT INTO organization_memberships \
             (organization_id, user_id, role, created_at, updated_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000722'::uuid, \
              '0199ee6c-c777-7000-8000-000000000711'::uuid, 'member', \
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 second')",
        ),
    ];
    for (contract, statement) in cases {
        assert_rejected(pool, statement, contract).await;
    }

    execute(
        pool,
        "UPDATE users SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP, \
         updated_at = CURRENT_TIMESTAMP \
         WHERE id = '0199ee6c-c777-7000-8000-000000000712'::uuid",
        "disable member user",
    )
    .await;
    let preserved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships \
         WHERE organization_id = $1::uuid AND user_id = $2::uuid",
    )
    .bind(ORGANIZATION_ID)
    .bind(MEMBER_ID)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("disabled user membership must remain queryable"));
    assert_eq!(preserved, 1);

    assert_rejected(
        pool,
        "DELETE FROM users WHERE id = '0199ee6c-c777-7000-8000-000000000712'::uuid",
        "membership preserves referenced users",
    )
    .await;
    assert_rejected(
        pool,
        "DELETE FROM organizations \
         WHERE id = '0199ee6c-c777-7000-8000-000000000721'::uuid",
        "membership preserves referenced organizations",
    )
    .await;
}

async fn verify_member_limit(pool: &DatabasePool) {
    insert_organization(
        pool,
        CAPACITY_ORGANIZATION_ID,
        "capacity-team",
        "Capacity Team",
    )
    .await;
    execute(
        pool,
        "WITH inserted_users AS (\
           INSERT INTO users (id, email, normalized_email, display_name) \
           SELECT ('0199ee6c-c777-7000-8004-' || lpad(sequence::text, 12, '0'))::uuid, \
                  'schema-capacity-' || sequence || '@example.test', \
                  'schema-capacity-' || sequence || '@example.test', \
                  'Schema Capacity Member ' || sequence \
           FROM generate_series(1, 101) AS generated(sequence) \
           RETURNING id \
         ) \
         INSERT INTO organization_memberships (organization_id, user_id, role) \
         SELECT '0199ee6c-c777-7000-8000-000000000723'::uuid, id, 'member' \
         FROM inserted_users \
         WHERE id::text < '0199ee6c-c777-7000-8004-000000000101'",
        "one hundred memberships",
    )
    .await;

    assert_limit_rejected(
        pool,
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES \
         ('0199ee6c-c777-7000-8000-000000000723'::uuid, \
          '0199ee6c-c777-7000-8004-000000000101'::uuid, 'member')",
        "the 101st membership",
    )
    .await;

    execute(
        pool,
        "UPDATE users SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP, \
         updated_at = CURRENT_TIMESTAMP \
         WHERE id = '0199ee6c-c777-7000-8004-000000000101'::uuid",
        "disable the overflow candidate",
    )
    .await;
    assert_limit_rejected(
        pool,
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES \
         ('0199ee6c-c777-7000-8000-000000000723'::uuid, \
          '0199ee6c-c777-7000-8004-000000000101'::uuid, 'member')",
        "inactive users still count toward the membership cap",
    )
    .await;

    execute(
        pool,
        "DROP TRIGGER organization_memberships_member_limit ON organization_memberships",
        "remove the membership limit trigger",
    )
    .await;
    execute(
        pool,
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES \
         ('0199ee6c-c777-7000-8000-000000000723'::uuid, \
          '0199ee6c-c777-7000-8004-000000000101'::uuid, 'member')",
        "construct legacy over-cap data",
    )
    .await;
    let error = sqlx::raw_sql(include_str!(
        "../migrations/0021_organization_member_limit.sql"
    ))
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_err();
    assert_limit_database_error(&error, "migration 21 over-cap preflight");
    execute(
        pool,
        "DELETE FROM organization_memberships \
         WHERE organization_id = '0199ee6c-c777-7000-8000-000000000723'::uuid \
           AND user_id = '0199ee6c-c777-7000-8004-000000000101'::uuid",
        "repair legacy over-cap data",
    )
    .await;
    sqlx::raw_sql(include_str!(
        "../migrations/0021_organization_member_limit.sql"
    ))
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("migration 21 must apply after data repair: {error}"));
}

async fn verify_schema_objects(pool: &DatabasePool) {
    let constraints: Vec<String> = sqlx::query_scalar(
        "SELECT conname FROM pg_constraint \
         WHERE conrelid IN ('organizations'::regclass, 'organization_memberships'::regclass) \
         ORDER BY conname",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("organization constraints must be inspectable"));
    for required in [
        "organizations_id_v7_check",
        "organizations_slug_unique",
        "organizations_lifecycle_check",
        "organizations_lock_version_check",
        "organization_memberships_pkey",
        "organization_memberships_role_check",
        "organization_memberships_user_fk",
    ] {
        assert!(
            constraints.iter().any(|value| value == required),
            "missing {required}"
        );
    }

    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT indexname FROM pg_indexes \
         WHERE schemaname = 'public' AND tablename IN ('organizations', 'organization_memberships') \
         ORDER BY indexname",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("organization indexes must be inspectable"));
    for required in [
        "organizations_active_slug_idx",
        "organization_memberships_owner_idx",
        "organization_memberships_user_idx",
    ] {
        assert!(
            indexes.iter().any(|value| value == required),
            "missing {required}"
        );
    }

    let triggers: Vec<String> = sqlx::query_scalar(
        "SELECT tgname FROM pg_trigger \
         WHERE NOT tgisinternal AND tgname = 'organization_memberships_member_limit' \
         ORDER BY tgname",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("organization limit triggers must be inspectable"));
    assert_eq!(
        triggers,
        vec!["organization_memberships_member_limit".to_owned()]
    );
}

async fn insert_users(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users (id, email, normalized_email, display_name) VALUES \
         ($1::uuid, 'owner@example.test', 'owner@example.test', 'Organization Owner'), \
         ($2::uuid, 'member@example.test', 'member@example.test', 'Organization Member')",
    )
    .bind(OWNER_ID)
    .bind(MEMBER_ID)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("fixture users must insert: {error}"));
}

async fn insert_organization(pool: &DatabasePool, id: &str, slug: &str, name: &str) {
    sqlx::query("INSERT INTO organizations (id, slug, display_name) VALUES ($1::uuid, $2, $3)")
        .bind(id)
        .bind(slug)
        .bind(name)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("fixture organization must insert"));
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"));
    let ca = fs::read(ca_path).unwrap_or_else(|_| panic!("fixture CA must be readable"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|_| panic!("fixture TLS must be valid"));
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap_or_else(|_| panic!("fixture database config must be valid"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|_| panic!("fixture database must connect"))
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap_or_else(|_| panic!("fixture schema must drop"));
    connection
        .execute("CREATE SCHEMA public")
        .await
        .unwrap_or_else(|_| panic!("fixture schema must recreate"));
}

async fn migrate(pool: &DatabasePool) -> nuriteo_server::database::MigrationReport {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30))
            .unwrap_or_else(|_| panic!("fixture migration options must be valid")),
    )
    .await
    .unwrap_or_else(|_| panic!("embedded migrations must succeed"))
}

async fn readiness(pool: &DatabasePool) -> SchemaReadiness {
    check_schema_readiness(pool)
        .await
        .unwrap_or_else(|_| panic!("schema readiness must be available"))
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .unwrap_or_else(|_| panic!("fixture connection must be available"))
}

async fn execute(pool: &DatabasePool, statement: &'static str, contract: &str) {
    sqlx::query(statement)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("{contract} must succeed"));
}

async fn assert_rejected(pool: &DatabasePool, statement: &'static str, contract: &str) {
    assert!(
        sqlx::query(statement)
            .execute(&mut *acquire(pool).await)
            .await
            .is_err(),
        "{contract} must reject invalid direct SQL"
    );
}

async fn assert_limit_rejected(pool: &DatabasePool, statement: &'static str, contract: &str) {
    let error = sqlx::query(statement)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_err();
    assert_limit_database_error(&error, contract);
}

fn assert_limit_database_error(error: &sqlx::Error, contract: &str) {
    let database = error
        .as_database_error()
        .unwrap_or_else(|| panic!("{contract} must return a database constraint error"));
    assert_eq!(database.code().as_deref(), Some("23514"));
    assert_eq!(database.constraint(), Some("organization_member_limit"));
}
