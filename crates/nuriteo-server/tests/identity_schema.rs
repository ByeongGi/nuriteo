use std::borrow::Cow;
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};
use sqlx::SqlSafeStr;
use sqlx::migrate::{Migration, MigrationType, Migrator};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const PRIMARY_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000001";
const SECONDARY_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000002";
const AUDIT_ONLY_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000003";
const FIRST_PROVIDER_ID: &str = "0199ee6c-c777-7000-8000-000000000101";
const SECOND_PROVIDER_ID: &str = "0199ee6c-c777-7000-8000-000000000102";
const REPLACEMENT_SESSION_ID: &str = "0199ee6c-c777-7000-8000-000000000201";
const ROTATED_SESSION_ID: &str = "0199ee6c-c777-7000-8000-000000000202";
const AUDIT_EVENT_ID: &str = "0199ee6c-c777-7000-8000-000000000301";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-identity/run.sh"]
async fn identity_session_and_audit_schema_enforces_contracts() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;

    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Pending {
            current: None,
            target: 14
        }
    );
    verify_failed_migration_rolls_back(&pool).await;
    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Pending {
            current: None,
            target: 14
        }
    );

    let first_report = migrate(&pool).await;
    let repeated_report = migrate(&pool).await;
    assert_eq!(
        first_report,
        MigrationReport {
            latest_version: Some(15),
            known_migrations: 15
        }
    );
    assert_eq!(repeated_report, first_report);
    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Ready { version: 14 }
    );

    verify_user_and_identity_constraints(&pool).await;
    verify_session_constraints(&pool).await;
    verify_audit_retention_contract(&pool).await;
    verify_required_indexes(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("identity fixture pool must close"));
}

async fn verify_failed_migration_rolls_back(pool: &DatabasePool) {
    let migration = Migration::new(
        9_101,
        Cow::Borrowed("identity transaction rollback probe"),
        MigrationType::Simple,
        "CREATE TABLE id001_partial_probe (id integer PRIMARY KEY);\
         INSERT INTO id001_partial_probe (id) VALUES (1);\
         INSERT INTO id001_partial_probe (id) VALUES (1);"
            .into_sql_str(),
        false,
    );
    let mut migrator = Migrator::with_migrations(vec![migration]);
    migrator.set_locking(false);
    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|_| panic!("rollback probe must acquire a connection"));

    assert!(
        migrator
            .run_direct(None, &mut *connection, false)
            .await
            .is_err()
    );
    assert!(!relation_exists(pool, "id001_partial_probe").await);
    assert_eq!(migration_row_count(pool, 9_101).await, 0);
}

