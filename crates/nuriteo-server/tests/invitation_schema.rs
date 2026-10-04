use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, MigrationReport,
    SchemaReadiness, check_schema_readiness, run_embedded_migrations,
};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const INVITER_ID: &str = "0199ee6c-c777-7000-8000-000000000401";
const FIRST_ID: &str = "0199ee6c-c777-7000-8000-000000000411";
const ACCEPTED_ID: &str = "0199ee6c-c777-7000-8000-000000000412";
const SUPERSEDED_ID: &str = "0199ee6c-c777-7000-8000-000000000413";
const REPLACEMENT_ID: &str = "0199ee6c-c777-7000-8000-000000000414";
const MISMATCHED_ID: &str = "0199ee6c-c777-7000-8000-000000000415";
const MISMATCHED_REPLACEMENT_ID: &str = "0199ee6c-c777-7000-8000-000000000416";
const RAW_TOKEN: &str = "nrt_inv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-invitation/run.sh"]
async fn activation_invitation_schema_enforces_hash_only_lifecycle() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;

    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Pending {
            current: None,
            target: 14
        }
    );
    let first_report = migrate(&pool).await;
    assert_eq!(
        first_report,
        MigrationReport {
            latest_version: Some(15),
            known_migrations: 15
        }
    );
    assert_eq!(migrate(&pool).await, first_report);
    assert_eq!(
        readiness(&pool).await,
        SchemaReadiness::Ready { version: 14 }
    );

    insert_inviter(&pool).await;
    verify_hash_only_storage(&pool).await;
    verify_direct_sql_constraints(&pool).await;
    verify_terminal_transition(&pool).await;
    verify_replacement_lineage(&pool).await;
    verify_schema_objects(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("invitation fixture pool must close"));
}

async fn verify_hash_only_storage(pool: &DatabasePool) {
    let digest = Sha256::digest(RAW_TOKEN.as_bytes()).to_vec();
    insert_pending(pool, FIRST_ID, "first@example.test", &digest).await;

    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM activation_invitations WHERE id = $1::uuid")
            .bind(FIRST_ID)
            .fetch_one(&mut *acquire(pool).await)
            .await
            .unwrap_or_else(|_| panic!("stored token digest must be readable"));
    assert_eq!(stored, digest);

    let serialized: String = sqlx::query_scalar(
        "SELECT row_to_json(invitation)::text FROM activation_invitations invitation \
         WHERE id = $1::uuid",
    )
    .bind(FIRST_ID)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("invitation row JSON must be readable"));
    assert!(!serialized.contains(RAW_TOKEN));

    let token_columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = 'activation_invitations' \
         AND column_name LIKE '%token%' ORDER BY column_name",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("token columns must be inspectable"));
    assert_eq!(token_columns, vec!["token_hash"]);
}

async fn verify_direct_sql_constraints(pool: &DatabasePool) {
    let cases = [
        (
            "UUIDv7 identifier",
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
             ('0199ee6c-c777-4000-8000-000000000421', 'uuid@example.test', $1::uuid, \
              decode(repeat('21', 32), 'hex'), CURRENT_TIMESTAMP + INTERVAL '7 days')",
        ),
        (
            "normalized email",
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000422', 'UPPER@example.test', $1::uuid, \
              decode(repeat('22', 32), 'hex'), CURRENT_TIMESTAMP + INTERVAL '7 days')",
        ),
        (
            "fixed digest length",
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000423', 'digest@example.test', $1::uuid, \
              decode(repeat('23', 31), 'hex'), CURRENT_TIMESTAMP + INTERVAL '7 days')",
        ),
        (
            "minimum expiry",
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000424', 'minimum@example.test', $1::uuid, \
              decode(repeat('24', 32), 'hex'), CURRENT_TIMESTAMP + INTERVAL '59 minutes')",
        ),
        (
            "maximum expiry",
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000425', 'maximum@example.test', $1::uuid, \
              decode(repeat('25', 32), 'hex'), CURRENT_TIMESTAMP + INTERVAL '31 days')",
        ),
        (
            "terminal timestamp pairing",
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, status, token_hash, expires_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000426', 'terminal@example.test', $1::uuid, \
              'accepted', decode(repeat('26', 32), 'hex'), CURRENT_TIMESTAMP + INTERVAL '7 days')",
        ),
    ];
    for (contract, statement) in cases {
        assert_rejected(pool, sqlx::query(statement).bind(INVITER_ID), contract).await;
    }

    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000427', 'duplicate-hash@example.test', \
              $1::uuid, $2, CURRENT_TIMESTAMP + INTERVAL '7 days')",
        )
        .bind(INVITER_ID)
        .bind(Sha256::digest(RAW_TOKEN.as_bytes()).to_vec()),
        "token digest uniqueness",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
             ('0199ee6c-c777-7000-8000-000000000428', 'first@example.test', $1::uuid, \
              decode(repeat('28', 32), 'hex'), CURRENT_TIMESTAMP + INTERVAL '7 days')",
        )
        .bind(INVITER_ID),
        "one pending invitation per normalized email",
    )
    .await;
}

