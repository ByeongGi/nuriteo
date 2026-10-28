#![allow(unused_imports)]
use super::admission::*;
use super::fake_store::*;
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

#[tokio::test]
#[ignore = "requires tests/fixtures/project-history/run.sh"]
pub(crate) async fn project_history_promotes_atomically_and_replays_durable_outcomes() {
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
            &ProjectDeleteConfirmation::new(ProjectName::new("Save B".to_owned()).unwrap()),
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

pub(crate) fn history_audit(actor: UserId, correlation_id: &str) -> ProjectAuditContext {
    ProjectAuditContext::new(
        AuditEventId::new(),
        actor,
        Some("Save Fixture".to_owned()),
        correlation_id.to_owned(),
        None,
    )
}

pub(crate) async fn prepare_verified_head(
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
pub(crate) async fn prepare_verified_head_for(
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