async fn verify_user_and_identity_constraints(pool: &DatabasePool) {
    insert_user(
        pool,
        PRIMARY_USER_ID,
        "Admin@Example.test",
        "admin@example.test",
    )
    .await;
    insert_user(
        pool,
        SECONDARY_USER_ID,
        "member@example.test",
        "member@example.test",
    )
    .await;

    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO users (id, email, normalized_email, display_name) \
             VALUES ('0199ee6c-c777-7000-8000-000000000004', \
                     'ADMIN@example.test', 'admin@example.test', 'Duplicate')",
        ),
        "normalized email uniqueness",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO users (id, email, normalized_email, display_name, status) \
             VALUES ('0199ee6c-c777-7000-8000-000000000005', \
                     'invalid@example.test', 'invalid@example.test', 'Invalid', 'pending')",
        ),
        "user lifecycle status",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "UPDATE users SET status = 'disabled', updated_at = CURRENT_TIMESTAMP \
             WHERE id = $1::uuid",
        )
        .bind(PRIMARY_USER_ID),
        "disabled timestamp pairing",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO users \
             (id, email, normalized_email, display_name, created_at, updated_at) \
             VALUES ('0199ee6c-c777-7000-8000-000000000006', \
                     'time@example.test', 'time@example.test', 'Time', \
                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 second')",
        ),
        "user timestamp ordering",
    )
    .await;

    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO local_password_credentials (user_id, password_verifier) \
             VALUES ($1::uuid, 'not-a-verifier')",
        )
        .bind(PRIMARY_USER_ID),
        "local verifier format",
    )
    .await;
    execute(
        pool,
        sqlx::query(
            "INSERT INTO local_password_credentials (user_id, password_verifier) \
             VALUES ($1::uuid, $2)",
        )
        .bind(PRIMARY_USER_ID)
        .bind("$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$dmVyaWZpZXI"),
        "valid local verifier insert",
    )
    .await;

    insert_provider(
        pool,
        FIRST_PROVIDER_ID,
        "Corporate identity",
        "https://identity.example.test",
    )
    .await;
    insert_provider(
        pool,
        SECOND_PROVIDER_ID,
        "Partner identity",
        "https://partner.example.test",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO oidc_providers (id, display_name, issuer) \
             VALUES ('0199ee6c-c777-7000-8000-000000000103', \
                     'Duplicate issuer', 'https://identity.example.test')",
        ),
        "OIDC issuer uniqueness",
    )
    .await;

    insert_identity(
        pool,
        "0199ee6c-c777-7000-8000-000000000111",
        PRIMARY_USER_ID,
        FIRST_PROVIDER_ID,
        "subject-1",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO oidc_identities (id, user_id, provider_id, subject) \
             VALUES ('0199ee6c-c777-7000-8000-000000000112', \
                     $1::uuid, $2::uuid, 'subject-1')",
        )
        .bind(SECONDARY_USER_ID)
        .bind(FIRST_PROVIDER_ID),
        "OIDC provider and subject uniqueness",
    )
    .await;
    insert_identity(
        pool,
        "0199ee6c-c777-7000-8000-000000000113",
        PRIMARY_USER_ID,
        SECOND_PROVIDER_ID,
        "subject-1",
    )
    .await;

    assert_rejected(
        pool,
        sqlx::query("DELETE FROM oidc_providers WHERE id = $1::uuid").bind(FIRST_PROVIDER_ID),
        "linked OIDC provider deletion",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query("DELETE FROM users WHERE id = $1::uuid").bind(PRIMARY_USER_ID),
        "credential-bearing user deletion",
    )
    .await;
}

async fn verify_session_constraints(pool: &DatabasePool) {
    insert_session(pool, REPLACEMENT_SESSION_ID, PRIMARY_USER_ID, "02").await;
    insert_session(pool, ROTATED_SESSION_ID, PRIMARY_USER_ID, "01").await;

    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, token_hash, idle_expires_at, absolute_expires_at) \
             VALUES ('0199ee6c-c777-7000-8000-000000000203', $1::uuid, \
                     decode(repeat('01', 32), 'hex'), \
                     CURRENT_TIMESTAMP + INTERVAL '1 day', \
                     CURRENT_TIMESTAMP + INTERVAL '30 days')",
        )
        .bind(PRIMARY_USER_ID),
        "session token digest uniqueness",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, token_hash, idle_expires_at, absolute_expires_at) \
             VALUES ('0199ee6c-c777-7000-8000-000000000204', $1::uuid, \
                     decode(repeat('03', 32), 'hex'), \
                     CURRENT_TIMESTAMP + INTERVAL '31 days', \
                     CURRENT_TIMESTAMP + INTERVAL '30 days')",
        )
        .bind(PRIMARY_USER_ID),
        "session expiry ordering",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "UPDATE sessions \
             SET rotated_at = CURRENT_TIMESTAMP, replaced_by_session_id = $1::uuid \
             WHERE id = $2::uuid",
        )
        .bind(REPLACEMENT_SESSION_ID)
        .bind(ROTATED_SESSION_ID),
        "rotation without revocation",
    )
    .await;
    execute(
        pool,
        sqlx::query(
            "UPDATE sessions \
             SET rotated_at = CURRENT_TIMESTAMP, revoked_at = CURRENT_TIMESTAMP, \
                 revocation_reason = 'rotated', replaced_by_session_id = $1::uuid \
             WHERE id = $2::uuid",
        )
        .bind(REPLACEMENT_SESSION_ID)
        .bind(ROTATED_SESSION_ID),
        "valid session rotation",
    )
    .await;
}

