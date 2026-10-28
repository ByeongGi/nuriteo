#![allow(unused_imports)]
use super::*;
use super::verifier::*;
use super::working_head::*;
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
#[ignore = "requires tests/fixtures/save-http/run.sh"]
pub(crate) async fn save_http_is_authorized_restart_stable_and_commits_the_working_head() {    let pool = fixture_pool().await;
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
