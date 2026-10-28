#![allow(unused_imports)]
use super::aws::*;
use super::materialization::*;
use super::s3_env::*;
use super::*;
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

use nuriteo_server::config::{Environment, InstanceSettingBootstrap, SystemFileReader};

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use nuriteo_server::identity::UserId;

use nuriteo_server::instance_settings::InstanceSettingsRepository;

use nuriteo_server::object_storage::{
    MIN_MULTIPART_PART_BYTES, MultipartLimits, MultipartPartRequest, ObjectKey,
    ObjectStorageConfig, OperationLimits, PresignExpiry, PresignedPutRequest, S3ObjectStore,
    Sha256Checksum,
};

use nuriteo_server::policy::PolicyMaintenanceWorker;

use nuriteo_server::project::ProjectId;

use nuriteo_server::quota::SaveSessionId;

use nuriteo_server::save::{
    AbortSaveSession, AbortSaveSessionResult, CleanupOperationsPolicy, CleanupOperationsService,
    CleanupOperatorState, CleanupService, CleanupWorkerPolicy, WorkerShutdown,
};

use nuriteo_server::workspace::StorageScopeId;

use sha2::{Digest, Sha256};

use super::{
    ABORT_PROJECT, ACCESS_KEY, ATTACHED_PROJECT, BACKFILL_PROJECT, BUCKET,
    COMPLETE_MISSING_PROJECT, COMPLETE_PROJECT, DATABASE_CA_ENV, DATABASE_URL_ENV,
    FixtureEnvironment, KNOWN_PROJECT, MULTIPART_PROJECT, NORMAL_COMPLETE_PROJECT, OUTSIDER,
    RACE_PROJECT, RACED_PROJECT, S3_CA_ENV, S3_ENDPOINT_ENV, SCOPE, SECRET_KEY, USER,
};
use sqlx::{Acquire, Executor};

