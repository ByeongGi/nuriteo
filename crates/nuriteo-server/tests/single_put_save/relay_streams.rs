#![allow(unused_imports)]
use super::admission::*;
use super::fake_store::*;
use super::history::*;
use super::postgres_bucket::*;
use super::relay_client::*;
use super::relay_multipart::*;
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

#[tokio::test]
#[ignore = "requires tests/fixtures/authenticated-upload-relay/run.sh"]
pub(crate) async fn authenticated_upload_relay_streams_single_and_multipart_without_bearer_exposure()
 {
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

    authenticated_upload_relay_streams_after_multipart(
        captured_logs,
        failure_problems,
        capability_checksums,
        pool,
        store,
        secret,
        router,
        owner,
        outsider,
        organization_owner,
        organization_writer,
    )
    .await;
}
