use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nuriteo_server::config::{Environment, FileReader, InstanceSettingBootstrap};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::git_operations::{
    GitOperationError, GitOperationService, UnavailableGitExecutor,
};
use nuriteo_server::identity::{SessionId, UserId};
use nuriteo_server::instance_settings::InstanceSettingsRepository;
use nuriteo_server::integration::{IntegrationRepository, MasterKeyring, SecretValue};
use sqlx::{Executor, Row};
use uuid::Uuid;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const USER_ID: &str = "0199ee6c-c777-7000-8000-000000014001";
const SESSION_ID: &str = "0199ee6c-c777-7000-8000-000000014002";
const PROVIDER_ID: &str = "0199ee6c-c777-7000-8000-000000014003";

#[tokio::test]
#[ignore = "requires tests/fixtures/git-https/run-credentials.sh"]
async fn stale_reauthentication_never_mutates_git_credentials() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert!(report.latest_version.is_some_and(|version| version >= 44));
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    seed_user_session_and_provider(&pool).await;

    let user_id = USER_ID.parse::<UserId>().unwrap();
    let session_id = SESSION_ID.parse::<SessionId>().unwrap();
    let provider_id = Uuid::parse_str(PROVIDER_ID).unwrap();
    let service = GitOperationService::new(
        IntegrationRepository::new(pool.clone(), fixture_keyring()),
        Arc::new(UnavailableGitExecutor),
    );
    let initial = SecretValue::new(b"initial-token".to_vec()).unwrap();

    assert_eq!(
        service
            .connect(
                user_id,
                session_id,
                provider_id,
                &initial,
                "request:git-stale-connect",
            )
            .await
            .unwrap_err(),
        GitOperationError::ReauthenticationRequired
    );
    assert_credential_counts(&pool, 0, 0).await;

    reauthenticate(&pool).await;
    let connected = service
        .connect(
            user_id,
            session_id,
            provider_id,
            &initial,
            "request:git-connect",
        )
        .await
        .unwrap();
    assert_credential_counts(&pool, 1, 1).await;
    let before = credential_snapshot(&pool, connected.id).await;

    make_session_stale(&pool).await;
    let replacement = SecretValue::new(b"replacement-token".to_vec()).unwrap();
    assert_eq!(
        service
            .rotate(
                user_id,
                session_id,
                connected.id,
                connected.connection_version,
                &replacement,
                "request:git-stale-rotate",
            )
            .await
            .unwrap_err(),
        GitOperationError::ReauthenticationRequired
    );
    assert_eq!(credential_snapshot(&pool, connected.id).await, before);

    assert_eq!(
        service
            .disconnect(
                user_id,
                session_id,
                connected.id,
                connected.connection_version,
                "request:git-stale-disconnect",
            )
            .await
            .unwrap_err(),
        GitOperationError::ReauthenticationRequired
    );
    assert_eq!(credential_snapshot(&pool, connected.id).await, before);
    assert_credential_counts(&pool, 1, 1).await;
}

#[derive(Debug, PartialEq, Eq)]
struct CredentialSnapshot {
    connection_version: i64,
    credential_version: i64,
    key_version: i32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

async fn credential_snapshot(pool: &DatabasePool, id: Uuid) -> CredentialSnapshot {
    let row = sqlx::query(
        "SELECT user_credential.connection_version,user_credential.credential_version,
                encrypted.key_version,encrypted.nonce,encrypted.ciphertext
         FROM user_git_credentials user_credential
         JOIN integration_credentials encrypted ON encrypted.id=user_credential.credential_id
         WHERE user_credential.id=$1::uuid",
    )
    .bind(id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    CredentialSnapshot {
        connection_version: row.get("connection_version"),
        credential_version: row.get("credential_version"),
        key_version: row.get("key_version"),
        nonce: row.get("nonce"),
        ciphertext: row.get("ciphertext"),
    }
}

async fn assert_credential_counts(pool: &DatabasePool, users: i64, encrypted: i64) {
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_git_credentials")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let encrypted_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM integration_credentials WHERE integration_type='git_user'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!((user_count, encrypted_count), (users, encrypted));
}

async fn seed_user_session_and_provider(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name)
         VALUES($1::uuid,'git-user@example.test','git-user@example.test','Git User')",
    )
    .bind(USER_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sessions
         (id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,
          absolute_expires_at,last_reauthenticated_at)
         VALUES($1::uuid,$2::uuid,decode(repeat('41',32),'hex'),CURRENT_TIMESTAMP-INTERVAL '2 hours',
                CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',
                CURRENT_TIMESTAMP+INTERVAL '2 hours',CURRENT_TIMESTAMP-INTERVAL '1 hour')",
    )
    .bind(SESSION_ID)
    .bind(USER_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO git_providers
         (id,display_name,provider_kind,canonical_host,canonical_port,api_base_url,
          status,allows_read,allows_write)
         VALUES($1::uuid,'Fixture Git','generic','git.example.test',443,
                'https://git.example.test/api','disabled',TRUE,TRUE)",
    )
    .bind(PROVIDER_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE git_providers
         SET status='active',disabled_at=NULL,config_version=2,
             validation_config_version=1,
             validation_endpoint_fingerprint=decode(repeat('11',32),'hex'),
             validation_ca_fingerprint=decode(repeat('22',32),'hex'),
             validated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
         WHERE id=$1::uuid",
    )
    .bind(PROVIDER_ID)
    .execute(&mut *connection)
    .await
    .unwrap();
}

async fn reauthenticate(pool: &DatabasePool) {
    sqlx::query(
        "UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP,
         last_reauthenticated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
    )
    .bind(SESSION_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn make_session_stale(pool: &DatabasePool) {
    sqlx::query(
        "UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP,
         last_reauthenticated_at=CURRENT_TIMESTAMP-INTERVAL '1 hour' WHERE id=$1::uuid",
    )
    .bind(SESSION_ID)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

#[derive(Clone)]
struct TestEnvironment(Vec<(OsString, OsString)>);

impl Environment for TestEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

struct NoFiles;

impl FileReader for NoFiles {
    fn read(&self, _: &Path, _: usize) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::NotFound.into())
    }
}

fn fixture_keyring() -> MasterKeyring {
    MasterKeyring::load(
        &TestEnvironment(vec![
            (
                "NURITEO_MASTER_KEY".into(),
                URL_SAFE_NO_PAD.encode([42_u8; 32]).into(),
            ),
            ("NURITEO_MASTER_KEY_VERSION".into(), "1".into()),
        ]),
        &NoFiles,
    )
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
