use std::fs;
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::ServerSideEncryption;
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use nuriteo_server::backup::{
    BackupDestination, BackupDestinationConfig, BackupDestinationConfigError,
    BackupDestinationError, BackupSse, BackupWriterCredential,
};
use uuid::Uuid;

const BUCKET: &str = "nuriteo-bkp-003";
const ACCESS_KEY: &str = "backup-writer-access";
const SECRET_KEY: &str = "backup-writer-secret-0123456789";

#[test]
fn destination_configuration_is_https_only_and_redacted() {
    let credential = BackupWriterCredential::new(
        ACCESS_KEY.to_owned(),
        SECRET_KEY.to_owned(),
        Some("temporary-session-token".to_owned()),
    )
    .expect("credential is valid");
    let rendered = format!("{credential:?}");
    assert!(!rendered.contains(ACCESS_KEY));
    assert!(!rendered.contains(SECRET_KEY));
    assert!(!rendered.contains("temporary-session-token"));
    let encrypted_value = credential
        .encrypted_repository_value()
        .expect("credential can be handed to encrypted repository");
    let restored = BackupWriterCredential::from_repository_value(&encrypted_value)
        .expect("decrypted repository value is versioned and valid");
    assert!(!format!("{restored:?}").contains(SECRET_KEY));
    let identity = BackupWriterCredential::repository_identity("default", Uuid::now_v7())
        .expect("backup credential has a scoped repository identity");
    assert_eq!(identity.integration_type, "backup_destination");
    assert_eq!(identity.credential_kind, "writer");

    let error = BackupDestinationConfig::new(
        "http://backup.invalid",
        "us-east-1".to_owned(),
        BUCKET.to_owned(),
        "instance/backups".to_owned(),
        true,
        BackupSse::S3,
        None,
        Duration::from_secs(2),
    )
    .expect_err("plaintext endpoint must fail closed");
    assert_eq!(error, BackupDestinationConfigError::Endpoint);

    let invalid_ca = BackupDestinationConfig::new(
        "https://backup.invalid",
        "us-east-1".to_owned(),
        BUCKET.to_owned(),
        "instance/backups".to_owned(),
        true,
        BackupSse::S3,
        Some(b"-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n".to_vec()),
        Duration::from_secs(2),
    )
    .expect_err("malformed custom CA must fail before network use");
    assert_eq!(invalid_ca, BackupDestinationConfigError::InvalidCa);

    let config = BackupDestinationConfig::new(
        "https://backup.invalid",
        "us-east-1".to_owned(),
        BUCKET.to_owned(),
        "instance/backups".to_owned(),
        true,
        BackupSse::Kms {
            key_id: "sensitive-kms-key-id".to_owned(),
        },
        None,
        Duration::from_secs(2),
    )
    .expect("HTTPS destination is valid");
    let rendered = format!("{config:?}");
    for prohibited in [
        "backup.invalid",
        BUCKET,
        "instance/backups",
        "sensitive-kms-key-id",
    ] {
        assert!(!rendered.contains(prohibited));
    }
}