async fn verify_terminal_transition(pool: &DatabasePool) {
    insert_pending(pool, ACCEPTED_ID, "accepted@example.test", &[0x31; 32]).await;
    execute(
        pool,
        sqlx::query(
            "UPDATE activation_invitations SET status = 'accepted', \
             accepted_at = CURRENT_TIMESTAMP WHERE id = $1::uuid",
        )
        .bind(ACCEPTED_ID),
        "pending to accepted transition",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "UPDATE activation_invitations SET status = 'pending', accepted_at = NULL \
             WHERE id = $1::uuid",
        )
        .bind(ACCEPTED_ID),
        "terminal to pending transition",
    )
    .await;
    assert_rejected(
        pool,
        sqlx::query(
            "UPDATE activation_invitations SET expires_at = expires_at + INTERVAL '1 day' \
             WHERE id = $1::uuid",
        )
        .bind(FIRST_ID),
        "immutable issued expiry",
    )
    .await;
}

async fn verify_replacement_lineage(pool: &DatabasePool) {
    insert_pending(pool, SUPERSEDED_ID, "lineage@example.test", &[0x41; 32]).await;
    let mut connection = acquire(pool).await;
    let mut transaction = connection
        .begin()
        .await
        .unwrap_or_else(|_| panic!("lineage transaction must begin"));
    sqlx::query(
        "UPDATE activation_invitations SET status = 'superseded', \
         superseded_at = CURRENT_TIMESTAMP, replaced_by_invitation_id = $2::uuid \
         WHERE id = $1::uuid",
    )
    .bind(SUPERSEDED_ID)
    .bind(REPLACEMENT_ID)
    .execute(&mut *transaction)
    .await
    .unwrap_or_else(|_| panic!("superseded transition must succeed"));
    sqlx::query(
        "INSERT INTO activation_invitations \
         (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
         ($1::uuid, 'lineage@example.test', $2::uuid, decode(repeat('42', 32), 'hex'), \
          CURRENT_TIMESTAMP + INTERVAL '7 days')",
    )
    .bind(REPLACEMENT_ID)
    .bind(INVITER_ID)
    .execute(&mut *transaction)
    .await
    .unwrap_or_else(|_| panic!("same-email replacement must succeed"));
    transaction
        .commit()
        .await
        .unwrap_or_else(|_| panic!("valid replacement lineage must commit"));

    assert_rejected(
        pool,
        sqlx::query(
            "UPDATE activation_invitations SET status = 'superseded', \
             superseded_at = CURRENT_TIMESTAMP, replaced_by_invitation_id = id \
             WHERE id = $1::uuid",
        )
        .bind(REPLACEMENT_ID),
        "self replacement lineage",
    )
    .await;

    insert_pending(pool, MISMATCHED_ID, "old-lineage@example.test", &[0x43; 32]).await;
    let mut connection = acquire(pool).await;
    let mut transaction = connection
        .begin()
        .await
        .unwrap_or_else(|_| panic!("mismatched lineage transaction must begin"));
    transaction
        .execute(
            sqlx::query(
                "UPDATE activation_invitations SET status = 'superseded', \
                 superseded_at = CURRENT_TIMESTAMP, replaced_by_invitation_id = $2::uuid \
                 WHERE id = $1::uuid",
            )
            .bind(MISMATCHED_ID)
            .bind(MISMATCHED_REPLACEMENT_ID),
        )
        .await
        .unwrap_or_else(|_| panic!("deferred mismatched lineage update must initially succeed"));
    transaction
        .execute(
            sqlx::query(
                "INSERT INTO activation_invitations \
                 (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
                 ($1::uuid, 'new-lineage@example.test', $2::uuid, \
                  decode(repeat('44', 32), 'hex'), CURRENT_TIMESTAMP + INTERVAL '7 days')",
            )
            .bind(MISMATCHED_REPLACEMENT_ID)
            .bind(INVITER_ID),
        )
        .await
        .unwrap_or_else(|_| panic!("mismatched replacement insert must reach deferred check"));
    assert!(
        transaction.commit().await.is_err(),
        "different-email replacement lineage must fail at commit"
    );
}

async fn verify_schema_objects(pool: &DatabasePool) {
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' \
         AND tablename = 'activation_invitations' ORDER BY indexname",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("invitation indexes must be inspectable"));
    for required in [
        "activation_invitations_one_pending_email_idx",
        "activation_invitations_pending_expiry_idx",
        "activation_invitations_inviter_idx",
        "activation_invitations_replacement_idx",
    ] {
        assert!(indexes.iter().any(|index| index == required));
    }
    let trigger_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = 'activation_invitations'::regclass \
         AND tgname = 'activation_invitations_forward_only_update' AND NOT tgisinternal",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("invitation trigger must be inspectable"));
    assert_eq!(trigger_count, 1);
}

async fn insert_inviter(pool: &DatabasePool) {
    execute(
        pool,
        sqlx::query(
            "INSERT INTO users (id, email, normalized_email, display_name, is_instance_admin) \
             VALUES ($1::uuid, 'admin@example.test', 'admin@example.test', 'Admin', TRUE)",
        )
        .bind(INVITER_ID),
        "inviter insert",
    )
    .await;
}

async fn insert_pending(pool: &DatabasePool, id: &str, email: &str, digest: &[u8]) {
    execute(
        pool,
        sqlx::query(
            "INSERT INTO activation_invitations \
             (id, normalized_email, invited_by_user_id, token_hash, expires_at) VALUES \
             ($1::uuid, $2, $3::uuid, $4, CURRENT_TIMESTAMP + INTERVAL '7 days')",
        )
        .bind(id)
        .bind(email)
        .bind(INVITER_ID)
        .bind(digest),
        "pending invitation insert",
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
    .unwrap_or_else(|_| panic!("embedded invitation migrations must succeed"))
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
