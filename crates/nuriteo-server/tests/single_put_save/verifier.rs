#![allow(unused_imports)]
use super::admission::*;
use super::fake_store::*;
use super::history::*;
use super::postgres_bucket::*;
use super::relay_client::*;
use super::relay_multipart::*;
use super::relay_streams::*;
use super::save_http::*;
use super::versions::*;
use super::working_head::*;
use super::*;
use std::env;

use std::ffi::OsString;

use std::fs;

use std::pin::Pin;

use std::str::FromStr;

use std::task::Poll;

use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};

use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};

use aws_smithy_http_client::tls::rustls_provider::CryptoMode;

use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};

use axum::Router;

use axum::body::{Body, to_bytes};

use axum::http::header::{CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, ORIGIN, SET_COOKIE};

use axum::http::{Method, Request, Response, StatusCode};

use base64::Engine as _;

use base64::engine::general_purpose::STANDARD as BASE64;

use bytes::Bytes;

use nuriteo_server::app::{build_router_with_project_service, build_router_with_save_service};

use nuriteo_server::audit::AuditEventId;

use nuriteo_server::auth::{AuthPolicy, AuthService};

use nuriteo_server::config::{Environment, InstanceSettingBootstrap, SystemFileReader};

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use nuriteo_server::health::HealthService;

use nuriteo_server::identity::SessionPolicy;

use nuriteo_server::identity::UserId;

use nuriteo_server::instance_settings::InstanceSettingsRepository;

use nuriteo_server::invitations::InvitationHttpService;

use nuriteo_server::object_storage::{
    BoundedPresignedRequest, MultipartUpload, ObjectKey, ObjectStorageConfig, OperationLimits,
    PresignedMultipartPartRequest, PresignedPutRequest, PutRequest, S3ObjectStore, Sha256Checksum,
    UploadedPart,
};

use nuriteo_server::organization::{OrganizationHttpService, OrganizationId};

use nuriteo_server::project::{
    ProjectAuditContext, ProjectDeleteConfirmation, ProjectHttpPolicy, ProjectHttpService,
    ProjectId, ProjectName, ProjectOwner, ProjectService, ProjectServicePolicy, ProjectSlug,
    ProjectVersion,
};

use nuriteo_server::published_example::{
    CreatePublishedExample, ForkPublishedExample, PublishedExampleDeleteConfirmation,
    PublishedExampleForkError, PublishedExampleForkKey, PublishedExampleForkPolicy,
    PublishedExampleForkService, PublishedExampleName, PublishedExampleService,
    PublishedExampleServicePolicy, PublishedExampleVisibility,
};

use nuriteo_server::quota::EffectiveQuota;

use nuriteo_server::save::{
    CleanupWorkerPolicy, ContentServicePolicy, CreateMultipartSession, CreateProjectVersion,
    CreateSinglePutSession, HistoricalReferenceKind, IdempotencyKey, IdempotencySecret,
    MultipartPartPlan, MultipartPartReceipt, MultipartService, MultipartServiceError,
    MultipartServicePolicy, MultipartSessionContext, MultipartStore, ProjectHistoryError,
    ProjectHistoryService, ProjectHistoryServicePolicy, ProjectVersionError, ProjectVersionName,
    ProjectVersionPageLimit, ProjectVersionService, ProjectVersionServicePolicy,
    PromoteHistoricalReference, PutPresigner, RecoveryCheckpoint, SaveHttpError, SaveHttpPolicy,
    SaveHttpService, SaveUploadTransport, SinglePutService, SinglePutServiceError,
    SinglePutServicePolicy, StagingVerifier, StagingVerifierPolicy, VerificationError,
    VerifiedStagingBundle, VerifyStagingBundle, WorkingHeadCommitError, WorkingHeadCommitPolicy,
    WorkingHeadCommitReconciliation, WorkingHeadCommitService, decode_git_bundle,
};

use nuriteo_server::setup::SetupStatusService;

use nuriteo_server::workspace::StorageScopeId;

use serde_json::{Value, json};

use sha2::{Digest, Sha256};

use sqlx::{Acquire, Executor};

