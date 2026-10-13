use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};
use sqlx::{Acquire, Executor};
use tokio::time;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-project-bundles/run.sh"]
async fn project_bundle_schema_is_verified_scoped_bounded_and_gc_safe() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Pending {
            current: None,
            target: 14,
        }
    );
    assert_eq!(
        migrate(&pool).await,
        MigrationReport {
            latest_version: Some(15),
            known_migrations: 15,
        }
    );
    assert_eq!(
        check_schema_readiness(&pool).await.unwrap(),
        SchemaReadiness::Ready { version: 14 }
    );

    seed_owners_scopes_and_projects(&pool).await;
    verify_initial_save_and_working_head(&pool).await;
    verify_atomic_head_replacement_and_gc_fence(&pool).await;
    verify_completed_gc_metadata_cleanup_allows_verified_reupload(&pool).await;
    verify_working_head_swap_uses_deterministic_object_lock_order(&pool).await;
    verify_scope_reference_and_metadata_constraints(&pool).await;
    verify_multipart_expiry_and_staging_gc(&pool).await;
    verify_bundle_persistence_truncate_is_rejected(&pool).await;
    verify_project_delete_enqueues_without_dangling_references(&pool).await;
    verify_schema_shape(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn seed_owners_scopes_and_projects(pool: &DatabasePool) {
    execute(pool, "INSERT INTO users (id,email,normalized_email,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000006001','owner@example.test','owner@example.test','Owner'), \
        ('0199ee6c-c777-7000-8000-000000006002','member@example.test','member@example.test','Member')").await;
    execute(
        pool,
        "INSERT INTO organizations (id,slug,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000006010','bundle-org','Bundle Org')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO organization_memberships (organization_id,user_id,role) VALUES \
        ('0199ee6c-c777-7000-8000-000000006010','0199ee6c-c777-7000-8000-000000006001','owner'), \
        ('0199ee6c-c777-7000-8000-000000006010','0199ee6c-c777-7000-8000-000000006002','member')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_scopes (id,owner_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006001')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_scopes (id,owner_organization_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006010')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO projects \
        (id,owner_user_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000006030','0199ee6c-c777-7000-8000-000000006001', \
         '0199ee6c-c777-7000-8000-000000006020','personal-bundle','Personal Bundle')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO projects \
        (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000006031','0199ee6c-c777-7000-8000-000000006010', \
         '0199ee6c-c777-7000-8000-000000006021','org-bundle','Org Bundle')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO projects \
        (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000006032','0199ee6c-c777-7000-8000-000000006010', \
         '0199ee6c-c777-7000-8000-000000006021','org-reupload','Org Reupload')",
    )
    .await;
}

async fn verify_initial_save_and_working_head(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO save_sessions \
        (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
         expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
         expected_file_count,staging_object_key,upload_mode,expires_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006040','0199ee6c-c777-7000-8000-000000006030', \
         '0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006001',1, \
         decode(repeat('11',32),'hex'),1024,5,1,'staging/projects/6030/save-6040','single', \
         CURRENT_TIMESTAMP + INTERVAL '1 hour')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_reservations \
        (save_session_id,storage_scope_id,reserved_bytes,expires_at) \
        SELECT id,storage_scope_id,expected_physical_bytes,expires_at FROM save_sessions \
        WHERE id='0199ee6c-c777-7000-8000-000000006040'",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='uploading',updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006040'",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='verifying',updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006040'",
    )
    .await;

    assert_rejected(pool, "INSERT INTO bundles \
        (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verification_state,verified_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006050',decode(repeat('11',32),'hex'), \
         'staging/projects/6030/save-6040',1024,5,1,'project-bundle-v1','staging',CURRENT_TIMESTAMP)",
        "unverified Bundle metadata").await;
    execute(
        pool,
        "INSERT INTO bundles \
        (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006050',decode(repeat('11',32),'hex'), \
         'staging/projects/6030/save-6040',1024,5,1,'project-bundle-v1',CURRENT_TIMESTAMP)",
    )
    .await;
    assert_rejected(
        pool,
        "DELETE FROM storage_reservations \
         WHERE save_session_id='0199ee6c-c777-7000-8000-000000006040'",
        "independent active reservation release",
    )
    .await;
    assert_rejected(
        pool,
        "DELETE FROM save_sessions \
         WHERE id='0199ee6c-c777-7000-8000-000000006040'",
        "active Save session deletion",
    )
    .await;
    assert_rejected(
        pool,
        "DELETE FROM projects \
         WHERE id='0199ee6c-c777-7000-8000-000000006030'",
        "Project cascade over an active Save session",
    )
    .await;

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    transaction
        .execute(
            "UPDATE save_sessions SET state='committed', \
        committed_bundle_id='0199ee6c-c777-7000-8000-000000006050', \
        terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006040'",
        )
        .await
        .unwrap();
    let reservation_released: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM storage_reservations \
         WHERE save_session_id='0199ee6c-c777-7000-8000-000000006040')",
    )
    .fetch_one(&mut *transaction)
    .await
    .unwrap();
    assert!(
        reservation_released,
        "terminal transition must atomically release its reservation"
    );
    transaction
        .execute(
            "INSERT INTO project_bundle_admissions \
        (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006030','0199ee6c-c777-7000-8000-000000006020', \
         '0199ee6c-c777-7000-8000-000000006050','0199ee6c-c777-7000-8000-000000006040', \
         '0199ee6c-c777-7000-8000-000000006040')",
        )
        .await
        .unwrap();
    transaction
        .execute(
            "UPDATE projects SET working_head_bundle_id= \
        '0199ee6c-c777-7000-8000-000000006050',updated_at=CURRENT_TIMESTAMP, \
        lock_version=lock_version+1 WHERE id='0199ee6c-c777-7000-8000-000000006030'",
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();

    assert_rejected(
        pool,
        "UPDATE save_sessions SET state='failed', \
        terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006040'",
        "terminal Save mutation",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE bundles SET physical_bytes=2048 \
        WHERE id='0199ee6c-c777-7000-8000-000000006050'",
        "immutable Bundle metadata",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE projects SET working_head_bundle_id= \
        '0199ee6c-c777-7000-8000-000000006050',updated_at=CURRENT_TIMESTAMP, \
        lock_version=lock_version+1 WHERE id='0199ee6c-c777-7000-8000-000000006031'",
        "cross-Project Working Head without admission",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006065','0199ee6c-c777-7000-8000-000000006031', \
         '0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006050', \
         'version','Cross Project','0199ee6c-c777-7000-8000-000000006001')",
        "cross-Project Version without admission",
    )
    .await;
}