#[tokio::test]
#[ignore = "requires tests/fixtures/save-cleanup/run.sh"]
pub(crate) async fn cleanup_is_bounded_persisted_redacted_and_restart_safe() {
    let pool = fixture_pool().await;
    reset_and_seed(&pool).await;
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    prove_forward_backfill(&pool).await;
    let endpoint = env::var(S3_ENDPOINT_ENV).unwrap();
    let ca_file = env::var(S3_CA_ENV).unwrap();
    create_bucket(&endpoint, &ca_file).await;
    let store = object_store(endpoint.clone(), ca_file.clone()).await;
    let policy = CleanupWorkerPolicy::new(
        100,
        4,
        4,
        Duration::from_secs(10),
        Duration::from_millis(500),
        Duration::from_secs(9 * 60),
        Duration::from_millis(20),
        Duration::from_millis(100),
        Duration::from_millis(200),
    )
    .unwrap();
    let service = CleanupService::new(pool.clone(), store.clone(), policy);

    seed_expired_sessions(&pool, 101).await;
    assert_eq!(service.expire_scope(scope()).await.unwrap().expired, 100);
    assert_eq!(service.expire_scope(scope()).await.unwrap().expired, 1);
    assert_eq!(service.expire_scope(scope()).await.unwrap().expired, 0);
    let (expired, reservations, queued): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM save_sessions WHERE state='expired'),\
                (SELECT COUNT(*) FROM storage_reservations),\
                (SELECT COUNT(*) FROM save_cleanup_jobs WHERE status='queued')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!((expired, reservations, queued), (101, 0, 101));

    // Operational aggregation uses retry_at, rather than the original
    // eligible_at, for retry_wait. A future retry is backlog but not yet stale.
    let retry_session = "0199ee6c-c777-7000-8000-000000009093";
    sqlx::query(
        "INSERT INTO save_cleanup_jobs \
         (save_session_id,cleanup_kind,object_key,status,attempts,eligible_at,retry_at,\
          started_at,last_failure_category,created_at,updated_at) VALUES \
         ($1::uuid,'object_delete','staging/operations-retry','retry_wait',1,\
          transaction_timestamp()-interval '2 hours',\
          transaction_timestamp()+interval '1 hour',\
          transaction_timestamp()-interval '2 hours','retryable',\
          transaction_timestamp()-interval '2 hours',transaction_timestamp())",
    )
    .bind(retry_session)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let operations = CleanupOperationsService::new(
        pool.clone(),
        CleanupOperationsPolicy::new(Duration::from_secs(60), 1, Duration::from_secs(2)).unwrap(),
    );
    let future_retry = operations.snapshot().await.unwrap();
    assert_eq!(future_retry.queue_depth, 102);
    assert_eq!(future_retry.retry_count, 1);
    assert!(future_retry.oldest_eligible_age_seconds.unwrap() < 60);
    assert_eq!(future_retry.state, CleanupOperatorState::Nominal);
    sqlx::query(
        "UPDATE save_cleanup_jobs SET retry_at=transaction_timestamp()-interval '2 minutes',\
                updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid",
    )
    .bind(retry_session)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let overdue_retry = operations.snapshot().await.unwrap();
    assert_eq!(overdue_retry.retry_count, 1);
    assert!(overdue_retry.oldest_eligible_age_seconds.unwrap() >= 120);
    assert_eq!(overdue_retry.state, CleanupOperatorState::Degraded);
    sqlx::query(
        "UPDATE save_cleanup_jobs SET status='running',retry_at=NULL,attempts=2,\
                lease_owner='0199ee6c-c777-7000-8000-000000009094'::uuid,\
                lease_expires_at=transaction_timestamp()+interval '10 minutes',\
                updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid",
    )
    .bind(retry_session)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_cleanup_jobs SET status='completed',lease_owner=NULL,lease_expires_at=NULL,\
                completed_at=transaction_timestamp(),last_failure_category=NULL,\
                updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid",
    )
    .bind(retry_session)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM save_cleanup_jobs WHERE save_session_id=$1::uuid AND status='completed'",
    )
    .bind(retry_session)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let abort_session = insert_session(&pool, ABORT_PROJECT, "single", None).await;
    let abort_key = session_key(&pool, abort_session).await;
    let body = Bytes::from_static(b"late-presigned-cleanup-object");
    let late_capability = store
        .presign_put(PresignedPutRequest {
            key: ObjectKey::parse(abort_key.clone()).unwrap(),
            content_length: body.len() as u64,
            content_type: "application/vnd.nuriteo.project-bundle".to_owned(),
            checksum: Sha256Checksum::calculate(&body),
            expiry: PresignExpiry::minutes(5).unwrap(),
        })
        .await
        .unwrap();
    let abort = AbortSaveSession {
        storage_scope_id: scope(),
        project_id: ProjectId::from_str(ABORT_PROJECT).unwrap(),
        session_id: abort_session,
        actor_user_id: UserId::from_str(USER).unwrap(),
    };
    assert_eq!(
        service.abort(abort).await.unwrap(),
        AbortSaveSessionResult::Aborted
    );
    assert_eq!(
        service.abort(abort).await.unwrap(),
        AbortSaveSessionResult::AlreadyAborted
    );
    let denied = AbortSaveSession {
        actor_user_id: UserId::from_str(OUTSIDER).unwrap(),
        ..abort
    };
    assert!(service.abort(denied).await.is_err());

    // The bearer remains valid after abort. An early worker must not delete
    // and complete the job before that capability expires.
    let early_worker = service.start_worker();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        early_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    let single_status: String =
        sqlx::query_scalar("SELECT status FROM save_cleanup_jobs WHERE save_session_id=$1::uuid")
            .bind(abort_session.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(single_status, "queued");
    store
        .execute_presigned(&late_capability, Some(body.clone()))
        .await
        .unwrap();

    let multipart_session = insert_session(&pool, MULTIPART_PROJECT, "multipart", None).await;
    let multipart_key = ObjectKey::parse(session_key(&pool, multipart_session).await).unwrap();
    let upload = store.create_multipart(multipart_key.clone()).await.unwrap();
    let limits = MultipartLimits::new(MIN_MULTIPART_PART_BYTES).unwrap();
    let part_body = Bytes::from(vec![0x5a; MIN_MULTIPART_PART_BYTES]);
    let part_request = MultipartPartRequest {
        upload: upload.clone(),
        part_number: 1,
        body: part_body.clone(),
        final_part: true,
        checksum: Sha256Checksum::calculate(&part_body),
    };
    store
        .upload_part(part_request.clone(), &limits)
        .await
        .unwrap();
    let multipart_abort = AbortSaveSession {
        storage_scope_id: scope(),
        project_id: ProjectId::from_str(MULTIPART_PROJECT).unwrap(),
        session_id: multipart_session,
        actor_user_id: UserId::from_str(USER).unwrap(),
    };
    // Simulate a backend create response/attach loss. The lifecycle update
    // atomically makes the expiry guard immediately eligible without first
    // terminalizing (which the multipart fence correctly rejects).
    sqlx::query(
        "UPDATE multipart_lifecycles SET create_status='unknown',\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND create_status='creating'",
    )
    .bind(multipart_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_cleanup_jobs SET eligible_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='queued'",
    )
    .bind(multipart_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(service.abort(multipart_abort).await.is_err());
    let kind: String = sqlx::query_scalar(
        "SELECT cleanup_kind FROM save_cleanup_jobs WHERE save_session_id=$1::uuid",
    )
    .bind(multipart_session.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(kind, "multipart_reconcile");

    // A broken endpoint claims persisted jobs and leaves retry state. A fresh
    // worker with the real backend then recovers them after process restart.
    let bad_store = object_store("https://127.0.0.1:9".to_owned(), ca_file.clone()).await;
    let crashed = SaveSessionId::from_uuid(
        uuid::Uuid::parse_str("0199ee6c-c777-7000-8000-000000009999").unwrap(),
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO save_cleanup_jobs \
         (save_session_id,cleanup_kind,object_key,status,attempts,eligible_at,lease_owner,\
          lease_expires_at,started_at,created_at,updated_at) VALUES \
         ($1::uuid,'object_delete','staging/crashed-final-attempt','running',4,\
          transaction_timestamp()-interval '20 seconds',\
          '0199ee6c-c777-7000-8000-000000009998'::uuid,\
          transaction_timestamp()-interval '1 second',\
          transaction_timestamp()-interval '10 seconds',\
          transaction_timestamp()-interval '20 seconds',\
          transaction_timestamp()-interval '1 second')",
    )
    .bind(crashed.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let wrong_owner = sqlx::query(
        "UPDATE save_cleanup_jobs SET status='completed',\
                completed_at=transaction_timestamp(),lease_owner=NULL,lease_expires_at=NULL,\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='running' \
           AND lease_owner='0199ee6c-c777-7000-8000-000000009097'::uuid",
    )
    .bind(crashed.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(wrong_owner.rows_affected(), 0);
    let stale_owner_session = SaveSessionId::new();
    let original_owner = "0199ee6c-c777-7000-8000-000000009095";
    let replacement_owner = "0199ee6c-c777-7000-8000-000000009096";
    sqlx::query(
        "INSERT INTO save_cleanup_jobs \
         (save_session_id,cleanup_kind,object_key,status,attempts,eligible_at,lease_owner,\
          lease_expires_at,started_at,created_at,updated_at) VALUES \
         ($1::uuid,'object_delete','staging/stale-owner','running',1,\
          transaction_timestamp()-interval '20 seconds',$2::uuid,\
          transaction_timestamp()-interval '1 second',\
          transaction_timestamp()-interval '10 seconds',\
          transaction_timestamp()-interval '20 seconds',transaction_timestamp()-interval '1 second')",
    )
    .bind(stale_owner_session.to_string())
    .bind(original_owner)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_cleanup_jobs SET attempts=attempts+1,lease_owner=$2::uuid,\
                lease_expires_at=transaction_timestamp()+interval '1 minute',\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='running' \
           AND lease_expires_at <= transaction_timestamp()",
    )
    .bind(stale_owner_session.to_string())
    .bind(replacement_owner)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let stale_finalize = sqlx::query(
        "UPDATE save_cleanup_jobs SET status='completed',completed_at=transaction_timestamp(),\
                lease_owner=NULL,lease_expires_at=NULL,updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='running' AND lease_owner=$2::uuid \
           AND lease_expires_at > clock_timestamp()",
    )
    .bind(stale_owner_session.to_string())
    .bind(original_owner)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(stale_finalize.rows_affected(), 0);
    sqlx::query(
        "UPDATE save_cleanup_jobs SET status='completed',completed_at=transaction_timestamp(),\
                lease_owner=NULL,lease_expires_at=NULL,updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='running' AND lease_owner=$2::uuid \
           AND lease_expires_at > clock_timestamp()",
    )
    .bind(stale_owner_session.to_string())
    .bind(replacement_owner)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM save_cleanup_jobs WHERE save_session_id=$1::uuid AND status='completed'",
    )
    .bind(stale_owner_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE save_cleanup_jobs SET object_key='staging/tampered' \
             WHERE save_session_id=$1::uuid",
        )
        .bind(abort_session.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM save_cleanup_jobs WHERE save_session_id=$1::uuid")
            .bind(abort_session.to_string())
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err()
    );
    let bad_service = CleanupService::new(pool.clone(), bad_store, policy);
    let bad_worker = bad_service.start_worker();
    wait_for_count(&pool, "retry_wait", 1).await;
    wait_for_count(&pool, "failed", 1).await;
    assert_eq!(
        bad_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );

    sqlx::query(
        "UPDATE save_cleanup_jobs SET retry_at=transaction_timestamp() \
         WHERE status='retry_wait'",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_cleanup_jobs SET eligible_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid",
    )
    .bind(abort_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let good_worker = service.start_worker();
    wait_for_count(&pool, "completed", 103).await;
    assert_eq!(
        good_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    assert!(
        store
            .head(&ObjectKey::parse(abort_key.clone()).unwrap())
            .await
            .is_err()
    );
    assert!(store.upload_part(part_request, &limits).await.is_err());
    let reconciled: (String, String, i64) = sqlx::query_as(
        "SELECT session.state,lifecycle.create_status,\
                (SELECT COUNT(*) FROM storage_reservations reservation \
                 WHERE reservation.save_session_id=session.id) \
         FROM save_sessions session JOIN multipart_lifecycles lifecycle \
           ON lifecycle.save_session_id=session.id \
         WHERE session.id=$1::uuid",
    )
    .bind(multipart_session.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(reconciled, ("failed".to_owned(), "cleaned".to_owned(), 0));

    // LIST returning zero exact-key uploads is not a successful abort. It is
    // persisted as the first absence observation, and a late upload created
    // before the second poll must still be discovered and aborted.
    let absent_create_session = insert_session(&pool, MULTIPART_PROJECT, "multipart", None).await;
    let absent_create_key = session_key(&pool, absent_create_session).await;
    sqlx::query(
        "UPDATE multipart_lifecycles SET create_status='unknown',\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND create_status='creating'",
    )
    .bind(absent_create_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_cleanup_jobs SET eligible_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='queued'",
    )
    .bind(absent_create_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let absence_policy = CleanupWorkerPolicy::new(
        100,
        4,
        4,
        Duration::from_secs(10),
        Duration::from_millis(500),
        Duration::from_secs(9 * 60),
        Duration::from_millis(20),
        Duration::from_secs(30),
        Duration::from_secs(30),
    )
    .unwrap();
    let absence_service = CleanupService::new(pool.clone(), store.clone(), absence_policy);
    let absence_worker = absence_service.start_worker();
    wait_for_absence_observation(&pool, absent_create_session).await;
    assert_eq!(
        absence_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    let late_upload_id = create_backend_multipart(&endpoint, &ca_file, &absent_create_key).await;
    sqlx::query(
        "UPDATE save_cleanup_jobs SET retry_at=transaction_timestamp(),\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='retry_wait' AND absence_count=1",
    )
    .bind(absent_create_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let late_upload_worker = service.start_worker();
    wait_for_count(&pool, "completed", 104).await;
    assert_eq!(
        late_upload_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    assert!(
        !backend_multipart_exists(&endpoint, &ca_file, &absent_create_key, &late_upload_id).await
    );
    assert_multipart_finalized(&pool, absent_create_session, "failed").await;
    sqlx::query(
        "DELETE FROM save_cleanup_jobs \
         WHERE save_session_id=$1::uuid AND status='completed'",
    )
    .bind(absent_create_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    // If attach committed, ready and guard deletion are atomic. A caller that
    // lost the commit response must not reconcile/abort the live upload.
    let attached_session = insert_session(&pool, ATTACHED_PROJECT, "multipart", None).await;
    let attached_key = session_key(&pool, attached_session).await;
    let attached_upload_id = create_backend_multipart(&endpoint, &ca_file, &attached_key).await;
    attach_upload_fixture(&pool, attached_session, &attached_upload_id).await;
    let attached_jobs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=$1::uuid")
            .bind(attached_session.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(attached_jobs, 0);

    // Exact attach/reconcile interleaving: the guard is already claimed, then
    // attach commits ready. Reclaimed work must observe ready under canonical
    // locks, delete only the stale guard, and never call backend abort.
    let raced_session = insert_session(&pool, RACED_PROJECT, "multipart", None).await;
    let raced_key = session_key(&pool, raced_session).await;
    let raced_upload_id = create_backend_multipart(&endpoint, &ca_file, &raced_key).await;
    sqlx::query(
        "UPDATE save_cleanup_jobs SET status='running',attempts=1,\
                lease_owner='0199ee6c-c777-7000-8000-000000009090'::uuid,\
                lease_expires_at=transaction_timestamp()+interval '1 minute',\
                started_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='queued'",
    )
    .bind(raced_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    attach_upload_fixture(&pool, raced_session, &raced_upload_id).await;
    sqlx::query(
        "UPDATE save_cleanup_jobs SET started_at=created_at,\
                lease_expires_at=created_at+interval '1 millisecond',\
                updated_at=transaction_timestamp() WHERE save_session_id=$1::uuid",
    )
    .bind(raced_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let stale_worker = service.start_worker();
    wait_for_job_absent(&pool, raced_session).await;
    assert_eq!(
        stale_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    assert!(backend_multipart_exists(&endpoint, &ca_file, &raced_key, &raced_upload_id).await);
    abort_backend_multipart(&endpoint, &ca_file, &raced_key, &raced_upload_id).await;

    // Construct the response-loss boundary after a confirmed backend abort:
    // lifecycle cleaned committed, but the terminal/quota transaction did
    // not. The durable guard must finish all DB state atomically.
    abort_backend_multipart(&endpoint, &ca_file, &attached_key, &attached_upload_id).await;
    sqlx::query(
        "UPDATE multipart_lifecycles SET create_status='cleaned',\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND create_status='ready'",
    )
    .bind(attached_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let split_worker = service.start_worker();
    wait_for_count(&pool, "completed", 104).await;
    assert_eq!(
        split_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    assert_multipart_finalized(&pool, attached_session, "failed").await;

    // A known-ID terminal cleanup persists ready -> cleaned in the same
    // transaction that completes its cleanup claim.
    let known_session = insert_session(&pool, KNOWN_PROJECT, "multipart", None).await;
    let known_key = session_key(&pool, known_session).await;
    let known_upload_id = create_backend_multipart(&endpoint, &ca_file, &known_key).await;
    attach_upload_fixture(&pool, known_session, &known_upload_id).await;
    let known_abort = AbortSaveSession {
        storage_scope_id: scope(),
        project_id: ProjectId::from_str(KNOWN_PROJECT).unwrap(),
        session_id: known_session,
        actor_user_id: UserId::from_str(USER).unwrap(),
    };
    assert_eq!(
        service.abort(known_abort).await.unwrap(),
        AbortSaveSessionResult::Aborted
    );
    let known_worker = service.start_worker();
    wait_for_count(&pool, "completed", 105).await;
    assert_eq!(
        known_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    assert_multipart_finalized(&pool, known_session, "aborted").await;

    // Complete response-loss is also persistently owned. At expiry, an
    // existing object converges to completed/verifying without aborting it;
    // absence plus a confirmed upload abort converges to cleaned/expired.
    let complete_session = insert_session(&pool, COMPLETE_PROJECT, "multipart", None).await;
    let complete_key = session_key(&pool, complete_session).await;
    attach_upload_fixture(&pool, complete_session, "completed-response-lost").await;
    put_backend_object(&endpoint, &ca_file, &complete_key).await;
    mark_complete_unknown_fixture(&pool, complete_session).await;

    let missing_session = insert_session(&pool, COMPLETE_MISSING_PROJECT, "multipart", None).await;
    let missing_key = session_key(&pool, missing_session).await;
    let missing_upload_id = create_backend_multipart(&endpoint, &ca_file, &missing_key).await;
    attach_upload_fixture(&pool, missing_session, &missing_upload_id).await;
    mark_complete_unknown_fixture(&pool, missing_session).await;
    sqlx::query(
        "UPDATE save_cleanup_jobs SET eligible_at=transaction_timestamp() \
         WHERE save_session_id IN ($1::uuid,$2::uuid) AND status='queued'",
    )
    .bind(complete_session.to_string())
    .bind(missing_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let delayed_policy = CleanupWorkerPolicy::new(
        100,
        4,
        4,
        Duration::from_secs(10),
        Duration::from_millis(500),
        Duration::from_secs(9 * 60),
        Duration::from_millis(20),
        Duration::from_secs(30),
        Duration::from_secs(30),
    )
    .unwrap();
    let delayed_service = CleanupService::new(pool.clone(), store.clone(), delayed_policy);
    let first_observation_worker = delayed_service.start_worker();
    wait_for_absence_observation(&pool, missing_session).await;
    assert_eq!(
        first_observation_worker
            .shutdown(Duration::from_secs(3))
            .await,
        WorkerShutdown::Drained
    );
    assert!(backend_multipart_exists(&endpoint, &ca_file, &missing_key, &missing_upload_id).await);
    // The first HEAD miss must not abort the upload. Completion wins after the
    // persisted observation; the next poll must recover the resulting object.
    complete_backend_multipart(&endpoint, &ca_file, &missing_key, &missing_upload_id).await;
    sqlx::query(
        "UPDATE save_cleanup_jobs SET retry_at=transaction_timestamp(),\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='retry_wait' AND absence_count=1",
    )
    .bind(missing_session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let complete_worker = service.start_worker();
    wait_for_job_absent(&pool, complete_session).await;
    wait_for_job_absent(&pool, missing_session).await;
    assert_eq!(
        complete_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    let completed: (String, String, i64) = sqlx::query_as(
        "SELECT session.state,lifecycle.complete_status,\
                (SELECT COUNT(*) FROM storage_reservations reservation \
                 WHERE reservation.save_session_id=session.id) \
         FROM save_sessions session JOIN multipart_lifecycles lifecycle \
           ON lifecycle.save_session_id=session.id WHERE session.id=$1::uuid",
    )
    .bind(complete_session.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        completed,
        ("verifying".to_owned(), "completed".to_owned(), 1)
    );
    let recovered: (String, String, i64) = sqlx::query_as(
        "SELECT session.state,lifecycle.complete_status,\
                (SELECT COUNT(*) FROM storage_reservations reservation \
                 WHERE reservation.save_session_id=session.id) \
         FROM save_sessions session JOIN multipart_lifecycles lifecycle \
           ON lifecycle.save_session_id=session.id WHERE session.id=$1::uuid",
    )
    .bind(missing_session.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        recovered,
        ("verifying".to_owned(), "completed".to_owned(), 1)
    );

    // A recovered completed upload owns an object, not an incomplete upload.
    // The reconcile guard must vacate its PK slot so a later abort can enqueue
    // exact object deletion rather than a multipart abort.
    assert_eq!(
        service
            .abort(AbortSaveSession {
                storage_scope_id: scope(),
                project_id: ProjectId::from_str(COMPLETE_PROJECT).unwrap(),
                session_id: complete_session,
                actor_user_id: UserId::from_str(USER).unwrap(),
            })
            .await
            .unwrap(),
        AbortSaveSessionResult::Aborted
    );
    let recovered_cleanup: (String, Option<String>) = sqlx::query_as(
        "SELECT cleanup_kind,multipart_upload_id FROM save_cleanup_jobs \
         WHERE save_session_id=$1::uuid",
    )
    .bind(complete_session.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(recovered_cleanup, ("object_delete".to_owned(), None));
    let recovered_cleanup_worker = service.start_worker();
    wait_for_count(&pool, "completed", 106).await;
    assert_eq!(
        recovered_cleanup_worker
            .shutdown(Duration::from_secs(3))
            .await,
        WorkerShutdown::Drained
    );
    assert!(
        store
            .head(&ObjectKey::parse(complete_key.clone()).unwrap())
            .await
            .is_err()
    );

    // The ordinary successful complete path has the same terminal ownership:
    // its finalized staging object is deleted, never treated as an upload ID.
    let normal_session = insert_session(&pool, NORMAL_COMPLETE_PROJECT, "multipart", None).await;
    let normal_key = session_key(&pool, normal_session).await;
    let normal_upload_id = create_backend_multipart(&endpoint, &ca_file, &normal_key).await;
    attach_upload_fixture(&pool, normal_session, &normal_upload_id).await;
    mark_complete_started_fixture(&pool, normal_session).await;
    complete_backend_multipart(&endpoint, &ca_file, &normal_key, &normal_upload_id).await;
    mark_complete_finished_fixture(&pool, normal_session).await;
    assert_eq!(
        service
            .abort(AbortSaveSession {
                storage_scope_id: scope(),
                project_id: ProjectId::from_str(NORMAL_COMPLETE_PROJECT).unwrap(),
                session_id: normal_session,
                actor_user_id: UserId::from_str(USER).unwrap(),
            })
            .await
            .unwrap(),
        AbortSaveSessionResult::Aborted
    );
    let normal_cleanup: (String, Option<String>) = sqlx::query_as(
        "SELECT cleanup_kind,multipart_upload_id FROM save_cleanup_jobs \
         WHERE save_session_id=$1::uuid",
    )
    .bind(normal_session.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(normal_cleanup, ("object_delete".to_owned(), None));
    let normal_worker = service.start_worker();
    wait_for_count(&pool, "completed", 107).await;
    assert_eq!(
        normal_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    let normal_final: (String, String, i64) = sqlx::query_as(
        "SELECT session.state,lifecycle.complete_status,\
                (SELECT COUNT(*) FROM storage_reservations reservation \
                 WHERE reservation.save_session_id=session.id) \
         FROM save_sessions session JOIN multipart_lifecycles lifecycle \
           ON lifecycle.save_session_id=session.id WHERE session.id=$1::uuid",
    )
    .bind(normal_session.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        normal_final,
        ("aborted".to_owned(), "completed".to_owned(), 0)
    );
    assert!(
        store
            .head(&ObjectKey::parse(normal_key).unwrap())
            .await
            .is_err()
    );

    // Abort, expiry, Project deletion and the worker race on one session. The
    // first delete may fail closed while the session is active; retry after the
    // terminal transition must converge without losing the cleanup intent.
    let race_session = insert_session(&pool, RACE_PROJECT, "single", None).await;
    force_expired(&pool, race_session).await;
    let race_worker = service.start_worker();
    let abort_service = service.clone();
    let expiry_service = service.clone();
    let delete_pool = pool.clone();
    let abort_task = tokio::spawn(async move {
        abort_service
            .abort(AbortSaveSession {
                storage_scope_id: scope(),
                project_id: ProjectId::from_str(RACE_PROJECT).unwrap(),
                session_id: race_session,
                actor_user_id: UserId::from_str(USER).unwrap(),
            })
            .await
    });
    let expiry_task = tokio::spawn(async move { expiry_service.expire_scope(scope()).await });
    let delete_task = tokio::spawn(async move {
        sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
            .bind(RACE_PROJECT)
            .execute(&mut *delete_pool.acquire().await.unwrap())
            .await
    });
    let (abort_result, expiry_result, _) = tokio::join!(abort_task, expiry_task, delete_task);
    let abort_result = abort_result.unwrap();
    assert!(
        matches!(abort_result, Ok(AbortSaveSessionResult::Expired))
            || matches!(
                abort_result,
                Err(nuriteo_server::save::CleanupError::SessionTerminal)
                    | Err(nuriteo_server::save::CleanupError::SessionNotFound)
            )
    );
    assert!(expiry_result.unwrap().is_ok());
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(RACE_PROJECT)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    wait_for_count(&pool, "completed", 108).await;
    assert_eq!(
        race_worker.shutdown(Duration::from_secs(3)).await,
        WorkerShutdown::Drained
    );
    let race_jobs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=$1::uuid")
            .bind(race_session.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(race_jobs, 1);

    let rendered = format!("{service:?} {abort:?} {multipart_abort:?}");
    for prohibited in [
        endpoint.as_str(),
        ca_file.as_str(),
        ACCESS_KEY,
        SECRET_KEY,
        abort_key.as_str(),
        "X-Amz-Signature",
    ] {
        assert!(!rendered.contains(prohibited));
    }
    let supervised_worker = service.start_worker();
    assert_eq!(
        supervised_worker
            .run_until(
                tokio::time::sleep(Duration::from_millis(50)),
                Duration::from_secs(3),
            )
            .await,
        WorkerShutdown::Drained
    );
    pool.close(Duration::from_secs(2)).await.unwrap();
}
