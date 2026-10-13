use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{Timestamp, UserId};
use nuriteo_server::workspace::PersonalStorageScopeRepository;
use sqlx::Acquire;
use time::OffsetDateTime;
use uuid::Uuid;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-workspace/run.sh"]
async fn personal_scope_migration_backfill_and_provision_are_atomic() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;

    apply_pre_scope_schema(&pool).await;
    let existing = UserId::new();
    insert_user(&pool, existing, "existing@example.test", "Existing User").await;
    sqlx::raw_sql(include_str!(
        "../migrations/0006_personal_storage_scopes.sql"
    ))
    .execute(&mut *acquire(&pool).await)
    .await
    .expect("personal storage scope migration must backfill existing users");

    let backfilled: (String, String) = sqlx::query_as(
        "SELECT id::text, owner_user_id::text FROM storage_scopes WHERE owner_user_id = $1::uuid",
    )
    .bind(existing.to_string())
    .fetch_one(&mut *acquire(&pool).await)
    .await
    .expect("backfilled scope must exist");
    assert_eq!(backfilled, (existing.to_string(), existing.to_string()));
    assert!(!table_exists(&pool, "personal_workspaces").await);

    sqlx::query(
        "UPDATE users SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP, \
         updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid",
    )
    .bind(existing.to_string())
    .execute(&mut *acquire(&pool).await)
    .await
    .expect("fixture user must disable");
    assert_eq!(scope_count(&pool, existing).await, 1);
    assert!(
        sqlx::query("DELETE FROM users WHERE id = $1::uuid")
            .bind(existing.to_string())
            .execute(&mut *acquire(&pool).await)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("INSERT INTO storage_scopes (id, owner_user_id) VALUES ($1::uuid, $2::uuid)",)
            .bind(UserId::new().to_string())
            .bind(UserId::new().to_string())
            .execute(&mut *acquire(&pool).await)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("INSERT INTO storage_scopes (id, owner_user_id) VALUES ($1::uuid, $2::uuid)",)
            .bind(UserId::new().to_string())
            .bind(existing.to_string())
            .execute(&mut *acquire(&pool).await)
            .await
            .is_err()
    );

    let second = UserId::new();
    insert_user(&pool, second, "second@example.test", "Second User").await;
    assert!(
        sqlx::query("INSERT INTO storage_scopes (id, owner_user_id) VALUES ($1::uuid, $2::uuid)",)
            .bind(Uuid::new_v4().to_string())
            .bind(second.to_string())
            .execute(&mut *acquire(&pool).await)
            .await
            .is_err()
    );

    reset_fixture(&pool).await;
    migrate(&pool).await;
    migrate(&pool).await;
    assert_eq!(latest_migration(&pool).await, 10);

    let concurrent_owner = UserId::new();
    insert_user(
        &pool,
        concurrent_owner,
        "concurrent@example.test",
        "Concurrent User",
    )
    .await;
    let now = Timestamp::from_datetime(OffsetDateTime::now_utc()).expect("timestamp must be valid");
    let tasks = (0..10)
        .map(|_| {
            let pool = pool.clone();
            tokio::spawn(async move {
                let mut connection = pool.acquire().await.expect("task must acquire connection");
                let mut transaction = connection
                    .begin()
                    .await
                    .expect("task must begin transaction");
                let scope = PersonalStorageScopeRepository::provision(
                    &mut transaction,
                    concurrent_owner,
                    now,
                )
                .await
                .expect("concurrent provision must succeed");
                transaction.commit().await.expect("task must commit");
                scope.id()
            })
        })
        .collect::<Vec<_>>();
    let mut scope_ids = Vec::with_capacity(tasks.len());
    for task in tasks {
        scope_ids.push(task.await.expect("provision task must join"));
    }
    assert!(scope_ids.windows(2).all(|pair| pair[0] == pair[1]));
    assert_eq!(scope_count(&pool, concurrent_owner).await, 1);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .expect("workspace fixture pool must close");
}

async fn apply_pre_scope_schema(pool: &DatabasePool) {
    for migration in [
        include_str!("../migrations/0001_framework_baseline.sql"),
        include_str!("../migrations/0002_identity_core.sql"),
        include_str!("../migrations/0003_sessions_and_audit.sql"),
        include_str!("../migrations/0004_activation_invitations.sql"),
    ] {
        sqlx::raw_sql(migration)
            .execute(&mut *acquire(pool).await)
            .await
            .expect("pre-scope migration must apply");
    }
}

async fn migrate(pool: &DatabasePool) {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(3), Duration::from_secs(20))
            .expect("fixture migration options must be valid"),
    )
    .await
    .expect("embedded migrations must succeed");
}

async fn insert_user(pool: &DatabasePool, id: UserId, email: &str, display_name: &str) {
    sqlx::query(
        "INSERT INTO users (id, email, normalized_email, display_name) \
         VALUES ($1::uuid, $2, lower($2), $3)",
    )
    .bind(id.to_string())
    .bind(email)
    .bind(display_name)
    .execute(&mut *acquire(pool).await)
    .await
    .expect("fixture user must insert");
}

async fn scope_count(pool: &DatabasePool, owner: UserId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM storage_scopes WHERE owner_user_id = $1::uuid")
        .bind(owner.to_string())
        .fetch_one(&mut *acquire(pool).await)
        .await
        .expect("scope count must be readable")
}

async fn latest_migration(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success")
        .fetch_one(&mut *acquire(pool).await)
        .await
        .expect("migration version must be readable")
}

async fn table_exists(pool: &DatabasePool, table: &str) -> bool {
    sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
        .bind(table)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .expect("table existence must be readable")
}

async fn fixture_pool() -> DatabasePool {
    let ca = fs::read(database_ca()).expect("fixture CA must be readable");
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .expect("fixture TLS configuration must be valid");
    let config = DatabasePoolConfig::new(
        database_url(),
        0,
        16,
        Duration::from_secs(5),
        Duration::from_secs(5),
        tls,
    )
    .expect("fixture database configuration must be valid");
    DatabasePool::connect(config)
        .await
        .expect("fixture database must connect")
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    for statement in [
        "DROP TABLE IF EXISTS organization_memberships",
        "DROP TABLE IF EXISTS organizations",
        "DROP TABLE IF EXISTS storage_scopes",
        "DROP TABLE IF EXISTS local_auth_failures",
        "DROP TABLE IF EXISTS activation_invitations",
        "DROP TABLE IF EXISTS audit_events",
        "DROP TABLE IF EXISTS sessions",
        "DROP TABLE IF EXISTS oidc_identities",
        "DROP TABLE IF EXISTS oidc_providers",
        "DROP TABLE IF EXISTS local_password_credentials",
        "DROP TABLE IF EXISTS users",
        "DROP TABLE IF EXISTS framework_baseline",
        "DROP TABLE IF EXISTS _sqlx_migrations",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .expect("fixture reset statement must succeed");
    }
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .expect("fixture must acquire a database connection")
}

fn database_url() -> String {
    env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"))
}

fn database_ca() -> String {
    env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"))
}
