use std::borrow::Cow;
use std::env;
use std::fs;

use sqlx::migrate::{Migration, MigrationType};
use sqlx::{Acquire, SqlSafeStr};

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
    assert_eq!(migrations.len(), 37);
    assert_eq!(
        migrations
            .iter()
            .map(|migration| migration.version)
            .collect::<Vec<_>>(),
        vec![
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
            25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37
        ]
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

    let project_bundle_rollback_probe = project_bundle_rollback_probe_migrator();
    let rollback_failure = run_migrator(&pool, normal, &project_bundle_rollback_probe).await;
    assert!(matches!(
        rollback_failure,
        Err(MigrationError::ExecutionFailed {
            version: Some(14),
            ..
        })
    ));
    for relation in [
        "bundles",
        "save_sessions",
        "storage_reservations",
        "project_bundle_admissions",
        "multipart_parts",
        "project_bundle_refs",
        "gc_candidates",
    ] {
        assert!(!relation_exists(&pool, relation).await);
    }
    assert!(!column_exists(&pool, "projects", "working_head_bundle_id").await);
    assert!(!constraint_exists(&pool, "projects_storage_identity_unique").await);
    assert!(!constraint_exists(&pool, "projects_working_head_bundle_fk").await);
    assert!(!constraint_exists(&pool, "projects_working_head_admission_fk").await);
    assert_eq!(migration_row_count(&pool, 14).await, 0);

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
    assert_eq!(first_report.latest_version, Some(37));
    assert_eq!(first_report.known_migrations, 37);
    for version in 1..=37 {
        assert_eq!(migration_row_count(&pool, version).await, 1);
    }
    verify_save_upload_lease_delete_fence(&pool).await;
    verify_access_token_invariants(&pool).await;

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

async fn verify_save_upload_lease_delete_fence(pool: &DatabasePool) {
    const USER: &str = "0199ee6c-c777-7000-8000-000000009001";
    const SCOPE: &str = "0199ee6c-c777-7000-8000-000000009010";
    const PROJECT: &str = "0199ee6c-c777-7000-8000-000000009020";
    const SESSION: &str = "0199ee6c-c777-7000-8000-000000009030";
    const FIRST_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009040";
    const SECOND_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009041";

    sqlx::query(
        "INSERT INTO users (id,email,normalized_email,display_name) \
         VALUES ($1::uuid,'lease-fence@example.test','lease-fence@example.test','Lease Fence')",
    )
    .bind(USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("INSERT INTO storage_scopes (id,owner_user_id) VALUES ($1::uuid,$2::uuid)")
        .bind(SCOPE)
        .bind(USER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) \
         VALUES ($1::uuid,$2::uuid,$3::uuid,'lease-fence','Lease Fence')",
    )
    .bind(PROJECT)
    .bind(USER)
    .bind(SCOPE)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO save_sessions \
         (id,project_id,storage_scope_id,actor_user_id,expected_project_version,\
          expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,\
          expected_file_count,staging_object_key,upload_mode,expires_at) \
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,decode(repeat('42',32),'hex'),\
                 1,0,0,'staging/lease-fence.bundle','single',clock_timestamp()+interval '1 hour')",
    )
    .bind(SESSION)
    .bind(PROJECT)
    .bind(SCOPE)
    .bind(USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO save_upload_leases \
         (save_session_id,part_number,generation,lease_token,lease_expires_at) \
         VALUES ($1::uuid,0,1,$2::uuid,clock_timestamp()+interval '5 minutes')",
    )
    .bind(SESSION)
    .bind(FIRST_TOKEN)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    assert_constraint_rejected(
        sqlx::query("DELETE FROM save_upload_leases WHERE save_session_id=$1::uuid")
            .bind(SESSION)
            .execute(&mut *pool.acquire().await.unwrap())
            .await,
    );
    sqlx::query(
        "UPDATE save_upload_leases SET released_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid",
    )
    .bind(SESSION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_constraint_rejected(
        sqlx::query("DELETE FROM save_upload_leases WHERE save_session_id=$1::uuid")
            .bind(SESSION)
            .execute(&mut *pool.acquire().await.unwrap())
            .await,
    );

    let next_generation: i64 = sqlx::query_scalar(
        "INSERT INTO save_upload_leases \
         (save_session_id,part_number,generation,lease_token,lease_expires_at) \
         VALUES ($1::uuid,0,1,$2::uuid,clock_timestamp()+interval '5 minutes') \
         ON CONFLICT (save_session_id,part_number) DO UPDATE SET \
           generation=save_upload_leases.generation+1,lease_token=EXCLUDED.lease_token,\
           lease_expires_at=EXCLUDED.lease_expires_at,released_at=NULL \
         RETURNING generation",
    )
    .bind(SESSION)
    .bind(SECOND_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(next_generation, 2);
    sqlx::query(
        "UPDATE save_upload_leases SET released_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND generation=2",
    )
    .bind(SESSION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_sessions SET state='failed',terminal_at=clock_timestamp(),\
         updated_at=clock_timestamp() WHERE id=$1::uuid",
    )
    .bind(SESSION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("DELETE FROM save_sessions WHERE id=$1::uuid")
        .bind(SESSION)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let lease_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM save_upload_leases WHERE save_session_id=$1::uuid",
    )
    .bind(SESSION)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(lease_count, 0);
}

async fn verify_access_token_invariants(pool: &DatabasePool) {
    const USER: &str = "0199ee6c-c777-7000-8000-000000009001";
    const TOKEN: &str = "0199ee6c-c777-7000-8000-000000009101";
    const DISABLE_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009102";
    const PROJECT_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009105";
    const PROJECT: &str = "0199ee6c-c777-7000-8000-000000009020";
    const DELETED_USER: &str = "0199ee6c-c777-7000-8000-000000009107";
    const DELETED_USER_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009108";
    const FAMILY: &str = "0199ee6c-c777-7000-8000-000000009110";

    let insert = |id: &'static str, suffix: u8| {
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,created_by_user_id,scopes,token_prefix,\
              secret_hash,expires_at,rotation_family_id) \
             VALUES ($1::uuid,'personal','CLI',$2::uuid,$2::uuid,$2::uuid,\
                     ARRAY['project:read'],$3,decode(repeat($4,32),'hex'),\
                     transaction_timestamp()+interval '90 days',$5::uuid)",
        )
        .bind(id)
        .bind(USER)
        .bind(format!("nur_pat_{id}_"))
        .bind(format!("{suffix:02x}"))
        .bind(FAMILY)
    };

    insert(TOKEN, 0x11)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,project_id,created_by_user_id,scopes,token_prefix,\
          secret_hash,expires_at,rotation_family_id) \
         VALUES ($1::uuid,'project','CI',$2::uuid,$2::uuid,$3::uuid,ARRAY['project:publish'],\
                 $4,decode(repeat('55',32),'hex'),transaction_timestamp()+interval '90 days',$5::uuid)",
    )
    .bind(PROJECT_TOKEN)
    .bind(PROJECT)
    .bind(USER)
    .bind(format!("nur_prj_{PROJECT_TOKEN}_"))
    .bind(FAMILY)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009103','personal','Too Long',$1::uuid,$1::uuid,\
                     ARRAY['project:read'],'nur_pat_0199ee6c-c777-7000-8000-000000009103_',\
                     decode(repeat('33',32),'hex'),transaction_timestamp()+interval '366 days',$2::uuid)",
        )
        .bind(USER)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );
    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,project_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009106','project','Git Escape',$1::uuid,$1::uuid,\
                     ARRAY['git:read'],'nur_prj_0199ee6c-c777-7000-8000-000000009106_',\
                     decode(repeat('66',32),'hex'),transaction_timestamp()+interval '90 days',$2::uuid)",
        )
        .bind(PROJECT)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );
    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009104','personal','Bad Scope',$1::uuid,$1::uuid,\
                     ARRAY['project:read','project:read'],'nur_pat_0199ee6c-c777-7000-8000-000000009104_',\
                     decode(repeat('44',32),'hex'),transaction_timestamp()+interval '90 days',$2::uuid)",
        )
        .bind(USER)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );

    sqlx::query(
        "UPDATE access_tokens SET state='revoked',secret_hash=NULL,revoked_at=clock_timestamp(),\
         revoke_reason='operator_revoked',updated_at=clock_timestamp(),lock_version=lock_version+1 \
         WHERE id=$1::uuid",
    )
    .bind(TOKEN)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_constraint_rejected(
        sqlx::query(
            "UPDATE access_tokens SET state='active',secret_hash=decode(repeat('11',32),'hex'),\
             revoked_at=NULL,revoke_reason=NULL,updated_at=clock_timestamp(),lock_version=lock_version+1 \
             WHERE id=$1::uuid",
        )
        .bind(TOKEN)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );

    insert(DISABLE_TOKEN, 0x22)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE users SET status='disabled',disabled_at=clock_timestamp(),updated_at=clock_timestamp() \
         WHERE id=$1::uuid",
    )
    .bind(USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let lifecycle: (String, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,revoke_reason FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(DISABLE_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(lifecycle, ("revoked".into(), true, "user_disabled".into()));

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO project_tombstones(former_project_id,owner_user_id,slug) \
         VALUES ($1::uuid,$2::uuid,'lease-fence')",
    )
    .bind(PROJECT)
    .bind(USER)
    .execute(&mut *transaction)
    .await
    .unwrap();
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(PROJECT)
        .execute(&mut *transaction)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    let project_lifecycle: (String, bool, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,project_id IS NULL,revoke_reason \
         FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(PROJECT_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        project_lifecycle,
        ("revoked".into(), true, true, "project_deleted".into())
    );

    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name) \
         VALUES ($1::uuid,'deleted-token-user@example.test','deleted-token-user@example.test','Delete Me')",
    )
    .bind(DELETED_USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
         VALUES ($1::uuid,'personal','Delete Lifecycle',$2::uuid,$2::uuid,ARRAY['project:read'],$3,\
                 decode(repeat('77',32),'hex'),transaction_timestamp()+interval '90 days',$4::uuid)",
    )
    .bind(DELETED_USER_TOKEN)
    .bind(DELETED_USER)
    .bind(format!("nur_pat_{DELETED_USER_TOKEN}_"))
    .bind(FAMILY)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("DELETE FROM users WHERE id=$1::uuid")
        .bind(DELETED_USER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let deletion_lifecycle: (String, bool, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,owner_user_id IS NULL,revoke_reason \
         FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(DELETED_USER_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        deletion_lifecycle,
        ("revoked".into(), true, true, "user_deleted".into())
    );
}

fn assert_constraint_rejected(result: Result<sqlx::postgres::PgQueryResult, sqlx::Error>) {
    let error = result.expect_err("constraint violation must be rejected");
    assert_eq!(
        error.as_database_error().and_then(|error| error.code()),
        Some(Cow::Borrowed("23514"))
    );
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

fn project_bundle_rollback_probe_migrator() -> Migrator {
    let mut migrations: Vec<_> = embedded_migrator()
        .iter()
        .filter(|migration| migration.version < 14)
        .cloned()
        .collect();
    let rollback_sql: &'static str =
        Box::leak(format!("{PROJECT_BUNDLES_SQL}\nSELECT 1 / 0;").into_boxed_str());
    migrations.push(Migration::new(
        14,
        Cow::Borrowed("project bundles rollback probe"),
        MigrationType::Simple,
        rollback_sql.into_sql_str(),
        false,
    ));
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

async fn column_exists(pool: &DatabasePool, relation: &str, column: &str) -> bool {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("column query must acquire a connection: {error}"));
    sqlx::query_scalar(
        "SELECT EXISTS (\
             SELECT 1 FROM information_schema.columns \
             WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2\
         )",
    )
    .bind(relation)
    .bind(column)
    .fetch_one(&mut *connection)
    .await
    .unwrap_or_else(|error| panic!("column query must succeed: {error}"))
}

async fn constraint_exists(pool: &DatabasePool, constraint: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1)")
        .bind(constraint)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
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
