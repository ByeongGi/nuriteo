use std::env;
use std::ffi::OsString;
use std::fs;
use std::num::NonZeroU16;
use std::process::{Command, Output};
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use nuriteo_server::app::build_router_with_health;
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::{HealthPolicy, HealthService};
use nuriteo_server::object_storage::{ObjectStorageConfig, OperationLimits, S3ObjectStore};
use serde_json::{Value, json};
use tokio::sync::oneshot;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";
const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";
const ACCESS_KEY: &str = "integration-access";
const SECRET_KEY: &str = "integration-secret-0123456789";
const BUCKET: &str = "nuriteo-hlt-001";

#[tokio::test]
#[ignore = "requires pinned TLS PostgreSQL and HTTPS RustFS; run tests/fixtures/health-backends/run.sh"]
async fn real_backends_drive_http_readiness_and_healthcheck_cli() {
    let database_url = required_env(DATABASE_URL_ENV);
    let database_ca = fs::read(required_env(DATABASE_CA_ENV)).unwrap();
    let s3_endpoint = required_env(S3_ENDPOINT_ENV);
    let s3_ca_path = required_env(S3_CA_ENV);
    let s3_ca = fs::read(&s3_ca_path).unwrap();

    let pool = database_pool(database_url, database_ca).await;
    reset_history(&pool).await;
    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(2), Duration::from_secs(10)).unwrap(),
    )
    .await
    .unwrap();

    let fixture_client = fixture_s3_client(&s3_endpoint, &s3_ca);
    create_bucket(&fixture_client).await;
    let store = object_store(&s3_endpoint, &s3_ca_path).await;
    let health = HealthService::production(
        pool.clone(),
        store,
        HealthPolicy::new(
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_millis(1500),
            2,
        )
        .unwrap(),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, build_router_with_health(health))
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
    });
    let live_url = format!("http://{address}/health/live");
    let ready_url = format!("http://{address}/health/ready");
    let client = reqwest::Client::new();

    assert_eq!(
        get_json(&client, &live_url).await,
        json!({"status": "live"})
    );
    assert_eq!(
        get_json(&client, &ready_url).await,
        json!({"status": "ready"})
    );
    assert!(
        fixture_client
            .list_objects_v2()
            .bucket(BUCKET)
            .max_keys(1)
            .send()
            .await
            .unwrap()
            .contents()
            .is_empty()
    );
    assert_healthcheck_success(run_healthcheck(ready_url.clone()).await);

    sqlx::query("DELETE FROM _sqlx_migrations")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let response = client.get(&ready_url).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        serde_json::from_slice::<Value>(&response.bytes().await.unwrap()).unwrap(),
        json!({"status": "unavailable", "category": "schema-pending"})
    );
    assert_eq!(
        get_json(&client, &live_url).await,
        json!({"status": "live"})
    );
    assert_healthcheck_failure(run_healthcheck(ready_url.clone()).await);

    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(2), Duration::from_secs(10)).unwrap(),
    )
    .await
    .unwrap();
    fixture_client
        .delete_bucket()
        .bucket(BUCKET)
        .send()
        .await
        .unwrap();
    let response = client.get(&ready_url).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        serde_json::from_slice::<Value>(&response.bytes().await.unwrap()).unwrap(),
        json!({"status": "unavailable", "category": "storage"})
    );
    assert_eq!(
        get_json(&client, &live_url).await,
        json!({"status": "live"})
    );

    shutdown_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .expect("health server must drain within the shutdown deadline")
        .unwrap()
        .unwrap();
    reset_history(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn get_json(client: &reqwest::Client, url: &str) -> Value {
    let response = client.get(url).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

async fn run_healthcheck(url: String) -> Output {
    tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
            .arg("healthcheck")
            .env("NURITEO_HEALTHCHECK_URL", url)
            .env("NURITEO_HEALTHCHECK_TIMEOUT_MS", "2000")
            .output()
            .expect("healthcheck subprocess must start")
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

async fn reset_history(pool: &DatabasePool) {
    sqlx::query("DROP TABLE IF EXISTS _sqlx_migrations")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

struct StorageEnvironment(Vec<(OsString, OsString)>);

impl Environment for StorageEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

async fn object_store(endpoint: &str, ca_path: &str) -> S3ObjectStore {
    let values = [
        ("NURITEO_S3_ENDPOINT", endpoint),
        ("NURITEO_S3_REGION", "us-east-1"),
        ("NURITEO_S3_BUCKET", BUCKET),
        ("NURITEO_S3_ADDRESSING_STYLE", "path"),
        ("NURITEO_S3_CREDENTIAL_PROVIDER", "static"),
        ("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY),
        ("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY),
        ("NURITEO_S3_CA_FILE", ca_path),
    ]
    .into_iter()
    .map(|(name, value)| (name.into(), value.into()))
    .collect();
    let config = ObjectStorageConfig::load(&StorageEnvironment(values), &SystemFileReader).unwrap();
    let limits = OperationLimits {
        max_body_bytes: 1_024,
        max_stream_bytes: 1_024,
        max_range_bytes: 1_024,
        max_list_page: NonZeroU16::new(1).unwrap(),
        connect_timeout: Duration::from_secs(1),
        request_timeout: Duration::from_secs(2),
        attempt_timeout: Duration::from_secs(1),
        max_attempts: 1,
    };
    S3ObjectStore::new(&config, limits).await.unwrap()
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
    let http_client = PoolClient::new(&pool).unwrap();
    let credentials = Credentials::new(ACCESS_KEY, SECRET_KEY, None, None, "health-fixture");
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(endpoint)
        .region(Region::new("us-east-1"))
        .force_path_style(true)
        .credentials_provider(credentials)
        .http_client(http_client)
        .build();
    aws_sdk_s3::Client::from_conf(config)
}

async fn create_bucket(client: &aws_sdk_s3::Client) {
    client.create_bucket().bucket(BUCKET).send().await.unwrap();
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the health fixture"))
}
