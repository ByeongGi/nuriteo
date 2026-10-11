use std::borrow::Cow;
use std::env;
use std::fs;
use std::str::FromStr;

use sqlx::migrate::{Migration, MigrationType};
use sqlx::{Acquire, SqlSafeStr};

use super::*;
use crate::database::{DatabasePoolConfig, DatabaseTlsConfig};
use crate::identity::UserId;
use crate::project::ProjectId;
use crate::published_example::{
    CreatePublishedExample, PublishedExampleDeleteConfirmation, PublishedExampleError,
    PublishedExampleName, PublishedExampleService, PublishedExampleServicePolicy,
    PublishedExampleState, PublishedExampleVisibility,
};
use crate::save::ProjectVersionId;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const TEST_MIGRATION_VERSION: i64 = 9_001;
const TIMEOUT_MIGRATION_VERSION: i64 = 9_002;

#[test]
fn validates_migration_deadlines() {
    assert_eq!(
        MigrationOptions::new(Duration::from_millis(99), Duration::from_secs(1)),
        Err(MigrationError::InvalidLockWaitTimeout)
    );
    assert_eq!(
        MigrationOptions::new(Duration::from_secs(1), Duration::from_millis(999)),
        Err(MigrationError::InvalidExecutionTimeout)
    );
}

#[test]
fn embedded_baseline_is_forward_only_and_framework_scoped() {
    let embedded = embedded_migrator();
    let migrations: Vec<_> = embedded.iter().collect();
    assert_eq!(migrations.len(), 50);
    assert_eq!(
        migrations
            .iter()
            .map(|migration| migration.version)
            .collect::<Vec<_>>(),
        vec![
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
            25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46,
            47, 48, 49, 50
        ]
    );
    assert_eq!(migrations[0].version, 1);
    assert_eq!(migrations[0].migration_type, MigrationType::Simple);
    assert_eq!(migrations[0].description, "framework baseline");
    for forbidden in ["users", "organizations", "projects", "snapshots"] {
        assert!(!migrations[0].sql.as_str().contains(forbidden));
    }
}

#[test]
fn git_materialization_migration_preserves_destination_provenance_and_cleanup_ledger() {
    assert!(
        GIT_WORKING_HEAD_MATERIALIZATIONS_SQL
            .contains("fork.destination_bundle_id = NEW.bundle_id")
    );
    assert!(GIT_WORKING_HEAD_MATERIALIZATIONS_SQL.contains("canonical_bundle_materializations"));
    assert!(
        GIT_WORKING_HEAD_MATERIALIZATIONS_SQL
            .contains("verification GC candidate requires exact durable provenance")
    );
    assert!(GIT_WORKING_HEAD_MATERIALIZATIONS_SQL.contains("source_git_materialization_id"));
    assert!(
        !GIT_WORKING_HEAD_MATERIALIZATIONS_SQL.contains("fork.source_bundle_id = NEW.bundle_id")
    );
}

#[test]
fn invitation_delivery_rotation_is_forward_only_and_guarded_in_database() {
    for relation in ["activation_invitations", "organization_invitations"] {
        assert!(INVITATION_DELIVERY_TOKENS_SQL.contains(&format!(
            "ALTER TABLE {relation}\n    ADD COLUMN delivery_token_generation"
        )));
    }
    assert!(
        INVITATION_DELIVERY_TOKENS_SQL
            .matches("NEW.delivery_token_generation <> OLD.delivery_token_generation + 1")
            .count()
            == 2
    );
    assert!(
        INVITATION_DELIVERY_TOKENS_SQL
            .matches("OLD.status <> 'pending'")
            .count()
            >= 4
    );
    assert!(
        INVITATION_DELIVERY_TOKENS_SQL
            .matches("NEW.expires_at <= transaction_timestamp()")
            .count()
            == 2
    );
}

