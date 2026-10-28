#![allow(unused_imports)]
use super::access_tokens::*;
use super::schema_probes::*;
use super::*;
use std::borrow::Cow;

use std::env;

use std::fs;

use std::str::FromStr;

use sqlx::migrate::{Migration, MigrationType};

use sqlx::{Acquire, SqlSafeStr};

use super::super::*;

use crate::database::{DatabasePoolConfig, DatabaseTlsConfig};

use crate::identity::UserId;

use crate::project::ProjectId;

use crate::published_example::{
    CreatePublishedExample, PublishedExampleDeleteConfirmation, PublishedExampleError,
    PublishedExampleName, PublishedExampleService, PublishedExampleServicePolicy,
    PublishedExampleState, PublishedExampleVisibility,
};

use super::{DATABASE_CA_ENV, DATABASE_URL_ENV, TEST_MIGRATION_VERSION, TIMEOUT_MIGRATION_VERSION};
use crate::save::ProjectVersionId;

#[test]
pub(crate) fn validates_migration_deadlines() {
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
pub(crate) fn embedded_baseline_is_forward_only_and_framework_scoped() {
    let embedded = embedded_migrator();
    let migrations: Vec<_> = embedded.iter().collect();
    assert_eq!(migrations.len(), 51);
    assert_eq!(
        migrations
            .iter()
            .map(|migration| migration.version)
            .collect::<Vec<_>>(),
        vec![
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
            25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46,
            47, 48, 49, 50, 51
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
pub(crate) fn git_materialization_migration_preserves_destination_provenance_and_cleanup_ledger() {
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
pub(crate) fn invitation_delivery_rotation_is_forward_only_and_guarded_in_database() {
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
pub(crate) fn migration_errors_expose_only_stable_categories() {
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
pub(crate) async fn real_postgres_serializes_validates_rolls_back_and_retries() {
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
    assert_eq!(first_report.latest_version, Some(51));
    assert_eq!(first_report.known_migrations, 51);
    for version in 1..=51 {
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

pub(crate) async fn verify_invitation_delivery_rotation_invariants(pool: &DatabasePool) {
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

pub(crate) async fn verify_published_example_lifecycle(pool: &DatabasePool) {
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
                    name: PublishedExampleName::new("Wrong Published Example".into()).unwrap(),
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

pub(crate) async fn verify_save_upload_lease_delete_fence(pool: &DatabasePool) {
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
