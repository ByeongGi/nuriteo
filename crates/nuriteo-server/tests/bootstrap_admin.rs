use std::env;
use std::fs;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{PasswordService, PasswordVerification, StoredPasswordHash};

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const PASSWORD_FILE_ENV: &str = "NURITEO_TEST_BOOTSTRAP_PASSWORD_FILE";
const PASSWORD: &[u8] = b"fixture-bootstrap-password";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-bootstrap/run.sh"]
async fn bootstrap_cli_is_serialized_atomic_and_secret_safe() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;

    let not_ready = run_cli("admin@example.test", "Initial Admin", &password_file());
    assert_failure(&not_ready, "schema-not-ready");
    assert!(!table_exists(&pool, "users").await);

    migrate(&pool).await;
    let children = (0..10)
        .map(|_| spawn_cli("ADMIN@Example.test", "Initial Admin", &password_file()))
        .collect::<Vec<_>>();
    let outputs = children
        .into_iter()
        .map(|child| child.wait_with_output().expect("bootstrap child must exit"))
        .collect::<Vec<_>>();
    assert_eq!(
        outputs
            .iter()
            .filter(|output| output.stdout == b"bootstrap-admin created\n")
            .count(),
        1
    );
    assert_eq!(
        outputs
            .iter()
            .filter(|output| output.stdout == b"bootstrap-admin already-initialized\n")
            .count(),
        9
    );
    for output in &outputs {
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert_secret_free(output);
    }

    assert_counts(&pool, 1, 1, 1, 1).await;
    let (email, normalized, display_name, verifier): (String, String, String, String) =
        sqlx::query_as(
            "SELECT u.email, u.normalized_email, u.display_name, c.password_verifier \
             FROM users u JOIN local_password_credentials c ON c.user_id = u.id",
        )
        .fetch_one(&mut *acquire(&pool).await)
        .await
        .expect("created administrator must be readable");
    assert_eq!(email, "ADMIN@Example.test");
    assert_eq!(normalized, "admin@example.test");
    assert_eq!(display_name, "Initial Admin");
    assert!(!verifier.contains("fixture-bootstrap-password"));
    let stored = StoredPasswordHash::new(verifier.clone()).expect("stored verifier must parse");
    assert_eq!(
        PasswordService::default()
            .verify(PASSWORD, &stored)
            .expect("stored verifier must be supported"),
        PasswordVerification::Match
    );
    let audit: (String, String, String) =
        sqlx::query_as("SELECT action_code, result, metadata::text FROM audit_events")
            .fetch_one(&mut *acquire(&pool).await)
            .await
            .expect("bootstrap audit event must exist");
    assert_eq!(audit.0, "instance_admin.bootstrap_created");
    assert_eq!(audit.1, "succeeded");
    assert!(!audit.2.contains("fixture-bootstrap-password"));

    let missing_password_path = "/definitely/not/read/after/initialization";
    let repeated = run_cli(
        "replacement@example.test",
        "Replacement",
        missing_password_path,
    );
    assert_success(&repeated, "bootstrap-admin already-initialized\n");
    assert_counts(&pool, 1, 1, 1, 1).await;
    assert_eq!(stored_verifier(&pool).await, verifier);

    sqlx::query(
        "UPDATE users SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP, \
         updated_at = CURRENT_TIMESTAMP WHERE is_instance_admin",
    )
    .execute(&mut *acquire(&pool).await)
    .await
    .expect("fixture administrator must be disabled");
    let disabled = run_cli("second@example.test", "Second Admin", missing_password_path);
    assert_success(&disabled, "bootstrap-admin already-initialized\n");
    assert_counts(&pool, 1, 1, 1, 1).await;
    assert_eq!(stored_verifier(&pool).await, verifier);

    reset_rows(&pool).await;
    install_credential_failure(&pool).await;
    let credential_failure = run_cli("admin@example.test", "Initial Admin", &password_file());
    assert_failure(&credential_failure, "database-operation");
    assert_counts(&pool, 0, 0, 0, 0).await;
    remove_failure_hooks(&pool).await;

    install_scope_failure(&pool).await;
    let scope_failure = run_cli("admin@example.test", "Initial Admin", &password_file());
    assert_failure(&scope_failure, "database-operation");
    assert_counts(&pool, 0, 0, 0, 0).await;
    remove_failure_hooks(&pool).await;

    install_audit_failure(&pool).await;
    let audit_failure = run_cli("admin@example.test", "Initial Admin", &password_file());
    assert_failure(&audit_failure, "audit");
    assert_counts(&pool, 0, 0, 0, 0).await;
    remove_failure_hooks(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .expect("bootstrap fixture pool must close");
}

fn spawn_cli(email: &str, name: &str, password_file: &str) -> std::process::Child {
    command(email, name, password_file)
        .spawn()
        .expect("bootstrap process must start")
}

fn run_cli(email: &str, name: &str, password_file: &str) -> Output {
    command(email, name, password_file)
        .output()
        .expect("bootstrap process must exit")
}