async fn verify_atomic_head_replacement_and_gc_fence(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO save_sessions \
        (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
         expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
         expected_file_count,staging_object_key,upload_mode,expires_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006041','0199ee6c-c777-7000-8000-000000006030', \
         '0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006001',2, \
         decode(repeat('22',32),'hex'),2048,8,2,'staging/projects/6030/save-6041','single', \
         CURRENT_TIMESTAMP + INTERVAL '1 hour')",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='uploading',updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006041'",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='verifying',updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006041'",
    )
    .await;
    execute(
        pool,
        "INSERT INTO bundles \
        (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006051',decode(repeat('22',32),'hex'), \
         'staging/projects/6030/save-6041',2048,8,2,'project-bundle-v1',CURRENT_TIMESTAMP)",
    )
    .await;

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    transaction
        .execute(
            "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,recovery_position,actor_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006060','0199ee6c-c777-7000-8000-000000006030', \
         '0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006050', \
         'recovery',1,'0199ee6c-c777-7000-8000-000000006001')",
        )
        .await
        .unwrap();
    transaction
        .execute(
            "UPDATE save_sessions SET state='committed', \
        committed_bundle_id='0199ee6c-c777-7000-8000-000000006051', \
        terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006041'",
        )
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO project_bundle_admissions \
        (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006030','0199ee6c-c777-7000-8000-000000006020', \
         '0199ee6c-c777-7000-8000-000000006051','0199ee6c-c777-7000-8000-000000006041', \
         '0199ee6c-c777-7000-8000-000000006041')",
        )
        .await
        .unwrap();
    transaction
        .execute(
            "UPDATE projects SET working_head_bundle_id= \
        '0199ee6c-c777-7000-8000-000000006051',updated_at=CURRENT_TIMESTAMP, \
        lock_version=lock_version+1 WHERE id='0199ee6c-c777-7000-8000-000000006030'",
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();

    execute(
        pool,
        "UPDATE gc_candidates SET eligible_at=CURRENT_TIMESTAMP, \
        updated_at=CURRENT_TIMESTAMP WHERE object_key='staging/projects/6030/save-6040'",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE gc_candidates SET attempts=attempts+1,updated_at=CURRENT_TIMESTAMP \
         WHERE object_key='staging/projects/6030/save-6040'",
        "GC attempt advance outside running transition",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE gc_candidates SET status='running',attempts=attempts+1, \
        started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
        WHERE object_key='staging/projects/6030/save-6040'",
        "GC while recovery is live",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,recovery_position,actor_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006061','0199ee6c-c777-7000-8000-000000006030', \
         '0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006050', \
         'recovery',4,'0199ee6c-c777-7000-8000-000000006001')",
        "recovery position four",
    )
    .await;
    execute(
        pool,
        "DELETE FROM project_bundle_refs \
        WHERE id='0199ee6c-c777-7000-8000-000000006060'",
    )
    .await;
    execute(
        pool,
        "INSERT INTO save_sessions \
        (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
         expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
         expected_file_count,staging_object_key,upload_mode,expires_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006046','0199ee6c-c777-7000-8000-000000006031', \
         '0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006001',1, \
         decode(repeat('11',32),'hex'),1024,5,1,'staging/projects/6031/save-6046','single', \
         CURRENT_TIMESTAMP + INTERVAL '1 hour')",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='uploading',updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000006046'",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='verifying',updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000006046'",
    )
    .await;

    let mut gc_connection = pool.acquire().await.unwrap();
    let gc_holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gc_connection)
        .await
        .unwrap();
    let mut gc_transaction = gc_connection.begin().await.unwrap();
    gc_transaction
        .execute(
            "UPDATE gc_candidates SET status='running',attempts=attempts+1, \
             started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
             WHERE object_key='staging/projects/6030/save-6040'",
        )
        .await
        .unwrap();

    let mut commit_connection = pool.acquire().await.unwrap();
    let commit_contender_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *commit_connection)
        .await
        .unwrap();
    let commit_contender = tokio::spawn(async move {
        sqlx::query(
            "UPDATE save_sessions SET state='committed', \
         committed_bundle_id='0199ee6c-c777-7000-8000-000000006050', \
         terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000006046'",
        )
        .execute(&mut *commit_connection)
        .await
    });
    assert!(
        wait_for_database_block(pool, gc_holder_pid, commit_contender_pid).await,
        "Save commit must serialize behind the GC object lifecycle lock"
    );
    gc_transaction.commit().await.unwrap();
    assert!(
        commit_contender.await.unwrap().is_err(),
        "Save commit must fail closed after the GC lock publishes running"
    );
    execute(
        pool,
        "UPDATE save_sessions SET state='failed',terminal_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000006046'",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,recovery_position,actor_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006062','0199ee6c-c777-7000-8000-000000006030', \
         '0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006050', \
         'recovery',1,'0199ee6c-c777-7000-8000-000000006001')",
        "reference during GC delete fence",
    )
    .await;
    execute(
        pool,
        "UPDATE gc_candidates SET status='completed',completed_at=CURRENT_TIMESTAMP, \
        updated_at=CURRENT_TIMESTAMP WHERE object_key='staging/projects/6030/save-6040'",
    )
    .await;
}

