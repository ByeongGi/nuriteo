use super::*;

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::config::{Environment, FileReader, InstanceSettingBootstrap};
use crate::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use crate::identity::{SessionId, UserId};
use crate::instance_settings::InstanceSettingsRepository;
use crate::integration::{IntegrationAdminActor, MasterKeyring};

#[test]
fn validates_public_provider_fields_without_parsing_protocol_endpoints() {
    assert!(OidcProviderInput::new("Corporate", "https://id.example.test", "client").is_ok());
    assert_eq!(
        OidcProviderInput::new(" Corporate", "https://id.example.test", "client").unwrap_err(),
        OidcProviderError::InvalidInput
    );
    assert_eq!(
        OidcProviderInput::new("Corporate", "short", "client").unwrap_err(),
        OidcProviderError::InvalidInput
    );
}

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-oidc-providers/run.sh"]
async fn actual_runtime_resolver_is_version_bound_and_fail_closed() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    seed_admin(&pool).await;

    let service = OidcProviderService::new(IntegrationRepository::new(
        pool.clone(),
        keyring(1, [31; 32], &[]),
    ));
    let provider = service
        .create_provider(
            actor(),
            &OidcProviderInput::new(
                "Runtime provider",
                "https://runtime.example.test",
                "runtime-client",
            )
            .unwrap(),
            &SecretValue::new(b"runtime-secret".to_vec()).unwrap(),
            "request:oidc-runtime-create",
        )
        .await
        .unwrap();
    assert_eq!(
        service.active_provider(provider.id).await.unwrap_err(),
        OidcProviderError::Disabled
    );

    assert!(
        sqlx::query(
            "UPDATE oidc_providers SET status='active',disabled_at=NULL,
              config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(provider.id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err()
    );
    sqlx::query("ALTER TABLE oidc_providers DISABLE TRIGGER oidc_providers_update_guard")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE oidc_providers SET status='active',disabled_at=NULL,
          config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
    )
    .bind(provider.id.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("ALTER TABLE oidc_providers ENABLE TRIGGER oidc_providers_update_guard")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();

    let runtime = service.active_provider(provider.id).await.unwrap();
    assert_eq!(runtime.metadata.secret_version, 1);
    assert_eq!(runtime.client_secret.expose(), b"runtime-secret");
    let wrong = OidcProviderService::new(IntegrationRepository::new(
        pool.clone(),
        keyring(1, [41; 32], &[]),
    ));
    assert_eq!(
        wrong.active_provider(provider.id).await.unwrap_err(),
        OidcProviderError::CredentialUnavailable
    );
    let missing = OidcProviderService::new(IntegrationRepository::new(
        pool.clone(),
        keyring(2, [42; 32], &[]),
    ));
    assert_eq!(
        missing.active_provider(provider.id).await.unwrap_err(),
        OidcProviderError::CredentialUnavailable
    );

    let credential_id: String = sqlx::query_scalar(
        "SELECT client_secret_credential_id::text FROM oidc_providers WHERE id=$1::uuid",
    )
    .bind(provider.id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "ALTER TABLE integration_credentials DISABLE TRIGGER integration_credentials_update_guard",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE integration_credentials SET credential_version=credential_version+1
             WHERE id=$1::uuid",
        )
        .bind(&credential_id)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err(),
        "reverse binding must reject credential generation drift"
    );

    sqlx::query(
        "ALTER TABLE integration_credentials DISABLE TRIGGER oidc_credential_reverse_binding_guard",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE integration_credentials SET credential_version=credential_version+1
         WHERE id=$1::uuid",
    )
    .bind(&credential_id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "ALTER TABLE integration_credentials ENABLE TRIGGER oidc_credential_reverse_binding_guard",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service.active_provider(provider.id).await.unwrap_err(),
        OidcProviderError::CredentialUnavailable
    );
    sqlx::query(
        "ALTER TABLE integration_credentials DISABLE TRIGGER oidc_credential_reverse_binding_guard",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE integration_credentials SET credential_version=credential_version-1
         WHERE id=$1::uuid",
    )
    .bind(&credential_id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "ALTER TABLE integration_credentials ENABLE TRIGGER oidc_credential_reverse_binding_guard",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE integration_credentials SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1)
         WHERE id=$1::uuid",
    )
    .bind(&credential_id)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "ALTER TABLE integration_credentials ENABLE TRIGGER integration_credentials_update_guard",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service.active_provider(provider.id).await.unwrap_err(),
        OidcProviderError::CredentialUnavailable
    );

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

fn actor() -> IntegrationAdminActor {
    IntegrationAdminActor {
        user_id: "0199ee6c-c777-7000-8000-000000007001"
            .parse::<UserId>()
            .unwrap(),
        session_id: "0199ee6c-c777-7000-8000-000000007002"
            .parse::<SessionId>()
            .unwrap(),
    }
}

async fn seed_admin(pool: &DatabasePool) {
    sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000007001','runtime-admin@example.test','runtime-admin@example.test','Runtime Admin',TRUE)")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000007002','0199ee6c-c777-7000-8000-000000007001',decode(repeat('31',32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
}

fn keyring(current: u32, key: [u8; 32], previous: &[(u32, [u8; 32])]) -> MasterKeyring {
    let previous = serde_json::to_string(
        &previous
            .iter()
            .map(|(version, key)| {
                serde_json::json!({"version":version,"key":URL_SAFE_NO_PAD.encode(key)})
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    MasterKeyring::load(
        &TestEnvironment(vec![
            (
                "NURITEO_MASTER_KEY".into(),
                URL_SAFE_NO_PAD.encode(key).into(),
            ),
            (
                "NURITEO_MASTER_KEY_VERSION".into(),
                current.to_string().into(),
            ),
            ("NURITEO_PREVIOUS_MASTER_KEYS".into(), previous.into()),
        ]),
        &NoFiles,
    )
    .unwrap()
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

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&mut *connection)
        .await
        .unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(
        None,
        Some(fs::read(env::var("NURITEO_TEST_DATABASE_CA").unwrap()).unwrap()),
        None,
    )
    .unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            env::var("NURITEO_TEST_DATABASE_URL").unwrap(),
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
