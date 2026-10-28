#![allow(unused_imports)]
use super::*;
use super::verifier::*;
use super::working_head::*;
use super::save_http::*;
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



pub(crate) async fn authenticated_upload_relay_streams_after_multipart(    captured_logs: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    mut failure_problems: Vec<String>,
    mut capability_checksums: Vec<String>,
    pool: DatabasePool,
    store: S3ObjectStore,
    secret: IdempotencySecret,
    router: Router,
    owner: VersionBrowser,
    outsider: VersionBrowser,
    organization_owner: VersionBrowser,
    organization_writer: VersionBrowser,
) {
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
