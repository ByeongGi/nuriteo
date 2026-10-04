use std::env;
use std::ffi::OsString;
use std::fs;
use std::str::FromStr;
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use bytes::Bytes;
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::UserId;
use nuriteo_server::object_storage::{
    BoundedPresignedRequest, MultipartUpload, ObjectKey, ObjectStorageConfig, OperationLimits,
    PresignedMultipartPartRequest, PresignedPutRequest, PutRequest, S3ObjectStore, Sha256Checksum,
    UploadedPart,
};
use nuriteo_server::project::{ProjectId, ProjectVersion};
use nuriteo_server::quota::EffectiveQuota;
use nuriteo_server::save::{
    CreateMultipartSession, CreateSinglePutSession, IdempotencyKey, IdempotencySecret,
    MultipartPartPlan, MultipartPartReceipt, MultipartService, MultipartServiceError,
    MultipartServicePolicy, MultipartSessionContext, MultipartStore, PutPresigner,
    SinglePutService, SinglePutServiceError, SinglePutServicePolicy, StagingVerifier,
    StagingVerifierPolicy, VerificationError, VerifyStagingBundle, WorkingHeadCommitError,
    WorkingHeadCommitPolicy, WorkingHeadCommitReconciliation, WorkingHeadCommitService,
};
use nuriteo_server::workspace::StorageScopeId;
use sha2::{Digest, Sha256};
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";
const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";
const BUCKET: &str = "nuriteo-save-003";
const ACCESS_KEY: &str = "save003-access";
const SECRET_KEY: &str = "save003-secret-0123456789";
const USER: &str = "0199ee6c-c777-7000-8000-000000008001";
const SCOPE: &str = "0199ee6c-c777-7000-8000-000000008010";
const PROJECT_A: &str = "0199ee6c-c777-7000-8000-000000008020";
const PROJECT_B: &str = "0199ee6c-c777-7000-8000-000000008021";
const PROJECT_FAIL: &str = "0199ee6c-c777-7000-8000-000000008022";
const PROJECT_TIMEOUT: &str = "0199ee6c-c777-7000-8000-000000008023";
const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000008002";
const ORG_OWNER: &str = "0199ee6c-c777-7000-8000-000000008003";
const ORG_READ: &str = "0199ee6c-c777-7000-8000-000000008004";
const ORG_WRITE: &str = "0199ee6c-c777-7000-8000-000000008005";
const ORG_MEMBER: &str = "0199ee6c-c777-7000-8000-000000008006";
const ORG_SCOPE: &str = "0199ee6c-c777-7000-8000-000000008031";
const ORG_PROJECT_OWNER: &str = "0199ee6c-c777-7000-8000-000000008040";
const ORG_PROJECT_READ: &str = "0199ee6c-c777-7000-8000-000000008041";
const ORG_PROJECT_WRITE: &str = "0199ee6c-c777-7000-8000-000000008042";
const ORG_PROJECT_MEMBER: &str = "0199ee6c-c777-7000-8000-000000008043";
const ORG_PROJECT_OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000008044";

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
    let replaced: (String, String, i64) = sqlx::query_as(
        "SELECT working_head_bundle_id::text,candidate.status,lock_version FROM projects project \
         JOIN bundles old_bundle ON old_bundle.id=$2::uuid \
         JOIN gc_candidates candidate ON candidate.object_key=old_bundle.object_key \
         WHERE project.id=$1::uuid",
    )
    .bind(PROJECT_A)
    .bind(left.bundle_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        replaced,
        (second.bundle_id().to_string(), "queued".to_owned(), 3)
    );

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

    let race_body = canonical_test_bundle(PROJECT_A, SCOPE, "cleanup-race.txt", b"race\n");
    let mut race_request = request(PROJECT_A, "head-cleanup-race1", &race_body);
    race_request.expected_project_version = ProjectVersion::new(4).unwrap();
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
    assert_eq!(fenced_head, second.bundle_id().to_string());

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
        ('0199ee6c-c777-7000-8000-000000008023','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-timeout','Save Timeout')").await.unwrap();
    connection.execute("INSERT INTO projects (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008040','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-owner-save','Owner Save'),\
        ('0199ee6c-c777-7000-8000-000000008041','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-read-save','Read Save'),\
        ('0199ee6c-c777-7000-8000-000000008042','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-write-save','Write Save'),\
        ('0199ee6c-c777-7000-8000-000000008043','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-member-save','Member Save'),\
        ('0199ee6c-c777-7000-8000-000000008044','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-outsider-save','Outsider Save')").await.unwrap();
    connection.execute("INSERT INTO project_user_roles (project_id,organization_id,user_id,role) VALUES \
        ('0199ee6c-c777-7000-8000-000000008041','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008004','read'),\
        ('0199ee6c-c777-7000-8000-000000008042','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','write')").await.unwrap();
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