async fn verify_audit_retention_contract(pool: &DatabasePool) {
    insert_user(
        pool,
        AUDIT_ONLY_USER_ID,
        "auditor@example.test",
        "auditor@example.test",
    )
    .await;
    execute(
        pool,
        sqlx::query(
            "INSERT INTO audit_events \
             (id, actor_type, actor_id, actor_user_id, actor_display_name, action_code, \
              target_type, target_id, scope_type, scope_id, result, reason_code, \
              correlation_id, changed_fields, metadata) \
             VALUES ($1::uuid, 'user', $2, $2::uuid, 'Fixture actor', 'user.disabled', \
                     'user', $3, 'instance', 'primary', 'succeeded', NULL, \
                     'request:fixture-01', ARRAY['status'], \
                     '{\"summary\":\"lifecycle changed\"}'::jsonb)",
        )
        .bind(AUDIT_EVENT_ID)
        .bind(AUDIT_ONLY_USER_ID)
        .bind(SECONDARY_USER_ID),
        "valid audit event insert",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO audit_events \
             (id, actor_type, actor_id, action_code, target_type, target_id, \
              scope_type, scope_id, result, correlation_id, metadata) \
             VALUES ('0199ee6c-c777-7000-8000-000000000302', 'system', 'fixture', \
                     'invalid action', 'user', $1, 'instance', 'primary', \
                     'succeeded', 'request-02', '{}'::jsonb)",
        )
        .bind(PRIMARY_USER_ID),
        "audit action normalization",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO audit_events \
             (id, actor_type, actor_id, action_code, target_type, target_id, \
              scope_type, scope_id, result, correlation_id, metadata) \
             VALUES ('0199ee6c-c777-7000-8000-000000000303', 'system', 'fixture', \
                     'user.updated', 'user', $1, 'instance', 'primary', \
                     'succeeded', 'request-03', '[]'::jsonb)",
        )
        .bind(PRIMARY_USER_ID),
        "audit metadata object shape",
    )
    .await;

    execute(
        pool,
        sqlx::query("DELETE FROM users WHERE id = $1::uuid").bind(AUDIT_ONLY_USER_ID),
        "audit-only actor delete",
    )
    .await;
    let row = sqlx::query_as::<_, (Option<String>, String, String)>(
        "SELECT actor_user_id::text, actor_id, actor_display_name \
         FROM audit_events WHERE id = $1::uuid",
    )
    .bind(AUDIT_EVENT_ID)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("retained audit event must remain queryable"));
    assert_eq!(row.0, None);
    assert_eq!(row.1, AUDIT_ONLY_USER_ID);
    assert_eq!(row.2, "Fixture actor");
}

async fn verify_required_indexes(pool: &DatabasePool) {
    let index_names: BTreeSet<String> = sqlx::query_scalar(
        "SELECT indexname FROM pg_indexes \
         WHERE schemaname = 'public' \
           AND tablename IN ('users', 'oidc_identities', 'sessions', 'audit_events')",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("schema index inventory must be readable"))
    .into_iter()
    .collect();

    for required in [
        "users_active_instance_admin_idx",
        "oidc_identities_provider_subject_unique",
        "oidc_identities_user_idx",
        "sessions_token_hash_unique",
        "sessions_active_user_idx",
        "sessions_idle_expiry_idx",
        "sessions_absolute_expiry_idx",
        "sessions_revoked_at_idx",
        "sessions_replacement_idx",
        "audit_events_occurred_at_idx",
        "audit_events_actor_idx",
        "audit_events_action_idx",
        "audit_events_target_idx",
        "audit_events_scope_idx",
        "audit_events_result_idx",
        "audit_events_correlation_idx",
    ] {
        assert!(
            index_names.contains(required),
            "missing required index: {required}"
        );
    }
}

async fn insert_user(pool: &DatabasePool, id: &str, email: &str, normalized_email: &str) {
    execute(
        pool,
        sqlx::query(
            "INSERT INTO users (id, email, normalized_email, display_name) \
             VALUES ($1::uuid, $2, $3, 'Fixture user')",
        )
        .bind(id)
        .bind(email)
        .bind(normalized_email),
        "user insert",
    )
    .await;
}

