use std::ffi::OsString;
use std::fs;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::object_storage::{
    CapabilityState, ObjectStorageConfig, OperationLimits, ProbePrefix, S3ObjectStore,
};
use uuid::Uuid;

const BUCKET: &str = "nuriteo-s3-003";
const ACCESS_KEY: &str = "integration-access";
const SECRET_KEY: &str = "integration-secret-0123456789";

struct IntegrationEnvironment {
    endpoint: String,
    ca_file: String,
}

impl Environment for IntegrationEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        [
            ("NURITEO_S3_ENDPOINT", self.endpoint.as_str()),
            ("NURITEO_S3_REGION", "us-east-1"),
            ("NURITEO_S3_BUCKET", BUCKET),
            ("NURITEO_S3_ADDRESSING_STYLE", "path"),
            ("NURITEO_S3_CREDENTIAL_PROVIDER", "static"),
            ("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY),
            ("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY),
            ("NURITEO_S3_CA_FILE", self.ca_file.as_str()),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect()
    }
}

#[tokio::test]
#[ignore = "requires the pinned HTTPS RustFS fixture; run via the S3-003 integration script"]
async fn rustfs_capability_and_custom_ca_contract() {
    let endpoint = std::env::var("NURITEO_TEST_S3_ENDPOINT")
        .expect("fixture provides its private HTTPS endpoint");
    let ca_file = std::env::var("NURITEO_TEST_S3_CA_FILE").expect("fixture provides its CA file");
    create_bucket(&endpoint, &ca_file).await;

    let environment = IntegrationEnvironment {
        endpoint: endpoint.clone(),
        ca_file: ca_file.clone(),
    };
    let config = ObjectStorageConfig::load(&environment, &SystemFileReader)
        .expect("the TLS fixture configuration is valid");
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .expect("custom-CA HTTPS handshake configures successfully");
    let report = store
        .probe_capabilities(&ProbePrefix::new(Uuid::new_v4()))
        .await;

    assert_eq!(report.checksum, CapabilityState::Supported);
    assert_eq!(report.presigned_get, CapabilityState::Supported);
    assert_eq!(report.presigned_put, CapabilityState::Supported);
    assert_eq!(report.multipart_complete, CapabilityState::Supported);
    assert_eq!(report.multipart_abort, CapabilityState::Supported);
    assert_eq!(report.cleanup, CapabilityState::Supported);
    assert!(!report.orphan_warning);
    assert!(report.is_compatible());

    let rendered = format!("{report:?} {}", serde_json::to_string(&report).unwrap());
    for prohibited in [
        endpoint.as_str(),
        ca_file.as_str(),
        BUCKET,
        ACCESS_KEY,
        SECRET_KEY,
        "X-Amz-Signature",
        "__nuriteo_probe__",
    ] {
        assert!(!rendered.contains(prohibited));
    }
}

async fn create_bucket(endpoint: &str, ca_file: &str) {
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
    let credentials = Credentials::new(ACCESS_KEY, SECRET_KEY, None, None, "rustfs-fixture");
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(endpoint)
        .region(Region::new("us-east-1"))
        .force_path_style(true)
        .credentials_provider(credentials)
        .http_client(http_client)
        .build();
    let client = aws_sdk_s3::Client::from_conf(config);
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let existing = error
            .as_service_error()
            .and_then(aws_sdk_s3::error::ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(existing, "bucket fixture setup failed");
    }
}
