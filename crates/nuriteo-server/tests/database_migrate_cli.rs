use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, SchemaReadiness, check_schema_readiness,
};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const DATABASE_CLIENT_CERT_ENV: &str = "NURITEO_TEST_DATABASE_CLIENT_CERT";
const DATABASE_CLIENT_KEY_ENV: &str = "NURITEO_TEST_DATABASE_CLIENT_KEY";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-readiness/run.sh"]
async fn migrate_subprocess_enforces_schema_readiness_and_redaction() {
    let database_url = required_env(DATABASE_URL_ENV);
    let ca_path = required_env(DATABASE_CA_ENV);
    let ca =
        fs::read(&ca_path).unwrap_or_else(|error| panic!("fixture CA must be readable: {error}"));
    let pool = fixture_pool(database_url.clone(), ca).await;
    reset_schema(&pool).await;

    let target = match check_schema_readiness(&pool).await.unwrap() {
        SchemaReadiness::Pending {
            current: None,
            target,
        } => target,
        state => panic!("empty schema must be pending, got {state:?}"),
    };
    assert!(target > 0, "embedded migration target must be positive");
    assert_success(&run_migrate(&database_url, &ca_path, None), target);
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Ready { version: target }
    );
    assert_success(&run_migrate(&database_url, &ca_path, None), target);

    reset_schema(&pool).await;
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Pending {
            current: None,
            target
        }
    );
    let url_file = temporary_url_file(&database_url);
    assert_success(
        &run_migrate(&database_url, &ca_path, Some(url_file.as_path())),
        target,
    );

    sqlx::query("UPDATE _sqlx_migrations SET success = FALSE WHERE version = 1")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Dirty { version: 1 }
    );
    assert_failure(
        &run_migrate(&database_url, &ca_path, None),
        "nuriteo-server: migrate refused: schema=dirty version=1\n",
        &database_url,
    );

    sqlx::query("UPDATE _sqlx_migrations SET success = TRUE, checksum = decode('00', 'hex') WHERE version = 1")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::ChecksumMismatch { version: 1 }
    );
    assert_failure(
        &run_migrate(&database_url, &ca_path, None),
        "nuriteo-server: migrate refused: schema=checksum-mismatch version=1\n",
        &database_url,
    );

    sqlx::query("DELETE FROM _sqlx_migrations")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO _sqlx_migrations \
         (version, description, success, checksum, execution_time) \
         VALUES (9999, 'unsupported fixture', TRUE, decode('00', 'hex'), 0)",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Unsupported { version: 9_999 }
    );
    assert_failure(
        &run_migrate(&database_url, &ca_path, None),
        "nuriteo-server: migrate refused: schema=unsupported version=9999\n",
        &database_url,
    );

    reset_schema(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
    fs::remove_file(url_file).unwrap();
}

fn run_migrate(database_url: &str, ca_path: &str, url_file: Option<&std::path::Path>) -> Output {
    let client_certificate = required_env(DATABASE_CLIENT_CERT_ENV);
    let client_key = required_env(DATABASE_CLIENT_KEY_ENV);
    let mut command = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"));
    command
        .arg("migrate")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", "http://127.0.0.1:3000")
        .env("NURITEO_DATABASE_CA_FILE", ca_path)
        .env("NURITEO_DATABASE_CLIENT_CERT_FILE", client_certificate)
        .env("NURITEO_DATABASE_CLIENT_KEY_FILE", client_key)
        .env("NURITEO_DATABASE_MIN_CONNECTIONS", "0");
    if let Some(path) = url_file {
        command.env("NURITEO_DATABASE_URL_FILE", path);
    } else {
        command.env("NURITEO_DATABASE_URL", database_url);
    }
    command
        .output()
        .unwrap_or_else(|error| panic!("migrate subprocess must start: {error}"))
}

fn assert_success(output: &Output, target: i64) {
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        output.stdout,
        format!("database migration complete: schema=ready version={target}\n").as_bytes()
    );
    assert!(output.stderr.is_empty());
}

fn assert_failure(output: &Output, expected: &str, database_url: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, expected.as_bytes());
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!combined.contains(database_url));
    assert!(!combined.contains("nuriteo-test-password"));
    assert!(!combined.contains("postgres://"));
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

fn temporary_url_file(database_url: &str) -> PathBuf {
    let path = env::temp_dir().join(format!("nuriteo-db-003-url-{}", std::process::id()));
    fs::write(&path, format!("{database_url}\n")).unwrap();
    path
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the PostgreSQL fixture"))
}
