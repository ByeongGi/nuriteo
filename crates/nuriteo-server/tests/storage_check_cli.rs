use std::fs;
use std::process::{Command, Output};

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
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

    let compatible = run(&endpoint, &ca_file, BUCKET, SECRET_KEY);
    assert_eq!(compatible.status.code(), Some(0));
    assert!(compatible.stderr.is_empty());
    let report: Value = serde_json::from_slice(&compatible.stdout).expect("report is valid JSON");
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
    assert_safe(&compatible, &endpoint, &ca_file);
    assert_probe_namespace_empty(&client).await;

    let missing = run(&endpoint, &ca_file, MISSING_BUCKET, SECRET_KEY);
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

    let wrong_credential = run(&endpoint, &ca_file, BUCKET, WRONG_SECRET);
    assert_eq!(wrong_credential.status.code(), Some(1));
    assert!(wrong_credential.stdout.is_empty());
    assert_eq!(
        wrong_credential.stderr,
        b"nuriteo-server: storage-check failed (storage)\n"
    );
    assert_safe(&wrong_credential, &endpoint, &ca_file);
    assert_probe_namespace_empty(&client).await;
}

fn run(endpoint: &str, ca_file: &str, bucket: &str, secret: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nuriteo-server"))
        .arg("storage-check")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", "http://127.0.0.1:8080")
        .env("NURITEO_S3_ENDPOINT", endpoint)
        .env("NURITEO_S3_REGION", "us-east-1")
        .env("NURITEO_S3_BUCKET", bucket)
        .env("NURITEO_S3_ADDRESSING_STYLE", "path")
        .env("NURITEO_S3_CREDENTIAL_PROVIDER", "static")
        .env("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY)
        .env("NURITEO_S3_SECRET_ACCESS_KEY", secret)
        .env("NURITEO_S3_CA_FILE", ca_file)
        .output()
        .expect("storage-check subprocess starts")
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
