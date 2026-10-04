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
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::UserId;
use nuriteo_server::object_storage::{
    MIN_MULTIPART_PART_BYTES, MultipartLimits, MultipartPartRequest, ObjectKey,
    ObjectStorageConfig, OperationLimits, PresignExpiry, PresignedPutRequest, S3ObjectStore,
    Sha256Checksum,
};
use nuriteo_server::project::ProjectId;
use nuriteo_server::quota::SaveSessionId;
use nuriteo_server::save::{
    AbortSaveSession, AbortSaveSessionResult, CleanupService, CleanupWorkerPolicy, WorkerShutdown,
};
use nuriteo_server::workspace::StorageScopeId;
use sqlx::Executor;

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
        Duration::from_secs(2),
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
    assert_eq!(
        service.abort(multipart_abort).await.unwrap(),
        AbortSaveSessionResult::Aborted
    );
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
         ($1::uuid,'single_delete','staging/crashed-final-attempt','running',4,\
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
    wait_for_count(&pool, "completed", 104).await;
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
    pool.close(Duration::from_secs(2)).await.unwrap();
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
    assert_eq!(backfilled, ("single_delete".to_owned(), true));
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
    panic!("cleanup jobs did not reach {status}={expected}");
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
             ('0199ee6c-c777-7000-8000-000000009023','0199ee6c-c777-7000-8000-000000009001','0199ee6c-c777-7000-8000-000000009010','backfill','Backfill')",
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
    let context = TlsContext::builder()
        .with_trust_store(TrustStore::default().with_pem_certificate(fs::read(ca_file).unwrap()))
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
    let client = aws_sdk_s3::Client::from_conf(
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
    );
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let exists = error
            .as_service_error()
            .and_then(aws_sdk_s3::error::ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(exists);
    }
}