async fn insert_provider(pool: &DatabasePool, id: &str, display_name: &str, issuer: &str) {
    execute(
        pool,
        sqlx::query(
            "INSERT INTO oidc_providers (id, display_name, issuer) \
             VALUES ($1::uuid, $2, $3)",
        )
        .bind(id)
        .bind(display_name)
        .bind(issuer),
        "OIDC provider insert",
    )
    .await;
}

async fn insert_identity(
    pool: &DatabasePool,
    id: &str,
    user_id: &str,
    provider_id: &str,
    subject: &str,
) {
    execute(
        pool,
        sqlx::query(
            "INSERT INTO oidc_identities (id, user_id, provider_id, subject) \
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4)",
        )
        .bind(id)
        .bind(user_id)
        .bind(provider_id)
        .bind(subject),
        "OIDC identity insert",
    )
    .await;
}

async fn insert_session(pool: &DatabasePool, id: &str, user_id: &str, hash_byte: &str) {
    execute(
        pool,
        sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, token_hash, idle_expires_at, absolute_expires_at) \
             VALUES ($1::uuid, $2::uuid, decode(repeat($3, 32), 'hex'), \
                     CURRENT_TIMESTAMP + INTERVAL '7 days', \
                     CURRENT_TIMESTAMP + INTERVAL '30 days')",
        )
        .bind(id)
        .bind(user_id)
        .bind(hash_byte),
        "session insert",
    )
    .await;
}

async fn migrate(pool: &DatabasePool) -> MigrationReport {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(3), Duration::from_secs(20))
            .unwrap_or_else(|_| panic!("fixture migration options must be valid")),
    )
    .await
    .unwrap_or_else(|_| panic!("embedded identity migrations must succeed"))
}

async fn readiness(pool: &DatabasePool) -> SchemaReadiness {
    check_schema_readiness(pool)
        .await
        .unwrap_or_else(|_| panic!("schema readiness must be available"))
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"));
    let ca = fs::read(ca_path).unwrap_or_else(|_| panic!("fixture CA must be readable"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|_| panic!("fixture TLS must be valid"));
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap_or_else(|_| panic!("fixture database configuration must be valid"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|_| panic!("fixture database must connect"))
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    for statement in [
        "DROP TABLE IF EXISTS organization_memberships",
        "DROP TABLE IF EXISTS organizations",
        "DROP TABLE IF EXISTS storage_scopes",
        "DROP TABLE IF EXISTS local_auth_failures",
        "DROP TABLE IF EXISTS activation_invitations",
        "DROP TABLE IF EXISTS audit_events",
        "DROP TABLE IF EXISTS sessions",
        "DROP TABLE IF EXISTS oidc_identities",
        "DROP TABLE IF EXISTS oidc_providers",
        "DROP TABLE IF EXISTS local_password_credentials",
        "DROP TABLE IF EXISTS users",
        "DROP TABLE IF EXISTS id001_partial_probe",
        "DROP TABLE IF EXISTS _sqlx_migrations",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap_or_else(|_| panic!("fixture reset statement must succeed"));
    }
}

async fn relation_exists(pool: &DatabasePool, relation: &str) -> bool {
    sqlx::query_scalar::<_, Option<String>>("SELECT to_regclass($1)::text")
        .bind(format!("public.{relation}"))
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("relation lookup must succeed"))
        .is_some()
}

async fn migration_row_count(pool: &DatabasePool, version: i64) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = $1")
        .bind(version)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("migration history count must succeed"))
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .unwrap_or_else(|_| panic!("fixture must acquire a database connection"))
}

async fn execute<'q>(
    pool: &DatabasePool,
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    context: &str,
) {
    query
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("{context} must succeed"));
}

async fn assert_rejected<'q>(
    pool: &DatabasePool,
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    contract: &str,
) {
    assert!(
        query.execute(&mut *acquire(pool).await).await.is_err(),
        "database accepted an invalid {contract}"
    );
}
