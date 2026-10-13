use std::ffi::OsString;
use std::fs;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::object_storage::{
    MultipartLimits, ObjectKey, ObjectStorageConfig, ObjectStoreErrorKind, OperationLimits,
    S3ObjectStore, Sha256Checksum, StreamingMultipartPartRequest, StreamingPutRequest, UploadBody,
    UploadDeadlines, upload_abort_pair,
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWriteExt, ReadBuf};

const BUCKET: &str = "nuriteo-s3-006";
const ACCESS_KEY: &str = "integration-access";
const SECRET_KEY: &str = "integration-secret-0123456789";
const SINGLE_BYTES: u64 = 64 * 1024 * 1024;
const PART_BYTES: u64 = 16 * 1024 * 1024;

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
#[ignore = "requires the pinned HTTPS RustFS fixture; run via the S3-006 integration script"]
async fn rustfs_non_replayable_streaming_contract() {
    let endpoint = std::env::var("NURITEO_TEST_S3_ENDPOINT")
        .expect("fixture provides its private HTTPS endpoint");
    let ca_file = std::env::var("NURITEO_TEST_S3_CA_FILE").expect("fixture provides its CA file");
    create_bucket(&endpoint, &ca_file).await;

    let config = ObjectStorageConfig::load(
        &IntegrationEnvironment {
            endpoint: endpoint.clone(),
            ca_file: ca_file.clone(),
        },
        &SystemFileReader,
    )
    .expect("the TLS fixture configuration is valid");
    let limits = OperationLimits {
        request_timeout: Duration::from_secs(120),
        attempt_timeout: Duration::from_secs(120),
        ..OperationLimits::default()
    };
    let store = S3ObjectStore::new(&config, limits)
        .await
        .expect("custom-CA HTTPS adapter builds");

    // A productive non-replayable stream must be governed by the relay total,
    // not the regular SDK attempt timeout. This producer progresses inside the
    // idle budget but deliberately runs longer than the configured 600 ms
    // attempt timeout that the non-streaming client still uses.
    let short_attempt_store = S3ObjectStore::new(
        &config,
        OperationLimits {
            connect_timeout: Duration::from_millis(500),
            attempt_timeout: Duration::from_millis(600),
            request_timeout: Duration::from_secs(5),
            ..OperationLimits::default()
        },
    )
    .await
    .expect("short-attempt fixture adapter builds");
    let progress_key = ObjectKey::parse("streaming/progress-past-attempt").unwrap();
    let (mut progress_writer, progress_reader) = tokio::io::duplex(1);
    let progress_producer = tokio::spawn(async move {
        for _ in 0..24 {
            progress_writer.write_all(&[0]).await.unwrap();
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    });
    short_attempt_store
        .put_stream_once(StreamingPutRequest {
            key: progress_key.clone(),
            body: UploadBody::from_reader(progress_reader, 24, zero_checksum(24)),
            content_type: None,
            deadlines: UploadDeadlines::for_put(Duration::from_millis(150), Duration::from_secs(2))
                .unwrap(),
            abort: upload_abort_pair().1,
        })
        .await
        .expect("continuous progress survives the base attempt timeout");
    progress_producer.await.unwrap();
    assert_eq!(
        short_attempt_store
            .head(&progress_key)
            .await
            .unwrap()
            .content_length,
        24
    );
    short_attempt_store.delete(&progress_key).await.unwrap();

    let single_key = ObjectKey::parse("streaming/single-64m").unwrap();
    store
        .put_stream_once(StreamingPutRequest {
            key: single_key.clone(),
            body: UploadBody::from_reader(
                ZeroReader::new(SINGLE_BYTES),
                SINGLE_BYTES,
                zero_checksum(SINGLE_BYTES),
            ),
            content_type: Some("application/octet-stream".to_owned()),
            deadlines: UploadDeadlines::for_put(Duration::from_secs(10), Duration::from_secs(120))
                .unwrap(),
            abort: upload_abort_pair().1,
        })
        .await
        .expect("64 MiB single PUT streams exactly once");
    assert_eq!(
        store.head(&single_key).await.unwrap().content_length,
        SINGLE_BYTES
    );

    let multipart_key = ObjectKey::parse("streaming/multipart-16m").unwrap();
    let multipart = store
        .create_multipart(multipart_key.clone())
        .await
        .expect("multipart upload starts");
    let part = store
        .upload_part_stream_once(
            StreamingMultipartPartRequest {
                upload: multipart.clone(),
                part_number: 1,
                body: UploadBody::from_reader(
                    ZeroReader::new(PART_BYTES),
                    PART_BYTES,
                    zero_checksum(PART_BYTES),
                ),
                final_part: true,
                deadlines: UploadDeadlines::for_multipart_part(
                    Duration::from_secs(10),
                    Duration::from_secs(120),
                )
                .unwrap(),
                abort: upload_abort_pair().1,
            },
            &MultipartLimits::new(PART_BYTES as usize).unwrap(),
        )
        .await
        .expect("16 MiB multipart part streams exactly once");
    store
        .complete_multipart(&multipart, vec![part])
        .await
        .expect("multipart upload completes");
    assert_eq!(
        store.head(&multipart_key).await.unwrap().content_length,
        PART_BYTES
    );

    let idle_key = ObjectKey::parse("streaming/idle").unwrap();
    let (_idle_writer, idle_reader) = tokio::io::duplex(1);
    let idle_error = store
        .put_stream_once(StreamingPutRequest {
            key: idle_key,
            body: UploadBody::from_reader(idle_reader, 1, Sha256Checksum::calculate(&[0])),
            content_type: None,
            deadlines: UploadDeadlines::for_put(Duration::from_millis(25), Duration::from_secs(1))
                .unwrap(),
            abort: upload_abort_pair().1,
        })
        .await
        .unwrap_err();
    assert_eq!(idle_error.kind(), ObjectStoreErrorKind::Timeout);
    assert!(!idle_error.is_retryable());

    let (mut total_writer, total_reader) = tokio::io::duplex(1);
    let total_producer = tokio::spawn(async move {
        loop {
            if total_writer.write_all(&[0]).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let total_error = store
        .put_stream_once(StreamingPutRequest {
            key: ObjectKey::parse("streaming/total").unwrap(),
            body: UploadBody::from_reader(total_reader, 100, zero_checksum(100)),
            content_type: None,
            deadlines: UploadDeadlines::for_put(
                Duration::from_millis(30),
                Duration::from_millis(50),
            )
            .unwrap(),
            abort: upload_abort_pair().1,
        })
        .await
        .unwrap_err();
    total_producer.abort();
    assert_eq!(total_error.kind(), ObjectStoreErrorKind::Timeout);
    assert!(!total_error.is_retryable());

    for (suffix, bytes, declared, checksum) in [
        ("underrun", &b""[..], 1, Sha256Checksum::calculate(&[0])),
        ("overrun", &b"ab"[..], 1, Sha256Checksum::calculate(b"a")),
        ("checksum", &b"a"[..], 1, Sha256Checksum::calculate(b"b")),
    ] {
        let error = store
            .put_stream_once(StreamingPutRequest {
                key: ObjectKey::parse(format!("streaming/{suffix}")).unwrap(),
                body: UploadBody::from_reader(std::io::Cursor::new(bytes), declared, checksum),
                content_type: None,
                deadlines: UploadDeadlines::for_put(Duration::from_secs(1), Duration::from_secs(5))
                    .unwrap(),
                abort: upload_abort_pair().1,
            })
            .await
            .unwrap_err();
        assert_eq!(error.kind(), ObjectStoreErrorKind::Integrity, "{suffix}");
        assert!(!error.is_retryable(), "{suffix}");
    }

    let abort_key = ObjectKey::parse("streaming/abort").unwrap();
    let (_abort_writer, abort_reader) = tokio::io::duplex(1);
    let (abort_handle, abort_signal) = upload_abort_pair();
    let abort_store = store.clone();
    let aborted = tokio::spawn(async move {
        abort_store
            .put_stream_once(StreamingPutRequest {
                key: abort_key,
                body: UploadBody::from_reader(abort_reader, 1, Sha256Checksum::calculate(&[0])),
                content_type: None,
                deadlines: UploadDeadlines::for_put(
                    Duration::from_secs(10),
                    Duration::from_secs(30),
                )
                .unwrap(),
                abort: abort_signal,
            })
            .await
    });
    tokio::task::yield_now().await;
    abort_handle.abort();
    let abort_error = aborted.await.unwrap().unwrap_err();
    assert_eq!(abort_error.kind(), ObjectStoreErrorKind::ResponseUnknown);
    assert!(!abort_error.is_retryable());

    store.delete(&single_key).await.unwrap();
    store.delete(&multipart_key).await.unwrap();

    let rendered = format!("{store:?} {idle_error:?} {abort_error:?}");
    for prohibited in [
        endpoint.as_str(),
        ca_file.as_str(),
        BUCKET,
        ACCESS_KEY,
        SECRET_KEY,
    ] {
        assert!(!rendered.contains(prohibited));
    }
}

struct ZeroReader {
    remaining: u64,
}

impl ZeroReader {
    const fn new(remaining: u64) -> Self {
        Self { remaining }
    }
}

impl AsyncRead for ZeroReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.remaining == 0 {
            return Poll::Ready(Ok(()));
        }
        let count = usize::try_from(self.remaining)
            .unwrap_or(usize::MAX)
            .min(output.remaining())
            .min(64 * 1024);
        output.put_slice(&[0_u8; 64 * 1024][..count]);
        self.remaining -= count as u64;
        Poll::Ready(Ok(()))
    }
}

fn zero_checksum(size: u64) -> Sha256Checksum {
    let mut hasher = Sha256::new();
    let chunk = [0_u8; 64 * 1024];
    let mut remaining = size;
    while remaining != 0 {
        let count = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(chunk.len());
        hasher.update(&chunk[..count]);
        remaining -= count as u64;
    }
    Sha256Checksum::from_bytes(hasher.finalize().into())
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
