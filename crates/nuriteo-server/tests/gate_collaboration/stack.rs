#![allow(unused_imports)]
use super::*;
use super::journey::*;

use std::ffi::OsString;

use std::fs;

use std::io::Read;

use std::net::{SocketAddr, TcpListener};

use std::process::{Child, Command, ExitStatus, Output, Stdio};

use std::thread::{self, JoinHandle};

use std::time::{Duration, Instant};


use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};

use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};

use aws_smithy_http_client::tls::rustls_provider::CryptoMode;

use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};

use nuriteo_server::config::{Environment, SystemFileReader};

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    run_embedded_migrations,
};

use nuriteo_server::object_storage::{ObjectStorageConfig, OperationLimits, S3ObjectStore};

use reqwest::header::{CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, ORIGIN, SET_COOKIE};

use reqwest::{Client, Method, Response, StatusCode};

use serde_json::{Value, json};

use url::Url;
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, S3_ENDPOINT_ENV, S3_CA_ENV, BOOTSTRAP_PASSWORD_FILE_ENV, SAVE_IDEMPOTENCY_SECRET_FILE_ENV, GATE_PROJECT_RUNTIME_BROWSER_ENV, NODE_EXECUTABLE_ENV, BOOTSTRAP_PASSWORD, INVITEE_PASSWORD, ACCESS_KEY, SECRET_KEY, BUCKET, MAX_PROCESS_OUTPUT_BYTES, Browser, CapturedProcessOutput, CapturedStream, ChildGuard, StorageEnvironment};



impl super::ChildGuard {
    pub(crate) fn new(mut child: Child, forbidden: &[&str]) -> Self {
        let forbidden = forbidden
            .iter()
            .map(|value| value.as_bytes().to_vec())
            .collect::<Vec<_>>();
        let stdout = spawn_output_reader(child.stdout.take().unwrap(), forbidden.clone());
        let stderr = spawn_output_reader(child.stderr.take().unwrap(), forbidden);
        Self {
            child,
            reaped: false,
            stderr: Some(stderr),
            stdout: Some(stdout),
        }
    }

    pub(crate) async fn terminate(mut self, timeout: Duration) -> CapturedProcessOutput {
        let status = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        self.wait_for_exit(timeout).await
    }

    pub(crate) async fn wait_for_exit(&mut self, timeout: Duration) -> CapturedProcessOutput {
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                break status;
            }
            assert!(Instant::now() < deadline, "server shutdown timed out");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        read_output(
            status,
            self.stdout.take().unwrap(),
            self.stderr.take().unwrap(),
        )
    }
}


impl Drop for ChildGuard { fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        drain_output_reader(self.stdout.take());
        drain_output_reader(self.stderr.take());
    }
}


pub(crate) fn spawn_output_reader(    mut stream: impl Read + Send + 'static,
    forbidden: Vec<Vec<u8>>,
) -> JoinHandle<std::io::Result<CapturedStream>> {
    thread::spawn(move || {
        let mut diagnostic = Vec::new();
        let mut chunk = [0_u8; 8192];
        let maximum_secret_length = forbidden.iter().map(Vec::len).max().unwrap_or(0);
        let mut suffix = Vec::new();
        let mut secret_detected = false;
        loop {
            let read = stream.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            let mut searchable = Vec::with_capacity(suffix.len() + read);
            searchable.extend_from_slice(&suffix);
            searchable.extend_from_slice(&chunk[..read]);
            secret_detected |= forbidden
                .iter()
                .any(|secret| contains_bytes(&searchable, secret));
            let suffix_length = maximum_secret_length
                .saturating_sub(1)
                .min(searchable.len());
            suffix.clear();
            suffix.extend_from_slice(&searchable[searchable.len() - suffix_length..]);

            let remaining = MAX_PROCESS_OUTPUT_BYTES.saturating_sub(diagnostic.len());
            diagnostic.extend_from_slice(&chunk[..read.min(remaining)]);
        }
        Ok(CapturedStream {
            diagnostic,
            secret_detected,
        })
    })
}


pub(crate) fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}


pub(crate) fn drain_output_reader(reader: Option<JoinHandle<std::io::Result<CapturedStream>>>) {    if let Some(reader) = reader {
        let _ = reader.join();
    }
}


pub(crate) fn read_output(    status: ExitStatus,
    stdout: JoinHandle<std::io::Result<CapturedStream>>,
    stderr: JoinHandle<std::io::Result<CapturedStream>>,
) -> CapturedProcessOutput {
    let stdout = stdout.join().unwrap().unwrap();
    let stderr = stderr.join().unwrap().unwrap();
    CapturedProcessOutput {
        status,
        secret_detected: stdout.secret_detected || stderr.secret_detected,
        stdout: stdout.diagnostic,
        stderr: stderr.diagnostic,
    }
}


