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
use uuid::Uuid;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";
const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";
const BUCKET: &str = "nuriteo-save-003";
const ACCESS_KEY: &str = "save003-access";
const SECRET_KEY: &str = "save003-secret-0123456789";
const WEB_ORIGIN: &str = "http://localhost:3000";
const TEST_PASSWORD: &str = "correct horse battery staple";
const TEST_PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";
const USER: &str = "0199ee6c-c777-7000-8000-000000008001";
const SCOPE: &str = "0199ee6c-c777-7000-8000-000000008010";
const PROJECT_A: &str = "0199ee6c-c777-7000-8000-000000008020";
const PROJECT_B: &str = "0199ee6c-c777-7000-8000-000000008021";
const PROJECT_FAIL: &str = "0199ee6c-c777-7000-8000-000000008022";
const PROJECT_TIMEOUT: &str = "0199ee6c-c777-7000-8000-000000008023";
const PROJECT_LEASE_ABORT: &str = "0199ee6c-c777-7000-8000-000000008026";
const PROJECT_LEASE_EXPIRE: &str = "0199ee6c-c777-7000-8000-000000008027";
const PROJECT_LEASE_COMPLETE: &str = "0199ee6c-c777-7000-8000-000000008028";
const PROJECT_MULTI_EXPIRY: &str = "0199ee6c-c777-7000-8000-000000008029";
const PROJECT_LEASE_CLOCK: &str = "0199ee6c-c777-7000-8000-00000000802a";
const PROJECT_HISTORY_LEFT: &str = "0199ee6c-c777-7000-8000-000000008024";
const PROJECT_HISTORY_RIGHT: &str = "0199ee6c-c777-7000-8000-000000008025";
const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000008002";
const ORG_OWNER: &str = "0199ee6c-c777-7000-8000-000000008003";
const ORG_READ: &str = "0199ee6c-c777-7000-8000-000000008004";
const ORG_WRITE: &str = "0199ee6c-c777-7000-8000-000000008005";
const ORG_MEMBER: &str = "0199ee6c-c777-7000-8000-000000008006";
const ORG_SCOPE: &str = "0199ee6c-c777-7000-8000-000000008031";
const ORG: &str = "0199ee6c-c777-7000-8000-000000008030";
const ORG_PROJECT_OWNER: &str = "0199ee6c-c777-7000-8000-000000008040";
const ORG_PROJECT_READ: &str = "0199ee6c-c777-7000-8000-000000008041";
const ORG_PROJECT_WRITE: &str = "0199ee6c-c777-7000-8000-000000008042";
const ORG_PROJECT_MEMBER: &str = "0199ee6c-c777-7000-8000-000000008043";
const ORG_PROJECT_OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000008044";
const ORG_PROJECT_MULTI_REVOKE: &str = "0199ee6c-c777-7000-8000-000000008045";
const ORG_PROJECT_MULTI_ARCHIVE: &str = "0199ee6c-c777-7000-8000-000000008046";

type PersistedRelaySecretRow = (String, Vec<u8>, Vec<u8>, Option<String>);

#[tokio::test]
#[ignore = "requires tests/fixtures/staging-verifier/run.sh"]
async fn staging_verifier_accepts_golden_and_rejects_malicious_objects() {
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
async fn published_example_fork_rematerializes_destination_identity() {
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
                recently_reauthenticated: true,
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

#[tokio::test]
#[ignore = "requires tests/fixtures/working-head-commit/run.sh"]
async fn working_head_commit_is_atomic_idempotent_and_fenced() {
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
    let creator = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x66; 32]).unwrap(),
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
    let http = fixture_http_client(&ca_file);

    let first_body = canonical_test_bundle(PROJECT_A, SCOPE, "first.txt", b"first\n");
    let mut first_request = request(PROJECT_A, "head-first-000001", &first_body);
    first_request.expected_logical_bytes = 6;
    first_request.expected_file_count = 1;
    let first_session = creator.create(first_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            first_session.capability().request(),
            &first_body,
            None,
            None,
        )
        .await
    );
    let first_capability = verifier
        .verify(verification_context(PROJECT_A, first_session.session_id()))
        .await
        .unwrap();
    let (left, right) = tokio::join!(
        committer.commit(&first_capability),
        committer.commit(&first_capability)
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left, right);
    assert_eq!(left.project_version().get(), 2);
    assert_eq!(committer.commit(&first_capability).await.unwrap(), left);
    assert_eq!(
        committer.reconcile(&first_capability).await.unwrap(),
        WorkingHeadCommitReconciliation::Committed(left)
    );
    let first_state: (String, i64, i64, String, i64) = sqlx::query_as(
        "SELECT session.state,\
         (SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=session.id),\
         (SELECT COUNT(*) FROM project_bundle_admissions WHERE project_id=session.project_id \
          AND bundle_id=session.committed_bundle_id),\
         project.working_head_bundle_id::text,project.lock_version \
         FROM save_sessions session JOIN projects project ON project.id=session.project_id \
         WHERE session.id=$1::uuid",
    )
    .bind(first_session.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        first_state,
        (
            "committed".to_owned(),
            0,
            1,
            left.bundle_id().to_string(),
            2
        )
    );

    let second_body = canonical_test_bundle(PROJECT_A, SCOPE, "second.txt", b"second\n");
    let mut second_request = request(PROJECT_A, "head-second-00001", &second_body);
    second_request.expected_project_version = ProjectVersion::new(2).unwrap();
    second_request.expected_logical_bytes = 7;
    second_request.expected_file_count = 1;
    let second_session = creator.create(second_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            second_session.capability().request(),
            &second_body,
            None,
            None,
        )
        .await
    );
    let second_capability = verifier
        .verify(verification_context(PROJECT_A, second_session.session_id()))
        .await
        .unwrap();
    let second = committer.commit(&second_capability).await.unwrap();
    assert_ne!(second.bundle_id(), left.bundle_id());
    assert_eq!(second.project_version().get(), 3);
    let replaced: (String, i64, i64, bool, i64) = sqlx::query_as(
        "SELECT working_head_bundle_id::text,lock_version, \
         (SELECT COUNT(*) FROM project_bundle_refs reference \
          WHERE reference.project_id=project.id AND reference.kind='recovery'), \
         EXISTS(SELECT 1 FROM project_bundle_refs reference \
          WHERE reference.project_id=project.id AND reference.kind='recovery' \
            AND reference.bundle_id=$2::uuid), \
         (SELECT COUNT(*) FROM gc_candidates candidate JOIN bundles bundle \
          ON bundle.object_key=candidate.object_key WHERE bundle.id=$2::uuid) \
         FROM projects project WHERE project.id=$1::uuid",
    )
    .bind(PROJECT_A)
    .bind(left.bundle_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(replaced, (second.bundle_id().to_string(), 3, 1, true, 0));

    let stale_body = canonical_test_bundle(PROJECT_B, SCOPE, "stale.txt", b"stale\n");
    let mut stale_request = request(PROJECT_B, "head-stale-000001", &stale_body);
    stale_request.expected_logical_bytes = 6;
    stale_request.expected_file_count = 1;
    let stale_session = creator.create(stale_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            stale_session.capability().request(),
            &stale_body,
            None,
            None,
        )
        .await
    );
    let stale_capability = verifier
        .verify(verification_context(PROJECT_B, stale_session.session_id()))
        .await
        .unwrap();
    sqlx::query(
        "UPDATE projects SET name='Changed elsewhere',lock_version=lock_version+1,\
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(PROJECT_B)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        committer.commit(&stale_capability).await.unwrap_err(),
        WorkingHeadCommitError::StaleProjectVersion
    );
    let stale_preserved: (String, i64, i64, Option<String>) = sqlx::query_as(
        "SELECT session.state,\
         (SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=session.id),\
         (SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=session.id),\
         project.working_head_bundle_id::text FROM save_sessions session \
         JOIN projects project ON project.id=session.project_id WHERE session.id=$1::uuid",
    )
    .bind(stale_session.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(stale_preserved, ("failed".to_owned(), 0, 1, None));

    let missing_body = canonical_test_bundle(PROJECT_FAIL, SCOPE, "missing.txt", b"missing\n");
    let mut missing_request = request(PROJECT_FAIL, "head-missing-0001", &missing_body);
    missing_request.expected_logical_bytes = 8;
    missing_request.expected_file_count = 1;
    let missing_session = creator.create(missing_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            missing_session.capability().request(),
            &missing_body,
            None,
            None,
        )
        .await
    );
    let missing_capability = verifier
        .verify(verification_context(
            PROJECT_FAIL,
            missing_session.session_id(),
        ))
        .await
        .unwrap();
    let missing_key: String =
        sqlx::query_scalar("SELECT staging_object_key FROM save_sessions WHERE id=$1::uuid")
            .bind(missing_session.session_id().to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    store
        .delete(&ObjectKey::parse(missing_key).unwrap())
        .await
        .unwrap();
    assert_eq!(
        committer.commit(&missing_capability).await.unwrap_err(),
        WorkingHeadCommitError::ObjectMismatch
    );
    assert_eq!(
        terminal_cleanup_state(&pool, missing_session.session_id().to_string()).await,
        ("failed".to_owned(), 0, 1)
    );

    let mismatch_body = canonical_test_bundle(PROJECT_TIMEOUT, SCOPE, "mismatch.txt", b"match\n");
    let mut mismatch_request = request(PROJECT_TIMEOUT, "head-mismatch-001", &mismatch_body);
    mismatch_request.expected_logical_bytes = 6;
    mismatch_request.expected_file_count = 1;
    let mismatch_session = creator.create(mismatch_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            mismatch_session.capability().request(),
            &mismatch_body,
            None,
            None,
        )
        .await
    );
    let mismatch_capability = verifier
        .verify(verification_context(
            PROJECT_TIMEOUT,
            mismatch_session.session_id(),
        ))
        .await
        .unwrap();
    let mismatch_key: String =
        sqlx::query_scalar("SELECT staging_object_key FROM save_sessions WHERE id=$1::uuid")
            .bind(mismatch_session.session_id().to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    store
        .put(PutRequest {
            key: ObjectKey::parse(mismatch_key).unwrap(),
            body: Bytes::from_static(b"replaced"),
            content_type: None,
        })
        .await
        .unwrap();
    assert_eq!(
        committer.commit(&mismatch_capability).await.unwrap_err(),
        WorkingHeadCommitError::ObjectMismatch
    );
    assert_eq!(
        terminal_cleanup_state(&pool, mismatch_session.session_id().to_string()).await,
        ("failed".to_owned(), 0, 1)
    );

    verify_commit_permission_and_expiry(&pool, &creator, &verifier, &committer, &http).await;

    let mut dedupe_request = request(PROJECT_A, "head-dedupe-000001", &second_body);
    dedupe_request.expected_project_version = ProjectVersion::new(3).unwrap();
    dedupe_request.expected_logical_bytes = 7;
    dedupe_request.expected_file_count = 1;
    let dedupe_session = creator.create(dedupe_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            dedupe_session.capability().request(),
            &second_body,
            None,
            None,
        )
        .await
    );
    let dedupe_capability = verifier
        .verify(verification_context(PROJECT_A, dedupe_session.session_id()))
        .await
        .unwrap();

    let independent_body = canonical_test_bundle(
        ORG_PROJECT_OWNER,
        ORG_SCOPE,
        "independent.txt",
        b"independent\n",
    );
    let mut independent_request = request_for(
        ORG_SCOPE,
        ORG_PROJECT_OWNER,
        ORG_OWNER,
        "head-independent-01",
        &independent_body,
    );
    independent_request.expected_logical_bytes = 12;
    independent_request.expected_file_count = 1;
    let independent_session = creator.create(independent_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            independent_session.capability().request(),
            &independent_body,
            None,
            None,
        )
        .await
    );
    let independent_capability = verifier
        .verify(VerifyStagingBundle {
            storage_scope_id: StorageScopeId::from_str(ORG_SCOPE).unwrap(),
            project_id: ProjectId::from_str(ORG_PROJECT_OWNER).unwrap(),
            actor_user_id: UserId::from_str(ORG_OWNER).unwrap(),
            session_id: independent_session.session_id(),
        })
        .await
        .unwrap();

    let mut scope_lock = pool.acquire().await.unwrap();
    scope_lock.execute("BEGIN").await.unwrap();
    sqlx::query("SELECT id FROM storage_scopes WHERE id=$1::uuid FOR UPDATE")
        .bind(SCOPE)
        .execute(&mut *scope_lock)
        .await
        .unwrap();
    let bounded_committer = WorkingHeadCommitService::new(
        pool.clone(),
        store.clone(),
        WorkingHeadCommitPolicy::new(Duration::from_millis(100)).unwrap(),
    );
    let (blocked, independent) = tokio::join!(
        bounded_committer.commit(&dedupe_capability),
        committer.commit(&independent_capability),
    );
    assert_eq!(
        blocked.unwrap_err(),
        WorkingHeadCommitError::OperationTimeout
    );
    assert_eq!(independent.unwrap().project_version().get(), 2);
    scope_lock.execute("ROLLBACK").await.unwrap();
    let deduplicated = committer.commit(&dedupe_capability).await.unwrap();
    assert_eq!(deduplicated.bundle_id(), second.bundle_id());
    assert_eq!(deduplicated.project_version().get(), 4);
    let dedupe_state: (i64, i64, String) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM bundles WHERE sha256=session.expected_bundle_sha256),\
         (SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=session.id),session.state \
         FROM save_sessions session WHERE id=$1::uuid",
    )
    .bind(dedupe_session.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(dedupe_state, (1, 1, "committed".to_owned()));

    let third_capability = prepare_verified_head(
        &creator,
        &verifier,
        &http,
        ProjectVersion::new(4).unwrap(),
        "head-rotation-third",
        "third.txt",
        b"third\n",
    )
    .await;
    let third = committer.commit(&third_capability).await.unwrap();
    assert_eq!(third.project_version().get(), 5);
    let fourth_capability = prepare_verified_head(
        &creator,
        &verifier,
        &http,
        ProjectVersion::new(5).unwrap(),
        "head-rotation-fourth",
        "fourth.txt",
        b"fourth\n",
    )
    .await;
    let fourth = committer.commit(&fourth_capability).await.unwrap();
    assert_eq!(fourth.project_version().get(), 6);
    let fifth_capability = prepare_verified_head(
        &creator,
        &verifier,
        &http,
        ProjectVersion::new(6).unwrap(),
        "head-rotation-fifth",
        "fifth.txt",
        b"fifth\n",
    )
    .await;
    let (fifth_left, fifth_right) = tokio::join!(
        committer.commit(&fifth_capability),
        committer.commit(&fifth_capability),
    );
    let fifth = fifth_left.unwrap();
    assert_eq!(fifth_right.unwrap(), fifth);
    assert_eq!(committer.commit(&fifth_capability).await.unwrap(), fifth);
    assert_eq!(fifth.project_version().get(), 7);

    let recovery_rows: Vec<(String, i16)> = sqlx::query_as(
        "SELECT bundle_id::text,recovery_position FROM project_bundle_refs \
         WHERE project_id=$1::uuid AND kind='recovery' ORDER BY created_at,id",
    )
    .bind(PROJECT_A)
    .fetch_all(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(recovery_rows.len(), 3);
    let recovery_bundles: std::collections::BTreeSet<_> = recovery_rows
        .iter()
        .map(|(bundle_id, _)| bundle_id.as_str())
        .collect();
    assert_eq!(
        recovery_bundles,
        [
            second.bundle_id().to_string(),
            third.bundle_id().to_string(),
            fourth.bundle_id().to_string(),
        ]
        .iter()
        .map(String::as_str)
        .collect()
    );
    assert_eq!(
        recovery_rows
            .iter()
            .map(|(_, position)| *position)
            .collect::<std::collections::BTreeSet<_>>(),
        [1, 2, 3].into_iter().collect()
    );
    let retention_state: (i64, i64, String, i64) = sqlx::query_as(
        "SELECT \
         (SELECT COUNT(DISTINCT bundle_id) FROM ( \
            SELECT working_head_bundle_id AS bundle_id FROM projects WHERE id=$1::uuid \
            UNION SELECT bundle_id FROM project_bundle_refs WHERE project_id=$1::uuid) live), \
         (SELECT COUNT(*) FROM project_bundle_refs WHERE project_id=$1::uuid \
            AND bundle_id=$2::uuid), \
         candidate.reason, \
         (SELECT COUNT(*) FROM gc_candidates retained_candidate JOIN bundles retained_bundle \
            ON retained_bundle.object_key=retained_candidate.object_key \
          WHERE retained_bundle.id IN ($3::uuid,$4::uuid,$5::uuid,$6::uuid)) \
         FROM gc_candidates candidate JOIN bundles removed_bundle \
           ON removed_bundle.object_key=candidate.object_key \
         WHERE removed_bundle.id=$2::uuid",
    )
    .bind(PROJECT_A)
    .bind(left.bundle_id().to_string())
    .bind(second.bundle_id().to_string())
    .bind(third.bundle_id().to_string())
    .bind(fourth.bundle_id().to_string())
    .bind(fifth.bundle_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(retention_state, (4, 0, "reference_removed".to_owned(), 0));

    sqlx::query(
        "INSERT INTO gc_candidates \
         (object_key,expected_sha256,expected_bytes,reason,eligible_at) \
         SELECT object_key,sha256,physical_bytes,'reference_removed',transaction_timestamp() \
         FROM bundles WHERE id=$1::uuid ON CONFLICT (object_key) DO NOTHING",
    )
    .bind(third.bundle_id().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let retained_gc_attempt = sqlx::query(
        "UPDATE gc_candidates SET status='running',attempts=attempts+1, \
            started_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE object_key=(SELECT object_key FROM bundles WHERE id=$1::uuid)",
    )
    .bind(third.bundle_id().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await;
    assert!(retained_gc_attempt.is_err());
    sqlx::query(
        "DELETE FROM gc_candidates WHERE object_key=(SELECT object_key FROM bundles WHERE id=$1::uuid) \
         AND status='queued'",
    )
    .bind(third.bundle_id().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let race_body = canonical_test_bundle(PROJECT_A, SCOPE, "cleanup-race.txt", b"race\n");
    let mut race_request = request(PROJECT_A, "head-cleanup-race1", &race_body);
    race_request.expected_project_version = ProjectVersion::new(7).unwrap();
    race_request.expected_logical_bytes = 5;
    race_request.expected_file_count = 1;
    let race_session = creator.create(race_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            race_session.capability().request(),
            &race_body,
            None,
            None,
        )
        .await
    );
    let race_capability = verifier
        .verify(verification_context(PROJECT_A, race_session.session_id()))
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO save_cleanup_jobs (save_session_id,cleanup_kind,object_key,eligible_at) \
         SELECT id,'object_delete',staging_object_key,transaction_timestamp() \
         FROM save_sessions WHERE id=$1::uuid",
    )
    .bind(race_session.session_id().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        committer.commit(&race_capability).await.unwrap_err(),
        WorkingHeadCommitError::SessionUnavailable
    );
    let fenced_head: String =
        sqlx::query_scalar("SELECT working_head_bundle_id::text FROM projects WHERE id=$1::uuid")
            .bind(PROJECT_A)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(fenced_head, fifth.bundle_id().to_string());

    let active_body = canonical_test_bundle(PROJECT_B, SCOPE, "active.txt", b"active\n");
    let mut active_left = request(PROJECT_B, "active-race-left01", &active_body);
    active_left.expected_project_version = ProjectVersion::new(2).unwrap();
    active_left.expected_logical_bytes = 7;
    active_left.expected_file_count = 1;
    let mut active_right = active_left.clone();
    active_right.idempotency_key = IdempotencyKey::new("active-race-right1".to_owned()).unwrap();
    let (active_left, active_right) =
        tokio::join!(creator.create(active_left), creator.create(active_right));
    assert_ne!(active_left.is_ok(), active_right.is_ok());
}

#[tokio::test]
#[ignore = "requires tests/fixtures/save-http/run.sh"]
async fn save_http_is_authorized_restart_stable_and_commits_the_working_head() {
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
    for user in [USER, OUTSIDER] {
        sqlx::query(
            "INSERT INTO local_password_credentials (user_id,password_verifier) VALUES ($1::uuid,$2)",
        )
        .bind(user)
        .bind(TEST_PASSWORD_HASH)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }

    let secret = IdempotencySecret::new([0x79; 32]).unwrap();
    let router = save_http_router(pool.clone(), store.clone(), secret.clone())
        .await
        .unwrap();
    let owner = version_login(&router, "save@example.test").await;
    let outsider = version_login(&router, "outside@example.test").await;
    let content = b"saved through HTTP\n";
    let bundle = canonical_test_bundle(PROJECT_A, SCOPE, "saved.txt", content);
    let uri = format!("/api/v1/workspaces/users/{USER}/projects/{PROJECT_A}/save-sessions");
    let request_body = json!({
        "physicalBytes": bundle.len(),
        "logicalBytes": content.len(),
        "fileCount": 1,
        "sha256": BASE64.encode(Sha256::digest(&bundle)),
        "parts": []
    });
    let created = version_json_request(
        &router,
        &owner,
        Method::POST,
        &uri,
        Some("\"project-v1\""),
        Some("save-http-restart-0001"),
        request_body.clone(),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()["cache-control"], "private, no-store");
    let created = version_response_json(created).await;
    assert_eq!(created["uploadMode"], "single");
    assert_eq!(created["idempotentRetry"], false);
    assert_eq!(created["partCount"], 1);
    let session_id = created["sessionId"].as_str().unwrap().to_owned();

    // Rebuild every HTTP service around the same persistent database and
    // stable secret. The replay must resolve to the original session.
    let restarted = save_http_router(pool.clone(), store.clone(), secret.clone())
        .await
        .unwrap();
    let replay = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &uri,
        Some("\"project-v1\""),
        Some("save-http-restart-0001"),
        request_body.clone(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::OK);
    let replay = version_response_json(replay).await;
    assert_eq!(replay["sessionId"], session_id);
    assert_eq!(replay["idempotentRetry"], true);

    // A changed secret is rejected while assembling the replacement service,
    // before a router can accept traffic.
    assert!(matches!(
        save_http_service(
            pool.clone(),
            store.clone(),
            IdempotencySecret::new([0x7a; 32]).unwrap()
        )
        .await,
        Err(SaveHttpError::Internal)
    ));

    let upload = replay["upload"].as_object().unwrap();
    let mut put = fixture_http_client(&ca_file)
        .put(upload["url"].as_str().unwrap())
        .header(ORIGIN, WEB_ORIGIN);
    for header in upload["headers"].as_array().unwrap() {
        put = put.header(
            header["name"].as_str().unwrap(),
            header["value"].as_str().unwrap(),
        );
    }
    assert!(put.body(bundle).send().await.unwrap().status().is_success());

    let complete_uri = format!("{uri}/{session_id}/complete");
    let completed = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &complete_uri,
        None,
        None,
        json!({"uploadMode":"single"}),
    )
    .await;
    assert_eq!(completed.status(), StatusCode::OK);
    assert_eq!(completed.headers()[ETAG], "\"project-v2\"");
    assert_eq!(completed.headers()["cache-control"], "private, no-store");
    let completed = version_response_json(completed).await;
    assert_eq!(completed["projectVersion"], 2);
    let committed_bundle = completed["bundleId"].as_str().unwrap().to_owned();

    let completed_retry = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &complete_uri,
        None,
        None,
        json!({"uploadMode":"single"}),
    )
    .await;
    assert_eq!(completed_retry.status(), StatusCode::OK);
    assert_eq!(completed_retry.headers()[ETAG], "\"project-v2\"");
    assert_eq!(version_response_json(completed_retry).await, completed);

    // Advance the Project after the first Save. Reconciliation of that older
    // session must still return the version produced by the session, not the
    // Project's newer lock version.
    let next_content = b"saved through HTTP again\n";
    let next_bundle = canonical_test_bundle(PROJECT_A, SCOPE, "saved-again.txt", next_content);
    let next_request_body = json!({
        "physicalBytes": next_bundle.len(),
        "logicalBytes": next_content.len(),
        "fileCount": 1,
        "sha256": BASE64.encode(Sha256::digest(&next_bundle)),
        "parts": []
    });
    let next_created = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &uri,
        Some("\"project-v2\""),
        Some("save-http-advance-0001"),
        next_request_body,
    )
    .await;
    assert_eq!(next_created.status(), StatusCode::CREATED);
    let next_created = version_response_json(next_created).await;
    let next_session_id = next_created["sessionId"].as_str().unwrap();
    let next_upload = next_created["upload"].as_object().unwrap();
    let mut next_put = fixture_http_client(&ca_file)
        .put(next_upload["url"].as_str().unwrap())
        .header(ORIGIN, WEB_ORIGIN);
    for header in next_upload["headers"].as_array().unwrap() {
        next_put = next_put.header(
            header["name"].as_str().unwrap(),
            header["value"].as_str().unwrap(),
        );
    }
    assert!(
        next_put
            .body(next_bundle)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    let next_completed = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &format!("{uri}/{next_session_id}/complete"),
        None,
        None,
        json!({"uploadMode":"single"}),
    )
    .await;
    assert_eq!(next_completed.status(), StatusCode::OK);
    assert_eq!(
        version_response_json(next_completed).await["projectVersion"],
        3
    );

    let reconciled = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &format!("{uri}/{session_id}/reconcile"),
        None,
        None,
        json!({}),
    )
    .await;
    assert_eq!(reconciled.status(), StatusCode::OK);
    let reconciled = version_response_json(reconciled).await;
    assert_eq!(reconciled["state"], "committed");
    assert_eq!(reconciled["bundleId"], committed_bundle);
    assert_eq!(reconciled["projectVersion"], 2);

    // Exercise the same retry contract for a multipart session. The domain
    // setup uses the production 8 MiB part floor to keep this live fixture
    // bounded; HTTP owns multipart completion, verification, and commit.
    let multipart_content = vec![0x6d; 8 * 1024 * 1024];
    let multipart_bundle =
        canonical_test_bundle(PROJECT_B, SCOPE, "multipart.bin", &multipart_content);
    let multipart_bodies = multipart_bundle
        .chunks(8 * 1024 * 1024)
        .map(Bytes::copy_from_slice)
        .collect::<Vec<_>>();
    let mut multipart_request =
        multipart_request(PROJECT_B, "save-http-multipart-0001", &multipart_bodies);
    multipart_request.expected_logical_bytes = multipart_content.len() as u64;
    multipart_request.expected_file_count = 1;
    multipart_request.expected_sha256 = Sha256Checksum::calculate(&multipart_bundle);
    multipart_request.effective_quota = EffectiveQuota::limited(10 * 1024 * 1024 * 1024).unwrap();
    let multipart_plans = multipart_request.parts.clone();
    let multipart_service = MultipartService::new(
        pool.clone(),
        store,
        MultipartServicePolicy::new(
            Duration::from_secs(10),
            5,
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            4,
        )
        .unwrap(),
        secret,
    )
    .unwrap();
    let multipart_session = multipart_service.create(multipart_request).await.unwrap();
    let multipart_context = MultipartSessionContext {
        storage_scope_id: StorageScopeId::from_str(SCOPE).unwrap(),
        project_id: ProjectId::from_str(PROJECT_B).unwrap(),
        actor_user_id: UserId::from_str(USER).unwrap(),
        session_id: multipart_session.session_id(),
    };
    let multipart_capabilities = multipart_service
        .issue_parts(multipart_context, multipart_plans.clone())
        .await
        .unwrap();
    let multipart_client = fixture_http_client(&ca_file);
    let mut multipart_receipts = Vec::new();
    for ((capability, plan), body) in multipart_capabilities
        .iter()
        .zip(&multipart_plans)
        .zip(&multipart_bodies)
    {
        let etag = send_multipart_part(&multipart_client, capability.request(), body)
            .await
            .unwrap();
        multipart_receipts.push(json!({
            "partNumber": plan.part_number(),
            "expectedBytes": plan.expected_bytes(),
            "sha256": BASE64.encode(Sha256::digest(body)),
            "etag": etag,
        }));
    }
    let direct_receipts = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &format!(
            "/api/v1/workspaces/users/{USER}/projects/{PROJECT_B}/save-sessions/{}/parts/receipts",
            multipart_session.session_id()
        ),
        None,
        None,
        json!({"receipts": multipart_receipts}),
    )
    .await;
    assert_eq!(direct_receipts.status(), StatusCode::NO_CONTENT);
    let multipart_complete_uri = format!(
        "/api/v1/workspaces/users/{USER}/projects/{PROJECT_B}/save-sessions/{}/complete",
        multipart_session.session_id()
    );
    let multipart_completed = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &multipart_complete_uri,
        None,
        None,
        json!({"uploadMode":"multipart"}),
    )
    .await;
    assert_eq!(multipart_completed.status(), StatusCode::OK);
    assert_eq!(multipart_completed.headers()[ETAG], "\"project-v2\"");
    let multipart_completed = version_response_json(multipart_completed).await;
    let multipart_completed_retry = version_json_request(
        &restarted,
        &owner,
        Method::POST,
        &multipart_complete_uri,
        None,
        None,
        json!({"uploadMode":"multipart"}),
    )
    .await;
    assert_eq!(multipart_completed_retry.status(), StatusCode::OK);
    assert_eq!(multipart_completed_retry.headers()[ETAG], "\"project-v2\"");
    assert_eq!(
        version_response_json(multipart_completed_retry).await,
        multipart_completed
    );

    let outsider_response = version_json_request(
        &restarted,
        &outsider,
        Method::POST,
        &uri,
        Some("\"project-v2\""),
        Some("save-http-outsider-0001"),
        request_body,
    )
    .await;
    assert_eq!(outsider_response.status(), StatusCode::NOT_FOUND);
    let serialized = version_response_json(outsider_response).await.to_string();
    for secret_value in [SECRET_KEY, "save-http-outsider-0001", "X-Amz-Signature"] {
        assert!(!serialized.contains(secret_value));
    }
}

