use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nuriteo_server::config::{Environment, FileReader, InstanceSettingBootstrap};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{SessionId, UserId};
use nuriteo_server::instance_settings::InstanceSettingsRepository;
use nuriteo_server::integration::{
    CredentialIdentity, IntegrationAdminActor, IntegrationAdminService, IntegrationError,
    IntegrationRepository, MasterKeyring, SecretValue,
};
use nuriteo_server::oidc::{
    OidcProviderError, OidcProviderInput, OidcProviderService, OidcProviderState,
    OidcProviderUpdate,
};
use uuid::Uuid;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-oidc-providers/run.sh"]
async fn oidc_provider_lifecycle_is_concurrent_audited_and_fail_closed() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert!(report.latest_version.is_some_and(|version| version >= 28));
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    seed_admins(&pool).await;

    let integrations = IntegrationRepository::new(pool.clone(), keyring([11; 32]));
    let service = OidcProviderService::new(integrations.clone());
    let input = OidcProviderInput::new(
        "Corporate identity",
        "https://identity.example.test",
        "nuriteo-client",
    )
    .unwrap();
    sqlx::query("UPDATE sessions SET last_reauthenticated_at=NULL WHERE id=$1::uuid")
        .bind(actor().session_id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        service
            .create_provider(
                actor(),
                &input,
                &secret("secret-stale"),
                "request:oidc-stale",
            )
            .await
            .unwrap_err(),
        OidcProviderError::ReauthenticationRequired
    );
    reauthenticate(&pool, actor()).await;

    let first = service.clone();
    let second = service.clone();
    let first_input = input.clone();
    let second_input = input.clone();
    let (created_a, created_b) = tokio::join!(
        async move {
            first
                .create_provider(
                    actor(),
                    &first_input,
                    &secret("secret-a"),
                    "request:oidc-create-a",
                )
                .await
        },
        async move {
            second
                .create_provider(
                    second_actor(),
                    &second_input,
                    &secret("secret-b"),
                    "request:oidc-create-b",
                )
                .await
        }
    );
    let created = match (created_a, created_b) {
        (Ok(provider), Err(OidcProviderError::Conflict))
        | (Err(OidcProviderError::Conflict), Ok(provider)) => provider,
        observed => panic!("concurrent provider create was not classified: {observed:?}"),
    };
    assert_eq!(created.state, OidcProviderState::Disabled);
    assert_eq!(created.secret_version, 1);
    assert!(
        sqlx::query(
            "INSERT INTO oidc_providers
             (id,display_name,issuer,status,disabled_at,client_id,config_version,secret_version)
             VALUES($1::uuid,'Bypass','https://bypass.example.test','active',NULL,'bypass',1,0)",
        )
        .bind(Uuid::now_v7().to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err(),
        "OIDC providers must enter through disabled candidate state"
    );

    let generic = IntegrationAdminService::new(integrations.clone());
    let generic_identity =
        CredentialIdentity::new("instance", "oidc", created.id.to_string(), "client_secret")
            .unwrap();
    assert_eq!(
        generic
            .put_credential(
                actor(),
                &generic_identity,
                &secret("generic-bypass"),
                "request:oidc-generic",
            )
            .await
            .unwrap_err(),
        IntegrationError::InvalidInput
    );
    assert!(
        sqlx::query("UPDATE oidc_providers SET issuer='https://changed.example.test',config_version=config_version+1 WHERE id=$1::uuid")
            .bind(created.id.to_string())
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
        "issuer changes must create a new provider"
    );
    let updated = service
        .update_provider(
            actor(),
            created.id,
            created.config_version,
            &OidcProviderUpdate::new("Corporate SSO", "nuriteo-client-v2").unwrap(),
            "request:oidc-update",
        )
        .await
        .unwrap();

    let rotate_a = service.clone();
    let rotate_b = service.clone();
    let secret_a = secret("rotated-a");
    let secret_b = secret("rotated-b");
    let (rotated_a, rotated_b) = tokio::join!(
        rotate_a.rotate_client_secret(
            actor(),
            created.id,
            updated.config_version,
            &secret_a,
            "request:oidc-rotate-a",
        ),
        rotate_b.rotate_client_secret(
            second_actor(),
            created.id,
            updated.config_version,
            &secret_b,
            "request:oidc-rotate-b",
        )
    );
    let rotated = match (rotated_a, rotated_b) {
        (Ok(provider), Err(OidcProviderError::Conflict))
        | (Err(OidcProviderError::Conflict), Ok(provider)) => provider,
        observed => panic!("concurrent secret rotation was not fenced: {observed:?}"),
    };
    assert_eq!(rotated.secret_version, 2);
    assert!(
        sqlx::query(
            "UPDATE oidc_providers SET client_secret_credential_id=NULL,
              secret_version=0,config_version=config_version+1 WHERE id=$1::uuid",
        )
        .bind(created.id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err(),
        "an adopted provider credential reference cannot be cleared"
    );

    let unvalidated_activation_sql = "UPDATE oidc_providers SET status='active',disabled_at=NULL,
          config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid";
    assert!(
        sqlx::query(unvalidated_activation_sql)
            .bind(created.id.to_string())
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
        "OIDC activation must carry a complete validation proof"
    );
    let proof_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO oidc_validation_proofs
         (id,provider_id,config_version,secret_version,authorization_endpoint,token_endpoint,
          jwks_uri,redirect_uri,validation_fingerprint,validation_ca_fingerprint,
          jwks_fingerprint,expires_at,used_at,attestation_key_version,activation_attestation)
         VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,decode(repeat('11',32),'hex'),
                decode(repeat('12',32),'hex'),decode(repeat('22',32),'hex'),
                CURRENT_TIMESTAMP+INTERVAL '5 minutes',CURRENT_TIMESTAMP,
                1,decode(repeat('33',32),'hex'))",
    )
    .bind(proof_id.to_string())
    .bind(created.id.to_string())
    .bind(i64::try_from(rotated.config_version).unwrap())
    .bind(i64::try_from(rotated.secret_version).unwrap())
    .bind("https://identity.example.test/authorize")
    .bind("https://identity.example.test/token")
    .bind("https://identity.example.test/jwks")
    .bind("https://app.example.test/callback")
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let activation_sql = "UPDATE oidc_providers SET status='active',disabled_at=NULL,
          config_version=config_version+1,
          authorization_endpoint='https://identity.example.test/authorize',
          token_endpoint='https://identity.example.test/token',
          jwks_uri='https://identity.example.test/jwks',
          redirect_uri='https://app.example.test/callback',
          validation_config_version=config_version,validation_secret_version=secret_version,
          validation_fingerprint=decode(repeat('11',32),'hex'),
          validation_ca_fingerprint=decode(repeat('12',32),'hex'),
          jwks_fingerprint=decode(repeat('22',32),'hex'),validation_proof_id=$2::uuid,
          validated_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid";
    // Corruption-style setup solely to exercise active -> disabled/delete
    // guards; supported activation always uses the proof-bearing service.
    sqlx::query("ALTER TABLE oidc_providers DISABLE TRIGGER oidc_providers_update_guard")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(activation_sql)
        .bind(created.id.to_string())
        .bind(proof_id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query("ALTER TABLE oidc_providers ENABLE TRIGGER oidc_providers_update_guard")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        service
            .update_provider(
                actor(),
                created.id,
                rotated.config_version + 1,
                &OidcProviderUpdate::new("Unsafe Active Change", "changed-client").unwrap(),
                "request:oidc-active-update",
            )
            .await
            .unwrap_err(),
        OidcProviderError::MustDisable
    );
    assert!(
        sqlx::query("DELETE FROM oidc_providers WHERE id=$1::uuid")
            .bind(created.id.to_string())
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
        "an active provider cannot be deleted"
    );
    seed_linked_identity(&pool, created.id).await;
    let disabled = service
        .disable_provider(
            actor(),
            created.id,
            rotated.config_version + 1,
            "request:oidc-disable",
        )
        .await
        .unwrap();
    assert_eq!(disabled.state, OidcProviderState::Disabled);
    assert_eq!(disabled.linked_identity_count, 1);
    assert_eq!(
        service
            .delete_provider(
                actor(),
                created.id,
                disabled.config_version,
                "request:oidc-delete-linked",
            )
            .await
            .unwrap_err(),
        OidcProviderError::LinkedIdentities
    );

    sqlx::query("DELETE FROM oidc_identities WHERE provider_id=$1::uuid")
        .bind(created.id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        service
            .delete_provider(
                actor(),
                created.id,
                disabled.config_version,
                "request:oidc-delete-tombstoned",
            )
            .await
            .unwrap_err(),
        OidcProviderError::LinkedIdentities,
        "durable unlink generation fences must retain their Provider"
    );

    let disposable_input = OidcProviderInput::new(
        "Disposable identity",
        "https://disposable.example.test",
        "disposable-client",
    )
    .unwrap();
    let disposable = service
        .create_provider(
            actor(),
            &disposable_input,
            &secret("replacement-secret"),
            "request:oidc-disposable-create",
        )
        .await
        .unwrap();
    let retained_credential_id: String = sqlx::query_scalar(
        "SELECT client_secret_credential_id::text FROM oidc_providers WHERE id=$1::uuid",
    )
    .bind(disposable.id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    service
        .delete_provider(
            actor(),
            disposable.id,
            disposable.config_version,
            "request:oidc-delete",
        )
        .await
        .unwrap();
    let retained: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM integration_credentials WHERE id=$1::uuid)",
    )
    .bind(&retained_credential_id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        retained,
        "encrypted credential tombstone must retain INT history"
    );

    let audit_dump: String = sqlx::query_scalar(
        "SELECT string_agg(action_code || metadata::text || changed_fields::text, ' ') FROM audit_events WHERE action_code LIKE 'oidc.%'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    for forbidden in [
        "secret-a",
        "secret-b",
        "rotated-a",
        "rotated-b",
        "replacement-secret",
    ] {
        assert!(!audit_dump.contains(forbidden));
    }

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