async fn verify_completed_gc_metadata_cleanup_allows_verified_reupload(pool: &DatabasePool) {
    execute(
        pool,
        "DELETE FROM project_bundle_admissions \
        WHERE project_id='0199ee6c-c777-7000-8000-000000006030' \
          AND bundle_id='0199ee6c-c777-7000-8000-000000006050'",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET committed_bundle_id=NULL \
         WHERE id='0199ee6c-c777-7000-8000-000000006040'",
    )
    .await;
    execute(
        pool,
        "DELETE FROM bundles \
        WHERE id='0199ee6c-c777-7000-8000-000000006050'",
    )
    .await;
    let purged: bool = sqlx::query_scalar(
        "SELECT committed_bundle_id IS NULL \
        AND committed_bundle_purged_at IS NOT NULL FROM save_sessions \
        WHERE id='0199ee6c-c777-7000-8000-000000006040'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        purged,
        "completed GC must safely detach historical Save result metadata"
    );

    execute(
        pool,
        "INSERT INTO save_sessions \
        (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
         expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
         expected_file_count,staging_object_key,upload_mode,expires_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006044','0199ee6c-c777-7000-8000-000000006032', \
         '0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006001',1, \
         decode(repeat('11',32),'hex'),1024,5,1,'staging/projects/6032/save-6044','single', \
         CURRENT_TIMESTAMP + INTERVAL '1 hour')",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='uploading',updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006044'",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='verifying',updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006044'",
    )
    .await;
    execute(
        pool,
        "INSERT INTO bundles \
        (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006055',decode(repeat('11',32),'hex'), \
         'staging/projects/6032/save-6044',1024,5,1,'project-bundle-v1',CURRENT_TIMESTAMP)",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='committed', \
        committed_bundle_id='0199ee6c-c777-7000-8000-000000006055', \
        terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006044'",
    )
    .await;
    execute(
        pool,
        "INSERT INTO project_bundle_admissions \
        (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006032','0199ee6c-c777-7000-8000-000000006021', \
         '0199ee6c-c777-7000-8000-000000006055','0199ee6c-c777-7000-8000-000000006044', \
         '0199ee6c-c777-7000-8000-000000006044')",
    )
    .await;
    execute(
        pool,
        "UPDATE projects SET working_head_bundle_id= \
        '0199ee6c-c777-7000-8000-000000006055',updated_at=CURRENT_TIMESTAMP, \
        lock_version=lock_version+1 WHERE id='0199ee6c-c777-7000-8000-000000006032'",
    )
    .await;
    execute(
        pool,
        "DELETE FROM save_sessions \
         WHERE id='0199ee6c-c777-7000-8000-000000006044'",
    )
    .await;
    let retained: bool = sqlx::query_scalar(
        "SELECT admission.save_session_id IS NULL \
                AND admission.source_save_session_id='0199ee6c-c777-7000-8000-000000006044' \
                AND project.working_head_bundle_id=admission.bundle_id \
         FROM project_bundle_admissions admission \
         JOIN projects project ON project.id=admission.project_id \
         WHERE admission.project_id='0199ee6c-c777-7000-8000-000000006032' \
           AND admission.bundle_id='0199ee6c-c777-7000-8000-000000006055'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        retained,
        "Save session cleanup must retain admitted Working Head provenance"
    );
}

