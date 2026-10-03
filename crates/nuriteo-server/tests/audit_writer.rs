use std::env;
use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::str::FromStr;
use std::time::Duration;

use nuriteo_server::audit::{
    ActorType, AuditActor, AuditEvent, AuditEventFields, AuditEventId, AuditMetadata, AuditResult,
    AuditScope, AuditTarget, AuditWriteErrorCategory, AuditWriter, ScopeType,
};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{Timestamp, UserId};
use serde_json::json;
use sqlx::Acquire;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const ACTOR_USER_ID: &str = "01890f3e-0000-7000-8000-000000000001";
const COMMITTED_EVENT_ID: &str = "01890f3e-0000-7000-8000-000000000301";
const ROLLED_BACK_EVENT_ID: &str = "01890f3e-0000-7000-8000-000000000302";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-audit/run.sh"]
async fn audit_writer_is_atomic_with_the_callers_transaction() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    migrate(&pool).await;
    insert_actor(&pool).await;

    commit_mutation_and_event(&pool).await;
    verify_caller_rollback(&pool).await;
    verify_append_failure_rolls_back_mutation(&pool).await;
    verify_actor_context_survives_user_deletion(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("audit fixture pool must close"));
}

async fn commit_mutation_and_event(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    let mut transaction = connection
        .begin()
        .await
        .unwrap_or_else(|_| panic!("commit fixture transaction must begin"));

    sqlx::query("UPDATE users SET display_name = 'Committed actor' WHERE id = $1::uuid")
        .bind(actor_user_id().to_string())
        .execute(&mut *transaction)
        .await
        .unwrap_or_else(|_| panic!("domain mutation must execute"));
    AuditWriter::append(
        &mut transaction,
        &event(COMMITTED_EVENT_ID, "Committed actor"),
    )
    .await
    .unwrap_or_else(|_| panic!("audit append must succeed in caller transaction"));
    transaction
        .commit()
        .await
        .unwrap_or_else(|_| panic!("caller transaction must commit"));

    assert_eq!(user_display_name(pool).await, "Committed actor");
    assert_eq!(event_count(pool, COMMITTED_EVENT_ID).await, 1);
}

async fn verify_caller_rollback(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    let mut transaction = connection
        .begin()
        .await
        .unwrap_or_else(|_| panic!("rollback fixture transaction must begin"));

    sqlx::query("UPDATE users SET display_name = 'Caller rollback' WHERE id = $1::uuid")
        .bind(actor_user_id().to_string())
        .execute(&mut *transaction)
        .await
        .unwrap_or_else(|_| panic!("rollback fixture mutation must execute"));
    AuditWriter::append(
        &mut transaction,
        &event(ROLLED_BACK_EVENT_ID, "Caller rollback"),
    )
    .await
    .unwrap_or_else(|_| panic!("rollback fixture append must succeed"));
    transaction
        .rollback()
        .await
        .unwrap_or_else(|_| panic!("caller transaction must roll back"));

    assert_eq!(user_display_name(pool).await, "Committed actor");
    assert_eq!(event_count(pool, ROLLED_BACK_EVENT_ID).await, 0);
}

async fn verify_append_failure_rolls_back_mutation(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    let mut transaction = connection
        .begin()
        .await
        .unwrap_or_else(|_| panic!("failure fixture transaction must begin"));

    sqlx::query("UPDATE users SET display_name = 'Must roll back' WHERE id = $1::uuid")
        .bind(actor_user_id().to_string())
        .execute(&mut *transaction)
        .await
        .unwrap_or_else(|_| panic!("failure fixture mutation must execute"));
    let error = AuditWriter::append(
        &mut transaction,
        &event(COMMITTED_EVENT_ID, "Must roll back"),
    )
    .await
    .expect_err("duplicate event ID must fail");
    assert_eq!(error.category(), AuditWriteErrorCategory::Constraint);
    for formatted in [error.to_string(), format!("{error:?}")] {
        assert!(
            !formatted.contains("Must roll back"),
            "stable error leaked event context"
        );
        assert!(
            !formatted.contains("192.0.2.10"),
            "stable error leaked source IP"
        );
    }
    transaction
        .rollback()
        .await
        .unwrap_or_else(|_| panic!("failed audit transaction must roll back"));

    assert_eq!(user_display_name(pool).await, "Committed actor");
    assert_eq!(event_count(pool, COMMITTED_EVENT_ID).await, 1);
}

