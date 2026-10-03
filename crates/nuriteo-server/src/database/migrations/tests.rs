use std::borrow::Cow;
use std::env;
use std::fs;

use sqlx::SqlSafeStr;
use sqlx::migrate::{Migration, MigrationType};

use super::*;
use crate::database::{DatabasePoolConfig, DatabaseTlsConfig};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const TEST_MIGRATION_VERSION: i64 = 9_001;
const TIMEOUT_MIGRATION_VERSION: i64 = 9_002;

#[test]
fn validates_migration_deadlines() {
    assert_eq!(
        MigrationOptions::new(Duration::from_millis(99), Duration::from_secs(1)),
        Err(MigrationError::InvalidLockWaitTimeout)
    );
    assert_eq!(
        MigrationOptions::new(Duration::from_secs(1), Duration::from_millis(999)),
        Err(MigrationError::InvalidExecutionTimeout)
    );
}

#[test]
fn embedded_baseline_is_forward_only_and_framework_scoped() {
    let embedded = embedded_migrator();
    let migrations: Vec<_> = embedded.iter().collect();
    assert_eq!(migrations.len(), 11);
    assert_eq!(
        migrations
            .iter()
            .map(|migration| migration.version)
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    );
    assert_eq!(migrations[0].version, 1);
    assert_eq!(migrations[0].migration_type, MigrationType::Simple);
    assert_eq!(migrations[0].description, "framework baseline");
    for forbidden in ["users", "organizations", "projects", "snapshots"] {
        assert!(!migrations[0].sql.as_str().contains(forbidden));
    }
}

#[test]
fn migration_errors_expose_only_stable_categories() {
    let error = MigrationError::ExecutionFailed {
        version: Some(8),
        category: DatabaseErrorCategory::Internal,
    };
    let rendered = format!("{error:?} {error}");
    assert!(!rendered.contains("postgres://"));
    assert!(!rendered.contains("credential"));
    assert_eq!(error.to_string(), "migration 8 execution failed (internal)");
}

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-migrations/run.sh"]
async fn real_postgres_serializes_validates_rolls_back_and_retries() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let normal = options(Duration::from_secs(3), Duration::from_secs(10));

    let mut blocker = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("lock blocker must acquire a connection: {error}"));
    sqlx::query("SELECT pg_advisory_lock($1, $2)")
        .bind(ADVISORY_LOCK_NAMESPACE)
        .bind(ADVISORY_LOCK_KEY)
        .execute(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("fixture must hold the migration lock: {error}"));

    let first_pool = pool.clone();
    let first = tokio::spawn(async move { run_embedded_migrations(&first_pool, normal).await });
    let second_pool = pool.clone();
    let second = tokio::spawn(async move { run_embedded_migrations(&second_pool, normal).await });
    time::sleep(Duration::from_millis(150)).await;
    assert!(!first.is_finished());
    assert!(!second.is_finished());

    let released: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1, $2)")
        .bind(ADVISORY_LOCK_NAMESPACE)
        .bind(ADVISORY_LOCK_KEY)
        .fetch_one(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("fixture lock must release: {error}"));
    assert!(released);
    drop(blocker);

    let first_report = first
        .await
        .unwrap_or_else(|error| panic!("first runner task must join: {error}"))
        .unwrap_or_else(|error| panic!("first runner must succeed: {error}"));
    let second_report = second
        .await
        .unwrap_or_else(|error| panic!("second runner task must join: {error}"))
        .unwrap_or_else(|error| panic!("second runner must succeed: {error}"));
    assert_eq!(first_report, second_report);
    assert_eq!(first_report.latest_version, Some(11));
    assert_eq!(first_report.known_migrations, 11);
    for version in 1..=11 {
        assert_eq!(migration_row_count(&pool, version).await, 1);
    }

    let mut blocker = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("timeout blocker must acquire a connection: {error}"));
    sqlx::query("SELECT pg_advisory_lock($1, $2)")
        .bind(ADVISORY_LOCK_NAMESPACE)
        .bind(ADVISORY_LOCK_KEY)
        .execute(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("fixture must hold the timeout lock: {error}"));
    let lock_timeout = run_embedded_migrations(
        &pool,
        options(Duration::from_millis(150), Duration::from_secs(10)),
    )
    .await;
    assert_eq!(lock_timeout, Err(MigrationError::LockWaitTimeout));
    let released: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1, $2)")
        .bind(ADVISORY_LOCK_NAMESPACE)
        .bind(ADVISORY_LOCK_KEY)
        .fetch_one(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("timeout lock must release: {error}"));
    assert!(released);
    drop(blocker);

    let failing = test_migrator(Migration::new(
        TEST_MIGRATION_VERSION,
        Cow::Borrowed("transaction failure probe"),
        MigrationType::Simple,
        "CREATE TABLE db002_transaction_probe (id integer PRIMARY KEY);\
         INSERT INTO db002_transaction_probe (id) VALUES (1);\
         INSERT INTO db002_transaction_probe (id) VALUES (1);\
         -- credential-that-must-not-leak"
            .into_sql_str(),
        false,
    ));
    let failure = run_migrator(&pool, normal, &failing).await;
    assert!(matches!(
        failure,
        Err(MigrationError::ExecutionFailed {
            version: Some(TEST_MIGRATION_VERSION),
            ..
        })
    ));
    assert!(!format!("{failure:?}").contains("credential-that-must-not-leak"));
    assert!(!relation_exists(&pool, "db002_transaction_probe").await);
    assert_eq!(migration_row_count(&pool, TEST_MIGRATION_VERSION).await, 0);

    let corrected = test_migrator(Migration::new(
        TEST_MIGRATION_VERSION,
        Cow::Borrowed("transaction failure probe"),
        MigrationType::Simple,
        "CREATE TABLE db002_transaction_probe (id integer PRIMARY KEY);\
         INSERT INTO db002_transaction_probe (id) VALUES (1);"
            .into_sql_str(),
        false,
    ));
    run_migrator(&pool, normal, &corrected)
        .await
        .unwrap_or_else(|error| panic!("corrected migration must succeed: {error}"));
    run_migrator(&pool, normal, &corrected)
        .await
        .unwrap_or_else(|error| panic!("already-applied migration must be skipped: {error}"));
    assert_eq!(migration_row_count(&pool, TEST_MIGRATION_VERSION).await, 1);

    let modified = test_migrator(Migration::new(
        TEST_MIGRATION_VERSION,
        Cow::Borrowed("transaction failure probe"),
        MigrationType::Simple,
        "SELECT 2;".into_sql_str(),
        false,
    ));
    assert_eq!(
        run_migrator(&pool, normal, &modified).await,
        Err(MigrationError::ChecksumMismatch {
            version: TEST_MIGRATION_VERSION
        })
    );
    delete_history(&pool, TEST_MIGRATION_VERSION).await;
    drop_transaction_probe(&pool).await;

    let slow = test_migrator(Migration::new(
        TIMEOUT_MIGRATION_VERSION,
        Cow::Borrowed("execution timeout probe"),
        MigrationType::Simple,
        "SELECT pg_sleep(2);".into_sql_str(),
        false,
    ));
    assert_eq!(
        run_migrator(
            &pool,
            options(Duration::from_secs(2), Duration::from_secs(1)),
            &slow,
        )
        .await,
        Err(MigrationError::ExecutionTimeout)
    );
    assert_eq!(
        migration_row_count(&pool, TIMEOUT_MIGRATION_VERSION).await,
        0
    );
    let corrected_after_timeout = test_migrator(Migration::new(
        TIMEOUT_MIGRATION_VERSION,
        Cow::Borrowed("execution timeout probe"),
        MigrationType::Simple,
        "SELECT 1;".into_sql_str(),
        false,
    ));
    run_migrator(&pool, normal, &corrected_after_timeout)
        .await
        .unwrap_or_else(|error| panic!("migration must retry after timeout: {error}"));
    delete_history(&pool, TIMEOUT_MIGRATION_VERSION).await;

    insert_unknown_history(&pool, 9_999).await;
    assert_eq!(
        run_embedded_migrations(&pool, normal).await,
        Err(MigrationError::AppliedVersionMissing { version: 9_999 })
    );
    delete_history(&pool, 9_999).await;
    run_embedded_migrations(&pool, normal)
        .await
        .unwrap_or_else(|error| panic!("migration must recover after history repair: {error}"));

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|error| panic!("fixture pool must close: {error}"));
}