async fn verify_working_head_swap_uses_deterministic_object_lock_order(pool: &DatabasePool) {
    for statement in [
        "INSERT INTO save_sessions \
         (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
          expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
          expected_file_count,staging_object_key,upload_mode,expires_at) VALUES \
         ('0199ee6c-c777-7000-8000-000000006047','0199ee6c-c777-7000-8000-000000006030', \
          '0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006001',3, \
          decode(repeat('11',32),'hex'),1024,5,1,'staging/projects/6030/admit-6055','single', \
          CURRENT_TIMESTAMP + INTERVAL '1 hour')",
        "UPDATE save_sessions SET state='uploading',updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000006047'",
        "UPDATE save_sessions SET state='verifying',updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000006047'",
        "INSERT INTO save_sessions \
         (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
          expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
          expected_file_count,staging_object_key,upload_mode,expires_at) VALUES \
         ('0199ee6c-c777-7000-8000-000000006048','0199ee6c-c777-7000-8000-000000006032', \
          '0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006001',2, \
          decode(repeat('22',32),'hex'),2048,8,2,'staging/projects/6032/admit-6051','single', \
          CURRENT_TIMESTAMP + INTERVAL '1 hour')",
        "UPDATE save_sessions SET state='uploading',updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000006048'",
        "UPDATE save_sessions SET state='verifying',updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000006048'",
    ] {
        execute(pool, statement).await;
    }

    let mut blocker_connection = pool.acquire().await.unwrap();
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker_connection)
        .await
        .unwrap();
    let mut blocker = blocker_connection.begin().await.unwrap();
    blocker
        .execute(
            "SELECT pg_advisory_xact_lock(1347566129, LEAST( \
             hashtext('bundle-object:staging/projects/6030/save-6041'), \
             hashtext('bundle-object:staging/projects/6032/save-6044')))",
        )
        .await
        .unwrap();

    let mut first_connection = pool.acquire().await.unwrap();
    let first_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *first_connection)
        .await
        .unwrap();
    let first = tokio::spawn(async move {
        let mut transaction = first_connection.begin().await?;
        transaction
            .execute(
                "UPDATE save_sessions SET state='committed', \
                 committed_bundle_id='0199ee6c-c777-7000-8000-000000006055', \
                 terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
                 WHERE id='0199ee6c-c777-7000-8000-000000006047'",
            )
            .await?;
        transaction
            .execute(
                "INSERT INTO project_bundle_admissions \
                 (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) VALUES \
                 ('0199ee6c-c777-7000-8000-000000006030','0199ee6c-c777-7000-8000-000000006020', \
                  '0199ee6c-c777-7000-8000-000000006055','0199ee6c-c777-7000-8000-000000006047', \
                  '0199ee6c-c777-7000-8000-000000006047')",
            )
            .await?;
        transaction.execute(
            "UPDATE projects SET working_head_bundle_id='0199ee6c-c777-7000-8000-000000006055', \
             updated_at=CURRENT_TIMESTAMP,lock_version=lock_version+1 \
             WHERE id='0199ee6c-c777-7000-8000-000000006030'"
        ).await?;
        transaction.commit().await
    });

    let mut second_connection = pool.acquire().await.unwrap();
    let second_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *second_connection)
        .await
        .unwrap();
    let second = tokio::spawn(async move {
        let mut transaction = second_connection.begin().await?;
        transaction
            .execute(
                "UPDATE save_sessions SET state='committed', \
                 committed_bundle_id='0199ee6c-c777-7000-8000-000000006051', \
                 terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
                 WHERE id='0199ee6c-c777-7000-8000-000000006048'",
            )
            .await?;
        transaction
            .execute(
                "INSERT INTO project_bundle_admissions \
                 (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) VALUES \
                 ('0199ee6c-c777-7000-8000-000000006032','0199ee6c-c777-7000-8000-000000006021', \
                  '0199ee6c-c777-7000-8000-000000006051','0199ee6c-c777-7000-8000-000000006048', \
                  '0199ee6c-c777-7000-8000-000000006048')",
            )
            .await?;
        transaction.execute(
            "UPDATE projects SET working_head_bundle_id='0199ee6c-c777-7000-8000-000000006051', \
             updated_at=CURRENT_TIMESTAMP,lock_version=lock_version+1 \
             WHERE id='0199ee6c-c777-7000-8000-000000006032'"
        ).await?;
        transaction.commit().await
    });

    assert!(wait_for_database_block(pool, blocker_pid, first_pid).await);
    assert!(wait_for_database_block(pool, blocker_pid, second_pid).await);

    blocker.commit().await.unwrap();
    time::timeout(Duration::from_secs(5), first)
        .await
        .expect("first Working Head swap must not deadlock")
        .unwrap()
        .unwrap();
    time::timeout(Duration::from_secs(5), second)
        .await
        .expect("second Working Head swap must not deadlock")
        .unwrap()
        .unwrap();

    let swapped: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM projects WHERE \
         (id='0199ee6c-c777-7000-8000-000000006030' \
          AND working_head_bundle_id='0199ee6c-c777-7000-8000-000000006055') \
         OR (id='0199ee6c-c777-7000-8000-000000006032' \
          AND working_head_bundle_id='0199ee6c-c777-7000-8000-000000006051')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(swapped, 2);
}

