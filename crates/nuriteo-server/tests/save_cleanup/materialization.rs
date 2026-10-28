#![allow(unused_imports)]
use super::*;
use super::s3_env::*;
use super::bounds::*;
use super::aws::*;
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
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, S3_ENDPOINT_ENV, S3_CA_ENV, BUCKET, ACCESS_KEY, SECRET_KEY, USER, OUTSIDER, SCOPE, ABORT_PROJECT, MULTIPART_PROJECT, RACE_PROJECT, BACKFILL_PROJECT, ATTACHED_PROJECT, RACED_PROJECT, KNOWN_PROJECT, COMPLETE_PROJECT, COMPLETE_MISSING_PROJECT, NORMAL_COMPLETE_PROJECT, FixtureEnvironment};



#[tokio::test]
#[ignore = "requires tests/fixtures/save-cleanup/run.sh"]
pub(crate) async fn stale_canonical_materialization_aborts_persisted_multipart() {    let pool = fixture_pool().await;
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


pub(crate) async fn prove_stale_canonical_multipart_is_aborted(    pool: &DatabasePool,
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


pub(crate) fn scope() -> StorageScopeId {    StorageScopeId::from_str(SCOPE).unwrap()
}


pub(crate) async fn seed_expired_sessions(pool: &DatabasePool, count: u16) {    for index in 0..count {
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


pub(crate) async fn insert_session(    pool: &DatabasePool,
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


pub(crate) async fn session_key(pool: &DatabasePool, session: SaveSessionId) -> String {    sqlx::query_scalar("SELECT staging_object_key FROM save_sessions WHERE id=$1::uuid")
        .bind(session.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}


pub(crate) async fn attach_upload_fixture(pool: &DatabasePool, session: SaveSessionId, upload_id: &str) {    let mut connection = pool.acquire().await.unwrap();
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


pub(crate) async fn assert_multipart_finalized(    pool: &DatabasePool,
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


pub(crate) async fn mark_complete_unknown_fixture(pool: &DatabasePool, session: SaveSessionId) {    mark_complete_started_fixture(pool, session).await;
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


pub(crate) async fn mark_complete_started_fixture(pool: &DatabasePool, session: SaveSessionId) {    sqlx::query(
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


pub(crate) async fn mark_complete_finished_fixture(pool: &DatabasePool, session: SaveSessionId) {    let mut connection = pool.acquire().await.unwrap();
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


pub(crate) async fn force_expired(pool: &DatabasePool, session: SaveSessionId) {    let mut connection = pool.acquire().await.unwrap();
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


pub(crate) async fn prove_forward_backfill(pool: &DatabasePool) {    let session = insert_session(pool, BACKFILL_PROJECT, "single", None).await;
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
    sqlx::raw_sql(include_str!("../../migrations/0017_save_cleanup.sql"))
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


pub(crate) async fn wait_for_count(pool: &DatabasePool, status: &str, expected: i64) {    for _ in 0..300 {
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


pub(crate) async fn wait_for_job_absent(pool: &DatabasePool, session: SaveSessionId) {    for _ in 0..300 {
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


pub(crate) async fn wait_for_absence_observation(pool: &DatabasePool, session: SaveSessionId) {    for _ in 0..300 {
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


pub(crate) async fn reset_and_seed(pool: &DatabasePool) {    let mut connection = pool.acquire().await.unwrap();
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


pub(crate) async fn fixture_pool() -> DatabasePool {    let url = env::var(DATABASE_URL_ENV).unwrap();
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


pub(crate) async fn object_store(endpoint: String, ca_file: String) -> S3ObjectStore {    let config =
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


pub(crate) async fn create_bucket(endpoint: &str, ca_file: &str) {    let client = aws_client(endpoint, ca_file);
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let exists = error
            .as_service_error()
            .and_then(aws_sdk_s3::error::ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(exists);
    }
}


pub(crate) async fn create_backend_multipart(endpoint: &str, ca_file: &str, key: &str) -> String {    aws_client(endpoint, ca_file)
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


pub(crate) async fn abort_backend_multipart(endpoint: &str, ca_file: &str, key: &str, upload_id: &str) {    aws_client(endpoint, ca_file)
        .abort_multipart_upload()
        .bucket(BUCKET)
        .key(key)
        .upload_id(upload_id)
        .send()
        .await
        .unwrap();
}


pub(crate) async fn complete_backend_multipart(endpoint: &str, ca_file: &str, key: &str, upload_id: &str) {    let client = aws_client(endpoint, ca_file);
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


pub(crate) async fn put_backend_object(endpoint: &str, ca_file: &str, key: &str) {    aws_client(endpoint, ca_file)
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


pub(crate) async fn backend_multipart_exists(    endpoint: &str,
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
