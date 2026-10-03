#![cfg(unix)]

use std::env;
use std::fs;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, SchemaReadiness,
    check_schema_readiness, run_embedded_migrations,
};
use serde_json::{Value, json};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";
const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";
const ACCESS_KEY: &str = "integration-access";
const SECRET_KEY: &str = "integration-secret-0123456789";
const BUCKET: &str = "nuriteo-srv-004";

#[tokio::test]
#[ignore = "requires pinned TLS PostgreSQL and HTTPS RustFS; run tests/fixtures/production-serve/run.sh"]
async fn production_binary_serves_drains_and_never_mutates_backends() {
    let database_url = required_env(DATABASE_URL_ENV);
    let database_ca_path = required_env(DATABASE_CA_ENV);
    let database_ca = fs::read(&database_ca_path).unwrap();
    let s3_endpoint = required_env(S3_ENDPOINT_ENV);
    let s3_ca_path = required_env(S3_CA_ENV);
    let s3_ca = fs::read(&s3_ca_path).unwrap();
    let pool = database_pool(database_url.clone(), database_ca).await;
    reset_history(&pool).await;
    migrate(&pool).await;

    let s3 = fixture_s3_client(&s3_endpoint, &s3_ca);
    create_bucket(&s3).await;

    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_address = occupied.local_addr().unwrap();
    let bind_failure = spawn_server(
        occupied_address,
        &database_url,
        &database_ca_path,
        &s3_endpoint,
        &s3_ca_path,
    );
    let output = bind_failure.wait_for_exit(Duration::from_secs(8)).await;
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"nuriteo-server: serve failed (bind)\n");
    assert_redacted(&output);
    drop(occupied);

    let address = available_address();
    let mut server = spawn_server(
        address,
        &database_url,
        &database_ca_path,
        &s3_endpoint,
        &s3_ca_path,
    );
    let live_url = format!("http://{address}/health/live");
    let ready_url = format!("http://{address}/health/ready");
    wait_for_live(&mut server, &live_url).await;
    assert_response(&ready_url, 200, json!({"status": "ready"})).await;
    assert_healthcheck_success(run_healthcheck(ready_url.clone()).await);
    assert_eq!(migration_rows(&pool).await, 1);
    assert!(list_objects(&s3).await.is_empty());

    s3.delete_bucket().bucket(BUCKET).send().await.unwrap();
    assert_response(
        &ready_url,
        503,
        json!({"status": "unavailable", "category": "storage"}),
    )
    .await;
    assert_response(&live_url, 200, json!({"status": "live"})).await;
    assert_healthcheck_failure(run_healthcheck(ready_url.clone()).await);

    let output = server.terminate(Duration::from_secs(5)).await;
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert_port_closed(address).await;

    create_bucket(&s3).await;
    reset_history(&pool).await;
    assert!(matches!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Pending { .. }
    ));
    let pending_address = available_address();
    let mut pending = spawn_server(
        pending_address,
        &database_url,
        &database_ca_path,
        &s3_endpoint,
        &s3_ca_path,
    );
    let pending_live = format!("http://{pending_address}/health/live");
    let pending_ready = format!("http://{pending_address}/health/ready");
    wait_for_live(&mut pending, &pending_live).await;
    assert_response(
        &pending_ready,
        503,
        json!({"status": "unavailable", "category": "schema-pending"}),
    )
    .await;
    assert_response(&pending_live, 200, json!({"status": "live"})).await;
    assert!(matches!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Pending { .. }
    ));
    assert!(list_objects(&s3).await.is_empty());
    let output = pending.terminate(Duration::from_secs(5)).await;
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert_port_closed(pending_address).await;

    s3.delete_bucket().bucket(BUCKET).send().await.unwrap();
    reset_history(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

fn spawn_server(
    address: std::net::SocketAddr,
    database_url: &str,
    database_ca_path: &str,
    s3_endpoint: &str,
    s3_ca_path: &str,
) -> ChildGuard {
    let child = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("serve")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", format!("http://{address}"))
        .env("NURITEO_HTTP_LISTEN_ADDR", address.to_string())
        .env("NURITEO_SHUTDOWN_DRAIN_TIMEOUT_MS", "2000")
        .env("NURITEO_DATABASE_URL", database_url)
        .env("NURITEO_DATABASE_CA_FILE", database_ca_path)
        .env("NURITEO_DATABASE_MIN_CONNECTIONS", "1")
        .env("NURITEO_DATABASE_MAX_CONNECTIONS", "4")
        .env("NURITEO_DATABASE_CONNECT_TIMEOUT_MS", "3000")
        .env("NURITEO_DATABASE_ACQUIRE_TIMEOUT_MS", "1000")
        .env("NURITEO_DATABASE_CLOSE_TIMEOUT_MS", "2000")
        .env("NURITEO_S3_ENDPOINT", s3_endpoint)
        .env("NURITEO_S3_REGION", "us-east-1")
        .env("NURITEO_S3_BUCKET", BUCKET)
        .env("NURITEO_S3_ADDRESSING_STYLE", "path")
        .env("NURITEO_S3_CREDENTIAL_PROVIDER", "static")
        .env("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY)
        .env("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY)
        .env("NURITEO_S3_CA_FILE", s3_ca_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    ChildGuard::new(child)
}

struct ChildGuard {
    child: Child,
    reaped: bool,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self {
            child,
            reaped: false,
        }
    }

    async fn terminate(mut self, timeout: Duration) -> Output {
        let status = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        self.wait_for_exit_inner(timeout).await
    }

    async fn wait_for_exit(mut self, timeout: Duration) -> Output {
        self.wait_for_exit_inner(timeout).await
    }

    async fn wait_for_exit_inner(&mut self, timeout: Duration) -> Output {
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                break status;
            }
            assert!(Instant::now() < deadline, "serve process exit timed out");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        read_output(&mut self.child, status)
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn read_output(child: &mut Child, status: ExitStatus) -> Output {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_end(&mut stderr)
        .unwrap();
    Output {
        status,
        stdout,
        stderr,
    }
}

async fn wait_for_live(child: &mut ChildGuard, url: &str) {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        assert!(
            child.child.try_wait().unwrap().is_none(),
            "serve process exited before liveness"
        );
        if let Ok(response) = client.get(url).send().await
            && response.status() == reqwest::StatusCode::OK
        {
            return;
        }
        assert!(Instant::now() < deadline, "liveness startup timed out");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn assert_response(url: &str, status: u16, expected: Value) {
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), status);
    assert_eq!(
        serde_json::from_slice::<Value>(&response.bytes().await.unwrap()).unwrap(),
        expected
    );
}

async fn run_healthcheck(url: String) -> Output {
    tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
            .arg("healthcheck")
            .env_clear()
            .env("NURITEO_HEALTHCHECK_URL", url)
            .env("NURITEO_HEALTHCHECK_TIMEOUT_MS", "2000")
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

fn assert_healthcheck_success(output: Output) {
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"healthcheck ready\n");
    assert!(output.stderr.is_empty());
}

fn assert_healthcheck_failure(output: Output) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"nuriteo-server: healthcheck unavailable\n");
}

fn assert_redacted(output: &Output) {
    let mut bytes = output.stdout.clone();
    bytes.extend_from_slice(&output.stderr);
    for secret in [SECRET_KEY.as_bytes(), b"nuriteo-test-password"] {
        assert!(!bytes.windows(secret.len()).any(|window| window == secret));
    }
}

fn available_address() -> std::net::SocketAddr {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

async fn assert_port_closed(address: std::net::SocketAddr) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if tokio::net::TcpStream::connect(address).await.is_err() {
            return;
        }
        assert!(Instant::now() < deadline, "listener port remained open");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn database_pool(database_url: String, ca: Vec<u8>) -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap();
    DatabasePool::connect(config).await.unwrap()
}

async fn migrate(pool: &DatabasePool) {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(2), Duration::from_secs(10)).unwrap(),
    )
    .await
    .unwrap();
}