async fn verify_scope_reference_and_metadata_constraints(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006063','0199ee6c-c777-7000-8000-000000006030', \
         '0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006051', \
         'version','Version 1','0199ee6c-c777-7000-8000-000000006001')",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE project_bundle_refs SET version_name='Changed' \
        WHERE id='0199ee6c-c777-7000-8000-000000006063'",
        "immutable Version identity",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000006064','0199ee6c-c777-7000-8000-000000006030', \
         '0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006051', \
         'version','Cross Scope','0199ee6c-c777-7000-8000-000000006001')",
        "cross-scope Version",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO bundles \
        (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006052',decode(repeat('22',32),'hex'), \
         'staging/duplicate/checksum',2048,8,2,'project-bundle-v1',CURRENT_TIMESTAMP)",
        "duplicate checksum",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO bundles \
        (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006053',decode(repeat('33',32),'hex'), \
         'staging/projects/6030/save-6041',2048,8,2,'project-bundle-v1',CURRENT_TIMESTAMP)",
        "duplicate object identity",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO save_sessions \
        (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
         expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
         expected_file_count,staging_object_key,upload_mode,expires_at) VALUES \
        ('0199ee6c-c777-4000-8000-000000006047','0199ee6c-c777-7000-8000-000000006031', \
         '0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006001',1, \
         decode(repeat('77',32),'hex'),1,0,0,'staging/invalid/save-id','single', \
         CURRENT_TIMESTAMP + INTERVAL '1 hour')",
        "Save session UUIDv7",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id) VALUES \
        ('0199ee6c-c777-4000-8000-000000006066','0199ee6c-c777-7000-8000-000000006030', \
         '0199ee6c-c777-7000-8000-000000006020','0199ee6c-c777-7000-8000-000000006051', \
         'version','Invalid UUID','0199ee6c-c777-7000-8000-000000006001')",
        "Bundle reference UUIDv7",
    )
    .await;
    for (statement, contract) in [
        (
            "INSERT INTO bundles (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES ('0199ee6c-c777-4000-8000-000000006054',decode(repeat('44',32),'hex'),'staging/invalid/id',1,0,0,'project-bundle-v1',CURRENT_TIMESTAMP)",
            "Bundle UUIDv7",
        ),
        (
            "INSERT INTO bundles (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES ('0199ee6c-c777-7000-8000-000000006054',decode(repeat('44',31),'hex'),'staging/invalid/checksum',1,0,0,'project-bundle-v1',CURRENT_TIMESTAMP)",
            "SHA-256 length",
        ),
        (
            "INSERT INTO bundles (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES ('0199ee6c-c777-7000-8000-000000006054',decode(repeat('44',32),'hex'),'staging/invalid/negative',-1,0,0,'project-bundle-v1',CURRENT_TIMESTAMP)",
            "negative physical bytes",
        ),
        (
            "INSERT INTO bundles (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES ('0199ee6c-c777-7000-8000-000000006054',decode(repeat('44',32),'hex'),'staging/invalid/logical',1,268435457,0,'project-bundle-v1',CURRENT_TIMESTAMP)",
            "logical byte overflow",
        ),
        (
            "INSERT INTO bundles (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES ('0199ee6c-c777-7000-8000-000000006054',decode(repeat('44',32),'hex'),'staging/invalid/count',1,0,2501,'project-bundle-v1',CURRENT_TIMESTAMP)",
            "file-count overflow",
        ),
    ] {
        assert_rejected(pool, statement, contract).await;
    }
}

async fn verify_multipart_expiry_and_staging_gc(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO save_sessions \
        (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
         expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
         expected_file_count,staging_object_key,upload_mode,multipart_upload_id,expires_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006042','0199ee6c-c777-7000-8000-000000006031', \
         '0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006001',1, \
         decode(repeat('33',32),'hex'),16777217,3,1,'staging/projects/6031/save-6042', \
         'multipart','upload-6042',CURRENT_TIMESTAMP + INTERVAL '1 hour')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO multipart_parts \
        (save_session_id,part_number,expected_bytes,expected_sha256) VALUES \
        ('0199ee6c-c777-7000-8000-000000006042',1,16777216,decode(repeat('aa',32),'hex')), \
        ('0199ee6c-c777-7000-8000-000000006042',2,1,decode(repeat('bb',32),'hex'))",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO multipart_parts \
        (save_session_id,part_number,expected_bytes,expected_sha256) VALUES \
        ('0199ee6c-c777-7000-8000-000000006042',129,1,decode(repeat('cc',32),'hex'))",
        "multipart part 129",
    )
    .await;
    execute(
        pool,
        "UPDATE multipart_parts SET state='uploaded',object_etag='etag-1', \
        uploaded_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
        WHERE save_session_id='0199ee6c-c777-7000-8000-000000006042' AND part_number=1",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE multipart_parts SET expected_bytes=2,updated_at=CURRENT_TIMESTAMP \
        WHERE save_session_id='0199ee6c-c777-7000-8000-000000006042' AND part_number=1",
        "uploaded part mutation",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE save_sessions SET state='committed', \
        committed_bundle_id='0199ee6c-c777-7000-8000-000000006051', \
        terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006042'",
        "created-to-committed transition",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='failed',terminal_at=CURRENT_TIMESTAMP, \
        updated_at=CURRENT_TIMESTAMP WHERE id='0199ee6c-c777-7000-8000-000000006042'",
    )
    .await;

    execute(pool, "INSERT INTO save_sessions \
        (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
         expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
         expected_file_count,staging_object_key,upload_mode,created_at,updated_at,expires_at) VALUES \
        ('0199ee6c-c777-7000-8000-000000006043','0199ee6c-c777-7000-8000-000000006031', \
         '0199ee6c-c777-7000-8000-000000006021','0199ee6c-c777-7000-8000-000000006001',1, \
         decode(repeat('44',32),'hex'),4096,4,1,'staging/projects/6031/save-6043','single', \
         CURRENT_TIMESTAMP-INTERVAL '2 hours',CURRENT_TIMESTAMP-INTERVAL '2 hours', \
         CURRENT_TIMESTAMP-INTERVAL '1 hour')").await;
    assert_rejected(
        pool,
        "UPDATE save_sessions SET state='uploading',updated_at=CURRENT_TIMESTAMP \
        WHERE id='0199ee6c-c777-7000-8000-000000006043'",
        "expired session reuse",
    )
    .await;
    execute(
        pool,
        "UPDATE save_sessions SET state='expired',terminal_at=CURRENT_TIMESTAMP, \
        updated_at=CURRENT_TIMESTAMP WHERE id='0199ee6c-c777-7000-8000-000000006043'",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE save_sessions SET state='failed',terminal_at=CURRENT_TIMESTAMP, \
        updated_at=CURRENT_TIMESTAMP WHERE id='0199ee6c-c777-7000-8000-000000006043'",
        "expired terminal mutation",
    )
    .await;
    execute(
        pool,
        "INSERT INTO gc_candidates \
        (object_key,expected_sha256,expected_bytes,reason,eligible_at) VALUES \
        ('staging/projects/6031/save-6043',decode(repeat('44',32),'hex'),4096, \
         'save_abandoned',CURRENT_TIMESTAMP)",
    )
    .await;
    execute(
        pool,
        "UPDATE gc_candidates SET status='running',attempts=1, \
        started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP \
        WHERE object_key='staging/projects/6031/save-6043'",
    )
    .await;
    execute(
        pool,
        "UPDATE gc_candidates SET status='completed',completed_at=CURRENT_TIMESTAMP, \
        updated_at=CURRENT_TIMESTAMP WHERE object_key='staging/projects/6031/save-6043'",
    )
    .await;
}

