use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

type BackupPolicyRow = (
    bool,
    i32,
    String,
    Option<i32>,
    Option<i32>,
    Option<i32>,
    i32,
    String,
    i64,
);

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-backup-schema/run.sh"]
async fn complete_only_deduplication_and_gc_fences_are_database_enforced() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(50));

    let policy: BackupPolicyRow = sqlx::query_as(
        "SELECT enabled,interval_hours,schedule_timezone,daily_retention,weekly_retention,monthly_retention,\
         multipart_cleanup_hours,drill_frequency,lock_version FROM backup_policy WHERE singleton",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        policy,
        (
            true,
            24,
            "UTC".into(),
            Some(7),
            Some(4),
            Some(6),
            24,
            "monthly".into(),
            1
        )
    );
    assert_rejected(
        &pool,
        "UPDATE backup_policy SET daily_retention=366 WHERE singleton",
    )
    .await;
    sqlx::query("UPDATE backup_policy SET daily_retention=0 WHERE singleton")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query("UPDATE backup_policy SET daily_retention=NULL WHERE singleton")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query("INSERT INTO backup_operations(id,kind,source) VALUES($1::uuid,'create','manual')")
        .bind("0199ee6c-c777-7000-8000-000000010001")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_rejected_with_code(
        &pool,
        "INSERT INTO backup_operations(id,kind,source) VALUES('0199ee6c-c777-7000-8000-000000010002','drill','schedule')",
        "23505",
    )
    .await;
    assert_rejected(
        &pool,
        "UPDATE backup_operations SET state='succeeded',started_at=transaction_timestamp(),completed_at=transaction_timestamp() WHERE id='0199ee6c-c777-7000-8000-000000010001'",
    )
    .await;
    sqlx::query(
        "UPDATE backup_operations SET state='running',started_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind("0199ee6c-c777-7000-8000-000000010001")
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE backup_operations SET state='succeeded',completed_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind("0199ee6c-c777-7000-8000-000000010001")
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    sqlx::raw_sql(
        "INSERT INTO backup_generations(
             id,nuriteo_version,schema_version,postgres_major,synchronized_snapshot_id,
             expected_object_count,expected_payload_bytes
         ) VALUES(
             '0199ee6c-c777-7000-8000-000000020001','0.1.0',47,17,'snapshot-a',2,150
         );
         INSERT INTO backup_payloads(sha256,destination_object_key,payload_bytes) VALUES
             (decode(repeat('a1',32),'hex'),'backups/payloads/a1',100),
             (decode(repeat('b2',32),'hex'),'backups/payloads/b2',50);
         INSERT INTO backup_manifest_entries(
             backup_id,ordinal,component,source_object_key,payload_sha256,payload_bytes
         ) VALUES
             ('0199ee6c-c777-7000-8000-000000020001',1,'database_archive',NULL,
              decode(repeat('a1',32),'hex'),100),
             ('0199ee6c-c777-7000-8000-000000020001',2,'project_bundle','bundles/shared',
              decode(repeat('b2',32),'hex'),50)",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    assert_eq!(restore_point_count(&pool).await, 0);
    assert_rejected(
        &pool,
        "INSERT INTO backup_retention_claims(backup_id,retention_class,retain_until)
         VALUES('0199ee6c-c777-7000-8000-000000020001','daily',transaction_timestamp()+interval '7 days')",
    )
    .await;
    assert_rejected(
        &pool,
        "UPDATE backup_generations SET state='complete',manifest_sha256=decode(repeat('f1',32),'hex'),
         completed_at=transaction_timestamp(),updated_at=transaction_timestamp()
         WHERE id='0199ee6c-c777-7000-8000-000000020001'",
    )
    .await;

    complete_generation(&pool, "0199ee6c-c777-7000-8000-000000020001", 0xf1).await;
    assert_eq!(restore_point_count(&pool).await, 1);
    sqlx::query(
        "INSERT INTO backup_retention_claims(backup_id,retention_class,retain_until)
         VALUES($1::uuid,'daily',transaction_timestamp()+interval '7 days')",
    )
    .bind("0199ee6c-c777-7000-8000-000000020001")
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    sqlx::raw_sql(
        "INSERT INTO backup_generations(
             id,nuriteo_version,schema_version,postgres_major,synchronized_snapshot_id,
             expected_object_count,expected_payload_bytes
         ) VALUES(
             '0199ee6c-c777-7000-8000-000000020002','0.1.0',47,17,'snapshot-b',3,220
         );
         INSERT INTO backup_payloads(sha256,destination_object_key,payload_bytes) VALUES
             (decode(repeat('c3',32),'hex'),'backups/payloads/c3',120),
             (decode(repeat('b2',32),'hex'),'backups/payloads/duplicate-key-must-not-win',50)
         ON CONFLICT (sha256) DO NOTHING;
         INSERT INTO backup_manifest_entries(
             backup_id,ordinal,component,source_object_key,payload_sha256,payload_bytes
         ) VALUES
             ('0199ee6c-c777-7000-8000-000000020002',1,'database_archive',NULL,
              decode(repeat('c3',32),'hex'),120),
             ('0199ee6c-c777-7000-8000-000000020002',2,'project_bundle','bundles/shared',
              decode(repeat('b2',32),'hex'),50),
             ('0199ee6c-c777-7000-8000-000000020002',3,'project_bundle','bundles/shared-copy',
              decode(repeat('b2',32),'hex'),50)",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    complete_generation(&pool, "0199ee6c-c777-7000-8000-000000020002", 0xf2).await;

    let payload_count: i64 = sqlx::query_scalar("SELECT count(*) FROM backup_payloads")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        payload_count, 3,
        "shared payload must be stored once by digest"
    );
    assert_eq!(restore_point_count(&pool).await, 2);

    assert_gc_rejected(&pool).await;
    sqlx::query(
        "DELETE FROM backup_retention_claims
         WHERE backup_id=$1::uuid AND retention_class='daily'",
    )
    .bind("0199ee6c-c777-7000-8000-000000020001")
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    request_prune(&pool, "0199ee6c-c777-7000-8000-000000020001").await;
    assert_eq!(restore_point_count(&pool).await, 1);
    assert_gc_rejected(&pool).await;
    request_prune(&pool, "0199ee6c-c777-7000-8000-000000020002").await;
    assert_eq!(restore_point_count(&pool).await, 0);

    sqlx::query(
        "INSERT INTO backup_payload_gc_candidates(payload_sha256,eligible_at)
         VALUES(decode(repeat('b2',32),'hex'),transaction_timestamp())",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE backup_payload_gc_candidates SET status='running',attempt_count=1,
         updated_at=transaction_timestamp() WHERE payload_sha256=decode(repeat('b2',32),'hex')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO backup_generations(
             id,nuriteo_version,schema_version,postgres_major,synchronized_snapshot_id,
             expected_object_count,expected_payload_bytes
         ) VALUES($1::uuid,'0.1.0',47,17,'snapshot-c',1,50)",
    )
    .bind("0199ee6c-c777-7000-8000-000000020003")
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_rejected(
        &pool,
        "INSERT INTO backup_manifest_entries(
             backup_id,ordinal,component,source_object_key,payload_sha256,payload_bytes
         ) VALUES('0199ee6c-c777-7000-8000-000000020003',1,'database_archive',NULL,
                  decode(repeat('b2',32),'hex'),50)",
    )
    .await;

    sqlx::query(
        "UPDATE backup_generations SET state='failed',failure_code='payload_gc_fenced',
         completed_at=transaction_timestamp(),updated_at=transaction_timestamp()
         WHERE id=$1::uuid",
    )
    .bind("0199ee6c-c777-7000-8000-000000020003")
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM backup_manifest_entries
         WHERE backup_id IN (
             '0199ee6c-c777-7000-8000-000000020001'::uuid,
             '0199ee6c-c777-7000-8000-000000020002'::uuid
         ) AND payload_sha256=decode(repeat('b2',32),'hex')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE backup_payload_gc_candidates SET status='completed',completed_at=transaction_timestamp(),
         updated_at=transaction_timestamp() WHERE payload_sha256=decode(repeat('b2',32),'hex')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("DELETE FROM backup_payloads WHERE sha256=decode(repeat('b2',32),'hex')")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let deleted_payload_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM backup_payloads WHERE sha256=decode(repeat('b2',32),'hex')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(deleted_payload_count, 0);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn complete_generation(pool: &DatabasePool, id: &str, manifest_byte: u8) {
    for state in ["copying", "verifying"] {
        sqlx::query(
            "UPDATE backup_generations SET state=$2,updated_at=transaction_timestamp()
             WHERE id=$1::uuid",
        )
        .bind(id)
        .bind(state)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    sqlx::query(
        "UPDATE backup_generations SET state='complete',manifest_sha256=$2,\
         completed_at=transaction_timestamp(),updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(id)
    .bind(vec![manifest_byte; 32])
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn request_prune(pool: &DatabasePool, id: &str) {
    sqlx::query(
        "UPDATE backup_generations SET prune_requested_at=transaction_timestamp(),
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn assert_gc_rejected(pool: &DatabasePool) {
    assert_rejected(
        pool,
        "INSERT INTO backup_payload_gc_candidates(payload_sha256,eligible_at)
         VALUES(decode(repeat('b2',32),'hex'),transaction_timestamp())",
    )
    .await;
}

async fn assert_rejected(pool: &DatabasePool, sql: &'static str) {
    assert_rejected_with_code(pool, sql, "23514").await;
}

async fn assert_rejected_with_code(pool: &DatabasePool, sql: &'static str, code: &str) {
    let error = sqlx::query(sql)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .expect_err("database invariant must reject the mutation");
    assert_eq!(
        error
            .as_database_error()
            .and_then(|error| error.code())
            .as_deref(),
        Some(code)
    );
}

async fn restore_point_count(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM complete_backup_restore_points")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
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
            4,
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