use tower::ServiceExt as _;

use url::Url;

use super::{
    ACCESS_KEY, AbortBehavior, AttachFailureStore, BUCKET, BoundedFrameBody, CapturedLogWriter,
    DATABASE_CA_ENV, DATABASE_URL_ENV, FailingPresigner, FixtureEnvironment, GatedFrameBody,
    HangingPresigner, LostCompleteStore, NeverReadBody, ORG, ORG_MEMBER, ORG_OWNER,
    ORG_PROJECT_MEMBER, ORG_PROJECT_MULTI_ARCHIVE, ORG_PROJECT_MULTI_REVOKE, ORG_PROJECT_OUTSIDER,
    ORG_PROJECT_OWNER, ORG_PROJECT_READ, ORG_PROJECT_WRITE, ORG_READ, ORG_SCOPE, ORG_WRITE,
    OUTSIDER, ObservedFrameBody, PROJECT_A, PROJECT_B, PROJECT_FAIL, PROJECT_HISTORY_LEFT,
    PROJECT_HISTORY_RIGHT, PROJECT_LEASE_ABORT, PROJECT_LEASE_CLOCK, PROJECT_LEASE_COMPLETE,
    PROJECT_LEASE_EXPIRE, PROJECT_MULTI_EXPIRY, PROJECT_TIMEOUT, PersistedRelaySecretRow,
    RelayMultipartFixture, S3_CA_ENV, S3_ENDPOINT_ENV, SCOPE, SECRET_KEY, TEST_PASSWORD,
    TEST_PASSWORD_HASH, USER, VersionBrowser, WEB_ORIGIN,
};
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires tests/fixtures/staging-verifier/run.sh"]
pub(crate) async fn staging_verifier_accepts_golden_and_rejects_malicious_objects() {
    let pool = fixture_pool().await;
    reset_and_seed(&pool).await;
    let endpoint = env::var(S3_ENDPOINT_ENV).unwrap();
    let ca_file = env::var(S3_CA_ENV).unwrap();
    create_bucket(&endpoint, &ca_file).await;
    let config = ObjectStorageConfig::load(
        &FixtureEnvironment {
            endpoint,
            ca_file: ca_file.clone(),
        },
        &SystemFileReader,
    )
    .unwrap();
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap();
    let stream_store = S3ObjectStore::new(
        &config,
        OperationLimits {
            max_body_bytes: 1_024,
            max_range_bytes: 1_024,
            ..OperationLimits::default()
        },
    )
    .await
    .unwrap();
    let creator = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x65; 32]).unwrap(),
    )
    .unwrap();
    let http = fixture_http_client(&ca_file);
    let golden = canonical_test_bundle(PROJECT_A, SCOPE, "README.md", b"verified staging bundle\n");
    let mut creation = request(PROJECT_A, "staging-verify-good-01", &golden);
    creation.expected_logical_bytes = 24;
    creation.expected_file_count = 1;
    let session = creator.create(creation).await.unwrap();
    assert!(send_with_mutation(&http, session.capability().request(), &golden, None, None).await);

    let verifier = StagingVerifier::new(
        pool.clone(),
        stream_store.clone(),
        StagingVerifierPolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let context = verification_context(PROJECT_A, session.session_id());
    let (first, retried) = tokio::join!(verifier.verify(context), verifier.verify(context));
    let first = first.unwrap();
    let retried = retried.unwrap();
    assert_eq!(first.archive_sha256(), retried.archive_sha256());
    assert_eq!(
        (
            first.physical_bytes(),
            first.logical_bytes(),
            first.file_count()
        ),
        (golden.len() as u64, 24, 1)
    );
    let (state, reservations, bundles): (String, i64, i64) = sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=session.id),\
         (SELECT COUNT(*) FROM bundles) FROM save_sessions session WHERE id=$1::uuid",
    )
    .bind(session.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!((state.as_str(), reservations, bundles), ("verifying", 1, 0));

    let mut corrupt = canonical_test_bundle(PROJECT_B, SCOPE, "README.md", b"corrupt me\n");
    corrupt[1023] = 1;
    let mut bad_creation = request(PROJECT_B, "staging-verify-bad-001", &corrupt);
    bad_creation.expected_logical_bytes = 11;
    bad_creation.expected_file_count = 1;
    let bad = creator.create(bad_creation).await.unwrap();
    assert!(send_with_mutation(&http, bad.capability().request(), &corrupt, None, None).await);
    assert_eq!(
        verifier
            .verify(verification_context(PROJECT_B, bad.session_id()))
            .await
            .unwrap_err(),
        VerificationError::InvalidArchive
    );
    let (bad_state, bad_reservations, cleanup, head): (String, i64, i64, Option<String>) = sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=session.id),\
         (SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=session.id),\
         (SELECT working_head_bundle_id::text FROM projects WHERE id=session.project_id) \
         FROM save_sessions session WHERE id=$1::uuid",
    ).bind(bad.session_id().to_string()).fetch_one(&mut *pool.acquire().await.unwrap()).await.unwrap();
    assert_eq!(
        (bad_state.as_str(), bad_reservations, cleanup, head),
        ("failed", 0, 1, None)
    );

    let base = canonical_test_bundle(PROJECT_FAIL, SCOPE, "safe.txt", b"matrix\n");
    let mut checksum_header = base.clone();
    checksum_header[148] ^= 1;
    let mut manifest_count = base.clone();
    let count_offset = find_bytes(&manifest_count, b"\"fileCount\":1").unwrap() + 12;
    manifest_count[count_offset] = b'2';
    let mut wrong_order = base.clone();
    wrong_order[1024 + 156] = b'0';
    let mut file_checksum = base.clone();
    file_checksum[2560] ^= 1;
    let mut trailing = base.clone();
    trailing.push(0x5a);
    let excluded = canonical_test_bundle(PROJECT_FAIL, SCOPE, ".env", b"secret\n");
    for (index, (payload, logical)) in [
        (checksum_header, 7_u64),
        (manifest_count, 7),
        (wrong_order, 7),
        (file_checksum, 7),
        (trailing, 7),
        (excluded, 7),
    ]
    .into_iter()
    .enumerate()
    {
        let mut matrix_creation = request(
            PROJECT_FAIL,
            &format!("staging-matrix-{index:04}"),
            &payload,
        );
        matrix_creation.expected_logical_bytes = logical;
        matrix_creation.expected_file_count = 1;
        let matrix = creator.create(matrix_creation).await.unwrap();
        assert!(
            send_with_mutation(&http, matrix.capability().request(), &payload, None, None,).await
        );
        assert!(matches!(
            verifier
                .verify(verification_context(PROJECT_FAIL, matrix.session_id()))
                .await,
            Err(VerificationError::InvalidArchive | VerificationError::ObjectMismatch)
        ));
    }

    let timeout_bundle = canonical_test_bundle(PROJECT_TIMEOUT, SCOPE, "a.txt", b"timeout\n");
    let mut timeout_creation = request(PROJECT_TIMEOUT, "staging-timeout-0001", &timeout_bundle);
    timeout_creation.expected_logical_bytes = 8;
    timeout_creation.expected_file_count = 1;
    let timeout_session = creator.create(timeout_creation).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            timeout_session.capability().request(),
            &timeout_bundle,
            None,
            None
        )
        .await
    );
    let mut lock = pool.acquire().await.unwrap();
    lock.execute("BEGIN").await.unwrap();
    sqlx::query("SELECT id FROM storage_scopes WHERE id=$1::uuid FOR UPDATE")
        .bind(SCOPE)
        .execute(&mut *lock)
        .await
        .unwrap();
    let bounded = StagingVerifier::new(
        pool.clone(),
        stream_store,
        StagingVerifierPolicy::new(Duration::from_millis(100)).unwrap(),
    );
    assert_eq!(
        bounded
            .verify(verification_context(
                PROJECT_TIMEOUT,
                timeout_session.session_id()
            ))
            .await
            .unwrap_err(),
        VerificationError::OperationTimeout
    );
    lock.execute("ROLLBACK").await.unwrap();
    let preserved: String = sqlx::query_scalar("SELECT state FROM save_sessions WHERE id=$1::uuid")
        .bind(timeout_session.session_id().to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(preserved, "created");
}

