#![allow(unused_imports)]
use super::*;
use super::constraints::*;
use super::postgres::*;
use std::env;

use std::fs;

use std::time::Duration;


use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};

use sqlx::{Acquire, Executor};

use tokio::time;
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV};



#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-project-bundles/run.sh"]
pub(crate) async fn project_bundle_schema_is_verified_scoped_bounded_and_gc_safe() {    let pool = fixture_pool().await;
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


pub(crate) async fn seed_owners_scopes_and_projects(pool: &DatabasePool) {    execute(pool, "INSERT INTO users (id,email,normalized_email,display_name) VALUES \
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


pub(crate) async fn verify_initial_save_and_working_head(pool: &DatabasePool) {    execute(
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


pub(crate) async fn verify_atomic_head_replacement_and_gc_fence(pool: &DatabasePool) {    execute(
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


pub(crate) async fn verify_completed_gc_metadata_cleanup_allows_verified_reupload(pool: &DatabasePool) {    execute(
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


pub(crate) async fn verify_working_head_swap_uses_deterministic_object_lock_order(pool: &DatabasePool) {    for statement in [
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