#[test]
fn migration_errors_expose_only_stable_categories() {
    let error = MigrationError::ExecutionFailed {
        version: Some(8),
        category: DatabaseErrorCategory::Internal,
    };
    let rendered = format!("{error:?} {error}");
    assert!(!rendered.contains("postgres://"));
    assert!(!rendered.contains("credential"));
    assert_eq!(error.to_string(), "migration 8 execution failed (internal)");
}

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-migrations/run.sh"]
async fn real_postgres_serializes_validates_rolls_back_and_retries() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let normal = options(Duration::from_secs(3), Duration::from_secs(10));

    let project_bundle_rollback_probe = project_bundle_rollback_probe_migrator();
    let rollback_failure = run_migrator(&pool, normal, &project_bundle_rollback_probe).await;
    assert!(matches!(
        rollback_failure,
        Err(MigrationError::ExecutionFailed {
            version: Some(14),
            ..
        })
    ));
    for relation in [
        "bundles",
        "save_sessions",
        "storage_reservations",
        "project_bundle_admissions",
        "multipart_parts",
        "project_bundle_refs",
        "gc_candidates",
    ] {
        assert!(!relation_exists(&pool, relation).await);
    }
    assert!(!column_exists(&pool, "projects", "working_head_bundle_id").await);
    assert!(!constraint_exists(&pool, "projects_storage_identity_unique").await);
    assert!(!constraint_exists(&pool, "projects_working_head_bundle_fk").await);
    assert!(!constraint_exists(&pool, "projects_working_head_admission_fk").await);
    assert_eq!(migration_row_count(&pool, 14).await, 0);

    let mut blocker = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("lock blocker must acquire a connection: {error}"));
    sqlx::query("SELECT pg_advisory_lock($1, $2)")
        .bind(ADVISORY_LOCK_NAMESPACE)
        .bind(ADVISORY_LOCK_KEY)
        .execute(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("fixture must hold the migration lock: {error}"));

    let first_pool = pool.clone();
    let first = tokio::spawn(async move { run_embedded_migrations(&first_pool, normal).await });
    let second_pool = pool.clone();
    let second = tokio::spawn(async move { run_embedded_migrations(&second_pool, normal).await });
    time::sleep(Duration::from_millis(150)).await;
    assert!(!first.is_finished());
    assert!(!second.is_finished());

    let released: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1, $2)")
        .bind(ADVISORY_LOCK_NAMESPACE)
        .bind(ADVISORY_LOCK_KEY)
        .fetch_one(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("fixture lock must release: {error}"));
    assert!(released);
    drop(blocker);

    let first_report = first
        .await
        .unwrap_or_else(|error| panic!("first runner task must join: {error}"))
        .unwrap_or_else(|error| panic!("first runner must succeed: {error}"));
    let second_report = second
        .await
        .unwrap_or_else(|error| panic!("second runner task must join: {error}"))
        .unwrap_or_else(|error| panic!("second runner must succeed: {error}"));
    assert_eq!(first_report, second_report);
    assert_eq!(first_report.latest_version, Some(50));
    assert_eq!(first_report.known_migrations, 50);
    for version in 1..=50 {
        assert_eq!(migration_row_count(&pool, version).await, 1);
    }
    verify_save_upload_lease_delete_fence(&pool).await;
    verify_published_example_lifecycle(&pool).await;
    verify_access_token_invariants(&pool).await;
    verify_invitation_delivery_rotation_invariants(&pool).await;

    let mut blocker = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("timeout blocker must acquire a connection: {error}"));
    sqlx::query("SELECT pg_advisory_lock($1, $2)")
        .bind(ADVISORY_LOCK_NAMESPACE)
        .bind(ADVISORY_LOCK_KEY)
        .execute(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("fixture must hold the timeout lock: {error}"));
    let lock_timeout = run_embedded_migrations(
        &pool,
        options(Duration::from_millis(150), Duration::from_secs(10)),
    )
    .await;
    assert_eq!(lock_timeout, Err(MigrationError::LockWaitTimeout));
    let released: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1, $2)")
        .bind(ADVISORY_LOCK_NAMESPACE)
        .bind(ADVISORY_LOCK_KEY)
        .fetch_one(&mut *blocker)
        .await
        .unwrap_or_else(|error| panic!("timeout lock must release: {error}"));
    assert!(released);
    drop(blocker);

    let failing = test_migrator(Migration::new(
        TEST_MIGRATION_VERSION,
        Cow::Borrowed("transaction failure probe"),
        MigrationType::Simple,
        "CREATE TABLE db002_transaction_probe (id integer PRIMARY KEY);\
         INSERT INTO db002_transaction_probe (id) VALUES (1);\
         INSERT INTO db002_transaction_probe (id) VALUES (1);\
         -- credential-that-must-not-leak"
            .into_sql_str(),
        false,
    ));
    let failure = run_migrator(&pool, normal, &failing).await;
    assert!(matches!(
        failure,
        Err(MigrationError::ExecutionFailed {
            version: Some(TEST_MIGRATION_VERSION),
            ..
        })
    ));
    assert!(!format!("{failure:?}").contains("credential-that-must-not-leak"));
    assert!(!relation_exists(&pool, "db002_transaction_probe").await);
    assert_eq!(migration_row_count(&pool, TEST_MIGRATION_VERSION).await, 0);

    let corrected = test_migrator(Migration::new(
        TEST_MIGRATION_VERSION,
        Cow::Borrowed("transaction failure probe"),
        MigrationType::Simple,
        "CREATE TABLE db002_transaction_probe (id integer PRIMARY KEY);\
         INSERT INTO db002_transaction_probe (id) VALUES (1);"
            .into_sql_str(),
        false,
    ));
    run_migrator(&pool, normal, &corrected)
        .await
        .unwrap_or_else(|error| panic!("corrected migration must succeed: {error}"));
    run_migrator(&pool, normal, &corrected)
        .await
        .unwrap_or_else(|error| panic!("already-applied migration must be skipped: {error}"));
    assert_eq!(migration_row_count(&pool, TEST_MIGRATION_VERSION).await, 1);

    let modified = test_migrator(Migration::new(
        TEST_MIGRATION_VERSION,
        Cow::Borrowed("transaction failure probe"),
        MigrationType::Simple,
        "SELECT 2;".into_sql_str(),
        false,
    ));
    assert_eq!(
        run_migrator(&pool, normal, &modified).await,
        Err(MigrationError::ChecksumMismatch {
            version: TEST_MIGRATION_VERSION
        })
    );
    delete_history(&pool, TEST_MIGRATION_VERSION).await;
    drop_transaction_probe(&pool).await;

    let slow = test_migrator(Migration::new(
        TIMEOUT_MIGRATION_VERSION,
        Cow::Borrowed("execution timeout probe"),
        MigrationType::Simple,
        "SELECT pg_sleep(2);".into_sql_str(),
        false,
    ));
    assert_eq!(
        run_migrator(
            &pool,
            options(Duration::from_secs(2), Duration::from_secs(1)),
            &slow,
        )
        .await,
        Err(MigrationError::ExecutionTimeout)
    );
    assert_eq!(
        migration_row_count(&pool, TIMEOUT_MIGRATION_VERSION).await,
        0
    );
    let corrected_after_timeout = test_migrator(Migration::new(
        TIMEOUT_MIGRATION_VERSION,
        Cow::Borrowed("execution timeout probe"),
        MigrationType::Simple,
        "SELECT 1;".into_sql_str(),
        false,
    ));
    run_migrator(&pool, normal, &corrected_after_timeout)
        .await
        .unwrap_or_else(|error| panic!("migration must retry after timeout: {error}"));
    delete_history(&pool, TIMEOUT_MIGRATION_VERSION).await;

    insert_unknown_history(&pool, 9_999).await;
    assert_eq!(
        run_embedded_migrations(&pool, normal).await,
        Err(MigrationError::AppliedVersionMissing { version: 9_999 })
    );
    delete_history(&pool, 9_999).await;
    run_embedded_migrations(&pool, normal)
        .await
        .unwrap_or_else(|error| panic!("migration must recover after history repair: {error}"));

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|error| panic!("fixture pool must close: {error}"));
}

