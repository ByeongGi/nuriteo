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
use sqlx::{Acquire, Executor};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";
const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";
const BUCKET: &str = "nuriteo-save-009";
const ACCESS_KEY: &str = "save009-access";
const SECRET_KEY: &str = "save009-secret-0123456789";
const USER: &str = "0199ee6c-c777-7000-8000-000000009001";
const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000009002";
const SCOPE: &str = "0199ee6c-c777-7000-8000-000000009010";
const ABORT_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009020";
const MULTIPART_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009021";
const RACE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009022";
const BACKFILL_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009023";
const ATTACHED_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009024";
const RACED_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009025";
const KNOWN_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009026";
const COMPLETE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009027";
const COMPLETE_MISSING_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009028";
const NORMAL_COMPLETE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009029";

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
#[ignore = "requires tests/fixtures/save-cleanup/run.sh"]
async fn cleanup_is_bounded_persisted_redacted_and_restart_safe() {
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

#[tokio::test]
#[ignore = "requires tests/fixtures/save-cleanup/run.sh"]
async fn stale_canonical_materialization_aborts_persisted_multipart() {
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
    let store = object_store(endpoint.clone(), ca_file.clone()).await;
    let policy = CleanupWorkerPolicy::new(
        8,
        1,
        2,
        Duration::from_secs(10),
        Duration::from_millis(500),
        Duration::from_secs(9 * 60),
        Duration::from_millis(20),
        Duration::from_millis(100),
        Duration::from_millis(200),
    )
    .unwrap();
    let service = CleanupService::new(pool.clone(), store.clone(), policy);
    prove_stale_canonical_multipart_is_aborted(&pool, &service, &store, &endpoint, &ca_file).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn prove_stale_canonical_multipart_is_aborted(
    pool: &DatabasePool,
    service: &CleanupService,
    store: &S3ObjectStore,
    endpoint: &str,
    ca_file: &str,
) {
    let key = format!("canonical/{SCOPE}/stale-multipart.bundle");
    let upload_id = create_backend_multipart(endpoint, ca_file, &key).await;
    let ledger_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO canonical_bundle_materializations \
         (id,project_id,storage_scope_id,sha256,object_key,physical_bytes,logical_bytes,\
          file_count,multipart_upload_id,state,updated_at) \
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,1,0,0,$6,'pending',\
                transaction_timestamp()-INTERVAL '11 minutes')",
    )
    .bind(ledger_id.to_string())
    .bind(ABORT_PROJECT)
    .bind(SCOPE)
    .bind(vec![0x7au8; 32])
    .bind(&key)
    .bind(&upload_id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let referenced_key = format!("canonical/{SCOPE}/referenced.bundle");
    let referenced_body = b"durable-referenced-canonical-object";
    let referenced_sha = Sha256::digest(referenced_body).to_vec();
    aws_client(endpoint, ca_file)
        .put_object()
        .bucket(BUCKET)
        .key(&referenced_key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(
            referenced_body,
        ))
        .send()
        .await
        .unwrap();
    let referenced_ledger_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO canonical_bundle_materializations \
         (id,project_id,storage_scope_id,sha256,object_key,physical_bytes,logical_bytes,\
          file_count,state,updated_at) \
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,0,0,'uploaded',\
                transaction_timestamp()-INTERVAL '11 minutes')",
    )
    .bind(referenced_ledger_id.to_string())
    .bind(ABORT_PROJECT)
    .bind(SCOPE)
    .bind(&referenced_sha)
    .bind(&referenced_key)
    .bind(i64::try_from(referenced_body.len()).unwrap())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bundles \
         (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,\
          verification_state,verified_at) \
         VALUES($1::uuid,$2,$3,$4,0,0,'project-bundle-v1','verified',transaction_timestamp())",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&referenced_sha)
    .bind(&referenced_key)
    .bind(i64::try_from(referenced_body.len()).unwrap())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    service
        .reconcile_canonical_materializations_once()
        .await
        .unwrap();
    let stale_state: (String, Option<String>) = sqlx::query_as(
        "SELECT state,multipart_upload_id FROM canonical_bundle_materializations \
         WHERE id=$1::uuid",
    )
    .bind(ledger_id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(stale_state, ("cleanup_pending".to_owned(), None));
    let stale_gc: (String, String, Vec<u8>, i64) = sqlx::query_as(
        "SELECT status,reason,expected_sha256,expected_bytes FROM gc_candidates \
         WHERE object_key=$1",
    )
    .bind(&key)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        stale_gc,
        (
            "queued".to_owned(),
            "verification_failed".to_owned(),
            vec![0x7au8; 32],
            1
        )
    );
    let referenced_state: String =
        sqlx::query_scalar("SELECT state FROM canonical_bundle_materializations WHERE id=$1::uuid")
            .bind(referenced_ledger_id.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(referenced_state, "finalized");
    let referenced_gc: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM gc_candidates WHERE object_key=$1)")
            .bind(&referenced_key)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert!(!referenced_gc);
    assert!(!backend_multipart_exists(endpoint, ca_file, &key, &upload_id).await);

    // Recreate the queued candidate at an age beyond the production-default
    // 24-hour grace. Identity remains guarded by the canonical ledger trigger.
    sqlx::query("DELETE FROM gc_candidates WHERE object_key=$1 AND status='queued'")
        .bind(&key)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO gc_candidates \
         (object_key,expected_sha256,expected_bytes,reason,status,eligible_at,created_at,updated_at) \
         VALUES($1,$2,1,'verification_failed','queued',\
                transaction_timestamp()-INTERVAL '25 hours',\
                transaction_timestamp()-INTERVAL '25 hours',transaction_timestamp())",
    )
    .bind(&key)
    .bind(vec![0x7au8; 32])
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let gc = PolicyMaintenanceWorker::new(pool.clone(), store.clone(), Duration::from_secs(10))
        .unwrap()
        .run_once()
        .await
        .unwrap();
    assert_eq!(gc.gc_claimed, 1);
    assert_eq!(gc.gc_completed, 1);
    let gc_state: String =
        sqlx::query_scalar("SELECT status FROM gc_candidates WHERE object_key=$1")
            .bind(&key)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(gc_state, "completed");
    service
        .reconcile_canonical_materializations_once()
        .await
        .unwrap();
    let stale_ledger_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM canonical_bundle_materializations WHERE id=$1::uuid)",
    )
    .bind(ledger_id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(!stale_ledger_exists);
}