#[tokio::test]
#[ignore = "requires tests/fixtures/authenticated-upload-relay/run.sh"]
async fn authenticated_upload_relay_streams_single_and_multipart_without_bearer_exposure() {
    let captured_logs = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log_subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(CapturedLogWriter(captured_logs.clone()))
        .finish();
    let _log_guard = tracing::subscriber::set_default(log_subscriber);
    let mut failure_problems = Vec::new();
    let mut capability_checksums = Vec::new();
    let pool = fixture_pool().await;
    reset_and_seed(&pool).await;
    let endpoint = env::var(S3_ENDPOINT_ENV).unwrap();
    let ca_file = env::var(S3_CA_ENV).unwrap();
    create_bucket(&endpoint, &ca_file).await;
    let config = ObjectStorageConfig::load(
        &FixtureEnvironment {
            endpoint: endpoint.clone(),
            ca_file,
        },
        &SystemFileReader,
    )
    .unwrap();
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap();
    for user in [USER, OUTSIDER, ORG_OWNER, ORG_WRITE] {
        sqlx::query(
            "INSERT INTO local_password_credentials (user_id,password_verifier) VALUES ($1::uuid,$2)",
        )
        .bind(user)
        .bind(TEST_PASSWORD_HASH)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }

    let secret = IdempotencySecret::new([0x7b; 32]).unwrap();
    let router = save_http_router_with_transport(
        pool.clone(),
        store.clone(),
        secret.clone(),
        SaveUploadTransport::Relay,
    )
    .await
    .unwrap();
    let owner = version_login(&router, "save@example.test").await;
    let outsider = version_login(&router, "outside@example.test").await;
    let organization_owner = version_login(&router, "org-owner@example.test").await;
    let organization_writer = version_login(&router, "org-write@example.test").await;

    let content = b"private relay single\n";
    let single_bundle = canonical_test_bundle(PROJECT_A, SCOPE, "single.txt", content);
    let single_collection =
        format!("/api/v1/workspaces/users/{USER}/projects/{PROJECT_A}/save-sessions");
    let single_created = version_json_request(
        &router,
        &owner,
        Method::POST,
        &single_collection,
        Some("\"project-v1\""),
        Some("relay-single-create-0001"),
        json!({
            "physicalBytes": single_bundle.len(),
            "logicalBytes": content.len(),
            "fileCount": 1,
            "sha256": BASE64.encode(Sha256::digest(&single_bundle)),
            "parts": []
        }),
    )
    .await;
    assert_eq!(single_created.status(), StatusCode::CREATED);
    let single_created = version_response_json(single_created).await;
    let single_session = single_created["sessionId"].as_str().unwrap();
    let single_capability = &single_created["upload"];
    append_capability_checksums(&mut capability_checksums, single_capability);
    assert_eq!(single_capability["transport"], "relay");
    assert_eq!(single_capability["method"], "PUT");
    assert!(single_capability.get("url").is_none());
    assert_eq!(single_capability["expectedBytes"], single_bundle.len());
    assert_relay_projection_is_private(
        &single_created,
        &[
            &endpoint, ACCESS_KEY, SECRET_KEY, SCOPE, "staging/", "X-Amz-",
        ],
    );

    // Authorization, transport mode, metadata, and session state are all
    // rejected before the request body can be polled.
    let wrong_length = relay_put_request(
        single_capability,
        &owner,
        Body::new(NeverReadBody),
        Some((single_bundle.len() as u64).saturating_add(1)),
        None,
    );
    capture_private_problem(
        router.clone().oneshot(wrong_length).await.unwrap(),
        StatusCode::UNPROCESSABLE_ENTITY,
        &mut failure_problems,
    )
    .await;
    let wrong_checksum = relay_put_request(
        single_capability,
        &owner,
        Body::new(NeverReadBody),
        None,
        Some(BASE64.encode([0x99; 32])),
    );
    capture_private_problem(
        router.clone().oneshot(wrong_checksum).await.unwrap(),
        StatusCode::UNPROCESSABLE_ENTITY,
        &mut failure_problems,
    )
    .await;
    let cross_actor = relay_put_request(
        single_capability,
        &outsider,
        Body::new(NeverReadBody),
        None,
        None,
    );
    capture_private_problem(
        router.clone().oneshot(cross_actor).await.unwrap(),
        StatusCode::NOT_FOUND,
        &mut failure_problems,
    )
    .await;
    let direct_router = save_http_router_with_transport(
        pool.clone(),
        store.clone(),
        secret.clone(),
        SaveUploadTransport::Direct,
    )
    .await
    .unwrap();
    let direct_mode = relay_put_request(
        single_capability,
        &owner,
        Body::new(NeverReadBody),
        None,
        None,
    );
    capture_private_problem(
        direct_router.oneshot(direct_mode).await.unwrap(),
        StatusCode::NOT_FOUND,
        &mut failure_problems,
    )
    .await;

    let revoked = create_organization_relay_session(
        &router,
        &organization_writer,
        ORG_PROJECT_WRITE,
        "relay-role-race-000001",
    )
    .await;
    let mut scope_blocker = pool.acquire().await.unwrap();
    let mut scope_transaction = scope_blocker.begin().await.unwrap();
    sqlx::query("SELECT id FROM storage_scopes WHERE id=$1::uuid FOR UPDATE")
        .bind(ORG_SCOPE)
        .execute(&mut *scope_transaction)
        .await
        .unwrap();
    let revoked_request = relay_put_request(
        &revoked["upload"],
        &organization_writer,
        Body::new(NeverReadBody),
        None,
        None,
    );
    let revoked_upload = tokio::spawn(router.clone().oneshot(revoked_request));
    wait_for_relay_scope_lock_wait(&pool).await;
    sqlx::query("DELETE FROM project_user_roles WHERE project_id=$1::uuid AND user_id=$2::uuid")
        .bind(ORG_PROJECT_WRITE)
        .bind(ORG_WRITE)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    scope_transaction.commit().await.unwrap();
    capture_private_problem(
        revoked_upload.await.unwrap().unwrap(),
        StatusCode::NOT_FOUND,
        &mut failure_problems,
    )
    .await;

    let archived_race = create_organization_relay_session(
        &router,
        &organization_owner,
        ORG_PROJECT_OWNER,
        "relay-archive-race-0001",
    )
    .await;
    let mut scope_blocker = pool.acquire().await.unwrap();
    let mut scope_transaction = scope_blocker.begin().await.unwrap();
    sqlx::query("SELECT id FROM storage_scopes WHERE id=$1::uuid FOR UPDATE")
        .bind(ORG_SCOPE)
        .execute(&mut *scope_transaction)
        .await
        .unwrap();
    let archived_request = relay_put_request(
        &archived_race["upload"],
        &organization_owner,
        Body::new(NeverReadBody),
        None,
        None,
    );
    let archived_upload = tokio::spawn(router.clone().oneshot(archived_request));
    wait_for_relay_scope_lock_wait(&pool).await;
    sqlx::query(
        "UPDATE projects SET state='archived',archived_at=transaction_timestamp(),\
         updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(ORG_PROJECT_OWNER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    scope_transaction.commit().await.unwrap();
    capture_private_problem(
        archived_upload.await.unwrap().unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;

    let uploaded = router
        .clone()
        .oneshot(relay_put_request(
            single_capability,
            &owner,
            Body::from(single_bundle.clone()),
            None,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(uploaded.status(), StatusCode::NO_CONTENT);
    let single_completed = version_json_request(
        &router,
        &owner,
        Method::POST,
        &format!("{single_collection}/{single_session}/complete"),
        None,
        None,
        json!({"uploadMode":"single"}),
    )
    .await;
    assert_eq!(single_completed.status(), StatusCode::OK);
    assert_eq!(
        download_current_content(&router, &owner, PROJECT_A, single_bundle.len()).await,
        single_bundle
    );
    let terminal_retry = relay_put_request(
        single_capability,
        &owner,
        Body::new(NeverReadBody),
        None,
        None,
    );
    capture_private_problem(
        router.clone().oneshot(terminal_retry).await.unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;

    let multipart_files = (0..5)
        .map(|index| {
            (
                format!("part-{index:02}.bin"),
                vec![0x4d_u8.saturating_add(index); 13 * 1024 * 1024],
            )
        })
        .collect::<Vec<_>>();
    let multipart_logical_bytes = multipart_files
        .iter()
        .map(|(_, body)| body.len())
        .sum::<usize>();
    let multipart_bundle = canonical_multi_file_bundle(PROJECT_B, SCOPE, &multipart_files);
    let multipart_parts = multipart_bundle
        .chunks(16 * 1024 * 1024)
        .enumerate()
        .map(|(index, body)| {
            json!({
                "partNumber": index + 1,
                "expectedBytes": body.len(),
                "sha256": BASE64.encode(Sha256::digest(body))
            })
        })
        .collect::<Vec<_>>();
    let multipart_collection =
        format!("/api/v1/workspaces/users/{USER}/projects/{PROJECT_B}/save-sessions");
    let multipart_created = version_json_request(
        &router,
        &owner,
        Method::POST,
        &multipart_collection,
        Some("\"project-v1\""),
        Some("relay-multipart-create-0001"),
        json!({
            "physicalBytes": multipart_bundle.len(),
            "logicalBytes": multipart_logical_bytes,
            "fileCount": multipart_files.len(),
            "sha256": BASE64.encode(Sha256::digest(&multipart_bundle)),
            "parts": multipart_parts
        }),
    )
    .await;
    assert_eq!(multipart_created.status(), StatusCode::CREATED);
    let multipart_created = version_response_json(multipart_created).await;
    assert!(multipart_created["upload"].is_null());
    let multipart_session = multipart_created["sessionId"].as_str().unwrap();
    let issue_uri = format!("{multipart_collection}/{multipart_session}/parts");
    let capabilities = version_json_request(
        &router,
        &owner,
        Method::POST,
        &issue_uri,
        None,
        None,
        json!({"parts": multipart_parts}),
    )
    .await;
    assert_eq!(capabilities.status(), StatusCode::OK);
    let capabilities = version_response_json(capabilities).await;
    let capabilities = capabilities.as_array().unwrap();
    for capability in capabilities {
        append_capability_checksums(&mut capability_checksums, capability);
    }
    assert_eq!(capabilities.len(), multipart_parts.len());
    assert_relay_projection_is_private(
        &Value::Array(capabilities.clone()),
        &[
            &endpoint, ACCESS_KEY, SECRET_KEY, SCOPE, "staging/", "X-Amz-",
        ],
    );
    let poisoned_receipt = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "{multipart_collection}/{multipart_session}/parts/receipts"
                ))
                .header(CONTENT_TYPE, "application/json")
                .header("content-length", "999999999")
                .header(ORIGIN, WEB_ORIGIN)
                .header(COOKIE, &owner.cookie)
                .header("x-csrf-token", &owner.csrf)
                .body(Body::new(NeverReadBody))
                .unwrap(),
        )
        .await
        .unwrap();
    capture_private_problem(
        poisoned_receipt,
        StatusCode::NOT_FOUND,
        &mut failure_problems,
    )
    .await;
    let pending_after_poison: (String, Option<String>) = sqlx::query_as(
        "SELECT state,object_etag FROM multipart_parts \
         WHERE save_session_id=$1::uuid AND part_number=1",
    )
    .bind(multipart_session)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(pending_after_poison, ("pending".to_owned(), None));
    let mut wrong_part = capabilities[0].clone();
    let wrong_part_path = wrong_part["path"]
        .as_str()
        .unwrap()
        .rsplit_once('/')
        .map(|(prefix, _)| format!("{prefix}/99"))
        .unwrap();
    wrong_part["path"] = Value::String(wrong_part_path);
    capture_private_problem(
        router
            .clone()
            .oneshot(relay_put_request(
                &wrong_part,
                &owner,
                Body::new(NeverReadBody),
                None,
                None,
            ))
            .await
            .unwrap(),
        StatusCode::NOT_FOUND,
        &mut failure_problems,
    )
    .await;
    let first_relay_body_polled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_address = listener.local_addr().unwrap();
    let (relay_shutdown, relay_shutdown_rx) = tokio::sync::oneshot::channel();
    let relay_server = tokio::spawn({
        let router = router.clone();
        async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = relay_shutdown_rx.await;
                })
                .await
        }
    });
    for (index, (capability, body)) in capabilities
        .iter()
        .zip(multipart_bundle.chunks(16 * 1024 * 1024))
        .enumerate()
    {
        assert_eq!(capability["transport"], "relay");
        let status = if index == 1 {
            relay_put_over_http(relay_address, capability, &owner, body).await
        } else {
            let request_body = if index == 0 {
                Body::new(ObservedFrameBody::new(
                    body,
                    first_relay_body_polled.clone(),
                ))
            } else {
                Body::new(BoundedFrameBody::new(body))
            };
            router
                .clone()
                .oneshot(relay_put_request(
                    capability,
                    &owner,
                    request_body,
                    None,
                    None,
                ))
                .await
                .unwrap()
                .status()
        };
        assert_eq!(status, StatusCode::NO_CONTENT);
        if index == 0 {
            assert!(
                first_relay_body_polled.load(std::sync::atomic::Ordering::SeqCst),
                "relay receipt rejection must leave the part pending for a real S3 upload"
            );
            let original_etag: String = sqlx::query_scalar(
                "SELECT object_etag FROM multipart_parts WHERE save_session_id=$1::uuid \
                 AND part_number=1",
            )
            .bind(multipart_session)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
            let mut connection = pool.acquire().await.unwrap();
            connection
                .execute(
                    "ALTER TABLE multipart_parts DISABLE TRIGGER multipart_parts_write_invariants",
                )
                .await
                .unwrap();
            sqlx::query(
                "UPDATE multipart_parts SET object_etag='persisted-first-etag' \
                 WHERE save_session_id=$1::uuid AND part_number=1",
            )
            .bind(multipart_session)
            .execute(&mut *connection)
            .await
            .unwrap();
            connection
                .execute(
                    "ALTER TABLE multipart_parts ENABLE TRIGGER multipart_parts_write_invariants",
                )
                .await
                .unwrap();
            assert_eq!(
                router
                    .clone()
                    .oneshot(relay_put_request(
                        capability,
                        &owner,
                        Body::new(NeverReadBody),
                        None,
                        None,
                    ))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NO_CONTENT
            );
            let persisted_etag: String = sqlx::query_scalar(
                "SELECT object_etag FROM multipart_parts WHERE save_session_id=$1::uuid \
                 AND part_number=1",
            )
            .bind(multipart_session)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
            assert_eq!(persisted_etag, "persisted-first-etag");
            connection
                .execute(
                    "ALTER TABLE multipart_parts DISABLE TRIGGER multipart_parts_write_invariants",
                )
                .await
                .unwrap();
            sqlx::query(
                "UPDATE multipart_parts SET object_etag=$2 WHERE save_session_id=$1::uuid \
                 AND part_number=1",
            )
            .bind(multipart_session)
            .bind(original_etag)
            .execute(&mut *connection)
            .await
            .unwrap();
            connection
                .execute(
                    "ALTER TABLE multipart_parts ENABLE TRIGGER multipart_parts_write_invariants",
                )
                .await
                .unwrap();
        }
    }
    relay_shutdown.send(()).unwrap();
    relay_server.await.unwrap().unwrap();
    let multipart_completed = version_json_request(
        &router,
        &owner,
        Method::POST,
        &format!("{multipart_collection}/{multipart_session}/complete"),
        None,
        None,
        json!({"uploadMode":"multipart"}),
    )
    .await;
    assert_eq!(multipart_completed.status(), StatusCode::OK);
    assert_eq!(
        download_current_content(&router, &owner, PROJECT_B, multipart_bundle.len()).await,
        multipart_bundle
    );

    let restarted_router = save_http_router_with_transport(
        pool.clone(),
        store.clone(),
        secret.clone(),
        SaveUploadTransport::Relay,
    )
    .await
    .unwrap();

    let (abort_race, abort_bundle, abort_collection) = create_relay_single_session(
        &router,
        &owner,
        PROJECT_LEASE_ABORT,
        "relay-lease-abort-0001",
        "abort.txt",
    )
    .await;
    let abort_session = abort_race["sessionId"].as_str().unwrap().to_owned();
    let (abort_sender, abort_body) = gated_frame_body(abort_bundle.len());
    let abort_upload = tokio::spawn(router.clone().oneshot(relay_put_request(
        &abort_race["upload"],
        &owner,
        abort_body,
        None,
        None,
    )));
    wait_for_active_relay_lease(&pool, &abort_session, 0).await;
    let abort_while_uploading = version_empty_mutation(
        &restarted_router,
        &owner,
        Method::DELETE,
        &format!("{abort_collection}/{abort_session}"),
    )
    .await;
    capture_private_problem(
        abort_while_uploading,
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;
    send_bounded_frames(abort_sender, &abort_bundle).await;
    assert_eq!(
        abort_upload.await.unwrap().unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert_released_relay_generation(&pool, &abort_session, 0, 1).await;
    assert_eq!(
        version_json_request(
            &router,
            &owner,
            Method::POST,
            &format!("{abort_collection}/{abort_session}/complete"),
            None,
            None,
            json!({"uploadMode":"single"}),
        )
        .await
        .status(),
        StatusCode::OK
    );

    let (complete_race, complete_bundle, complete_collection) = create_relay_single_session(
        &router,
        &owner,
        PROJECT_LEASE_COMPLETE,
        "relay-lease-complete-01",
        "complete.txt",
    )
    .await;
    let complete_session = complete_race["sessionId"].as_str().unwrap().to_owned();
    let (complete_sender, complete_body) = gated_frame_body(complete_bundle.len());
    let complete_upload = tokio::spawn(router.clone().oneshot(relay_put_request(
        &complete_race["upload"],
        &owner,
        complete_body,
        None,
        None,
    )));
    wait_for_active_relay_lease(&pool, &complete_session, 0).await;
    capture_private_problem(
        version_json_request(
            &restarted_router,
            &owner,
            Method::POST,
            &format!("{complete_collection}/{complete_session}/complete"),
            None,
            None,
            json!({"uploadMode":"single"}),
        )
        .await,
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;
    send_bounded_frames(complete_sender, &complete_bundle).await;
    assert_eq!(
        complete_upload.await.unwrap().unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        version_json_request(
            &router,
            &owner,
            Method::POST,
            &format!("{complete_collection}/{complete_session}/complete"),
            None,
            None,
            json!({"uploadMode":"single"}),
        )
        .await
        .status(),
        StatusCode::OK
    );

    let (clock_race, clock_bundle, clock_collection) = create_relay_single_session(
        &router,
        &owner,
        PROJECT_LEASE_CLOCK,
        "relay-lease-clock-00001",
        "clock.txt",
    )
    .await;
    let clock_session = clock_race["sessionId"].as_str().unwrap().to_owned();
    let mut clock_blocker = pool.acquire().await.unwrap();
    let mut clock_transaction = clock_blocker.begin().await.unwrap();
    sqlx::query("SELECT id FROM storage_scopes WHERE id=$1::uuid FOR UPDATE")
        .bind(SCOPE)
        .execute(&mut *clock_transaction)
        .await
        .unwrap();
    let (clock_sender, clock_body) = gated_frame_body(clock_bundle.len());
    let clock_upload = tokio::spawn(router.clone().oneshot(relay_put_request(
        &clock_race["upload"],
        &owner,
        clock_body,
        None,
        None,
    )));
    wait_for_relay_scope_lock_wait(&pool).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    clock_transaction.commit().await.unwrap();
    wait_for_active_relay_lease(&pool, &clock_session, 0).await;
    let remaining_lease_seconds: f64 = sqlx::query_scalar(
        "SELECT extract(epoch FROM lease_expires_at-clock_timestamp())::float8 \
         FROM save_upload_leases WHERE save_session_id=$1::uuid AND part_number=0",
    )
    .bind(&clock_session)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        remaining_lease_seconds > 39.0,
        "lease must retain its 40 second stream/finalize/grace budget after lock acquisition"
    );
    send_bounded_frames(clock_sender, &clock_bundle).await;
    assert_eq!(
        clock_upload.await.unwrap().unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        version_json_request(
            &router,
            &owner,
            Method::POST,
            &format!("{clock_collection}/{clock_session}/complete"),
            None,
            None,
            json!({"uploadMode":"single"}),
        )
        .await
        .status(),
        StatusCode::OK
    );

    let (expiry_race, expiry_bundle, expiry_collection) = create_relay_single_session(
        &router,
        &owner,
        PROJECT_LEASE_EXPIRE,
        "relay-lease-expiry-0001",
        "expiry.txt",
    )
    .await;
    let expiry_session = expiry_race["sessionId"].as_str().unwrap().to_owned();
    let (expiry_sender, expiry_body) = gated_frame_body(expiry_bundle.len());
    let expiry_upload = tokio::spawn(router.clone().oneshot(relay_put_request(
        &expiry_race["upload"],
        &owner,
        expiry_body,
        None,
        None,
    )));
    wait_for_active_relay_lease(&pool, &expiry_session, 0).await;
    force_session_expiry(
        &pool,
        &expiry_session,
        "created_at + interval '1 microsecond'",
    )
    .await;
    capture_private_problem(
        version_empty_mutation(
            &restarted_router,
            &owner,
            Method::DELETE,
            &format!("{expiry_collection}/{expiry_session}"),
        )
        .await,
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;
    send_bounded_frames(expiry_sender, &expiry_bundle).await;
    capture_private_problem(
        expiry_upload.await.unwrap().unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;
    let expiry_state: (String, i64) = sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM save_cleanup_jobs job \
         WHERE job.save_session_id=save_sessions.id) FROM save_sessions WHERE id=$1::uuid",
    )
    .bind(&expiry_session)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(expiry_state, ("expired".to_owned(), 1));
    assert_released_relay_generation(&pool, &expiry_session, 0, 1).await;

    let revoke_multi = create_relay_multipart_session(
        &router,
        &organization_writer,
        "organizations",
        ORG,
        ORG_PROJECT_MULTI_REVOKE,
        "relay-multi-revoke-0001",
    )
    .await;
    for capability in &revoke_multi.capabilities {
        append_capability_checksums(&mut capability_checksums, capability);
    }
    let (revoke_sender_one, revoke_body_one) = gated_frame_body(revoke_multi.bodies[0].len());
    let (revoke_sender_two, revoke_body_two) = gated_frame_body(revoke_multi.bodies[1].len());
    let revoke_upload_one = tokio::spawn(router.clone().oneshot(relay_put_request(
        &revoke_multi.capabilities[0],
        &organization_writer,
        revoke_body_one,
        None,
        None,
    )));
    let revoke_upload_two = tokio::spawn(router.clone().oneshot(relay_put_request(
        &revoke_multi.capabilities[1],
        &organization_writer,
        revoke_body_two,
        None,
        None,
    )));
    wait_for_active_relay_lease(&pool, &revoke_multi.session_id, 1).await;
    wait_for_active_relay_lease(&pool, &revoke_multi.session_id, 2).await;
    sqlx::query("DELETE FROM project_user_roles WHERE project_id=$1::uuid AND user_id=$2::uuid")
        .bind(ORG_PROJECT_MULTI_REVOKE)
        .bind(ORG_WRITE)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    tokio::join!(
        send_bounded_frames(revoke_sender_one, &revoke_multi.bodies[0]),
        send_bounded_frames(revoke_sender_two, &revoke_multi.bodies[1])
    );
    capture_private_problem(
        revoke_upload_one.await.unwrap().unwrap(),
        StatusCode::NOT_FOUND,
        &mut failure_problems,
    )
    .await;
    capture_private_problem(
        revoke_upload_two.await.unwrap().unwrap(),
        StatusCode::NOT_FOUND,
        &mut failure_problems,
    )
    .await;
    assert_released_relay_generation(&pool, &revoke_multi.session_id, 1, 1).await;
    assert_released_relay_generation(&pool, &revoke_multi.session_id, 2, 1).await;
    assert_eq!(
        terminal_cleanup_state(&pool, revoke_multi.session_id.clone()).await,
        ("failed".to_owned(), 0, 1)
    );
    drop(revoke_multi);

    let archive_multi = create_relay_multipart_session(
        &router,
        &organization_owner,
        "organizations",
        ORG,
        ORG_PROJECT_MULTI_ARCHIVE,
        "relay-multi-archive-001",
    )
    .await;
    for capability in &archive_multi.capabilities {
        append_capability_checksums(&mut capability_checksums, capability);
    }
    let (archive_sender_one, archive_body_one) = gated_frame_body(archive_multi.bodies[0].len());
    let (archive_sender_two, archive_body_two) = gated_frame_body(archive_multi.bodies[1].len());
    let archive_upload_one = tokio::spawn(router.clone().oneshot(relay_put_request(
        &archive_multi.capabilities[0],
        &organization_owner,
        archive_body_one,
        None,
        None,
    )));
    let archive_upload_two = tokio::spawn(router.clone().oneshot(relay_put_request(
        &archive_multi.capabilities[1],
        &organization_owner,
        archive_body_two,
        None,
        None,
    )));
    wait_for_active_relay_lease(&pool, &archive_multi.session_id, 1).await;
    wait_for_active_relay_lease(&pool, &archive_multi.session_id, 2).await;
    sqlx::query(
        "UPDATE projects SET state='archived',archived_at=transaction_timestamp(), \
         updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(ORG_PROJECT_MULTI_ARCHIVE)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    tokio::join!(
        send_bounded_frames(archive_sender_one, &archive_multi.bodies[0]),
        send_bounded_frames(archive_sender_two, &archive_multi.bodies[1])
    );
    capture_private_problem(
        archive_upload_one.await.unwrap().unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;
    capture_private_problem(
        archive_upload_two.await.unwrap().unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;
    assert_released_relay_generation(&pool, &archive_multi.session_id, 1, 1).await;
    assert_released_relay_generation(&pool, &archive_multi.session_id, 2, 1).await;
    assert_eq!(
        terminal_cleanup_state(&pool, archive_multi.session_id.clone()).await,
        ("failed".to_owned(), 0, 1)
    );
    drop(archive_multi);

    let expiry_multi = create_relay_multipart_session(
        &router,
        &owner,
        "users",
        USER,
        PROJECT_MULTI_EXPIRY,
        "relay-multi-expiry-0001",
    )
    .await;
    for capability in &expiry_multi.capabilities {
        append_capability_checksums(&mut capability_checksums, capability);
    }
    let (multi_expiry_sender_one, multi_expiry_body_one) =
        gated_frame_body(expiry_multi.bodies[0].len());
    let (multi_expiry_sender_two, multi_expiry_body_two) =
        gated_frame_body(expiry_multi.bodies[1].len());
    let multi_expiry_upload_one = tokio::spawn(router.clone().oneshot(relay_put_request(
        &expiry_multi.capabilities[0],
        &owner,
        multi_expiry_body_one,
        None,
        None,
    )));
    let multi_expiry_upload_two = tokio::spawn(router.clone().oneshot(relay_put_request(
        &expiry_multi.capabilities[1],
        &owner,
        multi_expiry_body_two,
        None,
        None,
    )));
    wait_for_active_relay_lease(&pool, &expiry_multi.session_id, 1).await;
    wait_for_active_relay_lease(&pool, &expiry_multi.session_id, 2).await;
    force_session_expiry(
        &pool,
        &expiry_multi.session_id,
        "created_at + interval '1 microsecond'",
    )
    .await;
    tokio::join!(
        send_bounded_frames(multi_expiry_sender_one, &expiry_multi.bodies[0]),
        send_bounded_frames(multi_expiry_sender_two, &expiry_multi.bodies[1])
    );
    capture_private_problem(
        multi_expiry_upload_one.await.unwrap().unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;
    capture_private_problem(
        multi_expiry_upload_two.await.unwrap().unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;
    assert_released_relay_generation(&pool, &expiry_multi.session_id, 1, 1).await;
    assert_released_relay_generation(&pool, &expiry_multi.session_id, 2, 1).await;
    assert_eq!(
        terminal_cleanup_state(&pool, expiry_multi.session_id.clone()).await,
        ("expired".to_owned(), 0, 1)
    );
    drop(expiry_multi);

    let archived_content = b"archived relay\n";
    let archived_bundle =
        canonical_test_bundle(PROJECT_TIMEOUT, SCOPE, "archived.txt", archived_content);
    let archived_collection =
        format!("/api/v1/workspaces/users/{USER}/projects/{PROJECT_TIMEOUT}/save-sessions");
    let archived = version_json_request(
        &router,
        &owner,
        Method::POST,
        &archived_collection,
        Some("\"project-v1\""),
        Some("relay-archived-create-0001"),
        json!({
            "physicalBytes": archived_bundle.len(),
            "logicalBytes": archived_content.len(),
            "fileCount": 1,
            "sha256": BASE64.encode(Sha256::digest(&archived_bundle)),
            "parts": []
        }),
    )
    .await;
    assert_eq!(archived.status(), StatusCode::CREATED);
    let archived = version_response_json(archived).await;
    sqlx::query(
        "UPDATE projects SET state='archived',archived_at=transaction_timestamp(), \
         updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(PROJECT_TIMEOUT)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    capture_private_problem(
        router
            .clone()
            .oneshot(relay_put_request(
                &archived["upload"],
                &owner,
                Body::new(NeverReadBody),
                None,
                None,
            ))
            .await
            .unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;

    let expired_content = b"expired relay\n";
    let expired_bundle = canonical_test_bundle(PROJECT_FAIL, SCOPE, "expired.txt", expired_content);
    let expired_collection =
        format!("/api/v1/workspaces/users/{USER}/projects/{PROJECT_FAIL}/save-sessions");
    let expired = version_json_request(
        &router,
        &owner,
        Method::POST,
        &expired_collection,
        Some("\"project-v1\""),
        Some("relay-expired-create-0001"),
        json!({
            "physicalBytes": expired_bundle.len(),
            "logicalBytes": expired_content.len(),
            "fileCount": 1,
            "sha256": BASE64.encode(Sha256::digest(&expired_bundle)),
            "parts": []
        }),
    )
    .await;
    let expired = version_response_json(expired).await;
    force_session_expiry(
        &pool,
        expired["sessionId"].as_str().unwrap(),
        "created_at + interval '1 microsecond'",
    )
    .await;
    let expired_retry = relay_put_request(
        &expired["upload"],
        &owner,
        Body::new(NeverReadBody),
        None,
        None,
    );
    capture_private_problem(
        router.oneshot(expired_retry).await.unwrap(),
        StatusCode::CONFLICT,
        &mut failure_problems,
    )
    .await;

    let persisted_secrets: Vec<PersistedRelaySecretRow> = sqlx::query_as(
        "SELECT staging_object_key,idempotency_digest,expected_bundle_sha256,multipart_upload_id \
         FROM save_sessions ORDER BY id",
    )
    .fetch_all(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let lease_tokens: Vec<String> = sqlx::query_scalar(
        "SELECT lease_token::text FROM save_upload_leases ORDER BY save_session_id,part_number",
    )
    .fetch_all(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let mut sensitive = vec![ACCESS_KEY.to_owned(), SECRET_KEY.to_owned()];
    for (object_key, idempotency_digest, bundle_digest, upload_id) in persisted_secrets {
        sensitive.push(object_key);
        if let Some(upload_id) = upload_id {
            sensitive.push(upload_id);
        }
        append_digest_renderings(&mut sensitive, &idempotency_digest);
        append_digest_renderings(&mut sensitive, &bundle_digest);
    }
    sensitive.extend(lease_tokens);
    for browser in [&owner, &outsider, &organization_owner, &organization_writer] {
        sensitive.push(browser.cookie.clone());
        sensitive.push(browser.csrf.clone());
        for pair in browser.cookie.split("; ") {
            sensitive.push(pair.to_owned());
            if let Some((_, value)) = pair.split_once('=') {
                sensitive.push(value.to_owned());
            }
        }
    }
    sensitive.extend(capability_checksums);
    for problem in &failure_problems {
        assert_no_normalized_sensitive_leak(problem, &sensitive);
    }
    let rendered_logs = String::from_utf8(captured_logs.lock().unwrap().clone()).unwrap();
    assert!(
        !rendered_logs.is_empty(),
        "failure path must emit captured logs"
    );
    assert_no_normalized_sensitive_leak(&rendered_logs, &sensitive);
}

#[tokio::test]
#[ignore = "requires tests/fixtures/project-versions/run.sh"]
async fn explicit_project_versions_are_immutable_authorized_and_gc_safe() {
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
    let creator = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x68; 32]).unwrap(),
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
    let http = fixture_http_client(&ca_file);

    let first_body = canonical_test_bundle(PROJECT_A, SCOPE, "versioned.txt", b"version one\n");
    let mut first_request = request(PROJECT_A, "version-head-first1", &first_body);
    first_request.expected_logical_bytes = 12;
    first_request.expected_file_count = 1;
    let first_session = creator.create(first_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            first_session.capability().request(),
            &first_body,
            None,
            None,
        )
        .await
    );
    let first_capability = verifier
        .verify(verification_context(PROJECT_A, first_session.session_id()))
        .await
        .unwrap();
    let first_head = committer.commit(&first_capability).await.unwrap();
    assert_eq!(first_head.project_version().get(), 2);

    let version_request = CreateProjectVersion {
        owner: ProjectOwner::User(UserId::from_str(USER).unwrap()),
        project_id: ProjectId::from_str(PROJECT_A).unwrap(),
        actor_user_id: UserId::from_str(USER).unwrap(),
        expected_project_version: ProjectVersion::new(2).unwrap(),
        name: ProjectVersionName::new("Release One".to_owned()).unwrap(),
        idempotency_key: IdempotencyKey::new("explicit-version-key-0001".to_owned()).unwrap(),
    };
    let (left, right) = tokio::join!(
        versions.create(version_request.clone()),
        versions.create(version_request.clone())
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left.version(), right.version());
    assert_ne!(left.is_idempotent_retry(), right.is_idempotent_retry());
    assert_eq!(
        left.version().project_id(),
        ProjectId::from_str(PROJECT_A).unwrap()
    );
    assert_eq!(left.version().bundle_id(), first_head.bundle_id());
    assert_eq!(left.version().name().as_str(), "Release One");
    assert_eq!(
        left.version().actor_user_id(),
        UserId::from_str(USER).unwrap()
    );
    assert_eq!(left.version().source_project_version().get(), 2);
    let expected_sha256: [u8; 32] = Sha256::digest(&first_body).into();
    assert_eq!(left.version().sha256(), &expected_sha256);
    assert_eq!(left.version().physical_bytes(), first_body.len() as u64);
    assert_eq!(left.version().logical_bytes(), 12);
    assert_eq!(left.version().file_count(), 1);
    assert_eq!(left.version().format(), "project-bundle-v1");
    let digest_storage: (i32, bool) = sqlx::query_as(
        "SELECT octet_length(idempotency_digest),\
                idempotency_digest=convert_to($2,'UTF8') \
         FROM project_bundle_refs WHERE id=$1::uuid",
    )
    .bind(left.version().id().to_string())
    .bind("explicit-version-key-0001")
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(digest_storage, (32, false));
    assert!(
        sqlx::query(
            "INSERT INTO project_bundle_refs \
             (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000008099'::uuid,$1::uuid,$2::uuid,$3::uuid,\
                     'version','Missing durable metadata',$4::uuid)",
        )
        .bind(PROJECT_A)
        .bind(SCOPE)
        .bind(first_head.bundle_id().to_string())
        .bind(USER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err()
    );

    let mut conflicting_retry = version_request.clone();
    conflicting_retry.name = ProjectVersionName::new("Different body".to_owned()).unwrap();
    assert_eq!(
        versions.create(conflicting_retry).await.unwrap_err(),
        ProjectVersionError::IdempotencyConflict
    );
    let mut duplicate_name = version_request.clone();
    duplicate_name.idempotency_key =
        IdempotencyKey::new("explicit-version-key-0002".to_owned()).unwrap();
    assert_eq!(
        versions.create(duplicate_name).await.unwrap_err(),
        ProjectVersionError::NameConflict
    );
    let mut stale = version_request.clone();
    stale.name = ProjectVersionName::new("Stale".to_owned()).unwrap();
    stale.idempotency_key = IdempotencyKey::new("explicit-version-key-0003".to_owned()).unwrap();
    stale.expected_project_version = ProjectVersion::new(1).unwrap();
    assert_eq!(
        versions.create(stale).await.unwrap_err(),
        ProjectVersionError::StaleProjectVersion
    );

    for index in 2..=4 {
        let request = CreateProjectVersion {
            name: ProjectVersionName::new(format!("Release {index}")).unwrap(),
            idempotency_key: IdempotencyKey::new(format!("explicit-version-key-{index:04}"))
                .unwrap(),
            ..version_request.clone()
        };
        versions.create(request).await.unwrap();
    }
    let first_page = versions
        .list(
            UserId::from_str(USER).unwrap(),
            ProjectOwner::User(UserId::from_str(USER).unwrap()),
            ProjectId::from_str(PROJECT_A).unwrap(),
            ProjectVersionPageLimit::new(2).unwrap(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(first_page.versions().len(), 2);
    let second_page = versions
        .list(
            UserId::from_str(USER).unwrap(),
            ProjectOwner::User(UserId::from_str(USER).unwrap()),
            ProjectId::from_str(PROJECT_A).unwrap(),
            ProjectVersionPageLimit::new(2).unwrap(),
            first_page.next_key(),
        )
        .await
        .unwrap();
    assert_eq!(second_page.versions().len(), 2);
    assert!(second_page.next_key().is_none());
    assert!(first_page.versions()[0].created_at() >= first_page.versions()[1].created_at());

    let live_projection: (i64, i64) = sqlx::query_as(
        "SELECT COUNT(DISTINCT live.bundle_id),(SUM(DISTINCT bundle.physical_bytes))::bigint \
         FROM (SELECT working_head_bundle_id AS bundle_id FROM projects WHERE id=$1::uuid \
               UNION SELECT bundle_id FROM project_bundle_refs WHERE project_id=$1::uuid) live \
         JOIN bundles bundle ON bundle.id=live.bundle_id",
    )
    .bind(PROJECT_A)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(live_projection, (1, first_body.len() as i64));
    assert!(
        sqlx::query(
            "UPDATE project_bundle_refs SET version_name='mutated' \
             WHERE id=$1::uuid",
        )
        .bind(left.version().id().to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err()
    );

    sqlx::query(
        "INSERT INTO gc_candidates \
         (object_key,expected_sha256,expected_bytes,reason,eligible_at) \
         SELECT object_key,sha256,physical_bytes,'reference_removed',transaction_timestamp() \
         FROM bundles WHERE id=$1::uuid ON CONFLICT (object_key) DO NOTHING",
    )
    .bind(first_head.bundle_id().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let gc_guard = sqlx::query(
        "UPDATE gc_candidates SET status='running',attempts=attempts+1, \
         started_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE object_key=(SELECT object_key FROM bundles WHERE id=$1::uuid)",
    )
    .bind(first_head.bundle_id().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await;
    assert!(gc_guard.is_err());

    let second_body = canonical_test_bundle(PROJECT_A, SCOPE, "versioned.txt", b"version two\n");
    let mut second_request = request(PROJECT_A, "version-head-second", &second_body);
    second_request.expected_project_version = ProjectVersion::new(2).unwrap();
    second_request.expected_logical_bytes = 12;
    second_request.expected_file_count = 1;
    let second_session = creator.create(second_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            second_session.capability().request(),
            &second_body,
            None,
            None,
        )
        .await
    );
    let second_capability = verifier
        .verify(verification_context(PROJECT_A, second_session.session_id()))
        .await
        .unwrap();
    let second_head = committer.commit(&second_capability).await.unwrap();
    assert_eq!(second_head.project_version().get(), 3);
    let retried_after_head_change = versions.create(version_request.clone()).await.unwrap();
    assert!(retried_after_head_change.is_idempotent_retry());
    assert_eq!(
        retried_after_head_change.version().bundle_id(),
        first_head.bundle_id()
    );

    for user in [USER, OUTSIDER, ORG_READ] {
        sqlx::query(
            "INSERT INTO local_password_credentials (user_id,password_verifier) \
             VALUES ($1::uuid,$2)",
        )
        .bind(user)
        .bind(TEST_PASSWORD_HASH)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    let router = version_http_router(pool.clone());
    let owner_browser = version_login(&router, "save@example.test").await;
    let outsider_browser = version_login(&router, "outside@example.test").await;
    let version_uri = format!("/api/v1/workspaces/users/{USER}/projects/{PROJECT_A}/versions");
    let created = version_json_request(
        &router,
        &owner_browser,
        Method::POST,
        &version_uri,
        Some("\"project-v3\""),
        Some("http-explicit-version-01"),
        json!({"name":"HTTP Release"}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()["cache-control"], "private, no-store");
    let created_body = version_response_json(created).await;
    assert_eq!(created_body["idempotentRetry"], false);
    assert_eq!(created_body["version"]["sourceProjectVersion"], 3);
    assert_eq!(created_body["version"]["name"], "HTTP Release");
    assert_eq!(
        created_body["version"]["bundleId"],
        second_head.bundle_id().to_string()
    );
    let replay = version_json_request(
        &router,
        &owner_browser,
        Method::POST,
        &version_uri,
        Some("\"project-v3\""),
        Some("http-explicit-version-01"),
        json!({"name":"HTTP Release"}),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(version_response_json(replay).await["idempotentRetry"], true);
    assert_eq!(
        version_json_request(
            &router,
            &owner_browser,
            Method::POST,
            &version_uri,
            Some("\"project-v2\""),
            Some("http-explicit-version-02"),
            json!({"name":"HTTP Stale"}),
        )
        .await
        .status(),
        StatusCode::PRECONDITION_FAILED
    );
    assert_eq!(
        version_json_request(
            &router,
            &owner_browser,
            Method::POST,
            &version_uri,
            Some("\"project-v3\""),
            None,
            json!({"name":"Missing key"}),
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        version_empty_request(&router, &outsider_browser, &version_uri,)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let first_http_page = version_empty_request(
        &router,
        &owner_browser,
        &format!("{version_uri}?pageSize=2"),
    )
    .await;
    assert_eq!(first_http_page.status(), StatusCode::OK);
    let first_http_page = version_response_json(first_http_page).await;
    assert_eq!(first_http_page["items"].as_array().unwrap().len(), 2);
    let cursor = first_http_page["nextCursor"].as_str().unwrap();
    let second_http_page = version_empty_request(
        &router,
        &owner_browser,
        &format!("{version_uri}?pageSize=2&cursor={cursor}"),
    )
    .await;
    assert_eq!(second_http_page.status(), StatusCode::OK);
    assert!(
        !version_response_json(second_http_page).await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let org_body = canonical_test_bundle(
        ORG_PROJECT_READ,
        ORG_SCOPE,
        "shared.txt",
        b"shared version\n",
    );
    let mut org_request = request_for(
        ORG_SCOPE,
        ORG_PROJECT_READ,
        ORG_OWNER,
        "shared-version-head1",
        &org_body,
    );
    org_request.expected_logical_bytes = 15;
    org_request.expected_file_count = 1;
    let org_session = creator.create(org_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            org_session.capability().request(),
            &org_body,
            None,
            None,
        )
        .await
    );
    let org_capability = verifier
        .verify(VerifyStagingBundle {
            storage_scope_id: StorageScopeId::from_str(ORG_SCOPE).unwrap(),
            project_id: ProjectId::from_str(ORG_PROJECT_READ).unwrap(),
            actor_user_id: UserId::from_str(ORG_OWNER).unwrap(),
            session_id: org_session.session_id(),
        })
        .await
        .unwrap();
    committer.commit(&org_capability).await.unwrap();
    let read_request = CreateProjectVersion {
        owner: ProjectOwner::Organization(OrganizationId::from_str(ORG).unwrap()),
        project_id: ProjectId::from_str(ORG_PROJECT_READ).unwrap(),
        actor_user_id: UserId::from_str(ORG_READ).unwrap(),
        expected_project_version: ProjectVersion::new(2).unwrap(),
        name: ProjectVersionName::new("Read denied".to_owned()).unwrap(),
        idempotency_key: IdempotencyKey::new("read-version-denied1".to_owned()).unwrap(),
    };
    assert_eq!(
        versions.create(read_request).await.unwrap_err(),
        ProjectVersionError::Forbidden
    );
    let read_browser = version_login(&router, "org-read@example.test").await;
    let read_uri =
        format!("/api/v1/workspaces/organizations/{ORG}/projects/{ORG_PROJECT_READ}/versions");
    assert_eq!(
        version_json_request(
            &router,
            &read_browser,
            Method::POST,
            &read_uri,
            Some("\"project-v2\""),
            Some("http-read-version-denied"),
            json!({"name":"Read denied"}),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert!(
        versions
            .list(
                UserId::from_str(ORG_READ).unwrap(),
                ProjectOwner::Organization(OrganizationId::from_str(ORG).unwrap()),
                ProjectId::from_str(ORG_PROJECT_READ).unwrap(),
                ProjectVersionPageLimit::new(10).unwrap(),
                None,
            )
            .await
            .is_ok()
    );
    sqlx::query("DELETE FROM project_user_roles WHERE project_id=$1::uuid AND user_id=$2::uuid")
        .bind(ORG_PROJECT_READ)
        .bind(ORG_READ)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        versions
            .list(
                UserId::from_str(ORG_READ).unwrap(),
                ProjectOwner::Organization(OrganizationId::from_str(ORG).unwrap()),
                ProjectId::from_str(ORG_PROJECT_READ).unwrap(),
                ProjectVersionPageLimit::new(10).unwrap(),
                None,
            )
            .await
            .unwrap_err(),
        ProjectVersionError::NotFound
    );

    sqlx::query("UPDATE projects SET state='archived',archived_at=transaction_timestamp(),lock_version=lock_version+1,updated_at=transaction_timestamp() WHERE id=$1::uuid")
        .bind(PROJECT_A)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        versions
            .list(
                UserId::from_str(USER).unwrap(),
                ProjectOwner::User(UserId::from_str(USER).unwrap()),
                ProjectId::from_str(PROJECT_A).unwrap(),
                ProjectVersionPageLimit::new(10).unwrap(),
                None,
            )
            .await
            .unwrap()
            .versions()
            .len(),
        5
    );
    assert_eq!(
        version_empty_request(&router, &owner_browser, &version_uri)
            .await
            .status(),
        StatusCode::OK
    );
    let archived_create = CreateProjectVersion {
        name: ProjectVersionName::new("Archived denied".to_owned()).unwrap(),
        idempotency_key: IdempotencyKey::new("archived-version-denied".to_owned()).unwrap(),
        expected_project_version: ProjectVersion::new(4).unwrap(),
        ..version_request
    };
    assert_eq!(
        versions.create(archived_create).await.unwrap_err(),
        ProjectVersionError::ProjectUnavailable
    );
}

#[tokio::test]
#[ignore = "requires tests/fixtures/project-history/run.sh"]
async fn project_history_promotes_atomically_and_replays_durable_outcomes() {
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
    let creator = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x69; 32]).unwrap(),
    )
    .unwrap();
    let verifier = StagingVerifier::new(
        pool.clone(),
        store.clone(),
        StagingVerifierPolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let committer = WorkingHeadCommitService::new(
        pool.clone(),
        store,
        WorkingHeadCommitPolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let history = ProjectHistoryService::new(
        pool.clone(),
        ProjectHistoryServicePolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let versions = ProjectVersionService::new(
        pool.clone(),
        ProjectVersionServicePolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let http = fixture_http_client(&ca_file);
    let actor = UserId::from_str(USER).unwrap();
    let project_id = ProjectId::from_str(PROJECT_A).unwrap();
    let owner = ProjectOwner::User(actor);

    let mut heads = Vec::new();
    let mut first_version_id = None;
    for index in 1_i64..=4 {
        let capability = prepare_verified_head(
            &creator,
            &verifier,
            &http,
            ProjectVersion::new(index).unwrap(),
            &format!("history-head-{index:04}"),
            &format!("history-{index}.txt"),
            format!("history {index}\n").as_bytes(),
        )
        .await;
        let head = committer.commit(&capability).await.unwrap();
        heads.push(head.bundle_id());
        if index == 1 {
            first_version_id = Some(
                versions
                    .create(CreateProjectVersion {
                        owner,
                        project_id,
                        actor_user_id: actor,
                        expected_project_version: ProjectVersion::new(2).unwrap(),
                        name: ProjectVersionName::new("History anchor".to_owned()).unwrap(),
                        idempotency_key: IdempotencyKey::new(
                            "history-anchor-version-0001".to_owned(),
                        )
                        .unwrap(),
                    })
                    .await
                    .unwrap()
                    .version()
                    .id()
                    .to_string()
                    .parse()
                    .unwrap(),
            );
        }
    }
    let recoveries = history
        .list_recovery_checkpoints(actor, owner, project_id)
        .await
        .unwrap();
    assert_eq!(recoveries.len(), 3);
    assert_eq!(recoveries[0].bundle_id(), heads[2]);
    assert_eq!(recoveries[2].bundle_id(), heads[0]);

    let selected = &recoveries[2];
    sqlx::query(
        "INSERT INTO gc_candidates \
         (object_key,expected_sha256,expected_bytes,reason,eligible_at) \
         SELECT object_key,sha256,physical_bytes,'reference_removed',transaction_timestamp() \
         FROM bundles WHERE id=$1::uuid",
    )
    .bind(heads[0].to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE gc_candidates SET status='running',attempts=attempts+1,\
                    started_at=transaction_timestamp(),updated_at=transaction_timestamp() \
             WHERE object_key=(SELECT object_key FROM bundles WHERE id=$1::uuid)",
        )
        .bind(heads[0].to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err()
    );
    let key = IdempotencyKey::new("history-restore-oldest-0001".to_owned()).unwrap();
    let request = PromoteHistoricalReference {
        owner,
        project_id,
        actor_user_id: actor,
        expected_project_version: ProjectVersion::new(5).unwrap(),
        reference_kind: HistoricalReferenceKind::Recovery,
        reference_id: selected.id(),
        idempotency_key: key.clone(),
        audit: history_audit(actor, "history-restore-live-01"),
    };
    let promoted = history.promote(request.clone()).await.unwrap();
    assert!(promoted.changed());
    assert_eq!(promoted.project_version().get(), 6);
    assert_eq!(promoted.bundle_id(), heads[0]);
    let target_gc_candidates: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gc_candidates candidate JOIN bundles bundle \
         ON bundle.object_key=candidate.object_key WHERE bundle.id=$1::uuid",
    )
    .bind(heads[0].to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(target_gc_candidates, 0);
    let replay = history.promote(request).await.unwrap();
    assert!(replay.is_idempotent_retry());
    assert_eq!(replay.operation_id(), promoted.operation_id());
    assert_eq!(
        history
            .reconcile(actor, owner, project_id, &key)
            .await
            .unwrap(),
        replay
    );

    let no_op = history
        .promote(PromoteHistoricalReference {
            owner,
            project_id,
            actor_user_id: actor,
            expected_project_version: ProjectVersion::new(6).unwrap(),
            reference_kind: HistoricalReferenceKind::Version,
            reference_id: first_version_id.unwrap(),
            idempotency_key: IdempotencyKey::new("history-restore-noop-0001".to_owned()).unwrap(),
            audit: history_audit(actor, "history-restore-live-02"),
        })
        .await
        .unwrap();
    assert!(!no_op.changed());
    assert_eq!(no_op.project_version().get(), 6);

    let current: (String, i64, i64, i64) = sqlx::query_as(
        "SELECT working_head_bundle_id::text,lock_version,\
                (SELECT COUNT(*) FROM project_history_promotions WHERE project_id=projects.id),\
                (SELECT COUNT(*) FROM audit_events WHERE scope_id=projects.id::text \
                 AND action_code='project.history.promoted') \
         FROM projects WHERE id=$1::uuid",
    )
    .bind(PROJECT_A)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(current, (heads[0].to_string(), 6, 2, 2));
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT bundle_id) FROM (\
           SELECT working_head_bundle_id AS bundle_id FROM projects WHERE id=$1::uuid \
           UNION SELECT bundle_id FROM project_bundle_refs WHERE project_id=$1::uuid) refs",
    )
    .bind(PROJECT_A)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(live, 4);

    let stale = history
        .promote(PromoteHistoricalReference {
            owner,
            project_id,
            actor_user_id: actor,
            expected_project_version: ProjectVersion::new(5).unwrap(),
            reference_kind: HistoricalReferenceKind::Recovery,
            reference_id: recoveries[1].id(),
            idempotency_key: IdempotencyKey::new("history-restore-stale-0001".to_owned()).unwrap(),
            audit: history_audit(actor, "history-restore-live-03"),
        })
        .await
        .unwrap_err();
    assert_eq!(stale, ProjectHistoryError::StaleProjectVersion);

    for user in [USER, OUTSIDER, ORG_OWNER, ORG_READ] {
        sqlx::query(
            "INSERT INTO local_password_credentials (user_id,password_verifier) VALUES ($1::uuid,$2)",
        )
        .bind(user)
        .bind(TEST_PASSWORD_HASH)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    let router = version_http_router(pool.clone());
    let owner_browser = version_login(&router, "save@example.test").await;
    let outsider_browser = version_login(&router, "outside@example.test").await;
    let recovery_uri =
        format!("/api/v1/workspaces/users/{USER}/projects/{PROJECT_A}/recovery-checkpoints");
    let listed = version_empty_request(&router, &owner_browser, &recovery_uri).await;
    assert_eq!(listed.status(), StatusCode::OK);
    assert_eq!(listed.headers()["cache-control"], "private, no-store");
    assert_eq!(
        version_response_json(listed).await["items"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        version_empty_request(&router, &outsider_browser, &recovery_uri)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let history_uri =
        format!("/api/v1/workspaces/users/{USER}/projects/{PROJECT_A}/history/restore");
    let http_noop = version_json_request(
        &router,
        &owner_browser,
        Method::POST,
        &history_uri,
        Some("\"project-v6\""),
        Some("history-http-noop-0001"),
        json!({"referenceKind":"version","referenceId":first_version_id.unwrap().to_string()}),
    )
    .await;
    assert_eq!(http_noop.status(), StatusCode::OK);
    assert_eq!(http_noop.headers()[ETAG], "\"project-v6\"");
    assert_eq!(version_response_json(http_noop).await["changed"], false);
    let reconciled = version_json_request(
        &router,
        &owner_browser,
        Method::GET,
        &history_uri,
        None,
        Some("history-http-noop-0001"),
        json!({}),
    )
    .await;
    assert_eq!(reconciled.status(), StatusCode::OK);
    assert_eq!(
        version_response_json(reconciled).await["idempotentRetry"],
        true
    );

    let concurrent_left = history.promote(PromoteHistoricalReference {
        owner,
        project_id,
        actor_user_id: actor,
        expected_project_version: ProjectVersion::new(6).unwrap(),
        reference_kind: HistoricalReferenceKind::Recovery,
        reference_id: recoveries[0].id(),
        idempotency_key: IdempotencyKey::new("history-concurrent-left-01".to_owned()).unwrap(),
        audit: history_audit(actor, "history-restore-live-05"),
    });
    let concurrent_right = history.promote(PromoteHistoricalReference {
        owner,
        project_id,
        actor_user_id: actor,
        expected_project_version: ProjectVersion::new(6).unwrap(),
        reference_kind: HistoricalReferenceKind::Recovery,
        reference_id: recoveries[1].id(),
        idempotency_key: IdempotencyKey::new("history-concurrent-right-1".to_owned()).unwrap(),
        audit: history_audit(actor, "history-restore-live-06"),
    });
    let (left, right) = tokio::join!(concurrent_left, concurrent_right);
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    assert!(
        [left, right]
            .into_iter()
            .flatten()
            .all(|outcome| outcome.project_version().get() == 7)
    );

    let project_b = ProjectId::from_str(PROJECT_B).unwrap();
    let mut sequence_heads = Vec::new();
    for (index, label) in ["x", "y", "z", "h"].into_iter().enumerate() {
        let expected = ProjectVersion::new(i64::try_from(index).unwrap() + 1).unwrap();
        let capability = prepare_verified_head_for(
            &creator,
            &verifier,
            &http,
            SCOPE,
            PROJECT_B,
            USER,
            expected,
            &format!("history-sequence-{label}-01"),
            &format!("sequence-{label}.txt"),
            format!("sequence {label}\n").as_bytes(),
        )
        .await;
        sequence_heads.push(committer.commit(&capability).await.unwrap().bundle_id());
    }
    let sequence_recoveries = history
        .list_recovery_checkpoints(actor, owner, project_b)
        .await
        .unwrap();
    assert_eq!(sequence_recoveries[1].bundle_id(), sequence_heads[1]);
    history
        .promote(PromoteHistoricalReference {
            owner,
            project_id: project_b,
            actor_user_id: actor,
            expected_project_version: ProjectVersion::new(5).unwrap(),
            reference_kind: HistoricalReferenceKind::Recovery,
            reference_id: sequence_recoveries[1].id(),
            idempotency_key: IdempotencyKey::new("history-sequence-restore-y".to_owned()).unwrap(),
            audit: history_audit(actor, "history-sequence-restore-y"),
        })
        .await
        .unwrap();
    for (version, label) in [(6, "n"), (7, "m")] {
        let capability = prepare_verified_head_for(
            &creator,
            &verifier,
            &http,
            SCOPE,
            PROJECT_B,
            USER,
            ProjectVersion::new(version).unwrap(),
            &format!("history-sequence-{label}-01"),
            &format!("sequence-{label}.txt"),
            format!("sequence {label}\n").as_bytes(),
        )
        .await;
        sequence_heads.push(committer.commit(&capability).await.unwrap().bundle_id());
    }
    let refreshed = history
        .list_recovery_checkpoints(actor, owner, project_b)
        .await
        .unwrap();
    assert_eq!(
        refreshed
            .iter()
            .map(RecoveryCheckpoint::bundle_id)
            .collect::<Vec<_>>(),
        vec![sequence_heads[4], sequence_heads[1], sequence_heads[3]]
    );

    sqlx::query(
        "INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) VALUES \
         ($1::uuid,$3::uuid,$4::uuid,'history-left','History Left'),\
         ($2::uuid,$3::uuid,$4::uuid,'history-right','History Right')",
    )
    .bind(PROJECT_HISTORY_LEFT)
    .bind(PROJECT_HISTORY_RIGHT)
    .bind(USER)
    .bind(SCOPE)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let mut left_heads = Vec::new();
    let mut right_heads = Vec::new();
    for (index, label) in ["one", "two", "three", "four"].into_iter().enumerate() {
        let expected = ProjectVersion::new(i64::try_from(index).unwrap() + 1).unwrap();
        for (project, side, heads) in [
            (PROJECT_HISTORY_LEFT, "left", &mut left_heads),
            (PROJECT_HISTORY_RIGHT, "right", &mut right_heads),
        ] {
            let capability = prepare_verified_head_for(
                &creator,
                &verifier,
                &http,
                SCOPE,
                project,
                USER,
                expected,
                &format!("history-cross-{side}-{label}"),
                &format!("{side}-{label}.txt"),
                format!("{side} {label}\n").as_bytes(),
            )
            .await;
            heads.push(committer.commit(&capability).await.unwrap().bundle_id());
        }
    }
    let left_own =
        admit_bundle_version_for_fixture(&pool, PROJECT_HISTORY_LEFT, left_heads[3], "Left own")
            .await;
    let left_cross = admit_bundle_version_for_fixture(
        &pool,
        PROJECT_HISTORY_LEFT,
        right_heads[3],
        "Right shared",
    )
    .await;
    let right_own =
        admit_bundle_version_for_fixture(&pool, PROJECT_HISTORY_RIGHT, right_heads[3], "Right own")
            .await;
    let right_cross = admit_bundle_version_for_fixture(
        &pool,
        PROJECT_HISTORY_RIGHT,
        left_heads[3],
        "Left shared",
    )
    .await;
    let left_project = ProjectId::from_str(PROJECT_HISTORY_LEFT).unwrap();
    let right_project = ProjectId::from_str(PROJECT_HISTORY_RIGHT).unwrap();
    for round in 0..6 {
        let (left_target, right_target) = if round % 2 == 0 {
            (left_cross, right_cross)
        } else {
            (left_own, right_own)
        };
        let expected = ProjectVersion::new(5 + round).unwrap();
        let left = history.promote(PromoteHistoricalReference {
            owner,
            project_id: left_project,
            actor_user_id: actor,
            expected_project_version: expected,
            reference_kind: HistoricalReferenceKind::Version,
            reference_id: left_target,
            idempotency_key: IdempotencyKey::new(format!("history-cross-left-{round:02}")).unwrap(),
            audit: history_audit(actor, &format!("history-cross-left-{round:02}")),
        });
        let right = history.promote(PromoteHistoricalReference {
            owner,
            project_id: right_project,
            actor_user_id: actor,
            expected_project_version: expected,
            reference_kind: HistoricalReferenceKind::Version,
            reference_id: right_target,
            idempotency_key: IdempotencyKey::new(format!("history-cross-right-{round:02}"))
                .unwrap(),
            audit: history_audit(actor, &format!("history-cross-right-{round:02}")),
        });
        let (left, right) = tokio::join!(left, right);
        assert!(
            left.is_ok(),
            "left cross-project promotion {round}: {left:?}"
        );
        assert!(
            right.is_ok(),
            "right cross-project promotion {round}: {right:?}"
        );
    }

    assert!(
        sqlx::query("DELETE FROM project_history_promotions WHERE project_id=$1::uuid")
            .bind(PROJECT_A)
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err()
    );
    ProjectService::new(pool.clone(), ProjectServicePolicy::default())
        .delete(
            actor,
            owner,
            project_b,
            ProjectVersion::new(8).unwrap(),
            &ProjectDeleteConfirmation::new(ProjectName::new("Save B".to_owned()).unwrap(), true),
            &history_audit(actor, "history-project-delete-cascade"),
        )
        .await
        .unwrap();
    let deleted_history: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM project_history_promotions WHERE project_id=$1::uuid",
    )
    .bind(PROJECT_B)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(deleted_history, 0);

    let org_body = canonical_test_bundle(
        ORG_PROJECT_READ,
        ORG_SCOPE,
        "history-read.txt",
        b"read boundary\n",
    );
    let mut org_request = request_for(
        ORG_SCOPE,
        ORG_PROJECT_READ,
        ORG_OWNER,
        "history-org-head-0001",
        &org_body,
    );
    org_request.expected_logical_bytes = 14;
    org_request.expected_file_count = 1;
    let org_session = creator.create(org_request).await.unwrap();
    assert!(
        send_with_mutation(
            &http,
            org_session.capability().request(),
            &org_body,
            None,
            None,
        )
        .await
    );
    let org_capability = verifier
        .verify(VerifyStagingBundle {
            storage_scope_id: StorageScopeId::from_str(ORG_SCOPE).unwrap(),
            project_id: ProjectId::from_str(ORG_PROJECT_READ).unwrap(),
            actor_user_id: UserId::from_str(ORG_OWNER).unwrap(),
            session_id: org_session.session_id(),
        })
        .await
        .unwrap();
    committer.commit(&org_capability).await.unwrap();
    let org_project = ProjectId::from_str(ORG_PROJECT_READ).unwrap();
    let org_owner = ProjectOwner::Organization(OrganizationId::from_str(ORG).unwrap());
    let org_version = versions
        .create(CreateProjectVersion {
            owner: org_owner,
            project_id: org_project,
            actor_user_id: UserId::from_str(ORG_OWNER).unwrap(),
            expected_project_version: ProjectVersion::new(2).unwrap(),
            name: ProjectVersionName::new("Read boundary anchor".to_owned()).unwrap(),
            idempotency_key: IdempotencyKey::new("history-org-version-001".to_owned()).unwrap(),
        })
        .await
        .unwrap();
    let read_user = UserId::from_str(ORG_READ).unwrap();
    let read_browser = version_login(&router, "org-read@example.test").await;
    let org_recovery_uri = format!(
        "/api/v1/workspaces/organizations/{ORG}/projects/{ORG_PROJECT_READ}/recovery-checkpoints"
    );
    assert_eq!(
        version_empty_request(&router, &read_browser, &org_recovery_uri)
            .await
            .status(),
        StatusCode::OK
    );
    assert!(
        history
            .list_recovery_checkpoints(read_user, org_owner, org_project)
            .await
            .is_ok()
    );
    assert_eq!(
        history
            .promote(PromoteHistoricalReference {
                owner: org_owner,
                project_id: org_project,
                actor_user_id: read_user,
                expected_project_version: ProjectVersion::new(2).unwrap(),
                reference_kind: HistoricalReferenceKind::Version,
                reference_id: org_version.version().id().to_string().parse().unwrap(),
                idempotency_key: IdempotencyKey::new("history-read-denied-001".to_owned()).unwrap(),
                audit: history_audit(read_user, "history-restore-live-07"),
            })
            .await
            .unwrap_err(),
        ProjectHistoryError::Forbidden
    );
    let org_history_uri = format!(
        "/api/v1/workspaces/organizations/{ORG}/projects/{ORG_PROJECT_READ}/history/restore"
    );
    assert_eq!(
        version_json_request(
            &router,
            &read_browser,
            Method::POST,
            &org_history_uri,
            Some("\"project-v2\""),
            Some("history-http-read-denied"),
            json!({
                "referenceKind":"version",
                "referenceId":org_version.version().id().to_string()
            }),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    sqlx::query("DELETE FROM project_user_roles WHERE project_id=$1::uuid AND user_id=$2::uuid")
        .bind(ORG_PROJECT_READ)
        .bind(ORG_READ)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        history
            .list_recovery_checkpoints(read_user, org_owner, org_project)
            .await
            .unwrap_err(),
        ProjectHistoryError::NotFound
    );
    assert_eq!(
        version_empty_request(&router, &read_browser, &org_recovery_uri)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );

    sqlx::query(
        "UPDATE projects SET state='archived',archived_at=transaction_timestamp(),\
                lock_version=lock_version+1,updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(PROJECT_A)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        history
            .list_recovery_checkpoints(actor, owner, project_id)
            .await
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        history
            .promote(PromoteHistoricalReference {
                owner,
                project_id,
                actor_user_id: actor,
                expected_project_version: ProjectVersion::new(8).unwrap(),
                reference_kind: HistoricalReferenceKind::Recovery,
                reference_id: recoveries[1].id(),
                idempotency_key: IdempotencyKey::new("history-restore-archived-01".to_owned())
                    .unwrap(),
                audit: history_audit(actor, "history-restore-live-04"),
            })
            .await
            .unwrap_err(),
        ProjectHistoryError::ProjectUnavailable
    );
}

fn history_audit(actor: UserId, correlation_id: &str) -> ProjectAuditContext {
    ProjectAuditContext::new(
        AuditEventId::new(),
        actor,
        Some("Save Fixture".to_owned()),
        correlation_id.to_owned(),
        None,
    )
}

async fn prepare_verified_head(
    creator: &SinglePutService,
    verifier: &StagingVerifier,
    http: &reqwest::Client,
    expected_project_version: ProjectVersion,
    idempotency_key: &str,
    path: &str,
    content: &[u8],
) -> VerifiedStagingBundle {
    prepare_verified_head_for(
        creator,
        verifier,
        http,
        SCOPE,
        PROJECT_A,
        USER,
        expected_project_version,
        idempotency_key,
        path,
        content,
    )
    .await
}

#[allow(
    clippy::too_many_arguments,
    reason = "actual fixture keeps Project and Bundle identity inputs explicit"
)]
async fn prepare_verified_head_for(
    creator: &SinglePutService,
    verifier: &StagingVerifier,
    http: &reqwest::Client,
    storage_scope: &str,
    project: &str,
    actor: &str,
    expected_project_version: ProjectVersion,
    idempotency_key: &str,
    path: &str,
    content: &[u8],
) -> VerifiedStagingBundle {
    let body = canonical_test_bundle(project, storage_scope, path, content);
    let mut request = request_for(storage_scope, project, actor, idempotency_key, &body);
    request.expected_project_version = expected_project_version;
    request.expected_logical_bytes = content.len() as u64;
    request.expected_file_count = 1;
    let session = creator.create(request).await.unwrap();
    assert!(send_with_mutation(http, session.capability().request(), &body, None, None,).await);
    verifier
        .verify(VerifyStagingBundle {
            storage_scope_id: StorageScopeId::from_str(storage_scope).unwrap(),
            project_id: ProjectId::from_str(project).unwrap(),
            actor_user_id: UserId::from_str(actor).unwrap(),
            session_id: session.session_id(),
        })
        .await
        .unwrap()
}

async fn admit_bundle_version_for_fixture(
    pool: &DatabasePool,
    project: &str,
    bundle: Uuid,
    version_name: &str,
) -> Uuid {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    let admitted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM project_bundle_admissions \
         WHERE project_id=$1::uuid AND bundle_id=$2::uuid)",
    )
    .bind(project)
    .bind(bundle.to_string())
    .fetch_one(&mut *transaction)
    .await
    .unwrap();
    let expected_version: i64 =
        sqlx::query_scalar("SELECT lock_version FROM projects WHERE id=$1::uuid")
            .bind(project)
            .fetch_one(&mut *transaction)
            .await
            .unwrap();
    if !admitted {
        let metadata: (Vec<u8>, i64, i64, i32) = sqlx::query_as(
            "SELECT sha256,physical_bytes,logical_bytes,file_count FROM bundles WHERE id=$1::uuid",
        )
        .bind(bundle.to_string())
        .fetch_one(&mut *transaction)
        .await
        .unwrap();
        let session_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO save_sessions \
             (id,project_id,storage_scope_id,actor_user_id,expected_project_version,\
              expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,\
              expected_file_count,staging_object_key,upload_mode,expires_at) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,'single',\
                     transaction_timestamp()+INTERVAL '1 hour')",
        )
        .bind(session_id.to_string())
        .bind(project)
        .bind(SCOPE)
        .bind(USER)
        .bind(expected_version)
        .bind(metadata.0)
        .bind(metadata.1)
        .bind(metadata.2)
        .bind(metadata.3)
        .bind(format!("staging/history-cross/{}.bundle", Uuid::now_v7()))
        .execute(&mut *transaction)
        .await
        .unwrap();
        for state in ["uploading", "verifying"] {
            sqlx::query(
                "UPDATE save_sessions SET state=$2,updated_at=transaction_timestamp() \
                 WHERE id=$1::uuid",
            )
            .bind(session_id.to_string())
            .bind(state)
            .execute(&mut *transaction)
            .await
            .unwrap();
        }
        sqlx::query(
            "UPDATE save_sessions SET state='committed',committed_bundle_id=$2::uuid,\
                    terminal_at=transaction_timestamp(),updated_at=transaction_timestamp() \
             WHERE id=$1::uuid",
        )
        .bind(session_id.to_string())
        .bind(bundle.to_string())
        .execute(&mut *transaction)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO project_bundle_admissions \
             (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$4::uuid)",
        )
        .bind(project)
        .bind(SCOPE)
        .bind(bundle.to_string())
        .bind(session_id.to_string())
        .execute(&mut *transaction)
        .await
        .unwrap();
    }
    let reference_id = Uuid::now_v7();
    let idempotency_digest = Sha256::digest(format!("{project}:{version_name}").as_bytes());
    sqlx::query(
        "INSERT INTO project_bundle_refs \
         (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id,\
          idempotency_digest,source_project_version) \
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'version',$5,$6::uuid,$7,$8)",
    )
    .bind(reference_id.to_string())
    .bind(project)
    .bind(SCOPE)
    .bind(bundle.to_string())
    .bind(version_name)
    .bind(USER)
    .bind(idempotency_digest.as_slice())
    .bind(expected_version)
    .execute(&mut *transaction)
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    reference_id
}

async fn verify_commit_permission_and_expiry(
    pool: &DatabasePool,
    creator: &SinglePutService,
    verifier: &StagingVerifier,
    committer: &WorkingHeadCommitService,
    http: &reqwest::Client,
) {
    let denied_body = canonical_test_bundle(
        ORG_PROJECT_WRITE,
        ORG_SCOPE,
        "permission.txt",
        b"permission\n",
    );
    let mut denied_request = request_for(
        ORG_SCOPE,
        ORG_PROJECT_WRITE,
        ORG_WRITE,
        "head-permission-001",
        &denied_body,
    );
    denied_request.expected_logical_bytes = 11;
    denied_request.expected_file_count = 1;
    let denied_session = creator.create(denied_request).await.unwrap();
    assert!(
        send_with_mutation(
            http,
            denied_session.capability().request(),
            &denied_body,
            None,
            None,
        )
        .await
    );
    let denied_capability = verifier
        .verify(VerifyStagingBundle {
            storage_scope_id: StorageScopeId::from_str(ORG_SCOPE).unwrap(),
            project_id: ProjectId::from_str(ORG_PROJECT_WRITE).unwrap(),
            actor_user_id: UserId::from_str(ORG_WRITE).unwrap(),
            session_id: denied_session.session_id(),
        })
        .await
        .unwrap();
    sqlx::query("DELETE FROM project_user_roles WHERE project_id=$1::uuid AND user_id=$2::uuid")
        .bind(ORG_PROJECT_WRITE)
        .bind(ORG_WRITE)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        committer.commit(&denied_capability).await.unwrap_err(),
        WorkingHeadCommitError::Unauthorized
    );

    let expired_body =
        canonical_test_bundle(ORG_PROJECT_OWNER, ORG_SCOPE, "expired.txt", b"expired\n");
    let mut expired_request = request_for(
        ORG_SCOPE,
        ORG_PROJECT_OWNER,
        ORG_OWNER,
        "head-expired-00001",
        &expired_body,
    );
    expired_request.expected_logical_bytes = 8;
    expired_request.expected_file_count = 1;
    let expired_session = creator.create(expired_request).await.unwrap();
    assert!(
        send_with_mutation(
            http,
            expired_session.capability().request(),
            &expired_body,
            None,
            None,
        )
        .await
    );
    let expired_capability = verifier
        .verify(VerifyStagingBundle {
            storage_scope_id: StorageScopeId::from_str(ORG_SCOPE).unwrap(),
            project_id: ProjectId::from_str(ORG_PROJECT_OWNER).unwrap(),
            actor_user_id: UserId::from_str(ORG_OWNER).unwrap(),
            session_id: expired_session.session_id(),
        })
        .await
        .unwrap();
    force_session_expiry(
        pool,
        &expired_session.session_id().to_string(),
        "created_at + interval '1 microsecond'",
    )
    .await;
    assert_eq!(
        committer.commit(&expired_capability).await.unwrap_err(),
        WorkingHeadCommitError::SessionExpired
    );
    let expired_state: (String, i64, i64) = sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=session.id),\
         (SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=session.id) \
         FROM save_sessions session WHERE id=$1::uuid",
    )
    .bind(expired_session.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(expired_state, ("expired".to_owned(), 0, 1));
}

struct FixtureEnvironment {
    endpoint: String,
    ca_file: String,
}

impl Environment for FixtureEnvironment {
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
#[ignore = "requires tests/fixtures/single-put-save/run.sh"]
async fn single_put_is_atomic_idempotent_bounded_and_compensated() {
    let pool = fixture_pool().await;
    reset_and_seed(&pool).await;
    let endpoint = env::var(S3_ENDPOINT_ENV).unwrap();
    let ca_file = env::var(S3_CA_ENV).unwrap();
    create_bucket(&endpoint, &ca_file).await;
    let config = ObjectStorageConfig::load(
        &FixtureEnvironment {
            endpoint: endpoint.clone(),
            ca_file: ca_file.clone(),
        },
        &SystemFileReader,
    )
    .unwrap();
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap();
    let secret = IdempotencySecret::new([0x5a; 32]).unwrap();
    let service = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        secret.clone(),
    )
    .unwrap();
    let body = Bytes::from_static(b"bounded-single-put-body");
    let main_request = request(PROJECT_A, "single-put-retry-0001", &body);
    let created = service.create(main_request.clone()).await.unwrap();
    assert!(!created.is_idempotent_retry());
    verify_authorization(&service, &body).await;

    // A separately constructed service models a process restart with the same
    // stable secret. It must converge to the persisted active session.
    let restarted = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        secret,
    )
    .unwrap();
    let retried = restarted.create(main_request.clone()).await.unwrap();
    assert!(retried.is_idempotent_retry());
    assert_eq!(retried.session_id(), created.session_id());
    assert_eq!(
        reservation_count(&pool, created.session_id().to_string()).await,
        1
    );
    let failing_retry = SinglePutService::new(
        pool.clone(),
        FailingPresigner,
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        failing_retry
            .create(main_request.clone())
            .await
            .unwrap_err(),
        SinglePutServiceError::ObjectStorageUnavailable
    );
    let preserved_state: String =
        sqlx::query_scalar("SELECT state FROM save_sessions WHERE id=$1::uuid")
            .bind(created.session_id().to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(preserved_state, "created");
    assert_eq!(
        reservation_count(&pool, created.session_id().to_string()).await,
        1
    );
    sqlx::query(
        "UPDATE projects SET lock_version=lock_version+1,updated_at=CURRENT_TIMESTAMP \
         WHERE id=$1::uuid",
    )
    .bind(PROJECT_A)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let advanced_retry = restarted.create(main_request.clone()).await.unwrap();
    assert_eq!(advanced_retry.session_id(), created.session_id());

    let mut conflict = main_request.clone();
    conflict.expected_physical_bytes += 1;
    assert_eq!(
        restarted.create(conflict).await.unwrap_err(),
        SinglePutServiceError::IdempotencyConflict
    );
    let mut stale = request(PROJECT_B, "single-put-stale-0001", &body);
    stale.expected_project_version = ProjectVersion::new(2).unwrap();
    assert_eq!(
        restarted.create(stale).await.unwrap_err(),
        SinglePutServiceError::StaleProjectVersion
    );
    let expiring_request = request(PROJECT_B, "single-put-expiry-0001", &body);
    let expiring = restarted.create(expiring_request.clone()).await.unwrap();
    force_session_expiry(
        &pool,
        &expiring.session_id().to_string(),
        "created_at + interval '1 microsecond'",
    )
    .await;
    assert_eq!(
        restarted.create(expiring_request).await.unwrap_err(),
        SinglePutServiceError::SessionTerminal
    );
    let (expired_state, expired_reservations): (String, i64) = sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations r WHERE r.save_session_id=s.id) \
         FROM save_sessions s WHERE id=$1::uuid",
    )
    .bind(expiring.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(expired_state, "expired");
    assert_eq!(expired_reservations, 0);
    let rotated = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x6b; 32]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        rotated
            .create(request(PROJECT_B, "single-put-rotation-01", &body))
            .await
            .unwrap_err(),
        SinglePutServiceError::IdempotencyConfigurationMismatch
    );

    store
        .execute_presigned(created.capability().request(), Some(body.clone()))
        .await
        .unwrap();
    let signed_expiry_seconds = url::Url::parse(created.capability().request().expose_bearer_url())
        .unwrap()
        .query_pairs()
        .find_map(|(name, value)| (name == "X-Amz-Expires").then(|| value.parse::<i64>().unwrap()))
        .unwrap();
    assert!(signed_expiry_seconds >= 300);
    assert!(
        signed_expiry_seconds
            <= (created.expires_at() - time::OffsetDateTime::now_utc()).whole_seconds()
    );
    let tampered = Bytes::from(vec![b'x'; body.len()]);
    assert!(
        store
            .execute_presigned(created.capability().request(), Some(tampered))
            .await
            .is_err()
    );
    let client = fixture_http_client(&ca_file);
    assert!(
        !send_with_mutation(
            &client,
            created.capability().request(),
            &body[..body.len() - 1],
            None,
            None,
        )
        .await
    );
    assert!(
        !send_with_mutation(
            &client,
            created.capability().request(),
            &body,
            Some(("content-type", "application/octet-stream")),
            None,
        )
        .await
    );

    force_session_expiry(
        &pool,
        &created.session_id().to_string(),
        "CURRENT_TIMESTAMP + interval '4 minutes'",
    )
    .await;
    assert_eq!(
        restarted.create(main_request.clone()).await.unwrap_err(),
        SinglePutServiceError::SessionNearExpiry
    );
    assert_eq!(
        reservation_count(&pool, created.session_id().to_string()).await,
        1
    );
    assert!(
        !send_with_mutation(
            &client,
            created.capability().request(),
            &body,
            None,
            Some(("X-Amz-Expires=300", "X-Amz-Expires=1")),
        )
        .await
    );
    assert!(
        !send_with_mutation(
            &client,
            created.capability().request(),
            &body,
            None,
            Some((PROJECT_A, PROJECT_B)),
        )
        .await
    );

    let key: String =
        sqlx::query_scalar("SELECT staging_object_key FROM save_sessions WHERE id=$1::uuid")
            .bind(created.session_id().to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(
        key,
        format!(
            "staging/{SCOPE}/{PROJECT_A}/{}.bundle",
            created.session_id()
        )
    );
    assert!(!key.contains("single-put-retry-0001"));

    let failing = SinglePutService::new(
        pool.clone(),
        FailingPresigner,
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        failing
            .create(request(PROJECT_FAIL, "single-put-failure-001", &body))
            .await
            .unwrap_err(),
        SinglePutServiceError::ObjectStorageUnavailable
    );
    let (state, reservations): (String, i64) = sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations r \
         WHERE r.save_session_id=s.id) FROM save_sessions s WHERE project_id=$1::uuid",
    )
    .bind(PROJECT_FAIL)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(state, "failed");
    assert_eq!(reservations, 0);

    let hanging = SinglePutService::new(
        pool.clone(),
        HangingPresigner,
        SinglePutServicePolicy::new(Duration::from_millis(100), 5).unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    let timeout_request = request(PROJECT_TIMEOUT, "single-put-timeout-001", &body);
    assert_eq!(
        hanging.create(timeout_request.clone()).await.unwrap_err(),
        SinglePutServiceError::PresignTimeoutReconciliationRequired
    );
    assert!(matches!(
        restarted.reconcile(&timeout_request).await.unwrap(),
        nuriteo_server::save::ReconciliationState::Active(_)
    ));

    let rendered = format!(
        "{created:?} {:?}",
        restarted.reconcile(&main_request).await.unwrap()
    );
    for prohibited in [
        endpoint.as_str(),
        ca_file.as_str(),
        ACCESS_KEY,
        SECRET_KEY,
        "X-Amz-Signature",
        "single-put-retry-0001",
        key.as_str(),
    ] {
        assert!(!rendered.contains(prohibited));
    }
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[tokio::test]
#[ignore = "requires tests/fixtures/multipart-save/run.sh"]
async fn multipart_save_is_bounded_exact_and_reconcilable() {
    let pool = fixture_pool().await;
    reset_and_seed(&pool).await;
    let endpoint = env::var(S3_ENDPOINT_ENV).unwrap();
    let ca_file = env::var(S3_CA_ENV).unwrap();
    create_bucket(&endpoint, &ca_file).await;
    let config = ObjectStorageConfig::load(
        &FixtureEnvironment {
            endpoint: endpoint.clone(),
            ca_file: ca_file.clone(),
        },
        &SystemFileReader,
    )
    .unwrap();
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap();
    let single = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    let single_request = request(
        PROJECT_TIMEOUT,
        "single-before-multipart",
        b"same-secret-bootstrap",
    );
    let single_session = single.create(single_request.clone()).await.unwrap();
    force_session_expiry(
        &pool,
        &single_session.session_id().to_string(),
        "created_at + interval '1 microsecond'",
    )
    .await;
    assert_eq!(
        single.create(single_request).await.unwrap_err(),
        SinglePutServiceError::SessionTerminal
    );
    let policy = MultipartServicePolicy::new(
        Duration::from_secs(10),
        5,
        8 * 1024 * 1024,
        8 * 1024 * 1024,
        4,
    )
    .unwrap();
    let service = MultipartService::new(
        pool.clone(),
        store.clone(),
        policy,
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();

    let first_body = Bytes::from(vec![0x31; 8 * 1024 * 1024]);
    let second_body = Bytes::from(vec![0x32; 1024]);
    let request = multipart_request(
        PROJECT_A,
        "multipart-happy-0001",
        &[first_body.clone(), second_body.clone()],
    );
    let plans = request.parts.clone();
    let created = service.create(request.clone()).await.unwrap();
    assert_eq!(created.part_count(), 2);
    let restarted = MultipartService::new(
        pool.clone(),
        store.clone(),
        policy,
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    let retried = restarted.create(request).await.unwrap();
    assert!(retried.is_idempotent_retry());
    assert_eq!(retried.session_id(), created.session_id());
    assert_eq!(
        reservation_count(&pool, created.session_id().to_string()).await,
        1
    );

    let context = MultipartSessionContext {
        storage_scope_id: StorageScopeId::from_str(SCOPE).unwrap(),
        project_id: ProjectId::from_str(PROJECT_A).unwrap(),
        actor_user_id: UserId::from_str(USER).unwrap(),
        session_id: created.session_id(),
    };
    assert_eq!(
        service.complete(context).await.unwrap_err(),
        MultipartServiceError::PartsIncomplete
    );
    let capabilities = service.issue_parts(context, plans.clone()).await.unwrap();
    assert_eq!(capabilities.len(), 2);
    let client = fixture_http_client(&ca_file);
    let tampered = Bytes::from(vec![0x44; first_body.len()]);
    assert!(
        send_multipart_part(&client, capabilities[0].request(), &tampered)
            .await
            .is_none()
    );
    let first_etag = send_multipart_part(&client, capabilities[0].request(), &first_body)
        .await
        .unwrap();
    let second_etag = send_multipart_part(&client, capabilities[1].request(), &second_body)
        .await
        .unwrap();
    let wrong = MultipartPartReceipt::new(
        1,
        plans[0].expected_bytes(),
        Sha256Checksum::from_bytes([0xff; 32]),
        first_etag.clone(),
    )
    .unwrap();
    assert_eq!(
        service
            .record_receipts(context, vec![wrong])
            .await
            .unwrap_err(),
        MultipartServiceError::PartConflict
    );
    let receipts = vec![
        MultipartPartReceipt::new(
            1,
            plans[0].expected_bytes(),
            plans[0].expected_sha256().clone(),
            first_etag,
        )
        .unwrap(),
        MultipartPartReceipt::new(
            2,
            plans[1].expected_bytes(),
            plans[1].expected_sha256().clone(),
            second_etag,
        )
        .unwrap(),
    ];
    service
        .record_receipts(context, receipts.clone())
        .await
        .unwrap();
    service.record_receipts(context, receipts).await.unwrap();
    assert!(
        !service
            .complete(context)
            .await
            .unwrap()
            .is_idempotent_retry()
    );
    assert!(
        service
            .complete(context)
            .await
            .unwrap()
            .is_idempotent_retry()
    );
    let state: String = sqlx::query_scalar("SELECT state FROM save_sessions WHERE id=$1::uuid")
        .bind(created.session_id().to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(state, "verifying");

    let boundary_service = MultipartService::new(
        pool.clone(),
        store,
        MultipartServicePolicy::new(
            Duration::from_secs(10),
            5,
            8 * 1024 * 1024,
            16 * 1024 * 1024,
            4,
        )
        .unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    let boundary = multipart_boundary_request(PROJECT_B, "multipart-boundary-01");
    let boundary_session = boundary_service.create(boundary).await.unwrap();
    assert_eq!(boundary_session.part_count(), 128);
    let boundary_context = MultipartSessionContext {
        storage_scope_id: StorageScopeId::from_str(SCOPE).unwrap(),
        project_id: ProjectId::from_str(PROJECT_B).unwrap(),
        actor_user_id: UserId::from_str(USER).unwrap(),
        session_id: boundary_session.session_id(),
    };
    boundary_service.abort(boundary_context).await.unwrap();
    assert_eq!(
        reservation_count(&pool, boundary_session.session_id().to_string()).await,
        0
    );

    verify_attach_failure_compensation(&pool, &config).await;
    verify_complete_response_loss(&pool, &config, &ca_file).await;

    let rendered = format!("{created:?} {capabilities:?}");
    for prohibited in [
        endpoint.as_str(),
        ca_file.as_str(),
        ACCESS_KEY,
        SECRET_KEY,
        "X-Amz-Signature",
        "multipart-happy-0001",
    ] {
        assert!(!rendered.contains(prohibited));
    }
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[derive(Clone, Copy)]
enum AbortBehavior {
    Confirmed,
    Failed,
    Hanging,
}

#[derive(Clone)]
struct AttachFailureStore {
    inner: S3ObjectStore,
    pool: DatabasePool,
    project_id: ProjectId,
    abort_behavior: AbortBehavior,
}

impl MultipartStore for AttachFailureStore {
    type Error = ();

    async fn create(&self, key: ObjectKey) -> Result<MultipartUpload, Self::Error> {
        let upload = self.inner.create_multipart(key).await.map_err(|_| ())?;
        sqlx::query(
            "UPDATE projects SET state='archived',archived_at=transaction_timestamp(), \
             updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
        )
        .bind(self.project_id.to_string())
        .execute(&mut *self.pool.acquire().await.map_err(|_| ())?)
        .await
        .map_err(|_| ())?;
        Ok(upload)
    }

    async fn presign_part(
        &self,
        request: PresignedMultipartPartRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        self.inner
            .presign_multipart_part(request)
            .await
            .map_err(|_| ())
    }

    async fn complete(
        &self,
        upload: &MultipartUpload,
        parts: Vec<UploadedPart>,
    ) -> Result<(), Self::Error> {
        self.inner
            .complete_multipart(upload, parts)
            .await
            .map_err(|_| ())
    }

    async fn abort(&self, upload: &MultipartUpload) -> Result<(), Self::Error> {
        match self.abort_behavior {
            AbortBehavior::Confirmed => self.inner.abort_multipart(upload).await.map_err(|_| ()),
            AbortBehavior::Failed => Err(()),
            AbortBehavior::Hanging => std::future::pending().await,
        }
    }
}

#[derive(Clone)]
struct LostCompleteStore(S3ObjectStore);

impl MultipartStore for LostCompleteStore {
    type Error = ();

    async fn create(&self, key: ObjectKey) -> Result<MultipartUpload, Self::Error> {
        self.0.create_multipart(key).await.map_err(|_| ())
    }

    async fn presign_part(
        &self,
        request: PresignedMultipartPartRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        self.0.presign_multipart_part(request).await.map_err(|_| ())
    }

    async fn complete(
        &self,
        upload: &MultipartUpload,
        parts: Vec<UploadedPart>,
    ) -> Result<(), Self::Error> {
        self.0
            .complete_multipart(upload, parts)
            .await
            .map_err(|_| ())?;
        Err(())
    }

    async fn abort(&self, upload: &MultipartUpload) -> Result<(), Self::Error> {
        self.0.abort_multipart(upload).await.map_err(|_| ())
    }
}

async fn verify_attach_failure_compensation(pool: &DatabasePool, config: &ObjectStorageConfig) {
    for (project, scope, actor, key, behavior, timeout) in [
        (
            PROJECT_FAIL,
            SCOPE,
            USER,
            "multipart-attach-abort-ok",
            AbortBehavior::Confirmed,
            Duration::from_secs(5),
        ),
        (
            PROJECT_TIMEOUT,
            SCOPE,
            USER,
            "multipart-attach-abort-fail",
            AbortBehavior::Failed,
            Duration::from_secs(5),
        ),
        (
            ORG_PROJECT_OWNER,
            ORG_SCOPE,
            ORG_OWNER,
            "multipart-attach-abort-hang",
            AbortBehavior::Hanging,
            Duration::from_millis(500),
        ),
    ] {
        let inner = S3ObjectStore::new(config, OperationLimits::default())
            .await
            .unwrap();
        let service = MultipartService::new(
            pool.clone(),
            AttachFailureStore {
                inner,
                pool: pool.clone(),
                project_id: ProjectId::from_str(project).unwrap(),
                abort_behavior: behavior,
            },
            MultipartServicePolicy::new(timeout, 5, 8 * 1024 * 1024, 8 * 1024 * 1024, 4).unwrap(),
            IdempotencySecret::new([0x5a; 32]).unwrap(),
        )
        .unwrap();
        assert_eq!(
            service
                .create(multipart_request_for(scope, project, actor, key))
                .await
                .unwrap_err(),
            MultipartServiceError::CreateReconciliationRequired
        );
        let (session_id, state, create_status, reservations): (String, String, String, i64) =
            sqlx::query_as(
                "SELECT session.id::text,session.state,lifecycle.create_status, \
                 (SELECT COUNT(*) FROM storage_reservations reservation \
                  WHERE reservation.save_session_id=session.id) \
                 FROM save_sessions session JOIN multipart_lifecycles lifecycle \
                   ON lifecycle.save_session_id=session.id WHERE session.project_id=$1::uuid \
                   AND session.upload_mode='multipart'",
            )
            .bind(project)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
        match behavior {
            AbortBehavior::Confirmed => assert_eq!(
                (state.as_str(), create_status.as_str(), reservations),
                ("failed", "cleaned", 0)
            ),
            AbortBehavior::Failed | AbortBehavior::Hanging => {
                let expected_marker = match behavior {
                    AbortBehavior::Failed => "unknown",
                    AbortBehavior::Hanging => "creating",
                    AbortBehavior::Confirmed => unreachable!(),
                };
                assert_eq!(
                    (state.as_str(), create_status.as_str(), reservations),
                    ("created", expected_marker, 1)
                );
                assert!(
                    sqlx::query(
                        "UPDATE save_sessions SET state='failed',terminal_at=transaction_timestamp(), \
                         updated_at=transaction_timestamp() WHERE id=$1::uuid",
                    )
                    .bind(session_id)
                    .execute(&mut *pool.acquire().await.unwrap())
                    .await
                    .is_err()
                );
            }
        }
    }
}

async fn verify_complete_response_loss(
    pool: &DatabasePool,
    config: &ObjectStorageConfig,
    ca_file: &str,
) {
    let store = S3ObjectStore::new(config, OperationLimits::default())
        .await
        .unwrap();
    let service = MultipartService::new(
        pool.clone(),
        LostCompleteStore(store),
        MultipartServicePolicy::new(
            Duration::from_secs(10),
            5,
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            4,
        )
        .unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    let first = Bytes::from(vec![0x61; 8 * 1024 * 1024]);
    let second = Bytes::from_static(b"response-loss-tail");
    let request = multipart_request_for_bodies(
        ORG_SCOPE,
        ORG_PROJECT_WRITE,
        ORG_WRITE,
        "multipart-complete-loss",
        &[first.clone(), second.clone()],
    );
    let plans = request.parts.clone();
    let session = service.create(request).await.unwrap();
    let context = MultipartSessionContext {
        storage_scope_id: StorageScopeId::from_str(ORG_SCOPE).unwrap(),
        project_id: ProjectId::from_str(ORG_PROJECT_WRITE).unwrap(),
        actor_user_id: UserId::from_str(ORG_WRITE).unwrap(),
        session_id: session.session_id(),
    };
    let capabilities = service.issue_parts(context, plans.clone()).await.unwrap();
    let client = fixture_http_client(ca_file);
    let first_etag = send_multipart_part(&client, capabilities[0].request(), &first)
        .await
        .unwrap();
    let second_etag = send_multipart_part(&client, capabilities[1].request(), &second)
        .await
        .unwrap();
    service
        .record_receipts(
            context,
            vec![
                MultipartPartReceipt::new(
                    1,
                    plans[0].expected_bytes(),
                    plans[0].expected_sha256().clone(),
                    first_etag,
                )
                .unwrap(),
                MultipartPartReceipt::new(
                    2,
                    plans[1].expected_bytes(),
                    plans[1].expected_sha256().clone(),
                    second_etag,
                )
                .unwrap(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        service.complete(context).await.unwrap_err(),
        MultipartServiceError::CompleteReconciliationRequired
    );
    let (state, complete_status, reservations): (String, String, i64) = sqlx::query_as(
        "SELECT session.state,lifecycle.complete_status, \
         (SELECT COUNT(*) FROM storage_reservations reservation \
          WHERE reservation.save_session_id=session.id) \
         FROM save_sessions session JOIN multipart_lifecycles lifecycle \
           ON lifecycle.save_session_id=session.id WHERE session.id=$1::uuid",
    )
    .bind(session.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        (state.as_str(), complete_status.as_str(), reservations),
        ("uploading", "unknown", 1)
    );
    assert!(
        sqlx::query(
            "UPDATE save_sessions SET state='failed',terminal_at=transaction_timestamp(), \
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
        )
        .bind(session.session_id().to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err()
    );
}

#[derive(Clone)]
struct FailingPresigner;

impl PutPresigner for FailingPresigner {
    type Error = ();

    async fn presign(
        &self,
        _request: PresignedPutRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        Err(())
    }
}

#[derive(Clone)]
struct HangingPresigner;

impl PutPresigner for HangingPresigner {
    type Error = ();

    async fn presign(
        &self,
        _request: PresignedPutRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        std::future::pending().await
    }
}

fn request(project: &str, idempotency: &str, body: &[u8]) -> CreateSinglePutSession {
    request_for(SCOPE, project, USER, idempotency, body)
}

fn verification_context(
    project: &str,
    session_id: nuriteo_server::quota::SaveSessionId,
) -> VerifyStagingBundle {
    VerifyStagingBundle {
        storage_scope_id: StorageScopeId::from_str(SCOPE).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(USER).unwrap(),
        session_id,
    }
}

fn canonical_test_bundle(project: &str, scope: &str, path: &str, content: &[u8]) -> Vec<u8> {
    let content_sha = hex_digest(content);
    let manifest = format!(
        "{{\"format\":\"project-bundle-v1\",\"schemaVersion\":1,\"project\":{{\"id\":\"{project}\",\"storageScopeId\":\"{scope}\"}},\"fileCount\":1,\"logicalBytes\":{},\"files\":[{{\"path\":\"{path}\",\"kind\":\"text\",\"mode\":\"0644\",\"sizeBytes\":{},\"sha256\":\"{content_sha}\"}}]}}\n",
        content.len(),
        content.len()
    );
    let mut archive = test_tar_entry("manifest.json", b'0', 0o644, manifest.as_bytes());
    let pax = test_pax_record(&format!("files/{path}"));
    archive.extend(test_tar_entry(
        "PaxHeaders/00000000",
        b'x',
        0o644,
        pax.as_bytes(),
    ));
    archive.extend(test_tar_entry("files/00000000", b'0', 0o644, content));
    archive.extend([0_u8; 1024]);
    archive
}

fn canonical_multi_file_bundle(project: &str, scope: &str, files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let logical_bytes = files
        .iter()
        .map(|(_, content)| content.len())
        .sum::<usize>();
    let manifest_files = files
        .iter()
        .map(|(path, content)| {
            format!(
                "{{\"path\":\"{path}\",\"kind\":\"binary\",\"mode\":\"0644\",\"sizeBytes\":{},\"sha256\":\"{}\"}}",
                content.len(),
                hex_digest(content)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let manifest = format!(
        "{{\"format\":\"project-bundle-v1\",\"schemaVersion\":1,\"project\":{{\"id\":\"{project}\",\"storageScopeId\":\"{scope}\"}},\"fileCount\":{},\"logicalBytes\":{logical_bytes},\"files\":[{manifest_files}]}}\n",
        files.len()
    );
    let mut archive = test_tar_entry("manifest.json", b'0', 0o644, manifest.as_bytes());
    for (index, (path, content)) in files.iter().enumerate() {
        let sequence = format!("{index:08}");
        let pax = test_pax_record(&format!("files/{path}"));
        archive.extend(test_tar_entry(
            &format!("PaxHeaders/{sequence}"),
            b'x',
            0o644,
            pax.as_bytes(),
        ));
        archive.extend(test_tar_entry(
            &format!("files/{sequence}"),
            b'0',
            0o644,
            content,
        ));
    }
    archive.extend([0_u8; 1024]);
    archive
}

fn test_tar_entry(name: &str, kind: u8, mode: u64, content: &[u8]) -> Vec<u8> {
    let mut header = [0_u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    test_octal(&mut header[100..108], mode);
    test_octal(&mut header[108..116], 0);
    test_octal(&mut header[116..124], 0);
    test_octal(&mut header[124..136], content.len() as u64);
    test_octal(&mut header[136..148], 0);
    header[148..156].fill(b' ');
    header[156] = kind;
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
    let checksum = format!("{checksum:06o}");
    header[148..154].copy_from_slice(checksum.as_bytes());
    header[154] = 0;
    header[155] = b' ';
    let mut entry = header.to_vec();
    entry.extend(content);
    entry.resize(entry.len() + ((512 - content.len() % 512) % 512), 0);
    entry
}

fn test_octal(target: &mut [u8], value: u64) {
    let digits = format!("{:0width$o}", value, width = target.len() - 1);
    let count = target.len() - 1;
    target[..count].copy_from_slice(digits.as_bytes());
    target[count] = 0;
}

fn test_pax_record(path: &str) -> String {
    let body = format!("path={path}\n");
    let mut length = body.len() + 2;
    loop {
        let record = format!("{length} {body}");
        if record.len() == length {
            return record;
        }
        length = record.len();
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut value = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        let _ = write!(value, "{byte:02x}");
    }
    value
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn multipart_request(project: &str, idempotency: &str, bodies: &[Bytes]) -> CreateMultipartSession {
    multipart_request_for_bodies(SCOPE, project, USER, idempotency, bodies)
}

fn multipart_request_for_bodies(
    scope: &str,
    project: &str,
    actor: &str,
    idempotency: &str,
    bodies: &[Bytes],
) -> CreateMultipartSession {
    let parts = bodies
        .iter()
        .enumerate()
        .map(|(index, body)| {
            MultipartPartPlan::new(
                u16::try_from(index + 1).unwrap(),
                body.len() as u64,
                Sha256Checksum::calculate(body),
            )
        })
        .collect::<Vec<_>>();
    let total = parts.iter().map(MultipartPartPlan::expected_bytes).sum();
    CreateMultipartSession {
        storage_scope_id: StorageScopeId::from_str(scope).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(actor).unwrap(),
        expected_project_version: ProjectVersion::new(1).unwrap(),
        expected_physical_bytes: total,
        expected_logical_bytes: 0,
        expected_file_count: 0,
        expected_sha256: Sha256Checksum::from_bytes([0x73; 32]),
        effective_quota: EffectiveQuota::unlimited(),
        idempotency_key: IdempotencyKey::new(idempotency.to_owned()).unwrap(),
        parts,
    }
}

fn multipart_request_for(
    scope: &str,
    project: &str,
    actor: &str,
    idempotency: &str,
) -> CreateMultipartSession {
    let first = Bytes::from(vec![0x51; 8 * 1024 * 1024]);
    let second = Bytes::from_static(b"attach-failure-tail");
    let mut request = multipart_request(project, idempotency, &[first, second]);
    request.storage_scope_id = StorageScopeId::from_str(scope).unwrap();
    request.actor_user_id = UserId::from_str(actor).unwrap();
    request
}

fn multipart_boundary_request(project: &str, idempotency: &str) -> CreateMultipartSession {
    let part_size = 16 * 1024 * 1024_u64;
    let parts = (1..=128)
        .map(|number| {
            MultipartPartPlan::new(
                number,
                part_size,
                Sha256Checksum::from_bytes([u8::try_from(number).unwrap(); 32]),
            )
        })
        .collect();
    CreateMultipartSession {
        storage_scope_id: StorageScopeId::from_str(SCOPE).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(USER).unwrap(),
        expected_project_version: ProjectVersion::new(1).unwrap(),
        expected_physical_bytes: 2 * 1024 * 1024 * 1024,
        expected_logical_bytes: 0,
        expected_file_count: 0,
        expected_sha256: Sha256Checksum::from_bytes([0x74; 32]),
        effective_quota: EffectiveQuota::unlimited(),
        idempotency_key: IdempotencyKey::new(idempotency.to_owned()).unwrap(),
        parts,
    }
}

fn request_for(
    storage_scope: &str,
    project: &str,
    actor: &str,
    idempotency: &str,
    body: &[u8],
) -> CreateSinglePutSession {
    CreateSinglePutSession {
        storage_scope_id: StorageScopeId::from_str(storage_scope).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(actor).unwrap(),
        expected_project_version: ProjectVersion::new(1).unwrap(),
        expected_physical_bytes: body.len() as u64,
        expected_logical_bytes: 0,
        expected_file_count: 0,
        expected_sha256: Sha256Checksum::calculate(body),
        effective_quota: EffectiveQuota::limited(1_000_000).unwrap(),
        idempotency_key: IdempotencyKey::new(idempotency.to_owned()).unwrap(),
    }
}

async fn verify_authorization(service: &SinglePutService, body: &[u8]) {
    assert_eq!(
        service
            .create(request_for(
                SCOPE,
                PROJECT_B,
                OUTSIDER,
                "personal-outsider-01",
                body,
            ))
            .await
            .unwrap_err(),
        SinglePutServiceError::ProjectNotFound
    );
    service
        .create(request_for(
            ORG_SCOPE,
            ORG_PROJECT_OWNER,
            ORG_OWNER,
            "org-owner-save-0001",
            body,
        ))
        .await
        .unwrap();
    service
        .create(request_for(
            ORG_SCOPE,
            ORG_PROJECT_WRITE,
            ORG_WRITE,
            "org-write-save-0001",
            body,
        ))
        .await
        .unwrap();
    for (project, actor, key) in [
        (ORG_PROJECT_READ, ORG_READ, "org-read-denied-001"),
        (ORG_PROJECT_MEMBER, ORG_MEMBER, "org-member-denied1"),
        (ORG_PROJECT_OUTSIDER, OUTSIDER, "org-outsider-deny1"),
    ] {
        assert_eq!(
            service
                .create(request_for(ORG_SCOPE, project, actor, key, body))
                .await
                .unwrap_err(),
            SinglePutServiceError::ProjectNotFound
        );
    }
}

async fn send_with_mutation(
    client: &reqwest::Client,
    capability: &BoundedPresignedRequest,
    body: &[u8],
    header_override: Option<(&str, &str)>,
    url_replacement: Option<(&str, &str)>,
) -> bool {
    let url = if let Some((from, to)) = url_replacement {
        let changed = capability.expose_bearer_url().replace(from, to);
        assert_ne!(changed, capability.expose_bearer_url());
        changed
    } else {
        capability.expose_bearer_url().to_owned()
    };
    let mut request = client.put(url);
    for (name, value) in capability.signed_headers() {
        if header_override.is_none_or(|(override_name, _)| override_name != name) {
            request = request.header(name, value);
        }
    }
    if let Some((name, value)) = header_override {
        request = request.header(name, value);
    }
    request
        .body(body.to_vec())
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

async fn send_multipart_part(
    client: &reqwest::Client,
    capability: &BoundedPresignedRequest,
    body: &[u8],
) -> Option<String> {
    let mut request = client.put(capability.expose_bearer_url());
    for (name, value) in capability.signed_headers() {
        request = request.header(name, value);
    }
    let response = request.body(body.to_vec()).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn fixture_http_client(ca_file: &str) -> reqwest::Client {
    let certificate = reqwest::Certificate::from_pem(&fs::read(ca_file).unwrap()).unwrap();
    reqwest::Client::builder()
        .add_root_certificate(certificate)
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}

#[derive(Clone)]
struct VersionBrowser {
    cookie: String,
    csrf: String,
}

fn version_http_router(pool: DatabasePool) -> Router {
    let external_url = Url::parse(WEB_ORIGIN).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let projects = ProjectHttpService::production(
        pool,
        &external_url,
        ProjectHttpPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    build_router_with_project_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        projects,
        SetupStatusService::unconfigured(),
    )
}

async fn save_http_service(
    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
) -> Result<(ProjectHttpService, SaveHttpService), SaveHttpError> {
    save_http_service_with_transport(pool, store, secret, SaveUploadTransport::Direct).await
}

async fn save_http_service_with_transport(
    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
    transport: SaveUploadTransport,
) -> Result<(ProjectHttpService, SaveHttpService), SaveHttpError> {
    let external_url = Url::parse(WEB_ORIGIN).unwrap();
    let projects = ProjectHttpService::production_with_content(
        pool.clone(),
        &external_url,
        ProjectHttpPolicy::default(),
        SessionPolicy::default(),
        store.clone(),
        ContentServicePolicy::default(),
    )
    .unwrap();
    let save = SaveHttpService::production(
        pool,
        projects.clone(),
        store,
        secret,
        EffectiveQuota::limited(10 * 1024 * 1024 * 1024).unwrap(),
        transport,
        SaveHttpPolicy::default(),
        CleanupWorkerPolicy::default(),
    )
    .await?;
    Ok((projects, save))
}

async fn save_http_router_with_transport(
    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
    transport: SaveUploadTransport,
) -> Result<Router, SaveHttpError> {
    let external_url = Url::parse(WEB_ORIGIN).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let (projects, save) = save_http_service_with_transport(pool, store, secret, transport).await?;
    Ok(build_router_with_save_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        projects,
        save,
        SetupStatusService::unconfigured(),
    ))
}

async fn save_http_router(
    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
) -> Result<Router, SaveHttpError> {
    let external_url = Url::parse(WEB_ORIGIN).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let (projects, save) = save_http_service(pool, store, secret).await?;
    Ok(build_router_with_save_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        projects,
        save,
        SetupStatusService::unconfigured(),
    ))
}

async fn version_login(router: &Router, email: &str) -> VersionBrowser {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/auth/sessions")
                .header(CONTENT_TYPE, "application/json")
                .header(ORIGIN, WEB_ORIGIN)
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "email": email,
                        "password": TEST_PASSWORD,
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let pairs = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| {
            value
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    let csrf = pairs
        .iter()
        .find_map(|pair| pair.strip_prefix("nuriteo_dev_csrf="))
        .unwrap()
        .to_owned();
    VersionBrowser {
        cookie: pairs.join("; "),
        csrf,
    }
}

async fn version_json_request(
    router: &Router,
    browser: &VersionBrowser,
    method: Method,
    uri: &str,
    etag: Option<&str>,
    idempotency_key: Option<&str>,
    body: Value,
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, WEB_ORIGIN)
        .header(COOKIE, &browser.cookie)
        .header("x-csrf-token", &browser.csrf);
    if let Some(etag) = etag {
        builder = builder.header(IF_MATCH, etag);
    }
    if let Some(idempotency_key) = idempotency_key {
        builder = builder.header("idempotency-key", idempotency_key);
    }
    router
        .clone()
        .oneshot(
            builder
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn version_empty_request(
    router: &Router,
    browser: &VersionBrowser,
    uri: &str,
) -> Response<Body> {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(uri)
                .header(ORIGIN, WEB_ORIGIN)
                .header(COOKIE, &browser.cookie)
                .header("x-csrf-token", &browser.csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn version_empty_mutation(
    router: &Router,
    browser: &VersionBrowser,
    method: Method,
    uri: &str,
) -> Response<Body> {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(ORIGIN, WEB_ORIGIN)
                .header(COOKIE, &browser.cookie)
                .header("x-csrf-token", &browser.csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn create_relay_single_session(
    router: &Router,
    browser: &VersionBrowser,
    project_id: &str,
    idempotency_key: &str,
    file_name: &str,
) -> (Value, Vec<u8>, String) {
    let content = format!("relay lease {project_id}\n").into_bytes();
    let bundle = canonical_test_bundle(project_id, SCOPE, file_name, &content);
    let collection = format!("/api/v1/workspaces/users/{USER}/projects/{project_id}/save-sessions");
    let response = version_json_request(
        router,
        browser,
        Method::POST,
        &collection,
        Some("\"project-v1\""),
        Some(idempotency_key),
        json!({
            "physicalBytes": bundle.len(),
            "logicalBytes": content.len(),
            "fileCount": 1,
            "sha256": BASE64.encode(Sha256::digest(&bundle)),
            "parts": []
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    (version_response_json(response).await, bundle, collection)
}

async fn create_organization_relay_session(
    router: &Router,
    browser: &VersionBrowser,
    project_id: &str,
    idempotency_key: &str,
) -> Value {
    let content = format!("organization relay {project_id}\n").into_bytes();
    let bundle = canonical_test_bundle(project_id, ORG_SCOPE, "race.txt", &content);
    let collection =
        format!("/api/v1/workspaces/organizations/{ORG}/projects/{project_id}/save-sessions");
    let response = version_json_request(
        router,
        browser,
        Method::POST,
        &collection,
        Some("\"project-v1\""),
        Some(idempotency_key),
        json!({
            "physicalBytes": bundle.len(),
            "logicalBytes": content.len(),
            "fileCount": 1,
            "sha256": BASE64.encode(Sha256::digest(&bundle)),
            "parts": []
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    version_response_json(response).await
}

struct RelayMultipartFixture {
    session_id: String,
    capabilities: Vec<Value>,
    bodies: Vec<Bytes>,
}

async fn create_relay_multipart_session(
    router: &Router,
    browser: &VersionBrowser,
    owner_type: &str,
    owner_id: &str,
    project_id: &str,
    idempotency_key: &str,
) -> RelayMultipartFixture {
    let part_sizes = [
        16 * 1024 * 1024,
        16 * 1024 * 1024,
        16 * 1024 * 1024,
        16 * 1024 * 1024,
        1024 * 1024,
    ];
    let bodies = part_sizes
        .into_iter()
        .enumerate()
        .map(|(index, size)| Bytes::from(vec![0x61_u8.saturating_add(index as u8); size]))
        .collect::<Vec<_>>();
    let parts = bodies
        .iter()
        .enumerate()
        .map(|(index, body)| {
            json!({
                "partNumber": index + 1,
                "expectedBytes": body.len(),
                "sha256": BASE64.encode(Sha256::digest(body))
            })
        })
        .collect::<Vec<_>>();
    let mut digest = Sha256::new();
    for body in &bodies {
        digest.update(body);
    }
    let collection =
        format!("/api/v1/workspaces/{owner_type}/{owner_id}/projects/{project_id}/save-sessions");
    let created = version_json_request(
        router,
        browser,
        Method::POST,
        &collection,
        Some("\"project-v1\""),
        Some(idempotency_key),
        json!({
            "physicalBytes": bodies.iter().map(Bytes::len).sum::<usize>(),
            "logicalBytes": 65 * 1024 * 1024,
            "fileCount": 5,
            "sha256": BASE64.encode(digest.finalize()),
            "parts": parts
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = version_response_json(created).await;
    let session_id = created["sessionId"].as_str().unwrap().to_owned();
    let issued = version_json_request(
        router,
        browser,
        Method::POST,
        &format!("{collection}/{session_id}/parts"),
        None,
        None,
        json!({"parts": parts}),
    )
    .await;
    assert_eq!(issued.status(), StatusCode::OK);
    let capabilities = version_response_json(issued)
        .await
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(capabilities.len(), bodies.len());
    RelayMultipartFixture {
        session_id,
        capabilities,
        bodies,
    }
}

async fn version_response_json(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 256 * 1024).await.unwrap()).unwrap()
}

fn relay_put_request(
    capability: &Value,
    browser: &VersionBrowser,
    body: Body,
    length_override: Option<u64>,
    checksum_override: Option<String>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::PUT)
        .uri(capability["path"].as_str().unwrap())
        .header(ORIGIN, WEB_ORIGIN)
        .header(COOKIE, &browser.cookie)
        .header("x-csrf-token", &browser.csrf)
        .header(
            "content-length",
            length_override.unwrap_or_else(|| capability["expectedBytes"].as_u64().unwrap()),
        );
    for header in capability["headers"].as_array().unwrap() {
        let name = header["name"].as_str().unwrap();
        let value = if name.eq_ignore_ascii_case("x-nuriteo-content-sha256") {
            checksum_override
                .as_deref()
                .unwrap_or_else(|| header["value"].as_str().unwrap())
        } else {
            header["value"].as_str().unwrap()
        };
        builder = builder.header(name, value);
    }
    builder.body(body).unwrap()
}

async fn relay_put_over_http(
    address: std::net::SocketAddr,
    capability: &Value,
    browser: &VersionBrowser,
    body: &[u8],
) -> StatusCode {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let mut request = client
        .put(format!(
            "http://{address}{}",
            capability["path"].as_str().unwrap()
        ))
        .header(ORIGIN.as_str(), WEB_ORIGIN)
        .header(COOKIE.as_str(), &browser.cookie)
        .header("x-csrf-token", &browser.csrf)
        .header("content-length", body.len());
    for header in capability["headers"].as_array().unwrap() {
        request = request.header(
            header["name"].as_str().unwrap(),
            header["value"].as_str().unwrap(),
        );
    }
    let response = request.body(body.to_vec()).send().await.unwrap();
    StatusCode::from_u16(response.status().as_u16()).unwrap()
}

async fn download_current_content(
    router: &Router,
    browser: &VersionBrowser,
    project_id: &str,
    maximum: usize,
) -> Vec<u8> {
    let descriptor_response = version_empty_request(
        router,
        browser,
        &format!("/api/v1/workspaces/users/{USER}/projects/{project_id}/content"),
    )
    .await;
    assert_eq!(descriptor_response.status(), StatusCode::OK);
    let descriptor = version_response_json(descriptor_response).await;
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(descriptor["downloadUrl"].as_str().unwrap())
                .header(COOKIE, &browser.cookie)
                .header(IF_MATCH, descriptor["etag"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    to_bytes(response.into_body(), maximum + 1)
        .await
        .unwrap()
        .to_vec()
}

fn assert_relay_projection_is_private(value: &Value, prohibited: &[&str]) {
    let serialized = value.to_string();
    for prohibited in prohibited {
        assert!(
            !serialized.contains(prohibited),
            "relay projection leaked prohibited material"
        );
    }
}

async fn capture_private_problem(
    response: Response<Body>,
    expected_status: StatusCode,
    captured: &mut Vec<String>,
) {
    assert_eq!(response.status(), expected_status);
    assert_eq!(
        response.headers().get(CONTENT_TYPE).unwrap(),
        "application/problem+json"
    );
    captured.push(
        String::from_utf8(
            to_bytes(response.into_body(), 64 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap(),
    );
}

#[derive(Clone)]
struct CapturedLogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLogWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for CapturedLogWriter {
    type Writer = Self;

    fn make_writer(&'writer self) -> Self::Writer {
        self.clone()
    }
}

fn normalized_for_leak_scan(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn assert_no_normalized_sensitive_leak(rendered: &str, sensitive: &[String]) {
    let normalized = normalized_for_leak_scan(rendered);
    for secret in sensitive {
        let candidate = normalized_for_leak_scan(secret);
        assert!(candidate.len() >= 12);
        assert!(
            !normalized.contains(&candidate),
            "response or structured log leaked normalized sensitive material"
        );
    }
}

fn append_digest_renderings(sensitive: &mut Vec<String>, digest: &[u8]) {
    sensitive.push(
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    );
    sensitive.push(BASE64.encode(digest));
    sensitive.push(format!("{digest:?}"));
}

fn append_capability_checksums(checksums: &mut Vec<String>, capability: &Value) {
    for header in capability["headers"].as_array().unwrap() {
        if header["name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case("x-nuriteo-content-sha256"))
        {
            checksums.push(header["value"].as_str().unwrap().to_owned());
        }
    }
}

struct NeverReadBody;

impl http_body::Body for NeverReadBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        panic!("relay request body was polled before validation completed")
    }
}

struct BoundedFrameBody {
    content: Bytes,
    offset: usize,
}

struct ObservedFrameBody {
    body: BoundedFrameBody,
    polled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

struct GatedFrameBody {
    receiver: tokio::sync::mpsc::Receiver<Bytes>,
    remaining: u64,
}

fn gated_frame_body(expected_bytes: usize) -> (tokio::sync::mpsc::Sender<Bytes>, Body) {
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    (
        sender,
        Body::new(GatedFrameBody {
            receiver,
            remaining: expected_bytes as u64,
        }),
    )
}

impl http_body::Body for GatedFrameBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        match self.receiver.poll_recv(cx) {
            Poll::Ready(Some(frame)) => {
                self.remaining = self.remaining.saturating_sub(frame.len() as u64);
                Poll::Ready(Some(Ok(http_body::Frame::data(frame))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.remaining)
    }
}

async fn send_bounded_frames(sender: tokio::sync::mpsc::Sender<Bytes>, content: &[u8]) {
    for frame in content.chunks(64 * 1024) {
        sender.send(Bytes::copy_from_slice(frame)).await.unwrap();
    }
}

async fn wait_for_active_relay_lease(pool: &DatabasePool, session_id: &str, part_number: i16) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let active: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM save_upload_leases \
                 WHERE save_session_id=$1::uuid AND part_number=$2 \
                   AND released_at IS NULL AND lease_expires_at>clock_timestamp())",
            )
            .bind(session_id)
            .bind(part_number)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
            if active {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn assert_released_relay_generation(
    pool: &DatabasePool,
    session_id: &str,
    part_number: i16,
    expected_generation: i64,
) {
    let persisted: (i64, bool) = sqlx::query_as(
        "SELECT generation,released_at IS NOT NULL FROM save_upload_leases \
         WHERE save_session_id=$1::uuid AND part_number=$2",
    )
    .bind(session_id)
    .bind(part_number)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(persisted, (expected_generation, true));
}

async fn wait_for_relay_scope_lock_wait(pool: &DatabasePool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity \
                 WHERE wait_event_type='Lock' \
                   AND query LIKE 'SELECT id::text FROM storage_scopes WHERE id = $1::uuid FOR UPDATE%')",
            )
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
            if waiting {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

impl BoundedFrameBody {
    fn new(content: &[u8]) -> Self {
        Self {
            content: Bytes::copy_from_slice(content),
            offset: 0,
        }
    }
}

impl ObservedFrameBody {
    fn new(content: &[u8], polled: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Self {
        Self {
            body: BoundedFrameBody::new(content),
            polled,
        }
    }
}

impl http_body::Body for ObservedFrameBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        self.polled.store(true, std::sync::atomic::Ordering::SeqCst);
        Pin::new(&mut self.body).poll_frame(cx)
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

impl http_body::Body for BoundedFrameBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        if self.offset == self.content.len() {
            return Poll::Ready(None);
        }
        let end = self
            .offset
            .saturating_add(64 * 1024)
            .min(self.content.len());
        let frame = self.content.slice(self.offset..end);
        self.offset = end;
        Poll::Ready(Some(Ok(http_body::Frame::data(frame))))
    }

    fn size_hint(&self) -> http_body::SizeHint {
        let remaining = self.content.len().saturating_sub(self.offset) as u64;
        http_body::SizeHint::with_exact(remaining)
    }
}

async fn reset_and_seed(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    connection.execute("INSERT INTO users (id,email,normalized_email,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008001','save@example.test','save@example.test','Save Owner'),\
        ('0199ee6c-c777-7000-8000-000000008002','outside@example.test','outside@example.test','Outside'),\
        ('0199ee6c-c777-7000-8000-000000008003','org-owner@example.test','org-owner@example.test','Org Owner'),\
        ('0199ee6c-c777-7000-8000-000000008004','org-read@example.test','org-read@example.test','Org Read'),\
        ('0199ee6c-c777-7000-8000-000000008005','org-write@example.test','org-write@example.test','Org Write'),\
        ('0199ee6c-c777-7000-8000-000000008006','org-member@example.test','org-member@example.test','Org Member')").await.unwrap();
    connection
        .execute(
            "INSERT INTO organizations (id,slug,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008030','save-org','Save Org')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO organization_memberships (organization_id,user_id,role) VALUES \
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008003','owner'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008004','member'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','member'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008006','member')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_scopes (id,owner_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000008010','0199ee6c-c777-7000-8000-000000008001')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_scopes (id,owner_organization_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000008031','0199ee6c-c777-7000-8000-000000008030')",
        )
        .await
        .unwrap();
    connection.execute("INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008020','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-a','Save A'),\
        ('0199ee6c-c777-7000-8000-000000008021','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-b','Save B'),\
        ('0199ee6c-c777-7000-8000-000000008022','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-fail','Save Fail'),\
        ('0199ee6c-c777-7000-8000-000000008023','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-timeout','Save Timeout'),\
        ('0199ee6c-c777-7000-8000-000000008026','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','lease-abort','Lease Abort'),\
        ('0199ee6c-c777-7000-8000-000000008027','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','lease-expire','Lease Expire'),\
        ('0199ee6c-c777-7000-8000-000000008028','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','lease-complete','Lease Complete'),\
        ('0199ee6c-c777-7000-8000-000000008029','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','multi-expiry','Multi Expiry'),\
        ('0199ee6c-c777-7000-8000-00000000802a','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','lease-clock','Lease Clock')").await.unwrap();
    connection.execute("INSERT INTO projects (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008040','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-owner-save','Owner Save'),\
        ('0199ee6c-c777-7000-8000-000000008041','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-read-save','Read Save'),\
        ('0199ee6c-c777-7000-8000-000000008042','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-write-save','Write Save'),\
        ('0199ee6c-c777-7000-8000-000000008043','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-member-save','Member Save'),\
        ('0199ee6c-c777-7000-8000-000000008044','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-outsider-save','Outsider Save'),\
        ('0199ee6c-c777-7000-8000-000000008045','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','multi-revoke','Multi Revoke'),\
        ('0199ee6c-c777-7000-8000-000000008046','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','multi-archive','Multi Archive')").await.unwrap();
    connection.execute("INSERT INTO project_user_roles (project_id,organization_id,user_id,role) VALUES \
        ('0199ee6c-c777-7000-8000-000000008041','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008004','read'),\
        ('0199ee6c-c777-7000-8000-000000008042','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','write'),\
        ('0199ee6c-c777-7000-8000-000000008045','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','write')").await.unwrap();
}

async fn reservation_count(pool: &DatabasePool, session: String) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=$1::uuid")
        .bind(session)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn terminal_cleanup_state(pool: &DatabasePool, session: String) -> (String, i64, i64) {
    sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=save.id),\
         (SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=save.id) \
         FROM save_sessions save WHERE id=$1::uuid",
    )
    .bind(session)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn force_session_expiry(pool: &DatabasePool, session: &str, expression: &'static str) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("ALTER TABLE save_sessions DISABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE save_sessions SET expires_at={expression} WHERE id=$1::uuid"
    )))
    .bind(session)
    .execute(&mut *connection)
    .await
    .unwrap();
    connection
        .execute("ALTER TABLE save_sessions ENABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            url,
            0,
            12,
            Duration::from_secs(5),
            Duration::from_secs(2),
            DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap(),
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn create_bucket(endpoint: &str, ca_file: &str) {
    let context = TlsContext::builder()
        .with_trust_store(TrustStore::default().with_pem_certificate(fs::read(ca_file).unwrap()))
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
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
                "save003-fixture",
            ))
            .http_client(PoolClient::new(&pool).unwrap())
            .build(),
    );
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let exists = error
            .as_service_error()
            .and_then(aws_sdk_s3::error::ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(exists);
    }
}
