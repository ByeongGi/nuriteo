#![allow(unused_imports)]
use super::admission::*;
use super::fake_store::*;
use super::history::*;
use super::postgres_bucket::*;
use super::relay_client::*;
use super::relay_multipart::*;
use super::relay_streams::*;
use super::save_http::*;
use super::verifier::*;
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
#[ignore = "requires tests/fixtures/project-versions/run.sh"]
pub(crate) async fn explicit_project_versions_are_immutable_authorized_and_gc_safe() {
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