async fn reset_history(pool: &DatabasePool) {
    sqlx::query("DROP TABLE IF EXISTS _sqlx_migrations")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

async fn migration_rows(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

fn fixture_s3_client(endpoint: &str, ca_pem: &[u8]) -> aws_sdk_s3::Client {
    let mut trust_store = TrustStore::default();
    trust_store.add_pem_certificate(ca_pem.to_vec());
    let context = TlsContext::builder()
        .with_trust_store(trust_store)
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .max_connections_per_host(4)
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(endpoint)
        .region(Region::new("us-east-1"))
        .force_path_style(true)
        .credentials_provider(Credentials::new(
            ACCESS_KEY,
            SECRET_KEY,
            None,
            None,
            "serve-fixture",
        ))
        .http_client(PoolClient::new(&pool).unwrap())
        .build();
    aws_sdk_s3::Client::from_conf(config)
}

async fn create_bucket(client: &aws_sdk_s3::Client) {
    client.create_bucket().bucket(BUCKET).send().await.unwrap();
}

async fn list_objects(client: &aws_sdk_s3::Client) -> Vec<aws_sdk_s3::types::Object> {
    client
        .list_objects_v2()
        .bucket(BUCKET)
        .send()
        .await
        .unwrap()
        .contents
        .unwrap_or_default()
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the production serve fixture"))
}