fn command(email: &str, name: &str, password_file: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nuriteo-server"));
    command
        .arg("bootstrap-admin")
        .env_clear()
        .env("NURITEO_EXTERNAL_URL", "http://127.0.0.1:3000")
        .env("NURITEO_DATABASE_URL", database_url())
        .env("NURITEO_DATABASE_CA_FILE", database_ca())
        .env("NURITEO_DATABASE_TLS_MODE", "verify-full")
        .env("NURITEO_DATABASE_MAX_CONNECTIONS", "2")
        .env("NURITEO_BOOTSTRAP_ADMIN_EMAIL", email)
        .env("NURITEO_BOOTSTRAP_ADMIN_NAME", name)
        .env("NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", password_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn assert_success(output: &Output, expected: &str) {
    assert!(output.status.success());
    assert_eq!(output.stdout, expected.as_bytes());
    assert!(output.stderr.is_empty());
    assert_secret_free(output);
}

fn assert_failure(output: &Output, category: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        format!("nuriteo-server: bootstrap-admin failed ({category})\n").as_bytes()
    );
    assert_secret_free(output);
}

fn assert_secret_free(output: &Output) {
    let database_url = database_url();
    let password_file = password_file();
    for stream in [&output.stdout, &output.stderr] {
        let stream = String::from_utf8_lossy(stream);
        assert!(!stream.contains("fixture-bootstrap-password"));
        assert!(!stream.contains(database_url.as_str()));
        assert!(!stream.contains(password_file.as_str()));
    }
}

async fn assert_counts(
    pool: &DatabasePool,
    users: i64,
    credentials: i64,
    scopes: i64,
    audits: i64,
) {
    assert_eq!(row_count(pool, "users").await, users);
    assert_eq!(
        row_count(pool, "local_password_credentials").await,
        credentials
    );
    assert_eq!(row_count(pool, "storage_scopes").await, scopes);
    assert_eq!(row_count(pool, "audit_events").await, audits);
}

async fn row_count(pool: &DatabasePool, table: &str) -> i64 {
    let query = match table {
        "users" => "SELECT COUNT(*) FROM users",
        "local_password_credentials" => "SELECT COUNT(*) FROM local_password_credentials",
        "storage_scopes" => "SELECT COUNT(*) FROM storage_scopes",
        "audit_events" => "SELECT COUNT(*) FROM audit_events",
        _ => panic!("fixture row count table must be allowlisted"),
    };
    sqlx::query_scalar(query)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .expect("fixture row count must be readable")
}

async fn stored_verifier(pool: &DatabasePool) -> String {
    sqlx::query_scalar("SELECT password_verifier FROM local_password_credentials")
        .fetch_one(&mut *acquire(pool).await)
        .await
        .expect("stored verifier must remain readable")
}

async fn table_exists(pool: &DatabasePool, table: &str) -> bool {
    sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
        .bind(table)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .expect("fixture table existence must be readable")
}

async fn install_credential_failure(pool: &DatabasePool) {
    sqlx::query(
        "CREATE FUNCTION reject_bootstrap_credential() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'fixture credential rejection'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .expect("credential failure function must install");
    sqlx::query(
        "CREATE TRIGGER reject_bootstrap_credential BEFORE INSERT ON local_password_credentials \
         FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_credential()",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .expect("credential failure trigger must install");
}

async fn install_audit_failure(pool: &DatabasePool) {
    sqlx::query(
        "CREATE FUNCTION reject_bootstrap_audit() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'fixture audit rejection'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .expect("audit failure function must install");
    sqlx::query(
        "CREATE TRIGGER reject_bootstrap_audit BEFORE INSERT ON audit_events \
         FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_audit()",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .expect("audit failure trigger must install");
}

async fn install_scope_failure(pool: &DatabasePool) {
    sqlx::query(
        "CREATE FUNCTION reject_bootstrap_scope() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'fixture scope rejection'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .expect("scope failure function must install");
    sqlx::query(
        "CREATE TRIGGER reject_bootstrap_scope BEFORE INSERT ON storage_scopes \
         FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_scope()",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .expect("scope failure trigger must install");
}

async fn remove_failure_hooks(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    for statement in [
        "DROP TRIGGER IF EXISTS reject_bootstrap_credential ON local_password_credentials",
        "DROP FUNCTION IF EXISTS reject_bootstrap_credential()",
        "DROP TRIGGER IF EXISTS reject_bootstrap_scope ON storage_scopes",
        "DROP FUNCTION IF EXISTS reject_bootstrap_scope()",
        "DROP TRIGGER IF EXISTS reject_bootstrap_audit ON audit_events",
        "DROP FUNCTION IF EXISTS reject_bootstrap_audit()",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .expect("fixture failure hook must be removable");
    }
}

async fn reset_rows(pool: &DatabasePool) {
    sqlx::query("TRUNCATE audit_events, storage_scopes, local_password_credentials, users CASCADE")
        .execute(&mut *acquire(pool).await)
        .await
        .expect("fixture identity rows must reset");
}

async fn migrate(pool: &DatabasePool) {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(3), Duration::from_secs(20))
            .expect("fixture migration options must be valid"),
    )
    .await
    .expect("embedded migrations must succeed");
}

async fn fixture_pool() -> DatabasePool {
    let ca = fs::read(database_ca()).expect("fixture CA must be readable");
    let tls =
        DatabaseTlsConfig::verify_full(None, Some(ca), None).expect("fixture TLS must be valid");
    let config = DatabasePoolConfig::new(
        database_url(),
        0,
        16,
        Duration::from_secs(5),
        Duration::from_secs(5),
        tls,
    )
    .expect("fixture database configuration must be valid");
    DatabasePool::connect(config)
        .await
        .expect("fixture database must connect")
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
            .expect("fixture reset statement must succeed");
    }
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .expect("fixture must acquire a database connection")
}

fn database_url() -> String {
    env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"))
}

fn database_ca() -> String {
    env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"))
}

fn password_file() -> String {
    env::var(PASSWORD_FILE_ENV)
        .unwrap_or_else(|_| panic!("{PASSWORD_FILE_ENV} must be set by the fixture"))
}
