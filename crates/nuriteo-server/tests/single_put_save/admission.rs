#![allow(unused_imports)]
use super::fake_store::*;
use super::history::*;
use super::postgres_bucket::*;
use super::relay_client::*;
use super::relay_multipart::*;
use super::relay_streams::*;
use super::save_http::*;
use super::verifier::*;
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

pub(crate) async fn admit_bundle_version_for_fixture(
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

pub(crate) async fn verify_commit_permission_and_expiry(
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
pub(crate) async fn single_put_is_atomic_idempotent_bounded_and_compensated() {
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
pub(crate) async fn multipart_save_is_bounded_exact_and_reconcilable() {
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
