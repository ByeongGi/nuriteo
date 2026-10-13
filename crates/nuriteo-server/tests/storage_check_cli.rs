use std::fs;
use std::process::{Command, Output};

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::types::{CorsConfiguration, CorsRule};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use serde_json::Value;

const BUCKET: &str = "nuriteo-s3-004";
const MISSING_BUCKET: &str = "nuriteo-s3-004-missing";
const ACCESS_KEY: &str = "storage-check-access";
const SECRET_KEY: &str = "storage-check-secret-0123456789";
const WRONG_SECRET: &str = "storage-check-wrong-0123456789";
const PROBE_ROOT: &str = "__nuriteo_probe__/";

#[tokio::test]
#[ignore = "requires the pinned custom-CA HTTPS RustFS fixture"]
async fn storage_check_subprocess_is_safe_and_leaves_no_probe_objects() {
    let endpoint = std::env::var("NURITEO_TEST_S3_ENDPOINT")
        .expect("fixture provides its private HTTPS endpoint");
    let ca_file =
        std::env::var("NURITEO_TEST_S3_CA_FILE").expect("fixture provides its private CA");
    let client = client(&endpoint, &ca_file, SECRET_KEY).await;
    create_bucket(&client).await;

    let relay = run(&endpoint, &ca_file, BUCKET, SECRET_KEY, "relay");
    assert_eq!(
        relay.status.code(),
        Some(0),
        "storage-check stderr: {}",
        String::from_utf8_lossy(&relay.stderr)
    );
    assert!(relay.stderr.is_empty());
    let report: Value = serde_json::from_slice(&relay.stdout).expect("report is valid JSON");
    let fields = report.as_object().expect("report is a JSON object");
    assert_eq!(fields.len(), 10);
    assert!(
        report["backend"]
            .as_str()
            .is_some_and(|value| value.len() == 19 && value.starts_with("s3-"))
    );
    assert!(report["checked_at_unix_seconds"].is_u64());
    assert_eq!(report["server_release"], env!("CARGO_PKG_VERSION"));
    assert_eq!(report["cleanup"], "supported");
    assert_eq!(report["orphan_warning"], false);
    for capability in [
        "checksum",
        "presigned_get",
        "presigned_put",
        "multipart_complete",
        "multipart_abort",
    ] {
        assert_eq!(report[capability], "supported");
    }
    assert_safe(&relay, &endpoint, &ca_file);
    assert_probe_namespace_empty(&client).await;

    let direct_without_cors = run(&endpoint, &ca_file, BUCKET, SECRET_KEY, "direct");
    assert_eq!(direct_without_cors.status.code(), Some(1));
    assert!(direct_without_cors.stdout.is_empty());
    assert_eq!(
        direct_without_cors.stderr,
        b"nuriteo-server: storage-check failed (browser-upload-cors-mismatch)\n"
    );
    assert_safe(&direct_without_cors, &endpoint, &ca_file);

    configure_drifted_browser_upload_cors(&client).await;
    let relay_with_drift = run(&endpoint, &ca_file, BUCKET, SECRET_KEY, "relay");
    assert_eq!(relay_with_drift.status.code(), Some(0));
    assert!(relay_with_drift.stderr.is_empty());
    assert_safe(&relay_with_drift, &endpoint, &ca_file);
    assert_probe_namespace_empty(&client).await;

    let drifted = run(&endpoint, &ca_file, BUCKET, SECRET_KEY, "direct");
    assert_eq!(drifted.status.code(), Some(1));
    assert!(drifted.stdout.is_empty());
    assert_eq!(
        drifted.stderr,
        b"nuriteo-server: storage-check failed (browser-upload-cors-mismatch)\n"
    );
    assert_safe(&drifted, &endpoint, &ca_file);
    let drifted_policy = client
        .get_bucket_cors()
        .bucket(BUCKET)
        .send()
        .await
        .expect("drifted policy remains readable");
    assert_eq!(drifted_policy.cors_rules()[0].allowed_methods().len(), 2);

    let configured = run_command(
        "storage-configure-browser-upload-cors",
        &endpoint,
        &ca_file,
        BUCKET,
        SECRET_KEY,
    );
    assert_eq!(configured.status.code(), Some(0));
    assert_eq!(
        configured.stdout,
        b"browser upload CORS configured and verified\n"
    );
    assert!(configured.stderr.is_empty());
    assert_safe(&configured, &endpoint, &ca_file);
    let restored = run(&endpoint, &ca_file, BUCKET, SECRET_KEY, "direct");
    assert_eq!(restored.status.code(), Some(0));
    assert!(restored.stderr.is_empty());
    assert_safe(&restored, &endpoint, &ca_file);
    assert_probe_namespace_empty(&client).await;

    let missing = run(&endpoint, &ca_file, MISSING_BUCKET, SECRET_KEY, "relay");
    assert_eq!(missing.status.code(), Some(1));
    assert!(missing.stdout.is_empty());
    assert_eq!(
        missing.stderr,
        b"nuriteo-server: storage-check failed (bucket-missing)\n"
    );
    assert_safe(&missing, &endpoint, &ca_file);
    assert!(
        client
            .head_bucket()
            .bucket(MISSING_BUCKET)
            .send()
            .await
            .is_err()
    );

    let wrong_credential = run(&endpoint, &ca_file, BUCKET, WRONG_SECRET, "relay");
    assert_eq!(wrong_credential.status.code(), Some(1));
    assert!(wrong_credential.stdout.is_empty());
    assert_eq!(
        wrong_credential.stderr,
        b"nuriteo-server: storage-check failed (storage)\n"
    );
    assert_safe(&wrong_credential, &endpoint, &ca_file);
    assert_probe_namespace_empty(&client).await;

    for transport in [None, Some(""), Some("Relay"), Some("unknown")] {
        let invalid = run_with_transport(
            "storage-check",
            &endpoint,
            &ca_file,
            BUCKET,
            SECRET_KEY,
            transport,
        );
        assert_eq!(invalid.status.code(), Some(1));
        assert!(invalid.stdout.is_empty());
        assert_eq!(
            invalid.stderr,
            b"nuriteo-server: storage-check failed (configuration)\n"
        );
        assert_safe(&invalid, &endpoint, &ca_file);
    }
}

