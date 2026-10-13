use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::setup::{SetupStatusPolicy, SetupStatusService};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires pinned custom-CA PostgreSQL; run the postgres-setup-status fixture"]
async fn setup_status_tracks_only_active_instance_administrators() {
    let pool = database_pool().await;
    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(2), Duration::from_secs(10))
            .expect("migration options must be valid"),
    )
    .await
    .expect("migrations must succeed");
    let service = SetupStatusService::production(pool.clone(), SetupStatusPolicy::default());

    assert!(
        service
            .status()
            .await
            .expect("empty status must resolve")
            .bootstrap_required()
    );

    insert_user(
        &pool,
        "0199ee6c-c777-7000-8000-000000000901",
        "member@example.test",
        "active",
        false,
    )
    .await;
    insert_user(
        &pool,
        "0199ee6c-c777-7000-8000-000000000902",
        "disabled-admin@example.test",
        "disabled",
        true,
    )
    .await;
    assert!(
        service
            .status()
            .await
            .expect("non-active-admin status must resolve")
            .bootstrap_required()
    );

    sqlx::query(
        "UPDATE users SET status = 'active', disabled_at = NULL \
         WHERE id = '0199ee6c-c777-7000-8000-000000000902'::uuid",
    )
    .execute(&mut *pool.acquire().await.expect("connection must be available"))
    .await
    .expect("administrator activation must succeed");
    assert!(
        !service
            .status()
            .await
            .expect("active-admin status must resolve")
            .bootstrap_required()
    );

    sqlx::query(
        "UPDATE users SET status = 'disabled', updated_at = NOW(), disabled_at = NOW() \
         WHERE id = '0199ee6c-c777-7000-8000-000000000902'::uuid",
    )
    .execute(&mut *pool.acquire().await.expect("connection must be available"))
    .await
    .expect("administrator disable must succeed");
    assert!(
        service
            .status()
            .await
            .expect("disabled-admin status must resolve")
            .bootstrap_required()
    );

    pool.close(Duration::from_secs(2))
        .await
        .expect("pool must close");
}

async fn database_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).expect("database URL must be configured");
    let ca_path = env::var(DATABASE_CA_ENV).expect("database CA must be configured");
    let ca = fs::read(ca_path).expect("database CA must be readable");
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .expect("database TLS config must be valid");
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        4,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .expect("database pool config must be valid");
    DatabasePool::connect(config)
        .await
        .expect("database must connect")
}

async fn insert_user(
    pool: &DatabasePool,
    id: &str,
    email: &str,
    status: &str,
    is_instance_admin: bool,
) {
    sqlx::query(
        "INSERT INTO users \
         (id, email, normalized_email, display_name, status, is_instance_admin, \
          created_at, updated_at, disabled_at) \
         VALUES ($1::uuid, $2, $2, 'Fixture User', $3, $4, NOW(), NOW(), \
                 CASE WHEN $3 = 'disabled' THEN NOW() ELSE NULL END)",
    )
    .bind(id)
    .bind(email)
    .bind(status)
    .bind(is_instance_admin)
    .execute(&mut *pool.acquire().await.expect("connection must be available"))
    .await
    .expect("fixture user insert must succeed");
}