async fn verify_project_delete_enqueues_without_dangling_references(pool: &DatabasePool) {
    execute(
        pool,
        "DELETE FROM projects \
        WHERE id='0199ee6c-c777-7000-8000-000000006030'",
    )
    .await;
    let dangling: i64 = sqlx::query_scalar(
        "SELECT \
        (SELECT count(*) FROM projects WHERE id='0199ee6c-c777-7000-8000-000000006030') + \
        (SELECT count(*) FROM project_bundle_refs \
         WHERE project_id='0199ee6c-c777-7000-8000-000000006030')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(dangling, 0);
    let queued: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM gc_candidates \
        WHERE object_key='staging/projects/6032/save-6044' AND status='queued')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(queued, "Project deletion must leave a bounded GC candidate");
}

async fn verify_bundle_persistence_truncate_is_rejected(pool: &DatabasePool) {
    for (relation, statement) in [
        ("bundles", "TRUNCATE TABLE bundles CASCADE"),
        ("save_sessions", "TRUNCATE TABLE save_sessions CASCADE"),
        (
            "storage_reservations",
            "TRUNCATE TABLE storage_reservations CASCADE",
        ),
        (
            "project_bundle_admissions",
            "TRUNCATE TABLE project_bundle_admissions CASCADE",
        ),
        ("multipart_parts", "TRUNCATE TABLE multipart_parts CASCADE"),
        (
            "project_bundle_refs",
            "TRUNCATE TABLE project_bundle_refs CASCADE",
        ),
        ("gc_candidates", "TRUNCATE TABLE gc_candidates CASCADE"),
    ] {
        assert!(
            sqlx::query(statement)
                .execute(&mut *pool.acquire().await.unwrap())
                .await
                .is_err(),
            "{relation} TRUNCATE must fail closed"
        );
    }
}