fn run(endpoint: &str, ca_file: &str, bucket: &str, secret: &str, transport: &str) -> Output {
    run_with_transport(
        "storage-check",
        endpoint,
        ca_file,
        bucket,
        secret,
        Some(transport),
    )
}

fn run_command(command: &str, endpoint: &str, ca_file: &str, bucket: &str, secret: &str) -> Output {
    run_with_transport(command, endpoint, ca_file, bucket, secret, None)
}

fn run_with_transport(
    command: &str,
    endpoint: &str,
    ca_file: &str,
    bucket: &str,
    secret: &str,
    transport: Option<&str>,
) -> Output {
    let mut process = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"));
    process
        .arg(command)
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", "http://127.0.0.1:8080")
        .env("NURITEO_S3_ENDPOINT", endpoint)
        .env("NURITEO_S3_REGION", "us-east-1")
        .env("NURITEO_S3_BUCKET", bucket)
        .env("NURITEO_S3_ADDRESSING_STYLE", "path")
        .env("NURITEO_S3_CREDENTIAL_PROVIDER", "static")
        .env("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY)
        .env("NURITEO_S3_SECRET_ACCESS_KEY", secret)
        .env("NURITEO_S3_CA_FILE", ca_file);
    if let Some(transport) = transport {
        process.env("NURITEO_SAVE_UPLOAD_TRANSPORT", transport);
    }
    process.output().expect("storage-check subprocess starts")
}

fn assert_safe(output: &Output, endpoint: &str, ca_file: &str) {
    let rendered = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for prohibited in [
        endpoint,
        ca_file,
        BUCKET,
        MISSING_BUCKET,
        ACCESS_KEY,
        SECRET_KEY,
        WRONG_SECRET,
        "X-Amz-Signature",
        PROBE_ROOT,
    ] {
        assert!(!rendered.contains(prohibited), "leaked prohibited material");
    }
}

async fn client(endpoint: &str, ca_file: &str, secret: &str) -> aws_sdk_s3::Client {
    let ca = fs::read(ca_file).expect("fixture CA is readable");
    let context = TlsContext::builder()
        .with_trust_store(TrustStore::default().with_pem_certificate(ca))
        .build()
        .expect("fixture trust store is valid");
    let pool = ConnectionPool::builder()
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .expect("fixture HTTPS pool builds");
    let http_client = PoolClient::new(&pool).expect("fixture HTTP client builds");
    let credentials = Credentials::new(ACCESS_KEY, secret, None, None, "storage-check-fixture");
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
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let existing = error
            .as_service_error()
            .and_then(aws_sdk_s3::error::ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(existing, "bucket fixture setup failed");
    }
}

async fn configure_drifted_browser_upload_cors(client: &aws_sdk_s3::Client) {
    let rule = CorsRule::builder()
        .id("nuriteo-browser-upload-v1")
        .allowed_origins("http://127.0.0.1:8080")
        .allowed_methods("PUT")
        .allowed_methods("GET")
        .allowed_headers("content-type")
        .allowed_headers("x-amz-checksum-sha256")
        .allowed_headers("x-amz-sdk-checksum-algorithm")
        .expose_headers("etag")
        .expose_headers("x-amz-checksum-sha256")
        .max_age_seconds(300)
        .build()
        .unwrap();
    client
        .put_bucket_cors()
        .bucket(BUCKET)
        .cors_configuration(
            CorsConfiguration::builder()
                .cors_rules(rule)
                .build()
                .unwrap(),
        )
        .send()
        .await
        .expect("fixture drifted CORS can be configured");
}

async fn assert_probe_namespace_empty(client: &aws_sdk_s3::Client) {
    let objects = client
        .list_objects_v2()
        .bucket(BUCKET)
        .prefix(PROBE_ROOT)
        .send()
        .await
        .expect("probe objects can be listed");
    assert!(objects.contents().is_empty());

    let uploads = client
        .list_multipart_uploads()
        .bucket(BUCKET)
        .prefix(PROBE_ROOT)
        .send()
        .await
        .expect("probe uploads can be listed");
    assert!(uploads.uploads().is_empty());
}