#[tokio::test]
#[ignore = "requires the pinned HTTPS RustFS fixture; run via the BKP-003 integration script"]
async fn https_rustfs_sse_and_writer_permission_preflight() {
    let endpoint = std::env::var("NURITEO_TEST_BACKUP_ENDPOINT")
        .expect("fixture provides its private HTTPS endpoint");
    let ca_file =
        std::env::var("NURITEO_TEST_BACKUP_CA_FILE").expect("fixture provides its CA file");
    let ca_pem = fs::read(&ca_file).expect("fixture CA is readable");
    let fixture_client = prepare_bucket(&endpoint, &ca_pem).await;
    fixture_client
        .head_bucket()
        .bucket(BUCKET)
        .send()
        .await
        .expect("fixture head bucket succeeds");
    fixture_client
        .put_object()
        .bucket(BUCKET)
        .key("instance-1/backups/direct-client-probe")
        .server_side_encryption(ServerSideEncryption::Aes256)
        .body(ByteStream::from_static(b"direct-client-probe"))
        .send()
        .await
        .expect("fixture direct SSE put succeeds");

    let config = BackupDestinationConfig::new(
        &endpoint,
        "us-east-1".to_owned(),
        BUCKET.to_owned(),
        "instance-1/backups".to_owned(),
        true,
        BackupSse::S3,
        Some(ca_pem.clone()),
        Duration::from_secs(5),
    )
    .expect("fixture destination is valid");
    let credential =
        BackupWriterCredential::new(ACCESS_KEY.to_owned(), SECRET_KEY.to_owned(), None)
            .expect("fixture credential is valid");
    let destination =
        BackupDestination::new(config.clone(), &credential).expect("fixture TLS client builds");
    let report = destination.preflight().await.expect("preflight succeeds");
    assert!(report.write && report.read && report.list && report.delete_denied);
    assert_eq!(report.sse, BackupSse::S3);
    assert_eq!(
        report.probe_object_key,
        "instance-1/backups/__nuriteo_preflight__/writer-capability-v1"
    );
    assert!(report.external_lifecycle_cleanup_required);
    assert!(!format!("{report:?}").contains("instance-1/backups"));

    let body = b"verified-backup-object".to_vec();
    let object = destination
        .put_verified_bytes("restore-points/read-boundary/manifest.json", body.clone())
        .await
        .expect("fixture stores a bounded object");
    assert_eq!(
        destination
            .read_verified_bounded(&object.key, object.sha256, 1024)
            .await
            .expect("bounded read verifies the object"),
        body
    );
    let temporary = tempfile::tempdir().expect("temporary directory exists");
    let target = temporary.path().join("downloaded-object");
    destination
        .download_verified(&object.key, object.bytes, object.sha256, &target)
        .await
        .expect("streaming download verifies the object");
    assert_eq!(fs::read(target).unwrap(), body);
    let bad_target = temporary.path().join("bad-download");
    destination
        .download_verified(&object.key, object.bytes, [0_u8; 32], &bad_target)
        .await
        .expect_err("digest mismatch fails closed");
    assert!(!bad_target.exists(), "partial files must be removed");

    let bad_secret = "credential-that-must-never-appear";
    let invalid = BackupWriterCredential::new(ACCESS_KEY.to_owned(), bad_secret.to_owned(), None)
        .expect("syntactically valid credential");
    let error = BackupDestination::new(config, &invalid)
        .expect("TLS client still builds")
        .preflight()
        .await
        .expect_err("invalid credential fails closed");
    assert!(matches!(
        error,
        BackupDestinationError::Authentication
            | BackupDestinationError::Authorization
            | BackupDestinationError::Transport
    ));
    assert!(!format!("{error:?} {error}").contains(bad_secret));
}

async fn prepare_bucket(endpoint: &str, ca_pem: &[u8]) -> aws_sdk_s3::Client {
    let context = TlsContext::builder()
        .with_trust_store(TrustStore::default().with_pem_certificate(ca_pem.to_vec()))
        .build()
        .expect("fixture trust store is valid");
    let pool = ConnectionPool::builder()
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .expect("fixture HTTPS pool builds");
    let http_client = PoolClient::new(&pool).expect("fixture HTTP client builds");
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(endpoint)
            .region(Region::new("us-east-1"))
            .force_path_style(true)
            .credentials_provider(Credentials::new(
                ACCESS_KEY,
                SECRET_KEY,
                None,
                None,
                "backup-fixture",
            ))
            .http_client(http_client)
            .build(),
    );
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let existing = error
            .as_service_error()
            .and_then(aws_sdk_s3::error::ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(existing, "bucket fixture setup failed");
    }
    let policy = format!(
        r#"{{"Version":"2012-10-17","Statement":[{{"Sid":"DenyBackupWriterDelete","Effect":"Deny","Principal":"*","Action":["s3:DeleteObject","s3:DeleteObjectVersion"],"Resource":"arn:aws:s3:::{BUCKET}/instance-1/backups/*"}}]}}"#
    );
    client
        .put_bucket_policy()
        .bucket(BUCKET)
        .policy(policy)
        .send()
        .await
        .expect("fixture installs explicit delete deny policy");
    client
}