async fn verify_schema_shape(pool: &DatabasePool) {
    for relation in [
        "bundles",
        "save_sessions",
        "storage_reservations",
        "project_bundle_admissions",
        "multipart_parts",
        "project_bundle_refs",
        "gc_candidates",
    ] {
        let exists: bool = sqlx::query_scalar("SELECT to_regclass($1)::text IS NOT NULL")
            .bind(format!("public.{relation}"))
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
        assert!(exists, "missing relation {relation}");
    }
    let working_head: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 \
        FROM information_schema.columns WHERE table_schema='public' AND table_name='projects' \
        AND column_name='working_head_bundle_id')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(working_head);

    for (constraint, relation) in [
        ("bundles_sha256_unique", "bundles"),
        ("bundles_object_key_unique", "bundles"),
        ("save_sessions_identity_unique", "save_sessions"),
    ] {
        let actual: Option<String> = sqlx::query_scalar(
            "SELECT conrelid::regclass::text FROM pg_constraint WHERE conname=$1",
        )
        .bind(constraint)
        .fetch_optional(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        assert_eq!(actual.as_deref(), Some(relation), "constraint {constraint}");
    }

    for (constraint, relation, foreign_relation, delete_action, deferrable, deferred) in [
        (
            "save_sessions_project_scope_fk",
            "save_sessions",
            "projects",
            "c",
            false,
            false,
        ),
        (
            "save_sessions_actor_fk",
            "save_sessions",
            "users",
            "r",
            false,
            false,
        ),
        (
            "save_sessions_committed_bundle_fk",
            "save_sessions",
            "bundles",
            "r",
            false,
            false,
        ),
        (
            "storage_reservations_session_scope_fk",
            "storage_reservations",
            "save_sessions",
            "c",
            false,
            false,
        ),
        (
            "storage_reservations_scope_fk",
            "storage_reservations",
            "storage_scopes",
            "r",
            false,
            false,
        ),
        (
            "project_bundle_admissions_project_scope_fk",
            "project_bundle_admissions",
            "projects",
            "c",
            false,
            false,
        ),
        (
            "project_bundle_admissions_bundle_fk",
            "project_bundle_admissions",
            "bundles",
            "r",
            false,
            false,
        ),
        (
            "project_bundle_admissions_committed_save_fk",
            "project_bundle_admissions",
            "save_sessions",
            "n",
            false,
            false,
        ),
        (
            "multipart_parts_session_fk",
            "multipart_parts",
            "save_sessions",
            "c",
            false,
            false,
        ),
        (
            "project_bundle_refs_project_scope_fk",
            "project_bundle_refs",
            "projects",
            "c",
            false,
            false,
        ),
        (
            "project_bundle_refs_bundle_fk",
            "project_bundle_refs",
            "bundles",
            "r",
            false,
            false,
        ),
        (
            "project_bundle_refs_admission_fk",
            "project_bundle_refs",
            "project_bundle_admissions",
            "r",
            false,
            false,
        ),
        (
            "project_bundle_refs_actor_fk",
            "project_bundle_refs",
            "users",
            "r",
            false,
            false,
        ),
        (
            "projects_working_head_bundle_fk",
            "projects",
            "bundles",
            "r",
            false,
            false,
        ),
        (
            "projects_working_head_admission_fk",
            "projects",
            "project_bundle_admissions",
            "a",
            true,
            true,
        ),
    ] {
        let actual: Option<(String, String, String, bool, bool)> = sqlx::query_as(
            "SELECT conrelid::regclass::text,confrelid::regclass::text, \
             confdeltype::text,condeferrable,condeferred \
             FROM pg_constraint WHERE conname=$1 AND contype='f'",
        )
        .bind(constraint)
        .fetch_optional(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        assert_eq!(
            actual,
            Some((
                relation.to_owned(),
                foreign_relation.to_owned(),
                delete_action.to_owned(),
                deferrable,
                deferred,
            )),
            "foreign key {constraint}"
        );
    }

    for (trigger, relation, procedure, trigger_type) in [
        (
            "bundles_immutable",
            "bundles",
            "reject_bundle_update",
            19_i16,
        ),
        (
            "bundles_verified_source",
            "bundles",
            "enforce_verified_bundle_insert",
            7,
        ),
        (
            "bundles_safe_delete",
            "bundles",
            "enforce_verified_bundle_delete",
            11,
        ),
        (
            "bundles_no_truncate",
            "bundles",
            "reject_bundle_persistence_truncate",
            34,
        ),
        (
            "projects_working_head_verified",
            "projects",
            "enforce_project_working_head",
            23,
        ),
        (
            "projects_replaced_head_gc_candidate",
            "projects",
            "enqueue_replaced_working_head",
            17,
        ),
        (
            "projects_deleted_head_gc_candidate",
            "projects",
            "enqueue_deleted_project_head",
            9,
        ),
        (
            "save_sessions_insert_invariants",
            "save_sessions",
            "enforce_save_session_insert",
            7,
        ),
        (
            "save_sessions_update_invariants",
            "save_sessions",
            "enforce_save_session_update",
            19,
        ),
        (
            "save_sessions_terminal_reservation_release",
            "save_sessions",
            "release_terminal_save_reservation",
            17,
        ),
        (
            "save_sessions_safe_delete",
            "save_sessions",
            "enforce_save_session_delete",
            11,
        ),
        (
            "save_sessions_no_truncate",
            "save_sessions",
            "reject_bundle_persistence_truncate",
            34,
        ),
        (
            "storage_reservations_active_session",
            "storage_reservations",
            "enforce_storage_reservation_insert",
            7,
        ),
        (
            "storage_reservations_immutable",
            "storage_reservations",
            "reject_storage_reservation_update",
            19,
        ),
        (
            "storage_reservations_safe_delete",
            "storage_reservations",
            "enforce_storage_reservation_delete",
            11,
        ),
        (
            "storage_reservations_no_truncate",
            "storage_reservations",
            "reject_bundle_persistence_truncate",
            34,
        ),
        (
            "project_bundle_admissions_committed_save",
            "project_bundle_admissions",
            "enforce_project_bundle_admission_insert",
            7,
        ),
        (
            "project_bundle_admissions_immutable",
            "project_bundle_admissions",
            "reject_project_bundle_admission_update",
            19,
        ),
        (
            "project_bundle_admissions_no_truncate",
            "project_bundle_admissions",
            "reject_bundle_persistence_truncate",
            34,
        ),
        (
            "multipart_parts_write_invariants",
            "multipart_parts",
            "enforce_multipart_part_write",
            23,
        ),
        (
            "multipart_parts_no_truncate",
            "multipart_parts",
            "reject_bundle_persistence_truncate",
            34,
        ),
        (
            "project_bundle_refs_verified",
            "project_bundle_refs",
            "enforce_project_bundle_ref_insert",
            7,
        ),
        (
            "project_bundle_refs_immutable",
            "project_bundle_refs",
            "reject_project_bundle_ref_update",
            19,
        ),
        (
            "project_bundle_refs_deleted_gc_candidate",
            "project_bundle_refs",
            "enqueue_deleted_bundle_ref",
            9,
        ),
        (
            "project_bundle_refs_no_truncate",
            "project_bundle_refs",
            "reject_bundle_persistence_truncate",
            34,
        ),
        (
            "gc_candidates_insert_invariants",
            "gc_candidates",
            "enforce_gc_candidate_insert",
            7,
        ),
        (
            "gc_candidates_update_invariants",
            "gc_candidates",
            "enforce_gc_candidate_update",
            19,
        ),
        (
            "gc_candidates_safe_delete",
            "gc_candidates",
            "enforce_gc_candidate_delete",
            11,
        ),
        (
            "gc_candidates_no_truncate",
            "gc_candidates",
            "reject_bundle_persistence_truncate",
            34,
        ),
    ] {
        let actual: Option<(String, String, i16, String)> = sqlx::query_as(
            "SELECT relation.relname,procedure.proname,trigger.tgtype,trigger.tgenabled::text \
             FROM pg_trigger trigger \
             JOIN pg_class relation ON relation.oid=trigger.tgrelid \
             JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid \
             WHERE trigger.tgname=$1 AND NOT trigger.tgisinternal",
        )
        .bind(trigger)
        .fetch_optional(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        assert_eq!(
            actual,
            Some((
                relation.to_owned(),
                procedure.to_owned(),
                trigger_type,
                "O".to_owned(),
            )),
            "trigger {trigger}"
        );
    }

    for (index, unique, partial, keys, options) in [
        (
            "save_sessions_one_active_per_project_idx",
            true,
            true,
            &["project_id"][..],
            &[0_i16][..],
        ),
        (
            "save_sessions_expiry_idx",
            false,
            true,
            &["expires_at", "id"],
            &[0, 0],
        ),
        (
            "save_sessions_scope_state_idx",
            false,
            false,
            &["storage_scope_id", "state", "id"],
            &[0, 0, 0],
        ),
        (
            "storage_reservations_scope_idx",
            false,
            false,
            &["storage_scope_id", "expires_at", "save_session_id"],
            &[0, 0, 0],
        ),
        (
            "project_bundle_admissions_scope_bundle_idx",
            false,
            false,
            &["storage_scope_id", "bundle_id", "project_id"],
            &[0, 0, 0],
        ),
        (
            "project_bundle_refs_recovery_slot_unique",
            true,
            true,
            &["project_id", "recovery_position"],
            &[0, 0],
        ),
        (
            "project_bundle_refs_version_name_unique",
            true,
            true,
            &["project_id", "version_name"],
            &[0, 0],
        ),
        (
            "project_bundle_refs_bundle_idx",
            false,
            false,
            &["bundle_id", "project_id"],
            &[0, 0],
        ),
        (
            "project_bundle_refs_scope_bundle_idx",
            false,
            false,
            &["storage_scope_id", "bundle_id"],
            &[0, 0],
        ),
        (
            "project_bundle_refs_project_created_idx",
            false,
            false,
            &["project_id", "created_at", "id"],
            &[0, 3, 3],
        ),
        (
            "gc_candidates_work_idx",
            false,
            false,
            &["status", "eligible_at", "retry_at", "object_key"],
            &[0, 0, 0, 0],
        ),
    ] {
        let actual: Option<(bool, bool, Vec<String>, Vec<i16>)> = sqlx::query_as(
            "SELECT index.indisunique,index.indpred IS NOT NULL,ARRAY( \
             SELECT pg_get_indexdef(index.indexrelid,position,true) \
             FROM generate_series(1,index.indnkeyatts) position ORDER BY position), \
             ARRAY(SELECT option FROM unnest(index.indoption) option) \
             FROM pg_index index WHERE index.indexrelid=to_regclass($1)",
        )
        .bind(format!("public.{index}"))
        .fetch_optional(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        assert_eq!(
            actual,
            Some((
                unique,
                partial,
                keys.iter().map(|key| (*key).to_owned()).collect(),
                options.to_vec(),
            )),
            "index {index}"
        );
    }
}

async fn assert_rejected(pool: &DatabasePool, statement: &'static str, contract: &str) {
    assert!(
        sqlx::query(statement)
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
        "{contract} must reject invalid direct SQL"
    );
}

async fn wait_for_database_block(pool: &DatabasePool, holder_pid: i32, contender_pid: i32) -> bool {
    let deadline = time::Instant::now() + Duration::from_secs(2);
    let mut observer = pool.acquire().await.unwrap();
    loop {
        let remaining = deadline.saturating_duration_since(time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let observation = time::timeout(
            remaining,
            sqlx::query_scalar::<_, bool>(
                "SELECT $1::integer = ANY(pg_blocking_pids($2::integer))",
            )
            .bind(holder_pid)
            .bind(contender_pid)
            .fetch_one(&mut *observer),
        )
        .await;
        let Ok(Ok(blocked)) = observation else {
            return false;
        };
        if blocked {
            return true;
        }
        time::sleep(Duration::from_millis(25)).await;
    }
}

async fn execute(pool: &DatabasePool, statement: &'static str) {
    sqlx::query(statement)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap_or_else(|error| panic!("fixture statement failed: {statement}\n{error}"));
}

async fn migrate(pool: &DatabasePool) -> MigrationReport {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap()
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            database_url,
            0,
            8,
            Duration::from_secs(5),
            Duration::from_secs(2),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}