async fn verify_invitation_delivery_rotation_invariants(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES
         ('0199ee6c-c777-7000-8000-000000009501','delivery-admin@example.test',
          'delivery-admin@example.test','Delivery admin',true),
         ('0199ee6c-c777-7000-8000-000000009502','delivery-user@example.test',
          'delivery-user@example.test','Delivery user',false)",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO activation_invitations
         (id,normalized_email,invited_by_user_id,token_hash,expires_at)
         VALUES('0199ee6c-c777-7000-8000-000000009503','new-delivery@example.test',
         '0199ee6c-c777-7000-8000-000000009501',decode(repeat('11',32),'hex'),
         transaction_timestamp()+INTERVAL '7 days')",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE activation_invitations SET token_hash=decode(repeat('12',32),'hex'),
         delivery_token_generation=delivery_token_generation+1
         WHERE id='0199ee6c-c777-7000-8000-000000009503'",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE activation_invitations SET token_hash=decode(repeat('13',32),'hex')
             WHERE id='0199ee6c-c777-7000-8000-000000009503'",
        )
        .execute(&mut *connection)
        .await
        .is_err()
    );
    sqlx::query(
        "UPDATE activation_invitations SET status='revoked',revoked_at=transaction_timestamp()
         WHERE id='0199ee6c-c777-7000-8000-000000009503'",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE activation_invitations SET token_hash=decode(repeat('14',32),'hex'),
             delivery_token_generation=delivery_token_generation+1
             WHERE id='0199ee6c-c777-7000-8000-000000009503'",
        )
        .execute(&mut *connection)
        .await
        .is_err()
    );

    sqlx::query(
        "INSERT INTO organizations(id,slug,display_name)
         VALUES('0199ee6c-c777-7000-8000-000000009504','delivery-org','Delivery org')",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_invitations
         (id,organization_id,invitee_user_id,normalized_email,invited_by_user_id,proposed_role,
          token_hash,expires_at)
         VALUES('0199ee6c-c777-7000-8000-000000009505',
         '0199ee6c-c777-7000-8000-000000009504','0199ee6c-c777-7000-8000-000000009502',
         'delivery-user@example.test','0199ee6c-c777-7000-8000-000000009501','member',
         decode(repeat('21',32),'hex'),transaction_timestamp()+INTERVAL '7 days')",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE organization_invitations SET token_hash=decode(repeat('22',32),'hex'),
         delivery_token_generation=delivery_token_generation+1
         WHERE id='0199ee6c-c777-7000-8000-000000009505'",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE organization_invitations SET token_hash=decode(repeat('23',32),'hex'),
             delivery_token_generation=delivery_token_generation+2
             WHERE id='0199ee6c-c777-7000-8000-000000009505'",
        )
        .execute(&mut *connection)
        .await
        .is_err()
    );
    sqlx::query(
        "UPDATE organization_invitations SET status='declined',
         declined_at=transaction_timestamp()
         WHERE id='0199ee6c-c777-7000-8000-000000009505'",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE organization_invitations SET token_hash=decode(repeat('24',32),'hex'),
             delivery_token_generation=delivery_token_generation+1
             WHERE id='0199ee6c-c777-7000-8000-000000009505'",
        )
        .execute(&mut *connection)
        .await
        .is_err()
    );
}