async fn verify_actor_context_survives_user_deletion(pool: &DatabasePool) {
    sqlx::query("DELETE FROM users WHERE id = $1::uuid")
        .bind(actor_user_id().to_string())
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("audit-only actor deletion must succeed"));

    let row = sqlx::query_as::<_, (Option<String>, String, Option<String>)>(
        "SELECT actor_user_id::text, actor_id, actor_display_name \
         FROM audit_events WHERE id = $1::uuid",
    )
    .bind(
        AuditEventId::from_str(COMMITTED_EVENT_ID)
            .unwrap_or_else(|_| panic!("fixture event ID must be valid"))
            .to_string(),
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("retained audit event must remain queryable"));

    assert_eq!(row.0, None);
    assert_eq!(row.1, ACTOR_USER_ID);
    assert_eq!(row.2.as_deref(), Some("Committed actor"));
}

fn event(id: &str, actor_display_name: &str) -> AuditEvent {
    let user_id = actor_user_id();
    AuditEvent::new(AuditEventFields {
        id: AuditEventId::from_str(id).unwrap_or_else(|_| panic!("fixture event ID must be valid")),
        occurred_at: Timestamp::from_unix_timestamp(1_759_564_496)
            .unwrap_or_else(|_| panic!("fixture timestamp must be valid")),
        actor: AuditActor {
            kind: ActorType::User,
            id: user_id.to_string(),
            user_id: Some(user_id),
            display_name: Some(actor_display_name.into()),
        },
        action_code: "user.updated".into(),
        target: AuditTarget {
            kind: "user".into(),
            id: ACTOR_USER_ID.into(),
        },
        scope: AuditScope {
            kind: ScopeType::Instance,
            id: "primary".into(),
        },
        result: AuditResult::Succeeded,
        reason_code: None,
        correlation_id: "request:audit-fixture".into(),
        source_ip: Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        schema_version: 1,
        changed_fields: vec!["display_name".into()],
        metadata: AuditMetadata::new(json!({"summary": "profile changed"}))
            .unwrap_or_else(|_| panic!("fixture metadata must be safe")),
    })
    .unwrap_or_else(|_| panic!("fixture event must be valid"))
}

async fn insert_actor(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users \
         (id, email, normalized_email, display_name, status, is_instance_admin) \
         VALUES ($1::uuid, 'actor@example.test', 'actor@example.test', 'Original actor', \
                 'active', TRUE)",
    )
    .bind(actor_user_id().to_string())
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("fixture actor must be inserted"));
}

async fn user_display_name(pool: &DatabasePool) -> String {
    sqlx::query_scalar("SELECT display_name FROM users WHERE id = $1::uuid")
        .bind(actor_user_id().to_string())
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("fixture actor must remain queryable"))
}

async fn event_count(pool: &DatabasePool, id: &str) -> i64 {
    let id = AuditEventId::from_str(id)
        .unwrap_or_else(|_| panic!("fixture event ID must be valid"))
        .to_string();
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE id = $1::uuid")
        .bind(id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("audit event count must be readable"))
}

fn actor_user_id() -> UserId {
    UserId::from_str(ACTOR_USER_ID).unwrap_or_else(|_| panic!("fixture user ID must be valid"))
}

async fn migrate(pool: &DatabasePool) {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(3), Duration::from_secs(20))
            .unwrap_or_else(|_| panic!("fixture migration options must be valid")),
    )
    .await
    .unwrap_or_else(|_| panic!("embedded migrations must succeed"));
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
        "DROP TABLE IF EXISTS _sqlx_migrations",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap_or_else(|_| panic!("fixture reset statement must succeed"));
    }
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .unwrap_or_else(|_| panic!("fixture must acquire a database connection"))
}