#[tokio::test]
#[ignore = "requires tests/fixtures/published-example-fork/run.sh"]
pub(crate) async fn published_example_fork_rematerializes_destination_identity() {
    let pool = fixture_pool().await;
    reset_and_seed(&pool).await;
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    let endpoint = env::var(S3_ENDPOINT_ENV).unwrap();
    let ca_file = env::var(S3_CA_ENV).unwrap();
    create_bucket(&endpoint, &ca_file).await;
    let config = ObjectStorageConfig::load(
        &FixtureEnvironment {
            endpoint,
            ca_file: ca_file.clone(),
        },
        &SystemFileReader,
    )
    .unwrap();
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap();
    let creator = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x76; 32]).unwrap(),
    )
    .unwrap();
    let verifier = StagingVerifier::new(
        pool.clone(),
        store.clone(),
        StagingVerifierPolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let committer = WorkingHeadCommitService::new(
        pool.clone(),
        store.clone(),
        WorkingHeadCommitPolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let versions = ProjectVersionService::new(
        pool.clone(),
        ProjectVersionServicePolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let body = canonical_test_bundle(PROJECT_A, SCOPE, "fork.txt", b"forked content\n");
    let mut save = request(PROJECT_A, "published-fork-src1", &body);
    save.expected_logical_bytes = 15;
    save.expected_file_count = 1;
    let session = creator.create(save).await.unwrap();
    assert!(
        send_with_mutation(
            &fixture_http_client(&ca_file),
            session.capability().request(),
            &body,
            None,
            None,
        )
        .await
    );
    let verified = verifier
        .verify(verification_context(PROJECT_A, session.session_id()))
        .await
        .unwrap();
    let head = committer.commit(&verified).await.unwrap();
    let actor = UserId::from_str(USER).unwrap();
    let owner = ProjectOwner::User(actor);
    let explicit = versions
        .create(CreateProjectVersion {
            owner,
            project_id: ProjectId::from_str(PROJECT_A).unwrap(),
            actor_user_id: actor,
            expected_project_version: head.project_version(),
            name: ProjectVersionName::new("Fork Source".into()).unwrap(),
            idempotency_key: IdempotencyKey::new("published-fork-ver1".into()).unwrap(),
        })
        .await
        .unwrap();
    let examples = PublishedExampleService::new(
        pool.clone(),
        PublishedExampleServicePolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let (example, _) = examples
        .create(CreatePublishedExample {
            actor_user_id: actor,
            project_id: ProjectId::from_str(PROJECT_A).unwrap(),
            project_version_id: explicit.version().id(),
            name: PublishedExampleName::new("Fork Source".into()).unwrap(),
            visibility: PublishedExampleVisibility::Public,
        })
        .await
        .unwrap();
    let fork_service = PublishedExampleForkService::new(
        pool.clone(),
        store.clone(),
        PublishedExampleForkPolicy::default(),
    );
    let audit = ProjectAuditContext::new(
        AuditEventId::new(),
        actor,
        Some("Save Owner".into()),
        "published-example-fork-integration".into(),
        None,
    );
    let request = ForkPublishedExample {
        actor_user_id: actor,
        source_public_id: example.public_id().clone(),
        source_version_number: None,
        destination_owner: owner,
        destination_slug: ProjectSlug::new("fork-result".into()).unwrap(),
        destination_name: ProjectName::new("Fork Result".into()).unwrap(),
        idempotency_key: PublishedExampleForkKey::new("published-fork-request-01".into()).unwrap(),
    };
    let (left, right) = tokio::join!(
        fork_service.fork(request.clone(), &audit),
        fork_service.fork(request.clone(), &audit)
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left.project().id(), right.project().id());
    assert_ne!(left.is_idempotent_retry(), right.is_idempotent_retry());
    let forked = if left.is_idempotent_retry() {
        right
    } else {
        left
    };
    assert_eq!(forked.project().lock_version().get(), 2);
    let retried = fork_service.fork(request, &audit).await.unwrap();
    assert_eq!(retried.project().id(), forked.project().id());
    assert!(retried.is_idempotent_retry());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM projects WHERE owner_user_id=$1::uuid AND slug='fork-result'",
        )
        .bind(USER)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap(),
        1
    );
    let unpublished = examples.unpublish(actor, example.id(), 1).await.unwrap();
    examples
        .delete(
            actor,
            example.id(),
            unpublished.generation(),
            &PublishedExampleDeleteConfirmation {
                name: PublishedExampleName::new("Fork Source".into()).unwrap(),
            },
        )
        .await
        .unwrap();
    let destination: (String, String, Vec<u8>, i64, String, String, String) = sqlx::query_as(
        "SELECT bundle.id::text,bundle.object_key,bundle.sha256,bundle.physical_bytes,\
                project.storage_scope_id::text,fork.source_bundle_id::text,\
                materialization.state \
         FROM projects project \
         JOIN bundles bundle ON bundle.id=project.working_head_bundle_id \
         JOIN published_example_forks fork ON fork.destination_project_id=project.id \
         JOIN canonical_bundle_materializations materialization \
           ON materialization.sha256=bundle.sha256 \
          AND materialization.project_id=project.id \
          AND materialization.id=fork.canonical_materialization_id \
         WHERE project.id=$1::uuid",
    )
    .bind(forked.project().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_ne!(destination.0, destination.5);
    assert_eq!(destination.6, "finalized");
    let object = store
        .get(&ObjectKey::parse(destination.1).unwrap())
        .await
        .unwrap();
    assert_eq!(object.body.len(), usize::try_from(destination.3).unwrap());
    assert_eq!(Sha256::digest(&object.body).as_slice(), destination.2);
    let tree = decode_git_bundle(
        forked.project().id(),
        StorageScopeId::from_str(&destination.4).unwrap(),
        &object.body,
    )
    .unwrap();
    assert_eq!(tree.files().len(), 1);
    assert_eq!(tree.files()[0].path(), "fork.txt");
    assert_eq!(tree.files()[0].content(), b"forked content\n");
    let copied: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM project_user_roles WHERE project_id=$1::uuid),\
                (SELECT COUNT(*) FROM project_bundle_refs WHERE project_id=$1::uuid)",
    )
    .bind(forked.project().id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(copied, (0, 0));

    sqlx::query(
        "UPDATE instance_settings SET value='1'::jsonb,lock_version=lock_version+1,\
                updated_at=transaction_timestamp() \
         WHERE key='workspace.personal_default_quota_bytes'",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let quota_request = ForkPublishedExample {
        actor_user_id: actor,
        source_public_id: example.public_id().clone(),
        source_version_number: Some(1),
        destination_owner: owner,
        destination_slug: ProjectSlug::new("quota-rejected-fork".into()).unwrap(),
        destination_name: ProjectName::new("Quota Rejected Fork".into()).unwrap(),
        idempotency_key: PublishedExampleForkKey::new("published-fork-quota-01".into()).unwrap(),
    };
    // The source publication was deleted above, so recreate it only long enough
    // to exercise the live destination quota fence.
    let (quota_example, _) = examples
        .create(CreatePublishedExample {
            actor_user_id: actor,
            project_id: ProjectId::from_str(PROJECT_A).unwrap(),
            project_version_id: explicit.version().id(),
            name: PublishedExampleName::new("Quota Fork Source".into()).unwrap(),
            visibility: PublishedExampleVisibility::Public,
        })
        .await
        .unwrap();
    let quota_request = ForkPublishedExample {
        source_public_id: quota_example.public_id().clone(),
        ..quota_request
    };
    assert_eq!(
        fork_service.fork(quota_request, &audit).await,
        Err(PublishedExampleForkError::QuotaExceeded)
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM projects WHERE owner_user_id=$1::uuid \
             AND slug='quota-rejected-fork'",
        )
        .bind(USER)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap(),
        0
    );
    pool.close(Duration::from_secs(2)).await.unwrap();
}