async fn verify_published_example_lifecycle(pool: &DatabasePool) {
    const USER: &str = "0199ee6c-c777-7000-8000-000000008001";
    const SCOPE: &str = "0199ee6c-c777-7000-8000-000000008010";
    const PROJECT: &str = "0199ee6c-c777-7000-8000-000000008020";
    const BUNDLE_ONE: &str = "0199ee6c-c777-7000-8000-000000008030";
    const BUNDLE_TWO: &str = "0199ee6c-c777-7000-8000-000000008031";
    const SESSION_ONE: &str = "0199ee6c-c777-7000-8000-000000008040";
    const SESSION_TWO: &str = "0199ee6c-c777-7000-8000-000000008041";
    const VERSION_ONE: &str = "0199ee6c-c777-7000-8000-000000008050";
    const VERSION_TWO: &str = "0199ee6c-c777-7000-8000-000000008051";

    sqlx::query(
        "INSERT INTO users (id,email,normalized_email,display_name) \
         VALUES ($1::uuid,'published@example.test','published@example.test','Publisher')",
    )
    .bind(USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("INSERT INTO storage_scopes (id,owner_user_id) VALUES ($1::uuid,$2::uuid)")
        .bind(SCOPE)
        .bind(USER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) \
         VALUES ($1::uuid,$2::uuid,$3::uuid,'published-example','Published Example')",
    )
    .bind(PROJECT)
    .bind(USER)
    .bind(SCOPE)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    for (session, bundle, checksum, staging) in [
        (
            SESSION_ONE,
            BUNDLE_ONE,
            "81",
            "staging/published-one.bundle",
        ),
        (
            SESSION_TWO,
            BUNDLE_TWO,
            "82",
            "staging/published-two.bundle",
        ),
    ] {
        sqlx::query(
            "INSERT INTO save_sessions \
             (id,project_id,storage_scope_id,actor_user_id,expected_project_version,expected_bundle_sha256,\
              expected_physical_bytes,expected_logical_bytes,expected_file_count,staging_object_key,upload_mode,expires_at) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,decode(repeat($5,32),'hex'),1,0,0,$6,'single',\
                     transaction_timestamp()+interval '1 hour')",
        )
        .bind(session)
        .bind(PROJECT)
        .bind(SCOPE)
        .bind(USER)
        .bind(checksum)
        .bind(staging)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE save_sessions SET state='uploading',updated_at=transaction_timestamp() \
             WHERE id=$1::uuid AND state='created'",
        )
        .bind(session)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE save_sessions SET state='verifying',updated_at=transaction_timestamp() \
             WHERE id=$1::uuid AND state='uploading'",
        )
        .bind(session)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO bundles \
             (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) \
             VALUES ($1::uuid,decode(repeat($2,32),'hex'),$3,1,0,0,'project-bundle-v1',transaction_timestamp())",
        )
        .bind(bundle)
        .bind(checksum)
        .bind(staging)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE save_sessions SET state='committed',committed_bundle_id=$2::uuid,\
             terminal_at=transaction_timestamp(),updated_at=transaction_timestamp() \
             WHERE id=$1::uuid AND state='verifying'",
        )
        .bind(session)
        .bind(bundle)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO project_bundle_admissions \
             (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$4::uuid)",
        )
        .bind(PROJECT)
        .bind(SCOPE)
        .bind(bundle)
        .bind(session)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    for (version, bundle, name) in [
        (VERSION_ONE, BUNDLE_ONE, "Published v1"),
        (VERSION_TWO, BUNDLE_TWO, "Published v2"),
    ] {
        sqlx::query(
            "INSERT INTO project_bundle_refs \
             (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id,\
              idempotency_digest,source_project_version) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'version',$5,$6::uuid,\
                     decode(md5($1) || md5('published:' || $1),'hex'),1)",
        )
        .bind(version)
        .bind(PROJECT)
        .bind(SCOPE)
        .bind(bundle)
        .bind(name)
        .bind(USER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }

    let actor = UserId::from_str(USER).unwrap();
    let project_id = ProjectId::from_str(PROJECT).unwrap();
    let first_version = ProjectVersionId::from_str(VERSION_ONE).unwrap();
    let second_version = ProjectVersionId::from_str(VERSION_TWO).unwrap();
    let service =
        PublishedExampleService::new(pool.clone(), PublishedExampleServicePolicy::default());
    let (created, first) = service
        .create(CreatePublishedExample {
            actor_user_id: actor,
            project_id,
            project_version_id: first_version,
            name: PublishedExampleName::new("Actual Published Example".into()).unwrap(),
            visibility: PublishedExampleVisibility::Public,
        })
        .await
        .unwrap();
    assert_eq!(created.generation(), 1);
    assert_eq!(service.list_public(100).await.unwrap().len(), 1);
    let second = service
        .add_version(actor, created.id(), second_version, 1)
        .await
        .unwrap();
    assert_eq!(second.version_number(), 2);
    let selected = service
        .select_active_version(actor, created.id(), second.id(), 2)
        .await
        .unwrap();
    assert_eq!(selected.active_version_id(), second.id());
    assert_eq!(
        service
            .select_active_version(actor, created.id(), first.id(), 2)
            .await,
        Err(PublishedExampleError::StaleGeneration)
    );
    let unpublished = service.unpublish(actor, created.id(), 3).await.unwrap();
    assert_eq!(unpublished.state(), PublishedExampleState::Unpublished);
    assert_eq!(
        service.resolve_public(created.public_id(), None).await,
        Err(PublishedExampleError::NotFound)
    );
    let republished = service.republish(actor, created.id(), 4).await.unwrap();
    assert_eq!(republished.state(), PublishedExampleState::Published);
    assert_eq!(
        service
            .delete(
                actor,
                created.id(),
                5,
                &PublishedExampleDeleteConfirmation {
                    name: PublishedExampleName::new("Actual Published Example".into()).unwrap(),
                    recently_reauthenticated: false,
                },
            )
            .await,
        Err(PublishedExampleError::ConfirmationRequired)
    );
    let public_id = created.public_id().as_str().to_owned();
    service
        .delete(
            actor,
            created.id(),
            5,
            &PublishedExampleDeleteConfirmation {
                name: PublishedExampleName::new("Actual Published Example".into()).unwrap(),
                recently_reauthenticated: true,
            },
        )
        .await
        .unwrap();
    let tombstones: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM published_example_tombstones WHERE public_id=$1")
            .bind(public_id)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(tombstones, 1);
}

