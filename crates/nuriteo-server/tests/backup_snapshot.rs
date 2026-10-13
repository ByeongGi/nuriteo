use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use nuriteo_server::backup::{CommandPgDump, ExportedBackupSnapshot, PgDumpCommandConfig};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use sqlx::Executor;
use uuid::Uuid;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const PG_DUMP_ENV: &str = "NURITEO_TEST_PG_DUMP";
const PG_RESTORE_ENV: &str = "NURITEO_TEST_PG_RESTORE";
const USER_ID: &str = "0199ee6c-c777-7000-8000-000000021001";
const SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000021002";
const GENERATION_ID: &str = "0199ee6c-c777-7000-8000-000000021003";

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-backup-snapshot/run.sh"]
async fn pg_dump_and_inventory_share_the_exported_online_snapshot() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(50));
    seed_identity(&pool).await;
    seed_live_bundle(&pool, 10, "before-snapshot", "a1").await;
    seed_unreferenced_gc_candidate(&pool).await;
    verify_null_snapshot_failure_and_copying_fence(&pool).await;

    sqlx::query(
        "INSERT INTO backup_generations(
             id,nuriteo_version,schema_version,postgres_major,synchronized_snapshot_id,
             expected_object_count,expected_payload_bytes
         ) VALUES($1::uuid,'0.1.0',49,17,NULL,NULL,NULL)",
    )
    .bind(GENERATION_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    assert_rejected(
        &pool,
        "UPDATE gc_candidates SET status='running',attempts=1,started_at=transaction_timestamp(),
         updated_at=transaction_timestamp() WHERE object_key='bundles/unreferenced'",
    )
    .await;

    let exported =
        ExportedBackupSnapshot::begin(pool.clone(), Uuid::parse_str(GENERATION_ID).unwrap())
            .await
            .unwrap();
    assert!(!exported.snapshot_id().is_empty());
    let before_capture: (String, bool, bool) = sqlx::query_as(
        "SELECT state,synchronized_snapshot_id IS NOT NULL,
                expected_object_count IS NULL AND expected_payload_bytes IS NULL
         FROM backup_generations WHERE id=$1::uuid",
    )
    .bind(GENERATION_ID)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(before_capture, ("preparing".to_owned(), true, true));

    seed_live_bundle(&pool, 20, "after-snapshot", "b2").await;

    let output_dir = tempfile::tempdir().unwrap();
    let archive_path = output_dir.path().join("online.dump");
    let dump = CommandPgDump::new(
        PgDumpCommandConfig::new(
            absolute_env_path(PG_DUMP_ENV),
            "localhost".to_owned(),
            5432,
            "nuriteo".to_owned(),
            "nuriteo".to_owned(),
            "nuriteo-test-password".to_owned(),
            "disable".to_owned(),
            None,
            archive_path.clone(),
            Duration::from_secs(30),
        )
        .unwrap(),
    );
    let captured = exported.capture(dump).await.unwrap();

    assert_eq!(captured.objects.len(), 1);
    assert_eq!(captured.objects[0].object_key, "bundles/before-snapshot");
    assert_eq!(captured.objects[0].sha256, [0xa1; 32]);
    assert_eq!(captured.objects[0].physical_bytes, 128);
    assert!(captured.database_archive.bytes > 0);
    assert_eq!(&fs::read(&archive_path).unwrap()[..5], b"PGDMP");

    let state: (String, i64, i64) = sqlx::query_as(
        "SELECT state,expected_object_count,expected_payload_bytes
         FROM backup_generations WHERE id=$1::uuid",
    )
    .bind(GENERATION_ID)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(state.0, "copying");
    assert_eq!(state.1, 2);
    assert_eq!(
        state.2,
        i64::try_from(captured.database_archive.bytes).unwrap() + 128
    );

    let held_keys: Vec<String> = sqlx::query_scalar(
        "SELECT object_key FROM object_retention_holds
         WHERE holder_kind='backup' AND holder_id=$1::uuid ORDER BY object_key",
    )
    .bind(GENERATION_ID)
    .fetch_all(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(held_keys, vec!["bundles/before-snapshot"]);
    assert_rejected(
        &pool,
        "UPDATE backup_generations SET synchronized_snapshot_id='changed',
         updated_at=transaction_timestamp() WHERE id='0199ee6c-c777-7000-8000-000000021003'",
    )
    .await;

    let dumped_projects = Command::new(absolute_env_path(PG_RESTORE_ENV))
        .arg(&archive_path)
        .output()
        .unwrap();
    assert!(dumped_projects.status.success());
    let dumped_projects = String::from_utf8(dumped_projects.stdout).unwrap();
    assert!(dumped_projects.contains("before-snapshot"));
    assert!(!dumped_projects.contains("after-snapshot"));

    verify_capture_failure_cleans_archive_and_holds(&pool, output_dir.path()).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_capture_failure_cleans_archive_and_holds(
    pool: &DatabasePool,
    output_dir: &std::path::Path,
) {
    sqlx::query(
        "DELETE FROM object_retention_holds WHERE holder_kind='backup' AND holder_id=$1::uuid",
    )
    .bind(GENERATION_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE backup_generations SET state='failed',failure_code='fixture_complete',
         completed_at=transaction_timestamp(),updated_at=transaction_timestamp()
         WHERE id=$1::uuid",
    )
    .bind(GENERATION_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let failure_id = "0199ee6c-c777-7000-8000-000000021005";
    sqlx::query(
        "INSERT INTO backup_generations(
             id,nuriteo_version,schema_version,postgres_major,synchronized_snapshot_id,
             expected_object_count,expected_payload_bytes
         ) VALUES($1::uuid,'0.1.0',49,17,NULL,99,99)",
    )
    .bind(failure_id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let exported =
        ExportedBackupSnapshot::begin(pool.clone(), Uuid::parse_str(failure_id).unwrap())
            .await
            .unwrap();
    let archive_path = output_dir.join("failed-online.dump");
    let dump = CommandPgDump::new(
        PgDumpCommandConfig::new(
            absolute_env_path(PG_DUMP_ENV),
            "localhost".to_owned(),
            5432,
            "nuriteo".to_owned(),
            "nuriteo".to_owned(),
            "nuriteo-test-password".to_owned(),
            "disable".to_owned(),
            None,
            archive_path.clone(),
            Duration::from_secs(30),
        )
        .unwrap(),
    );
    assert!(exported.capture(dump).await.is_err());
    assert!(!archive_path.exists());
    let state: String =
        sqlx::query_scalar("SELECT state FROM backup_generations WHERE id=$1::uuid")
            .bind(failure_id)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(state, "failed");
    let hold_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM object_retention_holds
         WHERE holder_kind='backup' AND holder_id=$1::uuid",
    )
    .bind(failure_id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(hold_count, 0);
}

async fn verify_null_snapshot_failure_and_copying_fence(pool: &DatabasePool) {
    let id = "0199ee6c-c777-7000-8000-000000021004";
    sqlx::query(
        "INSERT INTO backup_generations(
             id,nuriteo_version,schema_version,postgres_major,synchronized_snapshot_id,
             expected_object_count,expected_payload_bytes
         ) VALUES($1::uuid,'0.1.0',49,17,NULL,NULL,NULL)",
    )
    .bind(id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_rejected(
        pool,
        "UPDATE backup_generations SET state='copying',updated_at=transaction_timestamp()
         WHERE id='0199ee6c-c777-7000-8000-000000021004'",
    )
    .await;
    sqlx::query(
        "UPDATE backup_generations SET state='failed',failure_code='snapshot_export_failed',
         completed_at=transaction_timestamp(),updated_at=transaction_timestamp()
         WHERE id=$1::uuid",
    )
    .bind(id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn seed_identity(pool: &DatabasePool) {
    sqlx::raw_sql(
        "INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin)
         VALUES('0199ee6c-c777-7000-8000-000000021001','backup@example.test',
                'backup@example.test','Backup fixture',TRUE);
         INSERT INTO storage_scopes(id,owner_user_id)
         VALUES('0199ee6c-c777-7000-8000-000000021002',
                '0199ee6c-c777-7000-8000-000000021001')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn seed_live_bundle(pool: &DatabasePool, suffix: u16, slug: &str, digest: &str) {
    let project_id = format!("0199ee6c-c777-7000-8000-{suffix:012}");
    let session_id = format!("0199ee6c-c777-7000-8001-{suffix:012}");
    let bundle_id = format!("0199ee6c-c777-7000-8002-{suffix:012}");
    let object_key = format!("bundles/{slug}");
    let mut connection = pool.acquire().await.unwrap();
    connection.execute("BEGIN").await.unwrap();
    let result = async {
        sqlx::query(
            "INSERT INTO projects(id,owner_user_id,storage_scope_id,slug,name)
             VALUES($1::uuid,$2::uuid,$3::uuid,$4,'Backup snapshot fixture')",
        )
        .bind(&project_id)
        .bind(USER_ID)
        .bind(SCOPE_ID)
        .bind(slug)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "INSERT INTO save_sessions(
                 id,project_id,storage_scope_id,actor_user_id,expected_project_version,
                 expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,
                 expected_file_count,staging_object_key,upload_mode,expires_at
             ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,decode(repeat($5,32),'hex'),
                      128,64,1,$6,'single',transaction_timestamp()+interval '1 hour')",
        )
        .bind(&session_id)
        .bind(&project_id)
        .bind(SCOPE_ID)
        .bind(USER_ID)
        .bind(digest)
        .bind(&object_key)
        .execute(&mut *connection)
        .await?;
        for state in ["uploading", "verifying"] {
            sqlx::query(
                "UPDATE save_sessions SET state=$2,updated_at=transaction_timestamp()
                 WHERE id=$1::uuid",
            )
            .bind(&session_id)
            .bind(state)
            .execute(&mut *connection)
            .await?;
        }
        sqlx::query(
            "INSERT INTO bundles(id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at)
             VALUES($1::uuid,decode(repeat($2,32),'hex'),$3,128,64,1,'project-bundle-v1',transaction_timestamp())",
        )
        .bind(&bundle_id)
        .bind(digest)
        .bind(&object_key)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "UPDATE save_sessions SET state='committed',committed_bundle_id=$2::uuid,
             terminal_at=transaction_timestamp(),updated_at=transaction_timestamp()
             WHERE id=$1::uuid",
        )
        .bind(&session_id)
        .bind(&bundle_id)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "INSERT INTO project_bundle_admissions(
                 project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id
             ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$4::uuid)",
        )
        .bind(&project_id)
        .bind(SCOPE_ID)
        .bind(&bundle_id)
        .bind(&session_id)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "UPDATE projects SET working_head_bundle_id=$2::uuid,updated_at=transaction_timestamp(),
             lock_version=lock_version+1 WHERE id=$1::uuid",
        )
        .bind(&project_id)
        .bind(&bundle_id)
        .execute(&mut *connection)
        .await?;
        Ok::<_, sqlx::Error>(())
    }
    .await;
    match result {
        Ok(()) => connection.execute("COMMIT").await.unwrap(),
        Err(error) => {
            let _ = connection.execute("ROLLBACK").await;
            panic!("fixture bundle must commit: {error}");
        }
    };
}

async fn seed_unreferenced_gc_candidate(pool: &DatabasePool) {
    sqlx::raw_sql(
        "INSERT INTO projects(id,owner_user_id,storage_scope_id,slug,name)
         VALUES('0199ee6c-c777-7000-8004-000000000001',
                '0199ee6c-c777-7000-8000-000000021001',
                '0199ee6c-c777-7000-8000-000000021002','unreferenced','Unreferenced fixture');
         INSERT INTO save_sessions(
             id,project_id,storage_scope_id,actor_user_id,expected_project_version,
             expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,
             expected_file_count,staging_object_key,upload_mode,expires_at
         ) VALUES(
             '0199ee6c-c777-7000-8005-000000000001',
             '0199ee6c-c777-7000-8004-000000000001',
             '0199ee6c-c777-7000-8000-000000021002',
             '0199ee6c-c777-7000-8000-000000021001',1,decode(repeat('c3',32),'hex'),
             128,64,1,'bundles/unreferenced','single',transaction_timestamp()+interval '1 hour');
         UPDATE save_sessions SET state='uploading',updated_at=transaction_timestamp()
          WHERE id='0199ee6c-c777-7000-8005-000000000001';
         UPDATE save_sessions SET state='verifying',updated_at=transaction_timestamp()
          WHERE id='0199ee6c-c777-7000-8005-000000000001';
         INSERT INTO bundles(id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at)
         VALUES('0199ee6c-c777-7000-8003-000000000001',decode(repeat('c3',32),'hex'),
                'bundles/unreferenced',128,64,1,'project-bundle-v1',transaction_timestamp());
         UPDATE save_sessions SET state='committed',
                committed_bundle_id='0199ee6c-c777-7000-8003-000000000001',
                terminal_at=transaction_timestamp(),updated_at=transaction_timestamp()
          WHERE id='0199ee6c-c777-7000-8005-000000000001';
         INSERT INTO gc_candidates(object_key,expected_sha256,expected_bytes,reason,eligible_at)
         VALUES('bundles/unreferenced',decode(repeat('c3',32),'hex'),128,'reference_removed',transaction_timestamp())",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn assert_rejected(pool: &DatabasePool, sql: &'static str) {
    let error = sqlx::query(sql)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .expect_err("database invariant must reject the mutation");
    assert_eq!(
        error
            .as_database_error()
            .and_then(|error| error.code())
            .as_deref(),
        Some("23514")
    );
}

fn absolute_env_path(name: &str) -> PathBuf {
    let path = PathBuf::from(env::var(name).unwrap());
    assert!(path.is_absolute());
    path
}

async fn fixture_pool() -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(
        None,
        Some(fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap()),
        None,
    )
    .unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            env::var(DATABASE_URL_ENV).unwrap(),
            1,
            8,
            Duration::from_secs(5),
            Duration::from_secs(5),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn reset_fixture(pool: &DatabasePool) {
    pool.acquire()
        .await
        .unwrap()
        .execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .await
        .unwrap();
}