fn secret(value: &str) -> SecretValue {
    SecretValue::new(value.as_bytes().to_vec()).unwrap()
}

fn keyring(key: [u8; 32]) -> MasterKeyring {
    MasterKeyring::load(
        &TestEnvironment(vec![
            (
                "NURITEO_MASTER_KEY".into(),
                URL_SAFE_NO_PAD.encode(key).into(),
            ),
            ("NURITEO_MASTER_KEY_VERSION".into(), "1".into()),
        ]),
        &NoFiles,
    )
    .unwrap()
}

async fn seed_admins(pool: &DatabasePool) {
    for (user_id, session_id, email, token) in [
        (
            "0199ee6c-c777-7000-8000-000000005001",
            "0199ee6c-c777-7000-8000-000000005002",
            "oidc-admin@example.test",
            "21",
        ),
        (
            "0199ee6c-c777-7000-8000-000000005003",
            "0199ee6c-c777-7000-8000-000000005004",
            "oidc-admin-two@example.test",
            "22",
        ),
    ] {
        sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES($1::uuid,$2,$2,'OIDC Admin',TRUE)")
            .bind(user_id).bind(email).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
        sqlx::query("INSERT INTO local_password_credentials(user_id,password_verifier) VALUES($1::uuid,'$argon2id$fixture-not-used-by-this-test')")
            .bind(user_id).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
        sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES($1::uuid,$2::uuid,decode(repeat($3,32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
            .bind(session_id).bind(user_id).bind(token).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    }
}

async fn seed_linked_identity(pool: &DatabasePool, provider_id: Uuid) {
    let user_id = "0199ee6c-c777-7000-8000-000000005010";
    sqlx::query("INSERT INTO users(id,email,normalized_email,display_name) VALUES($1::uuid,'linked@example.test','linked@example.test','Linked User')")
        .bind(user_id).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::query("INSERT INTO local_password_credentials(user_id,password_verifier) VALUES($1::uuid,'$argon2id$fixture-not-used-by-this-test')")
        .bind(user_id).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::query("INSERT INTO oidc_identities(id,user_id,provider_id,subject,normalized_email_at_link,link_source) VALUES($1::uuid,$2::uuid,$3::uuid,'subject-1','linked@example.test','preexisting')")
        .bind(Uuid::now_v7().to_string()).bind(user_id).bind(provider_id.to_string())
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
}

async fn reauthenticate(pool: &DatabasePool, actor: IntegrationAdminActor) {
    sqlx::query("UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP,last_reauthenticated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid")
        .bind(actor.session_id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

fn actor() -> IntegrationAdminActor {
    IntegrationAdminActor {
        user_id: "0199ee6c-c777-7000-8000-000000005001"
            .parse::<UserId>()
            .unwrap(),
        session_id: "0199ee6c-c777-7000-8000-000000005002"
            .parse::<SessionId>()
            .unwrap(),
    }
}

fn second_actor() -> IntegrationAdminActor {
    IntegrationAdminActor {
        user_id: "0199ee6c-c777-7000-8000-000000005003"
            .parse::<UserId>()
            .unwrap(),
        session_id: "0199ee6c-c777-7000-8000-000000005004"
            .parse::<SessionId>()
            .unwrap(),
    }
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
    DatabasePool::connect(
        DatabasePoolConfig::new(
            env::var(DATABASE_URL_ENV).unwrap(),
            0,
            8,
            Duration::from_secs(10),
            Duration::from_secs(5),
            DatabaseTlsConfig::verify_full(
                None,
                Some(fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap()),
                None,
            )
            .unwrap(),
        )
        .unwrap(),
    )
    .await
    .unwrap()
}