#[test]
pub(crate) fn process_output_scanner_reads_beyond_diagnostic_cap_and_across_chunks() {    let secret = b"nrt_inv_split-across-the-reader-boundary".to_vec();
    let mut bytes = vec![b'x'; MAX_PROCESS_OUTPUT_BYTES + 8_175];
    bytes.extend_from_slice(&secret);
    let captured = spawn_output_reader(std::io::Cursor::new(bytes), vec![secret])
        .join()
        .unwrap()
        .unwrap();

    assert_eq!(captured.diagnostic.len(), MAX_PROCESS_OUTPUT_BYTES);
    assert!(captured.secret_detected);
}


pub(crate) async fn wait_for_live(child: &mut ChildGuard, client: &Client, base: &str) {    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            child.child.try_wait().unwrap().is_none(),
            "actual Core exited before liveness"
        );
        if let Ok(response) = client.get(format!("{base}/health/live")).send().await
            && response.status() == StatusCode::OK
        {
            return;
        }
        assert!(Instant::now() < deadline, "actual Core startup timed out");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}


pub(crate) fn available_address() -> SocketAddr {    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}


pub(crate) async fn database_pool(database_url: &str, ca_path: &str) -> DatabasePool {    let tls = DatabaseTlsConfig::verify_full(None, Some(fs::read(ca_path).unwrap()), None).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            database_url.to_owned(),
            0,
            12,
            Duration::from_secs(5),
            Duration::from_secs(2),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}


pub(crate) async fn reset_schema(pool: &DatabasePool) {    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}


pub(crate) async fn active_administrator_count(pool: &DatabasePool) -> i64 {    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE is_instance_admin AND status = 'active'")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}


pub(crate) async fn activation_status(pool: &DatabasePool, id: &str) -> String {    sqlx::query_scalar("SELECT status FROM activation_invitations WHERE id = $1::uuid")
        .bind(id)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}


pub(crate) async fn expire_activation(pool: &DatabasePool, id: &str) {    let mut connection = pool.acquire().await.unwrap();
    sqlx::query(
        "ALTER TABLE activation_invitations DISABLE TRIGGER activation_invitations_forward_only_update",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE activation_invitations SET created_at = transaction_timestamp() - INTERVAL '2 hours', \
         expires_at = transaction_timestamp() - INTERVAL '1 hour' WHERE id = $1::uuid",
    )
    .bind(id)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "ALTER TABLE activation_invitations ENABLE TRIGGER activation_invitations_forward_only_update",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
}


pub(crate) async fn assert_required_audits(pool: &DatabasePool) {    for action in [
        "instance_admin.bootstrap_created",
        "auth.login_succeeded",
        "invitation.issue",
        "invitation.revoke",
        "invitation.accept",
        "organization.created",
        "organization.invitation_issued",
        "organization.invitation_reissued",
        "organization.invitation_accepted",
    ] {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action_code = $1")
                .bind(action)
                .fetch_one(&mut *pool.acquire().await.unwrap())
                .await
                .unwrap();
        assert!(count > 0, "missing aggregate audit action {action}");
    }
}


pub(crate) async fn assert_durable_state_is_secret_free(pool: &DatabasePool, secrets: &[&str]) {    let durable: String = sqlx::query_scalar(
        "SELECT COALESCE((SELECT string_agg(row_to_json(a)::text, '') FROM audit_events a), '') || \
         COALESCE((SELECT string_agg(row_to_json(i)::text, '') FROM activation_invitations i), '') || \
         COALESCE((SELECT string_agg(row_to_json(i)::text, '') FROM organization_invitations i), '')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    for secret in secrets {
        assert!(
            !durable.contains(*secret),
            "durable state leaked a credential"
        );
    }
}


pub(crate) fn assert_process_output_secret_free(output: &Output, secrets: &[&str]) {    for stream in [&output.stdout, &output.stderr] {
        let stream = String::from_utf8_lossy(stream);
        for secret in secrets {
            assert!(
                !stream.contains(*secret),
                "process output leaked a credential"
            );
        }
    }
}


impl Environment for StorageEnvironment { fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}


pub(crate) async fn object_store(endpoint: &str, ca_path: &str) -> S3ObjectStore {    let entries = [
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
    let config =
        ObjectStorageConfig::load(&StorageEnvironment(entries), &SystemFileReader).unwrap();
    S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap()
}


pub(crate) fn fixture_s3_client(endpoint: &str, ca_pem: &[u8]) -> aws_sdk_s3::Client {    let mut trust_store = TrustStore::default();
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
    let credentials = Credentials::new(ACCESS_KEY, SECRET_KEY, None, None, "gate-002");
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


pub(crate) async fn create_bucket(client: &aws_sdk_s3::Client) {    client.create_bucket().bucket(BUCKET).send().await.unwrap();
}


pub(crate) fn required_env(name: &str) -> String {    env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the GATE-002 fixture"))
}


pub(crate) fn assert_current_embedded_migrations(report: MigrationReport) {    let expected_latest = i64::try_from(report.known_migrations)
        .expect("embedded migration count must fit in a PostgreSQL migration version");
    assert!(
        expected_latest > 0,
        "the embedded migration set must not be empty"
    );
    assert_eq!(
        report.latest_version,
        Some(expected_latest),
        "the gate requires the complete, contiguous embedded migration set"
    );
}