async fn verify_save_upload_lease_delete_fence(pool: &DatabasePool) {
    const USER: &str = "0199ee6c-c777-7000-8000-000000009001";
    const SCOPE: &str = "0199ee6c-c777-7000-8000-000000009010";
    const PROJECT: &str = "0199ee6c-c777-7000-8000-000000009020";
    const SESSION: &str = "0199ee6c-c777-7000-8000-000000009030";
    const FIRST_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009040";
    const SECOND_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009041";

    sqlx::query(
        "INSERT INTO users (id,email,normalized_email,display_name) \
         VALUES ($1::uuid,'lease-fence@example.test','lease-fence@example.test','Lease Fence')",
    )
    .bind(USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("INSERT INTO storage_scopes (id,owner_user_id) VALUES ($1::uuid,$2::uuid)")
        .bind(SCOPE)
        .bind(USER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) \
         VALUES ($1::uuid,$2::uuid,$3::uuid,'lease-fence','Lease Fence')",
    )
    .bind(PROJECT)
    .bind(USER)
    .bind(SCOPE)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO save_sessions \
         (id,project_id,storage_scope_id,actor_user_id,expected_project_version,\
          expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,\
          expected_file_count,staging_object_key,upload_mode,expires_at) \
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,decode(repeat('42',32),'hex'),\
                 1,0,0,'staging/lease-fence.bundle','single',clock_timestamp()+interval '1 hour')",
    )
    .bind(SESSION)
    .bind(PROJECT)
    .bind(SCOPE)
    .bind(USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO save_upload_leases \
         (save_session_id,part_number,generation,lease_token,lease_expires_at) \
         VALUES ($1::uuid,0,1,$2::uuid,clock_timestamp()+interval '5 minutes')",
    )
    .bind(SESSION)
    .bind(FIRST_TOKEN)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    assert_constraint_rejected(
        sqlx::query("DELETE FROM save_upload_leases WHERE save_session_id=$1::uuid")
            .bind(SESSION)
            .execute(&mut *pool.acquire().await.unwrap())
            .await,
    );
    sqlx::query(
        "UPDATE save_upload_leases SET released_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid",
    )
    .bind(SESSION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_constraint_rejected(
        sqlx::query("DELETE FROM save_upload_leases WHERE save_session_id=$1::uuid")
            .bind(SESSION)
            .execute(&mut *pool.acquire().await.unwrap())
            .await,
    );

    let next_generation: i64 = sqlx::query_scalar(
        "INSERT INTO save_upload_leases \
         (save_session_id,part_number,generation,lease_token,lease_expires_at) \
         VALUES ($1::uuid,0,1,$2::uuid,clock_timestamp()+interval '5 minutes') \
         ON CONFLICT (save_session_id,part_number) DO UPDATE SET \
           generation=save_upload_leases.generation+1,lease_token=EXCLUDED.lease_token,\
           lease_expires_at=EXCLUDED.lease_expires_at,released_at=NULL \
         RETURNING generation",
    )
    .bind(SESSION)
    .bind(SECOND_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(next_generation, 2);
    sqlx::query(
        "UPDATE save_upload_leases SET released_at=transaction_timestamp(),updated_at=transaction_timestamp() \
         WHERE save_session_id=$1::uuid AND generation=2",
    )
    .bind(SESSION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE save_sessions SET state='failed',terminal_at=transaction_timestamp(),\
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(SESSION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("DELETE FROM save_sessions WHERE id=$1::uuid")
        .bind(SESSION)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let lease_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM save_upload_leases WHERE save_session_id=$1::uuid",
    )
    .bind(SESSION)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(lease_count, 0);
}

async fn verify_access_token_invariants(pool: &DatabasePool) {
    const USER: &str = "0199ee6c-c777-7000-8000-000000009001";
    const TOKEN: &str = "0199ee6c-c777-7000-8000-000000009101";
    const DISABLE_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009102";
    const PROJECT_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009105";
    const PROJECT: &str = "0199ee6c-c777-7000-8000-000000009020";
    const DELETED_USER: &str = "0199ee6c-c777-7000-8000-000000009107";
    const DELETED_USER_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009108";
    const FAMILY: &str = "0199ee6c-c777-7000-8000-000000009110";

    let insert = |id: &'static str, suffix: u8| {
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,created_by_user_id,scopes,token_prefix,\
              secret_hash,expires_at,rotation_family_id) \
             VALUES ($1::uuid,'personal','CLI',$2::uuid,$2::uuid,$2::uuid,\
                     ARRAY['project:read'],$3,decode(repeat($4,32),'hex'),\
                     transaction_timestamp()+interval '90 days',$5::uuid)",
        )
        .bind(id)
        .bind(USER)
        .bind(format!("nur_pat_{id}_"))
        .bind(format!("{suffix:02x}"))
        .bind(FAMILY)
    };

    insert(TOKEN, 0x11)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,project_id,created_by_user_id,scopes,token_prefix,\
          secret_hash,expires_at,rotation_family_id) \
         VALUES ($1::uuid,'project','CI',$2::uuid,$2::uuid,$3::uuid,ARRAY['project:publish'],\
                 $4,decode(repeat('55',32),'hex'),transaction_timestamp()+interval '90 days',$5::uuid)",
    )
    .bind(PROJECT_TOKEN)
    .bind(PROJECT)
    .bind(USER)
    .bind(format!("nur_prj_{PROJECT_TOKEN}_"))
    .bind(FAMILY)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009103','personal','Too Long',$1::uuid,$1::uuid,\
                     ARRAY['project:read'],'nur_pat_0199ee6c-c777-7000-8000-000000009103_',\
                     decode(repeat('33',32),'hex'),transaction_timestamp()+interval '366 days',$2::uuid)",
        )
        .bind(USER)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );
    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,project_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009106','project','Git Escape',$1::uuid,$1::uuid,\
                     ARRAY['git:read'],'nur_prj_0199ee6c-c777-7000-8000-000000009106_',\
                     decode(repeat('66',32),'hex'),transaction_timestamp()+interval '90 days',$2::uuid)",
        )
        .bind(PROJECT)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );
    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009104','personal','Bad Scope',$1::uuid,$1::uuid,\
                     ARRAY['project:read','project:read'],'nur_pat_0199ee6c-c777-7000-8000-000000009104_',\
                     decode(repeat('44',32),'hex'),transaction_timestamp()+interval '90 days',$2::uuid)",
        )
        .bind(USER)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );

    verify_access_token_runtime(pool, USER, PROJECT).await;
    verify_access_token_management(pool, USER, PROJECT).await;

    sqlx::query(
        "UPDATE access_tokens SET state='revoked',secret_hash=NULL,revoked_at=clock_timestamp(),\
         revoke_reason='operator_revoked',updated_at=clock_timestamp(),lock_version=lock_version+1 \
         WHERE id=$1::uuid",
    )
    .bind(TOKEN)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_constraint_rejected(
        sqlx::query(
            "UPDATE access_tokens SET state='active',secret_hash=decode(repeat('11',32),'hex'),\
             revoked_at=NULL,revoke_reason=NULL,updated_at=clock_timestamp(),lock_version=lock_version+1 \
             WHERE id=$1::uuid",
        )
        .bind(TOKEN)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );

    insert(DISABLE_TOKEN, 0x22)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE users SET status='disabled',disabled_at=clock_timestamp(),updated_at=clock_timestamp() \
         WHERE id=$1::uuid",
    )
    .bind(USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let lifecycle: (String, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,revoke_reason FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(DISABLE_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(lifecycle, ("revoked".into(), true, "user_disabled".into()));

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO project_tombstones(former_project_id,owner_user_id,slug) \
         VALUES ($1::uuid,$2::uuid,'lease-fence')",
    )
    .bind(PROJECT)
    .bind(USER)
    .execute(&mut *transaction)
    .await
    .unwrap();
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(PROJECT)
        .execute(&mut *transaction)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    let project_lifecycle: (String, bool, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,project_id IS NULL,revoke_reason \
         FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(PROJECT_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        project_lifecycle,
        ("revoked".into(), true, true, "project_deleted".into())
    );

    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name) \
         VALUES ($1::uuid,'deleted-token-user@example.test','deleted-token-user@example.test','Delete Me')",
    )
    .bind(DELETED_USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
         VALUES ($1::uuid,'personal','Delete Lifecycle',$2::uuid,$2::uuid,ARRAY['project:read'],$3,\
                 decode(repeat('77',32),'hex'),transaction_timestamp()+interval '90 days',$4::uuid)",
    )
    .bind(DELETED_USER_TOKEN)
    .bind(DELETED_USER)
    .bind(format!("nur_pat_{DELETED_USER_TOKEN}_"))
    .bind(FAMILY)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("DELETE FROM users WHERE id=$1::uuid")
        .bind(DELETED_USER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let deletion_lifecycle: (String, bool, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,owner_user_id IS NULL,revoke_reason \
         FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(DELETED_USER_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        deletion_lifecycle,
        ("revoked".into(), true, true, "user_deleted".into())
    );
}

async fn verify_access_token_runtime(pool: &DatabasePool, user: &str, project: &str) {
    use crate::access_token::{
        AccessTokenAuthenticator, AccessTokenKind, AccessTokenPrincipal, AccessTokenRequest,
        AccessTokenScope, AccessTokenServiceError, ApiCategory, ApiIdempotencyRepository,
        IdempotencyReservation, generate_access_token,
    };
    use crate::project::ProjectId;
    use uuid::Uuid;

    let generated =
        generate_access_token(AccessTokenKind::Personal, [AccessTokenScope::ProjectRead]).unwrap();
    let family = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,created_by_user_id,scopes,token_prefix,\
          secret_hash,expires_at,rotation_family_id) \
         VALUES($1::uuid,'personal','Runtime',$2::uuid,$2::uuid,$2::uuid,ARRAY['project:read'],\
                $3,$4,transaction_timestamp()+interval '90 days',$5::uuid)",
    )
    .bind(generated.id.to_string())
    .bind(user)
    .bind(&generated.token_prefix)
    .bind(generated.secret_hash.as_bytes().as_slice())
    .bind(family.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let authenticator = AccessTokenAuthenticator::new(pool.clone());
    let project_id = project.parse::<ProjectId>().unwrap();
    let source_ip = "192.0.2.44".parse().unwrap();

    let expired =
        generate_access_token(AccessTokenKind::Personal, [AccessTokenScope::ProjectRead]).unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,\
          rotation_family_id,created_at,updated_at) \
         VALUES($1::uuid,'personal','Expired',$2::uuid,$2::uuid,ARRAY['project:read'],$3,$4,\
                transaction_timestamp()-interval '1 second',$5::uuid,\
                transaction_timestamp()-interval '1 day',transaction_timestamp()-interval '1 day')",
    )
    .bind(expired.id.to_string())
    .bind(user)
    .bind(&expired.token_prefix)
    .bind(expired.secret_hash.as_bytes().as_slice())
    .bind(Uuid::now_v7().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        authenticator
            .authenticate(AccessTokenRequest {
                bearer: expired.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectRead,
                project_id: Some(project_id),
                source_ip: Some(source_ip),
                category: ApiCategory::Read,
            })
            .await,
        Err(AccessTokenServiceError::AuthenticationFailed)
    );
    let expired_state: (String, bool) =
        sqlx::query_as("SELECT state,secret_hash IS NULL FROM access_tokens WHERE id=$1::uuid")
            .bind(expired.id.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(expired_state, ("revoked".into(), true));

    for index in 0..30 {
        let observed_ip = std::net::IpAddr::V4(std::net::Ipv4Addr::new(
            192,
            0,
            2,
            40 + u8::try_from(index.min(5)).unwrap(),
        ));
        let principal = authenticator
            .authenticate(AccessTokenRequest {
                bearer: generated.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectRead,
                project_id: Some(project_id),
                source_ip: Some(observed_ip),
                category: ApiCategory::Integration,
            })
            .await
            .unwrap();
        assert!(matches!(principal, AccessTokenPrincipal::User(_)));
    }
    assert_eq!(
        authenticator
            .authenticate(AccessTokenRequest {
                bearer: generated.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectRead,
                project_id: Some(project_id),
                source_ip: Some(source_ip),
                category: ApiCategory::Integration,
            })
            .await,
        Err(AccessTokenServiceError::RateLimited)
    );
    let usage: (i64, i32, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM access_token_source_ips WHERE token_id=$1::uuid),\
                (SELECT used_points FROM api_rate_limit_buckets WHERE subject_kind='token' AND subject_id=$1::uuid),\
                (SELECT COUNT(*) FROM access_tokens WHERE id=$1::uuid AND last_api_category='integration')",
    )
    .bind(generated.id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(usage, (5, 600, 1));

    let project_token = generate_access_token(
        AccessTokenKind::Project,
        [
            AccessTokenScope::ProjectRead,
            AccessTokenScope::ProjectWrite,
        ],
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,project_id,created_by_user_id,scopes,token_prefix,\
          secret_hash,expires_at,rotation_family_id) \
         VALUES($1::uuid,'project','Archive Runtime',$2::uuid,$2::uuid,$3::uuid,\
                ARRAY['project:read','project:write'],$4,$5,\
                transaction_timestamp()+interval '90 days',$6::uuid)",
    )
    .bind(project_token.id.to_string())
    .bind(project)
    .bind(user)
    .bind(&project_token.token_prefix)
    .bind(project_token.secret_hash.as_bytes().as_slice())
    .bind(Uuid::now_v7().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE projects SET state='archived',archived_at=clock_timestamp(),\
         updated_at=clock_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(project)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        authenticator
            .authenticate(AccessTokenRequest {
                bearer: project_token.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectRead,
                project_id: Some(project_id),
                source_ip: Some(source_ip),
                category: ApiCategory::Read,
            })
            .await
            .unwrap(),
        AccessTokenPrincipal::Project(project_id)
    );
    assert_eq!(
        authenticator
            .authenticate(AccessTokenRequest {
                bearer: project_token.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectWrite,
                project_id: Some(project_id),
                source_ip: Some(source_ip),
                category: ApiCategory::Write,
            })
            .await,
        Err(AccessTokenServiceError::Forbidden)
    );
    sqlx::query(
        "UPDATE projects SET state='active',archived_at=NULL,updated_at=clock_timestamp(),\
         lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(project)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let principal_id = Uuid::parse_str(user).unwrap();
    let fingerprint = [0x42; 32];
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert_eq!(
        ApiIdempotencyRepository::reserve(
            &mut transaction,
            principal_id,
            generated.id,
            "POST",
            "/api/v1/projects",
            "runtime-idempotency-key-0001",
            &fingerprint,
        )
        .await
        .unwrap(),
        IdempotencyReservation::New
    );
    let body = serde_json::json!({"id":"project-result"});
    ApiIdempotencyRepository::complete(
        &mut transaction,
        principal_id,
        "POST",
        "/api/v1/projects",
        "runtime-idempotency-key-0001",
        201,
        &body,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert_eq!(
        ApiIdempotencyRepository::reserve(
            &mut transaction,
            principal_id,
            generated.id,
            "POST",
            "/api/v1/projects",
            "runtime-idempotency-key-0001",
            &fingerprint,
        )
        .await
        .unwrap(),
        IdempotencyReservation::Replay { status: 201, body }
    );
    assert_eq!(
        ApiIdempotencyRepository::reserve(
            &mut transaction,
            principal_id,
            generated.id,
            "POST",
            "/api/v1/projects",
            "runtime-idempotency-key-0001",
            &[0x43; 32],
        )
        .await
        .unwrap(),
        IdempotencyReservation::Conflict
    );
    transaction.commit().await.unwrap();
}

async fn verify_access_token_management(pool: &DatabasePool, user: &str, project: &str) {
    use crate::access_token::{
        AccessTokenManagementError, AccessTokenManagementService, AccessTokenScope,
        AccessTokenTarget,
    };
    use crate::config::InstanceSettingBootstrap;
    use crate::identity::{
        BrowserCookieBoundary, BrowserMethod, BrowserRequestHeaders, SessionPolicy, SessionService,
        UserId,
    };
    use crate::instance_settings::InstanceSettingsRepository;
    use crate::project::ProjectId;
    use url::Url;
    use uuid::Uuid;

    let user_id = user.parse::<UserId>().unwrap();
    let project_id = project.parse::<ProjectId>().unwrap();
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    let issued_session = SessionService::new(pool.clone(), SessionPolicy::default())
        .issue(user_id)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE sessions SET last_reauthenticated_at=transaction_timestamp(),\
         last_seen_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(issued_session.session().id().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let csrf = format!("nrt_csrf_{}", "A".repeat(43));
    let cookies = format!(
        "nuriteo_dev_session={}; nuriteo_dev_csrf={csrf}",
        issued_session.token().expose()
    );
    let origins = ["http://127.0.0.1:8080"];
    let cookie_headers = [cookies.as_str()];
    let csrf_headers = [csrf.as_str()];
    let request = |method| BrowserRequestHeaders {
        method,
        origins: &origins,
        cookie_headers: &cookie_headers,
        csrf_headers: &csrf_headers,
    };
    BrowserCookieBoundary::new(&Url::parse("http://127.0.0.1:8080").unwrap())
        .unwrap()
        .validate(request(BrowserMethod::Post))
        .unwrap();
    SessionService::new(pool.clone(), SessionPolicy::default())
        .authenticate(issued_session.token())
        .await
        .unwrap();
    let service = AccessTokenManagementService::production(
        pool.clone(),
        &Url::parse("http://127.0.0.1:8080").unwrap(),
        SessionPolicy::default(),
    )
    .unwrap();

    let issued = service
        .issue(
            request(BrowserMethod::Post),
            AccessTokenTarget::Personal,
            "Fixture CLI",
            vec![AccessTokenScope::ProjectRead],
            Some(30),
            "token-management-fixture-issue",
        )
        .await
        .unwrap();
    assert!(issued.plaintext.starts_with("nur_pat_"));
    assert!(!format!("{issued:?}").contains(&issued.plaintext));
    let stored: (bool, i32) = sqlx::query_as(
        "SELECT secret_hash IS NOT NULL,octet_length(secret_hash) FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(&issued.token.id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(stored, (true, 32));

    let rotated = service
        .rotate(
            request(BrowserMethod::Post),
            AccessTokenTarget::Personal,
            Uuid::parse_str(&issued.token.id).unwrap(),
            Some(7),
            "token-management-fixture-rotate",
        )
        .await
        .unwrap();
    assert_ne!(rotated.plaintext, issued.plaintext);
    let lineage: (String, bool, Option<String>) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,rotated_from_id::text FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(&rotated.token.id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(lineage.0, "active");
    assert!(!lineage.1);
    assert_eq!(lineage.2.as_deref(), Some(issued.token.id.as_str()));
    let old: (String, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,revoke_reason FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(&issued.token.id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(old, ("revoked".into(), true, "rotated".into()));

    let project_token = service
        .issue(
            request(BrowserMethod::Post),
            AccessTokenTarget::Project(project_id),
            "Fixture Project CI",
            vec![
                AccessTokenScope::ProjectRead,
                AccessTokenScope::ProjectWrite,
            ],
            None,
            "token-management-fixture-project",
        )
        .await
        .unwrap();
    assert!(project_token.plaintext.starts_with("nur_prj_"));
    let revoked = service
        .revoke(
            request(BrowserMethod::Delete),
            AccessTokenTarget::Project(project_id),
            Uuid::parse_str(&project_token.token.id).unwrap(),
            "token-management-fixture-revoke",
        )
        .await
        .unwrap();
    assert_eq!(revoked.status, "revoked");

    const OTHER_USER: &str = "0199ee6c-c777-7000-8000-000000009119";
    const OTHER_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009120";
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name) VALUES \
         ($1::uuid,'token-other@example.test','token-other@example.test','Other Token User')",
    )
    .bind(OTHER_USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
         VALUES($1::uuid,'personal','Not Mine',$2::uuid,$2::uuid,ARRAY['project:read'],$3,\
                decode(repeat('88',32),'hex'),transaction_timestamp()+interval '30 days',$4::uuid)",
    )
    .bind(OTHER_TOKEN)
    .bind(OTHER_USER)
    .bind(format!("nur_pat_{OTHER_TOKEN}_"))
    .bind(Uuid::now_v7().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .revoke(
                request(BrowserMethod::Delete),
                AccessTokenTarget::Personal,
                Uuid::parse_str(OTHER_TOKEN).unwrap(),
                "token-management-fixture-cross-user",
            )
            .await,
        Err(AccessTokenManagementError::NotFound)
    );
    let other_active: (String, bool) =
        sqlx::query_as("SELECT state,secret_hash IS NOT NULL FROM access_tokens WHERE id=$1::uuid")
            .bind(OTHER_TOKEN)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(other_active, ("active".into(), true));

    let visible = service
        .list(request(BrowserMethod::Get), AccessTokenTarget::Personal)
        .await
        .unwrap();
    assert!(visible.iter().any(|token| token.id == rotated.token.id));
    assert!(!visible.iter().any(|token| token.id == OTHER_TOKEN));
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE correlation_id LIKE 'token-management-fixture-%'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(audit_count, 4);
    let notification_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notifications WHERE recipient_user_id=$1::uuid \
         AND event_code IN ('access_token.created','access_token.rotated','access_token.revoked') \
         AND resource_type='access_token' AND NOT notification_payload_has_sensitive_key(rendering_data)",
    )
    .bind(user)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(notification_count, 4);
}

fn assert_constraint_rejected(result: Result<sqlx::postgres::PgQueryResult, sqlx::Error>) {
    let error = result.expect_err("constraint violation must be rejected");
    assert_eq!(
        error.as_database_error().and_then(|error| error.code()),
        Some(Cow::Borrowed("23514"))
    );
}

fn options(lock_wait_timeout: Duration, execution_timeout: Duration) -> MigrationOptions {
    MigrationOptions::new(lock_wait_timeout, execution_timeout)
        .unwrap_or_else(|error| panic!("test migration options must be valid: {error}"))
}

fn test_migrator(additional: Migration) -> Migrator {
    let mut migrations: Vec<_> = embedded_migrator().iter().cloned().collect();
    migrations.push(additional);
    migrator_without_driver_lock(migrations)
}

fn project_bundle_rollback_probe_migrator() -> Migrator {
    let mut migrations: Vec<_> = embedded_migrator()
        .iter()
        .filter(|migration| migration.version < 14)
        .cloned()
        .collect();
    let rollback_sql: &'static str =
        Box::leak(format!("{PROJECT_BUNDLES_SQL}\nSELECT 1 / 0;").into_boxed_str());
    migrations.push(Migration::new(
        14,
        Cow::Borrowed("project bundles rollback probe"),
        MigrationType::Simple,
        rollback_sql.into_sql_str(),
        false,
    ));
    migrator_without_driver_lock(migrations)
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"));
    let ca =
        fs::read(ca_path).unwrap_or_else(|error| panic!("fixture CA must be readable: {error}"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|error| panic!("fixture TLS must be valid: {error}"));
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap_or_else(|error| panic!("fixture database config must be valid: {error}"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|error| panic!("fixture database must connect: {error}"))
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("fixture reset must acquire a connection: {error}"));
    for statement in [
        "DROP TABLE IF EXISTS db002_transaction_probe",
        "DROP TABLE IF EXISTS _sqlx_migrations",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap_or_else(|error| panic!("fixture reset statement must succeed: {error}"));
    }
}

async fn migration_row_count(pool: &DatabasePool, version: i64) -> i64 {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history query must acquire a connection: {error}"));
    sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = $1")
        .bind(version)
        .fetch_one(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("history count must succeed: {error}"))
}

async fn relation_exists(pool: &DatabasePool, relation: &str) -> bool {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("relation query must acquire a connection: {error}"));
    sqlx::query_scalar::<_, Option<String>>("SELECT to_regclass($1)::text")
        .bind(format!("public.{relation}"))
        .fetch_one(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("relation query must succeed: {error}"))
        .is_some()
}

async fn column_exists(pool: &DatabasePool, relation: &str, column: &str) -> bool {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("column query must acquire a connection: {error}"));
    sqlx::query_scalar(
        "SELECT EXISTS (\
             SELECT 1 FROM information_schema.columns \
             WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2\
         )",
    )
    .bind(relation)
    .bind(column)
    .fetch_one(&mut *connection)
    .await
    .unwrap_or_else(|error| panic!("column query must succeed: {error}"))
}

async fn constraint_exists(pool: &DatabasePool, constraint: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1)")
        .bind(constraint)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn drop_transaction_probe(pool: &DatabasePool) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("cleanup must acquire a connection: {error}"));
    sqlx::query("DROP TABLE IF EXISTS db002_transaction_probe")
        .execute(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("probe table cleanup must succeed: {error}"));
}

async fn insert_unknown_history(pool: &DatabasePool, version: i64) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history insert must acquire a connection: {error}"));
    sqlx::query(
        "INSERT INTO _sqlx_migrations \
         (version, description, success, checksum, execution_time) \
         VALUES ($1, 'unknown fixture', TRUE, $2, 0)",
    )
    .bind(version)
    .bind(vec![0_u8; 48])
    .execute(&mut *connection)
    .await
    .unwrap_or_else(|error| panic!("unknown history insert must succeed: {error}"));
}

async fn delete_history(pool: &DatabasePool, version: i64) {
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history cleanup must acquire a connection: {error}"));
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = $1")
        .bind(version)
        .execute(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("history cleanup must succeed: {error}"));
}