fn scope() -> StorageScopeId {
    StorageScopeId::from_str(SCOPE).unwrap()
}

async fn seed_expired_sessions(pool: &DatabasePool, count: u16) {
    for index in 0..count {
        let suffix = 0x1000_u64 + u64::from(index);
        let project = format!("0199ee6c-c777-7000-8000-{suffix:012x}");
        let slug = format!("expiry-{index:03}");
        sqlx::query(
            "INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$4)",
        )
        .bind(&project)
        .bind(USER)
        .bind(SCOPE)
        .bind(slug)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        insert_session(pool, &project, "single", None).await;
    }
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("ALTER TABLE save_sessions DISABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
    connection
        .execute(
            "UPDATE save_sessions SET \
                 created_at=transaction_timestamp()-interval '2 hours',\
                 expires_at=transaction_timestamp()-interval '1 second' \
             WHERE project_id NOT IN \
             ('0199ee6c-c777-7000-8000-000000009020','0199ee6c-c777-7000-8000-000000009021')",
        )
        .await
        .unwrap();
    connection
        .execute("ALTER TABLE save_sessions ENABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
}

async fn insert_session(
    pool: &DatabasePool,
    project: &str,
    mode: &str,
    upload_id: Option<&str>,
) -> SaveSessionId {
    let session = SaveSessionId::new();
    let key = format!("staging/{SCOPE}/{project}/{session}.bundle");
    sqlx::query(
        "INSERT INTO save_sessions \
         (id,project_id,storage_scope_id,actor_user_id,expected_project_version,\
          expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,\
          expected_file_count,staging_object_key,upload_mode,multipart_upload_id,expires_at) \
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,decode(repeat('00',32),'hex'),\
                 1,0,0,$5,$6,$7,transaction_timestamp()+interval '1 hour')",
    )
    .bind(session.to_string())
    .bind(project)
    .bind(SCOPE)
    .bind(USER)
    .bind(key)
    .bind(mode)
    .bind(upload_id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    if mode == "multipart" {
        sqlx::query(
            "INSERT INTO multipart_lifecycles \
             (save_session_id,part_size_bytes,part_count,create_status,complete_status) \
             VALUES ($1::uuid,8388608,1,'creating','pending')",
        )
        .bind(session.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO storage_reservations \
         (save_session_id,storage_scope_id,reserved_bytes,expires_at) \
         SELECT id,storage_scope_id,expected_physical_bytes,expires_at \
         FROM save_sessions WHERE id=$1::uuid",
    )
    .bind(session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    session
}

async fn session_key(pool: &DatabasePool, session: SaveSessionId) -> String {
    sqlx::query_scalar("SELECT staging_object_key FROM save_sessions WHERE id=$1::uuid")
        .bind(session.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn attach_upload_fixture(pool: &DatabasePool, session: SaveSessionId, upload_id: &str) {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    let session_affected = sqlx::query(
        "UPDATE save_sessions SET multipart_upload_id=$2,state='uploading',\
                updated_at=transaction_timestamp() \
         WHERE id=$1::uuid AND state='created' AND multipart_upload_id IS NULL",
    )
    .bind(session.to_string())
    .bind(upload_id)
    .execute(&mut *transaction)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(session_affected, 1);
    let lifecycle_affected = sqlx::query(
        "UPDATE multipart_lifecycles SET create_status='ready',\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND create_status='creating' \
           AND complete_status='pending'",
    )
    .bind(session.to_string())
    .execute(&mut *transaction)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(lifecycle_affected, 1);
    transaction.commit().await.unwrap();
}

async fn assert_multipart_finalized(
    pool: &DatabasePool,
    session: SaveSessionId,
    expected_state: &str,
) {
    let row: (String, String, i64) = sqlx::query_as(
        "SELECT session.state,lifecycle.create_status,\
                (SELECT COUNT(*) FROM storage_reservations reservation \
                 WHERE reservation.save_session_id=session.id) \
         FROM save_sessions session JOIN multipart_lifecycles lifecycle \
           ON lifecycle.save_session_id=session.id \
         WHERE session.id=$1::uuid",
    )
    .bind(session.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(row, (expected_state.to_owned(), "cleaned".to_owned(), 0));
}

async fn mark_complete_unknown_fixture(pool: &DatabasePool, session: SaveSessionId) {
    mark_complete_started_fixture(pool, session).await;
    sqlx::query(
        "UPDATE multipart_lifecycles SET complete_status='unknown',\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND create_status='ready' \
           AND complete_status='completing'",
    )
    .bind(session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn mark_complete_started_fixture(pool: &DatabasePool, session: SaveSessionId) {
    sqlx::query(
        "UPDATE multipart_lifecycles SET complete_status='completing',\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND create_status='ready' \
           AND complete_status='pending'",
    )
    .bind(session.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn mark_complete_finished_fixture(pool: &DatabasePool, session: SaveSessionId) {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query(
        "UPDATE save_sessions SET state='verifying',updated_at=transaction_timestamp() \
         WHERE id=$1::uuid AND state='uploading'",
    )
    .bind(session.to_string())
    .execute(&mut *transaction)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE multipart_lifecycles SET complete_status='completed',\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND create_status='ready' \
           AND complete_status='completing'",
    )
    .bind(session.to_string())
    .execute(&mut *transaction)
    .await
    .unwrap();
    transaction.commit().await.unwrap();
}

async fn force_expired(pool: &DatabasePool, session: SaveSessionId) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("ALTER TABLE save_sessions DISABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
    sqlx::query(
        "UPDATE save_sessions SET created_at=transaction_timestamp()-interval '2 hours',\
                expires_at=transaction_timestamp()-interval '1 second' WHERE id=$1::uuid",
    )
    .bind(session.to_string())
    .execute(&mut *connection)
    .await
    .unwrap();
    connection
        .execute("ALTER TABLE save_sessions ENABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
}

async fn prove_forward_backfill(pool: &DatabasePool) {
    let session = insert_session(pool, BACKFILL_PROJECT, "single", None).await;
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute(
            "DROP TRIGGER multipart_lifecycle_cleanup_guard_insert ON multipart_lifecycles;\
             DROP TRIGGER multipart_lifecycle_cleanup_guard_update ON multipart_lifecycles;\
             DROP TRIGGER multipart_complete_cleanup_guard_update ON multipart_lifecycles",
        )
        .await
        .unwrap();
    connection
        .execute("DROP TRIGGER save_sessions_terminal_cleanup_enqueue ON save_sessions")
        .await
        .unwrap();
    connection
        .execute("DROP TABLE save_cleanup_jobs")
        .await
        .unwrap();
    sqlx::query(
        "UPDATE save_sessions SET state='aborted',terminal_at=transaction_timestamp(),\
                updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(session.to_string())
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../migrations/0017_save_cleanup.sql"))
        .execute(&mut *connection)
        .await
        .unwrap();
    let backfilled: (String, bool) = sqlx::query_as(
        "SELECT cleanup_kind,eligible_at >= expires_at FROM save_cleanup_jobs job \
         JOIN save_sessions session ON session.id=job.save_session_id \
         WHERE job.save_session_id=$1::uuid",
    )
    .bind(session.to_string())
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(backfilled, ("object_delete".to_owned(), true));
    sqlx::query(
        "UPDATE save_cleanup_jobs SET status='running',attempts=1,\
                lease_owner='0199ee6c-c777-7000-8000-000000009091'::uuid,\
                lease_expires_at=transaction_timestamp()+interval '1 minute',\
                started_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='queued'",
    )
    .bind(session.to_string())
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_cleanup_jobs SET status='completed',lease_owner=NULL,\
                lease_expires_at=NULL,completed_at=transaction_timestamp(),\
                updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND status='running'",
    )
    .bind(session.to_string())
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query("DELETE FROM save_cleanup_jobs WHERE save_session_id=$1::uuid")
        .bind(session.to_string())
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(BACKFILL_PROJECT)
        .execute(&mut *connection)
        .await
        .unwrap();
}

async fn wait_for_count(pool: &DatabasePool, status: &str, expected: i64) {
    for _ in 0..300 {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM save_cleanup_jobs WHERE status=$1")
                .bind(status)
                .fetch_one(&mut *pool.acquire().await.unwrap())
                .await
                .unwrap();
        if count >= expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let statuses: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status,COUNT(*) FROM save_cleanup_jobs GROUP BY status ORDER BY status",
    )
    .fetch_all(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let running: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT job.cleanup_kind,job.save_session_id::text,session.state,lifecycle.create_status \
         FROM save_cleanup_jobs job LEFT JOIN save_sessions session ON session.id=job.save_session_id \
         LEFT JOIN multipart_lifecycles lifecycle ON lifecycle.save_session_id=job.save_session_id \
         WHERE job.status='running'",
    )
    .fetch_all(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    panic!("cleanup jobs did not reach {status}={expected}: {statuses:?} {running:?}");
}

async fn wait_for_job_absent(pool: &DatabasePool, session: SaveSessionId) {
    for _ in 0..300 {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM save_cleanup_jobs WHERE save_session_id=$1::uuid",
        )
        .bind(session.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        if count == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("cleanup job did not become absent");
}

async fn wait_for_absence_observation(pool: &DatabasePool, session: SaveSessionId) {
    for _ in 0..300 {
        let observed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM save_cleanup_jobs \
             WHERE save_session_id=$1::uuid AND status='retry_wait' AND absence_count=1)",
        )
        .bind(session.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        if observed {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("cleanup job did not persist its first absence observation");
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
    connection
        .execute(
            "INSERT INTO users (id,email,normalized_email,display_name) VALUES \
             ('0199ee6c-c777-7000-8000-000000009001','owner@example.test','owner@example.test','Owner'),\
             ('0199ee6c-c777-7000-8000-000000009002','outside@example.test','outside@example.test','Outside');\
             INSERT INTO storage_scopes (id,owner_user_id) VALUES \
             ('0199ee6c-c777-7000-8000-000000009010','0199ee6c-c777-7000-8000-000000009001');\
             INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) VALUES \
             ('0199ee6c-c777-7000-8000-000000009020','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','abort','Abort'),\
             ('0199ee6c-c777-7000-8000-000000009021','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','multipart','Multipart'),\
             ('0199ee6c-c777-7000-8000-000000009022','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','race','Race'),\
             ('0199ee6c-c777-7000-8000-000000009023','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','backfill','Backfill'),\
             ('0199ee6c-c777-7000-8000-000000009024','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','attached','Attached'),\
             ('0199ee6c-c777-7000-8000-000000009025','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','raced','Raced'),\
             ('0199ee6c-c777-7000-8000-000000009026','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','known','Known'),\
             ('0199ee6c-c777-7000-8000-000000009027','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','complete','Complete'),\
             ('0199ee6c-c777-7000-8000-000000009028','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','complete-missing','Complete Missing'),\
             ('0199ee6c-c777-7000-8000-000000009029','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','normal-complete','Normal Complete')",
        )
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
            16,
            Duration::from_secs(5),
            Duration::from_secs(2),
            DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap(),
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn object_store(endpoint: String, ca_file: String) -> S3ObjectStore {
    let config =
        ObjectStorageConfig::load(&FixtureEnvironment { endpoint, ca_file }, &SystemFileReader)
            .unwrap();
    S3ObjectStore::new(
        &config,
        OperationLimits {
            connect_timeout: Duration::from_millis(200),
            attempt_timeout: Duration::from_millis(300),
            request_timeout: Duration::from_millis(500),
            max_attempts: 1,
            ..OperationLimits::default()
        },
    )
    .await
    .unwrap()
}

async fn create_bucket(endpoint: &str, ca_file: &str) {
    let client = aws_client(endpoint, ca_file);
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let exists = error
            .as_service_error()
            .and_then(aws_sdk_s3::error::ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(exists);
    }
}

async fn create_backend_multipart(endpoint: &str, ca_file: &str, key: &str) -> String {
    aws_client(endpoint, ca_file)
        .create_multipart_upload()
        .bucket(BUCKET)
        .key(key)
        .send()
        .await
        .unwrap()
        .upload_id()
        .unwrap()
        .to_owned()
}

async fn abort_backend_multipart(endpoint: &str, ca_file: &str, key: &str, upload_id: &str) {
    aws_client(endpoint, ca_file)
        .abort_multipart_upload()
        .bucket(BUCKET)
        .key(key)
        .upload_id(upload_id)
        .send()
        .await
        .unwrap();
}

async fn complete_backend_multipart(endpoint: &str, ca_file: &str, key: &str, upload_id: &str) {
    let client = aws_client(endpoint, ca_file);
    let uploaded = client
        .upload_part()
        .bucket(BUCKET)
        .key(key)
        .upload_id(upload_id)
        .part_number(1)
        .body(aws_sdk_s3::primitives::ByteStream::from(vec![
            b'x';
            MIN_MULTIPART_PART_BYTES
        ]))
        .send()
        .await
        .unwrap();
    let part = aws_sdk_s3::types::CompletedPart::builder()
        .part_number(1)
        .e_tag(uploaded.e_tag().unwrap())
        .build();
    client
        .complete_multipart_upload()
        .bucket(BUCKET)
        .key(key)
        .upload_id(upload_id)
        .multipart_upload(
            aws_sdk_s3::types::CompletedMultipartUpload::builder()
                .parts(part)
                .build(),
        )
        .send()
        .await
        .unwrap();
}

async fn put_backend_object(endpoint: &str, ca_file: &str, key: &str) {
    aws_client(endpoint, ca_file)
        .put_object()
        .bucket(BUCKET)
        .key(key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(
            b"completed-multipart-response-loss",
        ))
        .send()
        .await
        .unwrap();
}

async fn backend_multipart_exists(
    endpoint: &str,
    ca_file: &str,
    key: &str,
    upload_id: &str,
) -> bool {
    aws_client(endpoint, ca_file)
        .list_multipart_uploads()
        .bucket(BUCKET)
        .prefix(key)
        .send()
        .await
        .unwrap()
        .uploads()
        .iter()
        .any(|upload| upload.key() == Some(key) && upload.upload_id() == Some(upload_id))
}

fn aws_client(endpoint: &str, ca_file: &str) -> aws_sdk_s3::Client {
    let context = TlsContext::builder()
        .with_trust_store(TrustStore::default().with_pem_certificate(fs::read(ca_file).unwrap()))
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
    aws_sdk_s3::Client::from_conf(
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
                "save009-fixture",
            ))
            .http_client(PoolClient::new(&pool).unwrap())
            .build(),
    )
}
