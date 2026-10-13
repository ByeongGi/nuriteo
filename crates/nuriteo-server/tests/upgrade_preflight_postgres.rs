use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Command, Output};
use std::thread;
use std::time::Duration;

use nuriteo_server::config::InstanceSettingBootstrap;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, SchemaReadiness, check_schema_readiness,
};
use nuriteo_server::instance_settings::InstanceSettingsRepository;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-upgrade-preflight/run.sh"]
async fn preflight_is_read_only_and_stops_without_interrupting_previous_health() {
    let database_url = required_env(DATABASE_URL_ENV);
    let ca_path = required_env(DATABASE_CA_ENV);
    let ca = fs::read(&ca_path).expect("fixture CA should be readable");
    let pool = fixture_pool(database_url.clone(), ca).await;
    match check_schema_readiness(&pool).await.unwrap() {
        SchemaReadiness::Pending {
            current: Some(46),
            target,
        } if target > 46 => {}
        state => panic!("fixture must start at exact migration 46 source state: {state:?}"),
    }
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    create_domain_sentinel(&pool).await;

    let (health_address, health_service) = previous_health_fixture(5);
    assert_service_ready(health_address);

    let source_snapshot = database_snapshot(&pool).await;
    let success = run_preflight(&database_url, &ca_path);
    assert_eq!(success.status.code(), Some(0));
    assert!(success.stderr.is_empty());
    let report: serde_json::Value = serde_json::from_slice(&success.stdout).unwrap();
    assert_eq!(report["status"], "compatible");
    assert_eq!(report["sourceMigration"], 46);
    assert_eq!(report["currentMigration"], 46);
    assert_eq!(report["schemaState"], "upgrade-required");
    assert_eq!(report["targetMigration"], 50);
    assert_eq!(database_snapshot(&pool).await, source_snapshot);
    assert_service_ready(health_address);

    sqlx::query("UPDATE _sqlx_migrations SET success=FALSE WHERE version=46")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let dirty_snapshot = database_snapshot(&pool).await;
    assert_stopped(
        &run_preflight(&database_url, &ca_path),
        "schema-dirty",
        &database_url,
    );
    assert_eq!(database_snapshot(&pool).await, dirty_snapshot);
    assert_service_ready(health_address);

    sqlx::query(
        "UPDATE _sqlx_migrations SET success=TRUE, checksum=decode('00','hex') WHERE version=46",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let checksum_snapshot = database_snapshot(&pool).await;
    assert_stopped(
        &run_preflight(&database_url, &ca_path),
        "schema-checksum-mismatch",
        &database_url,
    );
    assert_eq!(database_snapshot(&pool).await, checksum_snapshot);
    assert_service_ready(health_address);

    assert_eq!(
        sentinel_payload(&pool).await,
        "004e55524954454f2d5550472d303032ff"
    );
    assert_service_ready(health_address);
    health_service.join().expect("health fixture should finish");
    reset_schema(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-upgrade-preflight/run.sh"]
async fn migration_46_to_50_preserves_existing_domain_data() {
    let database_url = required_env(DATABASE_URL_ENV);
    let ca_path = required_env(DATABASE_CA_ENV);
    let ca = fs::read(&ca_path).expect("fixture CA should be readable");
    let pool = fixture_pool(database_url.clone(), ca).await;
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Pending {
            current: Some(46),
            target: 50,
        }
    );
    create_domain_sentinel(&pool).await;

    let migration = run_migrate(&database_url, &ca_path);
    assert_eq!(migration.status.code(), Some(0));
    assert!(migration.stderr.is_empty());
    assert_eq!(
        migration.stdout,
        b"database migration complete: schema=ready version=50\n"
    );
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Ready { version: 50 }
    );
    assert_eq!(
        sentinel_payload(&pool).await,
        "004e55524954454f2d5550472d303032ff"
    );

    reset_schema(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

fn run_preflight(database_url: &str, ca_path: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("upgrade-preflight")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", "http://127.0.0.1:3000")
        .env("NURITEO_DATABASE_URL", database_url)
        .env("NURITEO_DATABASE_CA_FILE", ca_path)
        .env("NURITEO_DATABASE_MIN_CONNECTIONS", "0")
        .output()
        .expect("upgrade-preflight subprocess should start")
}

fn run_migrate(database_url: &str, ca_path: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("migrate")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", "http://127.0.0.1:3000")
        .env("NURITEO_DATABASE_URL", database_url)
        .env("NURITEO_DATABASE_CA_FILE", ca_path)
        .env("NURITEO_DATABASE_MIN_CONNECTIONS", "0")
        .output()
        .expect("migrate subprocess should start")
}

fn assert_stopped(output: &Output, category: &str, database_url: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        format!("nuriteo-server: upgrade-preflight stopped ({category})\n")
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains(database_url));
    assert!(!stderr.contains("nuriteo-test-password"));
    assert!(!stderr.contains("postgres://"));
}

async fn create_domain_sentinel(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query(
        "CREATE TABLE upgrade_preflight_sentinel(id integer PRIMARY KEY, payload bytea NOT NULL)",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query("INSERT INTO upgrade_preflight_sentinel(id,payload) VALUES(1,decode('004e55524954454f2d5550472d303032ff','hex'))")
        .execute(&mut *connection)
        .await
        .unwrap();
}

async fn database_snapshot(pool: &DatabasePool) -> (String, String) {
    let mut connection = pool.acquire().await.unwrap();
    let history: String = sqlx::query_scalar(
        "SELECT coalesce(jsonb_agg(to_jsonb(history) ORDER BY version)::text,'[]') FROM _sqlx_migrations history",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    let sentinel: String = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',id,'payload',encode(payload,'hex'))::text FROM upgrade_preflight_sentinel WHERE id=1",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    (history, sentinel)
}

async fn sentinel_payload(pool: &DatabasePool) -> String {
    sqlx::query_scalar("SELECT encode(payload,'hex') FROM upgrade_preflight_sentinel WHERE id=1")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

fn previous_health_fixture(expected_requests: usize) -> (SocketAddr, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("previous health fixture should bind");
    let address = listener.local_addr().expect("health address should exist");
    let service = thread::spawn(move || {
        for connection in listener.incoming().take(expected_requests) {
            let mut connection = connection.expect("health connection should open");
            let mut request = [0_u8; 256];
            let _ = connection.read(&mut request).unwrap();
            connection
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nready",
                )
                .unwrap();
        }
    });
    (address, service)
}

fn assert_service_ready(address: SocketAddr) {
    let mut connection = TcpStream::connect_timeout(&address, Duration::from_secs(1))
        .expect("previous health fixture should remain reachable");
    connection
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    connection
        .write_all(b"GET /health/ready HTTP/1.1\r\nHost: previous\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut response = Vec::new();
    connection.read_to_end(&mut response).unwrap();
    assert!(response.starts_with(b"HTTP/1.1 200 OK"));
    assert!(response.ends_with(b"ready"));
}

async fn fixture_pool(database_url: String, ca: Vec<u8>) -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        4,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap();
    DatabasePool::connect(config).await.unwrap()
}

async fn reset_schema(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("DROP SCHEMA public CASCADE")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("CREATE SCHEMA public")
        .execute(&mut *connection)
        .await
        .unwrap();
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the PostgreSQL fixture"))
}
