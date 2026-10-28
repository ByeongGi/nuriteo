#![allow(unused_imports)]
use super::*;
use super::verifier::*;
use super::save_http::*;
use super::relay_multipart::*;
use super::relay_streams::*;
use super::versions::*;
use super::history::*;
use super::admission::*;
use super::fake_store::*;
use super::relay_client::*;
use super::postgres_bucket::*;
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
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, S3_ENDPOINT_ENV, S3_CA_ENV, BUCKET, ACCESS_KEY, SECRET_KEY, WEB_ORIGIN, TEST_PASSWORD, TEST_PASSWORD_HASH, USER, SCOPE, PROJECT_A, PROJECT_B, PROJECT_FAIL, PROJECT_TIMEOUT, PROJECT_LEASE_ABORT, PROJECT_LEASE_EXPIRE, PROJECT_LEASE_COMPLETE, PROJECT_MULTI_EXPIRY, PROJECT_LEASE_CLOCK, PROJECT_HISTORY_LEFT, PROJECT_HISTORY_RIGHT, OUTSIDER, ORG_OWNER, ORG_READ, ORG_WRITE, ORG_MEMBER, ORG_SCOPE, ORG, ORG_PROJECT_OWNER, ORG_PROJECT_READ, ORG_PROJECT_WRITE, ORG_PROJECT_MEMBER, ORG_PROJECT_OUTSIDER, ORG_PROJECT_MULTI_REVOKE, ORG_PROJECT_MULTI_ARCHIVE, PersistedRelaySecretRow, FixtureEnvironment, AbortBehavior, AttachFailureStore, LostCompleteStore, FailingPresigner, HangingPresigner, VersionBrowser, RelayMultipartFixture, CapturedLogWriter, NeverReadBody, BoundedFrameBody, ObservedFrameBody, GatedFrameBody};



#[tokio::test]
#[ignore = "requires tests/fixtures/working-head-commit/run.sh"]
pub(crate) async fn working_head_commit_is_atomic_idempotent_and_fenced() {    let pool = fixture_pool().await;
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