fn options(lock_wait_timeout: Duration, execution_timeout: Duration) -> MigrationOptions {
    MigrationOptions::new(lock_wait_timeout, execution_timeout)
        .unwrap_or_else(|error| panic!("test migration options must be valid: {error}"))
}

fn test_migrator(additional: Migration) -> Migrator {
    let mut migrations: Vec<_> = embedded_migrator().iter().cloned().collect();
    migrations.push(additional);
    migrator_without_driver_lock(migrations)
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"));
    let ca =
        fs::read(ca_path).unwrap_or_else(|error| panic!("fixture CA must be readable: {error}"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|error| panic!("fixture TLS must be valid: {error}"));
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap_or_else(|error| panic!("fixture database config must be valid: {error}"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|error| panic!("fixture database must connect: {error}"))
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("fixture reset must acquire a connection: {error}"));
    for statement in [
        "DROP TABLE IF EXISTS db002_transaction_probe",
        "DROP TABLE IF EXISTS _sqlx_migrations",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap_or_else(|error| panic!("fixture reset statement must succeed: {error}"));
    }
}

async fn migration_row_count(pool: &DatabasePool, version: i64) -> i64 {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history query must acquire a connection: {error}"));
    sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = $1")
        .bind(version)
        .fetch_one(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("history count must succeed: {error}"))
}

async fn relation_exists(pool: &DatabasePool, relation: &str) -> bool {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("relation query must acquire a connection: {error}"));
    sqlx::query_scalar::<_, Option<String>>("SELECT to_regclass($1)::text")
        .bind(format!("public.{relation}"))
        .fetch_one(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("relation query must succeed: {error}"))
        .is_some()
}

async fn drop_transaction_probe(pool: &DatabasePool) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("cleanup must acquire a connection: {error}"));
    sqlx::query("DROP TABLE IF EXISTS db002_transaction_probe")
        .execute(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("probe table cleanup must succeed: {error}"));
}

async fn insert_unknown_history(pool: &DatabasePool, version: i64) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history insert must acquire a connection: {error}"));
    sqlx::query(
        "INSERT INTO _sqlx_migrations \
         (version, description, success, checksum, execution_time) \
         VALUES ($1, 'unknown fixture', TRUE, $2, 0)",
    )
    .bind(version)
    .bind(vec![0_u8; 48])
    .execute(&mut *connection)
    .await
    .unwrap_or_else(|error| panic!("unknown history insert must succeed: {error}"));
}

async fn delete_history(pool: &DatabasePool, version: i64) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history cleanup must acquire a connection: {error}"));
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = $1")
        .bind(version)
        .execute(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("history cleanup must succeed: {error}"));
}
