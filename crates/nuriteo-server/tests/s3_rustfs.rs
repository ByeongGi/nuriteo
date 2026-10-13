use std::ffi::OsString;
use std::num::NonZeroU16;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::error::ProvideErrorMetadata;
use bytes::Bytes;
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::object_storage::{
    ByteRange, ListRequest, ObjectKey, ObjectPrefix, ObjectStorageConfig, ObjectStoreErrorKind,
    OperationLimits, PutRequest, S3ObjectStore,
};

const ENDPOINT: &str = "http://127.0.0.1:19000";
const BUCKET: &str = "nuriteo-s3-002";
const ACCESS_KEY: &str = "integration-access";
const SECRET_KEY: &str = "integration-secret-0123456789";

struct IntegrationEnvironment;

impl Environment for IntegrationEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        [
            ("NURITEO_S3_ENDPOINT", ENDPOINT),
            ("NURITEO_S3_REGION", "us-east-1"),
            ("NURITEO_S3_BUCKET", BUCKET),
            ("NURITEO_S3_ADDRESSING_STYLE", "path"),
            ("NURITEO_S3_CREDENTIAL_PROVIDER", "static"),
            ("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY),
            ("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect()
    }
}

#[tokio::test]
#[ignore = "requires the pinned RustFS fixture; run via the S3-002 integration script"]
async fn rustfs_object_operations_contract() {
    create_bucket().await;
    let config = ObjectStorageConfig::load(&IntegrationEnvironment, &SystemFileReader)
        .expect("the fixed fixture configuration is valid");
    let limits = OperationLimits {
        max_body_bytes: 1_024,
        max_range_bytes: 16,
        max_list_page: NonZeroU16::new(2).expect("non-zero fixture constant"),
        ..OperationLimits::default()
    };
    let store = S3ObjectStore::new(&config, limits)
        .await
        .expect("adapter builds against RustFS");
    let debug = format!("{store:?}");
    for prohibited in [ENDPOINT, BUCKET, ACCESS_KEY, SECRET_KEY] {
        assert!(!debug.contains(prohibited));
    }

    for (key, body) in [
        ("contract/a", "abcdefghij"),
        ("contract/b", "second"),
        ("contract/c", "third"),
    ] {
        store
            .put(PutRequest {
                key: ObjectKey::parse(key).expect("valid fixture key"),
                body: Bytes::copy_from_slice(body.as_bytes()),
                content_type: Some("text/plain".to_owned()),
            })
            .await
            .expect("put succeeds");
    }

    let primary = ObjectKey::parse("contract/a").expect("valid fixture key");
    let full = store.get(&primary).await.expect("get succeeds");
    assert_eq!(full.body, Bytes::from_static(b"abcdefghij"));
    assert_eq!(store.head(&primary).await.unwrap().content_length, 10);

    let range = store
        .get_range(&primary, ByteRange::new(2, 5).expect("valid range"))
        .await
        .expect("range succeeds");
    assert_eq!(range.body, Bytes::from_static(b"cdef"));

    let missing = ObjectKey::parse("contract/missing").expect("valid fixture key");
    assert_eq!(
        store.get(&missing).await.unwrap_err().kind(),
        ObjectStoreErrorKind::NotFound
    );

    let first = store
        .list(ListRequest {
            prefix: ObjectPrefix::parse("contract/").expect("valid fixture prefix"),
            continuation: None,
            page_size: NonZeroU16::new(2).expect("non-zero fixture constant"),
        })
        .await
        .expect("first list page succeeds");
    assert_eq!(first.objects.len(), 2);
    let second = store
        .list(ListRequest {
            prefix: ObjectPrefix::parse("contract/").expect("valid fixture prefix"),
            continuation: first.next,
            page_size: NonZeroU16::new(2).expect("non-zero fixture constant"),
        })
        .await
        .expect("second list page succeeds");
    assert_eq!(second.objects.len(), 1);
    assert!(second.next.is_none());

    let oversized_page = store
        .list(ListRequest {
            prefix: ObjectPrefix::parse("contract/").expect("valid fixture prefix"),
            continuation: None,
            page_size: NonZeroU16::new(3).expect("non-zero fixture constant"),
        })
        .await
        .unwrap_err();
    assert_eq!(oversized_page.kind(), ObjectStoreErrorKind::InvalidRequest);

    store.delete(&primary).await.expect("first delete succeeds");
    store
        .delete(&primary)
        .await
        .expect("second delete is idempotent");
    assert_eq!(
        store.head(&primary).await.unwrap_err().kind(),
        ObjectStoreErrorKind::NotFound
    );
}

async fn create_bucket() {
    let credentials = Credentials::new(ACCESS_KEY, SECRET_KEY, None, None, "rustfs-fixture");
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(ENDPOINT)
        .region(Region::new("us-east-1"))
        .force_path_style(true)
        .credentials_provider(credentials)
        .build();
    let client = aws_sdk_s3::Client::from_conf(config);
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let already_exists = error
            .as_service_error()
            .and_then(ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(already_exists, "bucket fixture setup failed");
    }
}
