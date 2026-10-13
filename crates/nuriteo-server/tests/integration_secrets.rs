use std::env;
use std::ffi::OsString;
use std::fs;
use std::future::Future;
use std::io;
use std::io::Cursor;
use std::path::Path;
use std::pin::Pin;
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
    CaCandidatePreflight, CaEndpointBinding, CaPreflightProof, CredentialIdentity,
    IntegrationAdminActor, IntegrationAdminService, IntegrationError, IntegrationRepository,
    MasterKeyring, SecretValue, ValidatedCaBundle,
};
use rustls::RootCertStore;
use rustls::pki_types::ServerName;
use sqlx::{Executor, Row};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const ENDPOINT_PORT_ENV: &str = "NURITEO_TEST_ENDPOINT_PORT";

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-integration-secrets/run.sh"]
async fn encrypted_credentials_rotation_and_ca_activation_fail_closed() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(40));
    let settings_repository =
        InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5)).unwrap();
    settings_repository
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    seed_reauthenticated_admins(&pool).await;
    let endpoint = CaEndpointBinding::new(
        "smtp",
        "default",
        "localhost",
        env::var(ENDPOINT_PORT_ENV).unwrap().parse().unwrap(),
        "implicit-tls",
    )
    .unwrap();
    configure_smtp(&pool, &endpoint).await;
    let effective_settings = settings_repository.load().await.unwrap();

    let v1 = [11_u8; 32];
    let v2 = [22_u8; 32];
    assert_eq!(
        try_keyring(1, v1, &[(2, v2)]).unwrap_err(),
        IntegrationError::KeyConfiguration
    );
    assert_eq!(
        try_keyring(2, v2, &[(1, v2)]).unwrap_err(),
        IntegrationError::KeyConfiguration
    );
    let old = IntegrationRepository::new(pool.clone(), keyring(1, v1, &[]));
    let old_admin = IntegrationAdminService::new(old.clone());
    let username_identity =
        CredentialIdentity::new("instance-01", "smtp", "default", "username").unwrap();
    assert_eq!(
        old_admin
            .put_credential(
                fixture_actor(),
                &username_identity,
                &SecretValue::new(b"smtp-user".to_vec()).unwrap(),
                "request:int-001-username",
            )
            .await
            .unwrap_err(),
        IntegrationError::InvalidInput
    );
    let identity =
        CredentialIdentity::new("instance-01", "registry", "fixture", "access_token").unwrap();
    let first_admin = old_admin.clone();
    let second_admin = old_admin.clone();
    let first_identity = identity.clone();
    let second_identity = identity.clone();
    let (first, second) = tokio::join!(
        async move {
            first_admin
                .put_credential(
                    fixture_actor(),
                    &first_identity,
                    &SecretValue::new(b"smtp-secret-a".to_vec()).unwrap(),
                    "request:int-001-credential-a",
                )
                .await
        },
        async move {
            second_admin
                .put_credential(
                    second_fixture_actor(),
                    &second_identity,
                    &SecretValue::new(b"smtp-secret-b".to_vec()).unwrap(),
                    "request:int-001-credential-b",
                )
                .await
        }
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.id, second.id);
    let mut versions = [first.credential_version, second.credential_version];
    versions.sort_unstable();
    assert_eq!(versions, [1, 2]);
    let (_, password_metadata) = old_admin
        .put_smtp_credential_pair(
            fixture_actor(),
            "instance-01",
            &SecretValue::new(b"smtp-user".to_vec()).unwrap(),
            &SecretValue::new(b"smtp-secret-pair".to_vec()).unwrap(),
            "request:int-001-smtp-pair",
        )
        .await
        .unwrap();
    let adopted = smtp_password(&old, &effective_settings).await;
    assert_eq!(adopted, "smtp-secret-pair");

    let missing = IntegrationRepository::new(pool.clone(), keyring(3, [33; 32], &[]));
    assert_eq!(
        missing
            .smtp_config(
                "instance-01",
                &effective_settings,
                &TestEnvironment(vec![]),
                &NoFiles
            )
            .await
            .unwrap_err(),
        IntegrationError::CredentialUnavailable
    );
    let wrong = IntegrationRepository::new(pool.clone(), keyring(1, [44; 32], &[]));
    assert_eq!(
        wrong
            .smtp_config(
                "instance-01",
                &effective_settings,
                &TestEnvironment(vec![]),
                &NoFiles
            )
            .await
            .unwrap_err(),
        IntegrationError::CredentialUnavailable
    );

    let rotated = IntegrationRepository::new(pool.clone(), keyring(2, v2, &[(1, v1)]));
    assert_eq!(
        rotated.rotate_batch(101).await.unwrap_err(),
        IntegrationError::InvalidInput
    );
    let (rotation_a, rotation_b) = tokio::join!(rotated.rotate_batch(1), rotated.rotate_batch(1));
    assert_eq!(rotation_a.unwrap().rotated, 1);
    assert_eq!(rotation_b.unwrap().rotated, 1);
    assert_eq!(rotated.rotate_batch(10).await.unwrap().rotated, 1);
    assert_eq!(rotated.rotate_batch(10).await.unwrap().rotated, 0);
    assert_eq!(smtp_password(&rotated, &effective_settings).await, adopted);

    let ca_pem = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let bundle = ValidatedCaBundle::parse(ca_pem.clone()).unwrap();
    let actor = fixture_actor();
    let admin = IntegrationAdminService::new(rotated.clone());
    sqlx::query("UPDATE sessions SET last_reauthenticated_at=NULL WHERE id=$1::uuid")
        .bind(actor.session_id.to_string())
        .execute(&mut *acquire(&pool).await)
        .await
        .unwrap();
    assert_eq!(
        admin
            .stage_ca_candidate(
                actor,
                &endpoint,
                bundle.clone(),
                "request:int-001-stale-reauth",
            )
            .await
            .unwrap_err(),
        IntegrationError::ReauthenticationRequired
    );
    sqlx::query("UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP,last_reauthenticated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid")
        .bind(actor.session_id.to_string())
        .execute(&mut *acquire(&pool).await)
        .await
        .unwrap();
    let competing_admin = admin.clone();
    let competing_endpoint = endpoint.clone();
    let competing_bundle = bundle.clone();
    let (candidate_a, candidate_b) = tokio::join!(
        admin.stage_ca_candidate(actor, &endpoint, bundle, "request:int-001-stage-a"),
        competing_admin.stage_ca_candidate(
            second_fixture_actor(),
            &competing_endpoint,
            competing_bundle,
            "request:int-001-stage-b",
        )
    );
    let candidate = match (candidate_a, candidate_b) {
        (Ok(candidate), Err(IntegrationError::Conflict))
        | (Err(IntegrationError::Conflict), Ok(candidate)) => candidate,
        observed => panic!("concurrent candidate stage was not classified: {observed:?}"),
    };
    let active = admin
        .activate_ca_candidate(
            actor,
            candidate.id,
            &endpoint,
            "request:int-001-activate",
            &TlsEndpointPreflight,
        )
        .await
        .unwrap();
    assert_eq!(active.state, "active");
    let ca_metadata = admin
        .list_ca_metadata(actor, "smtp", "default")
        .await
        .unwrap();
    assert_eq!(ca_metadata.len(), 1);

    let failed_candidate = admin
        .stage_ca_candidate(
            actor,
            &endpoint,
            ValidatedCaBundle::parse(ca_pem).unwrap(),
            "request:int-001-stage-failed",
        )
        .await
        .unwrap();
    assert_eq!(
        admin
            .activate_ca_candidate(
                actor,
                failed_candidate.id,
                &endpoint,
                "request:int-001-preflight-failed",
                &FailedPreflight,
            )
            .await
            .unwrap_err(),
        IntegrationError::PreflightFailed
    );
    let active_id: String = sqlx::query_scalar(
        "SELECT id::text FROM integration_ca_bundles WHERE integration_type='smtp' AND integration_id='default' AND state='active'",
    )
    .fetch_one(&mut *acquire(&pool).await)
    .await
    .unwrap();
    assert_eq!(active_id, active.id.to_string());

    let slow_admin = IntegrationAdminService::new(
        rotated
            .clone()
            .with_timeout(Duration::from_secs(1))
            .unwrap(),
    );
    let slow_active = slow_admin
        .activate_ca_candidate(
            actor,
            failed_candidate.id,
            &endpoint,
            "request:int-001-slow-preflight",
            &SlowPreflight,
        )
        .await
        .unwrap();
    assert_eq!(slow_active.state, "active");

    let smtp = rotated
        .smtp_config(
            "instance-01",
            &effective_settings,
            &TestEnvironment(vec![(
                "NURITEO_SMTP_CA_FILE".into(),
                "/missing/beta-ca.pem".into(),
            )]),
            &NoFiles,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(smtp.tls_trust().integration_ca_certificates(), 1);
    assert_eq!(
        smtp.credentials().unwrap().username().expose_secret(),
        "smtp-user"
    );
    assert!(
        sqlx::query("DELETE FROM integration_credentials WHERE id=$1::uuid")
            .bind(password_metadata.id.to_string())
            .execute(&mut *acquire(&pool).await)
            .await
            .is_err(),
        "database credential adoption must not downgrade to deployment fallback"
    );
    assert!(
        sqlx::query(
            "INSERT INTO integration_ca_bundles
             (id,integration_type,integration_id,version,state,pem,certificate_count,fingerprints,
              earliest_expiry,endpoint_fingerprint,activated_at)
             SELECT '0199ee6c-c777-7000-8000-000000004099','smtp','bypass',1,'active',pem,
                    certificate_count,fingerprints,earliest_expiry,endpoint_fingerprint,CURRENT_TIMESTAMP
             FROM integration_ca_bundles WHERE id=$1::uuid",
        )
        .bind(active.id.to_string())
        .execute(&mut *acquire(&pool).await)
        .await
        .is_err(),
        "integration CA must enter through candidate state"
    );
    sqlx::query(
        "UPDATE instance_settings SET value=(value::int+1)::text::jsonb WHERE key='smtp.port'",
    )
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    let mismatched_settings = settings_repository.load().await.unwrap();
    assert_eq!(
        rotated
            .smtp_config(
                "instance-01",
                &mismatched_settings,
                &TestEnvironment(vec![]),
                &NoFiles,
            )
            .await
            .unwrap_err(),
        IntegrationError::PreflightFailed
    );
    configure_smtp(&pool, &endpoint).await;
    let effective_settings = settings_repository.load().await.unwrap();

    assert!(
        sqlx::query("UPDATE integration_credentials SET ciphertext = set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE id=$1::uuid")
            .bind(password_metadata.id.to_string())
            .execute(&mut *acquire(&pool).await)
            .await
            .is_err(),
        "partial cryptographic updates must be rejected"
    );
    assert!(
        sqlx::query(
            "UPDATE integration_credentials SET integration_id='renamed' WHERE id=$1::uuid"
        )
        .bind(password_metadata.id.to_string())
        .execute(&mut *acquire(&pool).await)
        .await
        .is_err(),
        "credential identity must be immutable"
    );
    sqlx::query(
        "ALTER TABLE integration_credentials DISABLE TRIGGER integration_credentials_update_guard",
    )
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    sqlx::query("UPDATE integration_credentials SET ciphertext = set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE id=$1::uuid")
        .bind(password_metadata.id.to_string()).execute(&mut *acquire(&pool).await).await.unwrap();
    sqlx::query(
        "ALTER TABLE integration_credentials ENABLE TRIGGER integration_credentials_update_guard",
    )
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    let tamper_error = rotated
        .smtp_config(
            "instance-01",
            &effective_settings,
            &TestEnvironment(vec![]),
            &NoFiles,
        )
        .await
        .unwrap_err();
    assert_eq!(tamper_error, IntegrationError::CredentialUnavailable);
    let rendered_error = format!("{tamper_error:?} {tamper_error}");
    assert!(!rendered_error.contains("smtp-secret"));
    assert_eq!(smtp.tls_trust().integration_ca_certificates(), 1);

    let audit_text: String = sqlx::query(
        "SELECT metadata::text FROM audit_events WHERE action_code='integration.ca_activated'",
    )
    .fetch_one(&mut *acquire(&pool).await)
    .await
    .unwrap()
    .get(0);
    assert!(!audit_text.contains("BEGIN CERTIFICATE"));
    let credential_audit: String = sqlx::query(
        "SELECT metadata::text FROM audit_events WHERE action_code='integration.credential_updated'",
    )
    .fetch_one(&mut *acquire(&pool).await)
    .await
    .unwrap()
    .get(0);
    assert!(!credential_audit.contains("smtp-secret"));
    assert!(
        sqlx::query("DELETE FROM integration_ca_bundles WHERE id=$1::uuid")
            .bind(active.id.to_string())
            .execute(&mut *acquire(&pool).await)
            .await
            .is_err(),
        "active CA history must be retained"
    );
    sqlx::query(
        "ALTER TABLE integration_ca_bundles DISABLE TRIGGER integration_ca_lifecycle_guard",
    )
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE integration_ca_bundles SET fingerprints=ARRAY[repeat('0',64)] WHERE id=$1::uuid",
    )
    .bind(active.id.to_string())
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    sqlx::query("ALTER TABLE integration_ca_bundles ENABLE TRIGGER integration_ca_lifecycle_guard")
        .execute(&mut *acquire(&pool).await)
        .await
        .unwrap();
    assert_eq!(
        rotated
            .smtp_config(
                "instance-01",
                &effective_settings,
                &TestEnvironment(vec![]),
                &NoFiles,
            )
            .await
            .unwrap_err(),
        IntegrationError::InvalidCaBundle
    );
    sqlx::query(
        "ALTER TABLE integration_ca_bundles DISABLE TRIGGER integration_ca_lifecycle_guard",
    )
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    sqlx::query("UPDATE integration_ca_bundles SET fingerprints=$1 WHERE id=$2::uuid")
        .bind(&active.fingerprints)
        .bind(active.id.to_string())
        .execute(&mut *acquire(&pool).await)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE integration_ca_bundles ENABLE TRIGGER integration_ca_lifecycle_guard")
        .execute(&mut *acquire(&pool).await)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE integration_ca_bundles SET state='retired',retired_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
    )
    .bind(active.id.to_string())
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    assert_eq!(
        rotated
            .smtp_config(
                "instance-01",
                &effective_settings,
                &TestEnvironment(vec![]),
                &NoFiles,
            )
            .await
            .unwrap_err(),
        IntegrationError::PreflightFailed
    );
    let master_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='integration_credentials' AND column_name LIKE '%master%'",
    ).fetch_one(&mut *acquire(&pool).await).await.unwrap();
    assert_eq!(master_columns, 0);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

struct TlsEndpointPreflight;
struct FailedPreflight;
struct SlowPreflight;

impl CaCandidatePreflight for TlsEndpointPreflight {
    fn preflight<'a>(
        &'a self,
        candidate: &'a ValidatedCaBundle,
        endpoint: &'a CaEndpointBinding,
    ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>> {
        Box::pin(async move {
            let mut roots = RootCertStore::empty();
            for certificate in rustls_pemfile::certs(&mut Cursor::new(candidate.pem())) {
                roots
                    .add(certificate.map_err(|_| IntegrationError::PreflightFailed)?)
                    .map_err(|_| IntegrationError::PreflightFailed)?;
            }
            let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(|_| IntegrationError::PreflightFailed)?
            .with_root_certificates(roots)
            .with_no_client_auth();
            let tcp = TcpStream::connect((endpoint.host(), endpoint.port()))
                .await
                .map_err(|_| IntegrationError::PreflightFailed)?;
            let server_name = ServerName::try_from(endpoint.host().to_owned())
                .map_err(|_| IntegrationError::PreflightFailed)?;
            let mut tls = TlsConnector::from(std::sync::Arc::new(config))
                .connect(server_name, tcp)
                .await
                .map_err(|_| IntegrationError::PreflightFailed)?;
            if tls.get_ref().1.peer_certificates().is_none() {
                return Err(IntegrationError::PreflightFailed);
            }
            let mut reader = BufReader::new(&mut tls);
            let mut reply = String::new();
            reader
                .read_line(&mut reply)
                .await
                .map_err(|_| IntegrationError::PreflightFailed)?;
            if !reply.starts_with("220 ") {
                return Err(IntegrationError::PreflightFailed);
            }
            reader
                .get_mut()
                .write_all(b"EHLO nuriteo.invalid\r\n")
                .await
                .map_err(|_| IntegrationError::PreflightFailed)?;
            reply.clear();
            reader
                .read_line(&mut reply)
                .await
                .map_err(|_| IntegrationError::PreflightFailed)?;
            if !reply.starts_with("250 ") {
                return Err(IntegrationError::PreflightFailed);
            }
            Ok(CaPreflightProof {
                endpoint_fingerprint: endpoint.fingerprint(),
            })
        })
    }
}

impl CaCandidatePreflight for FailedPreflight {
    fn preflight<'a>(
        &'a self,
        _: &'a ValidatedCaBundle,
        _: &'a CaEndpointBinding,
    ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>> {
        Box::pin(async { Err(IntegrationError::PreflightFailed) })
    }
}

impl CaCandidatePreflight for SlowPreflight {
    fn preflight<'a>(
        &'a self,
        _: &'a ValidatedCaBundle,
        endpoint: &'a CaEndpointBinding,
    ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(1_100)).await;
            Ok(CaPreflightProof {
                endpoint_fingerprint: endpoint.fingerprint(),
            })
        })
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

fn keyring(current_version: u32, current: [u8; 32], previous: &[(u32, [u8; 32])]) -> MasterKeyring {
    try_keyring(current_version, current, previous).unwrap()
}

fn try_keyring(
    current_version: u32,
    current: [u8; 32],
    previous: &[(u32, [u8; 32])],
) -> Result<MasterKeyring, IntegrationError> {
    let previous_json = serde_json::to_string(&previous.iter().map(|(version, key)| {
        serde_json::json!({"version": version, "key": URL_SAFE_NO_PAD.encode(key)})
    }).collect::<Vec<_>>()).unwrap();
    MasterKeyring::load(
        &TestEnvironment(vec![
            (
                "NURITEO_MASTER_KEY".into(),
                URL_SAFE_NO_PAD.encode(current).into(),
            ),
            (
                "NURITEO_MASTER_KEY_VERSION".into(),
                current_version.to_string().into(),
            ),
            ("NURITEO_PREVIOUS_MASTER_KEYS".into(), previous_json.into()),
        ]),
        &NoFiles,
    )
}

fn fixture_actor() -> IntegrationAdminActor {
    IntegrationAdminActor {
        user_id: "0199ee6c-c777-7000-8000-000000004001"
            .parse::<UserId>()
            .unwrap(),
        session_id: "0199ee6c-c777-7000-8000-000000004002"
            .parse::<SessionId>()
            .unwrap(),
    }
}

fn second_fixture_actor() -> IntegrationAdminActor {
    IntegrationAdminActor {
        user_id: "0199ee6c-c777-7000-8000-000000004003"
            .parse::<UserId>()
            .unwrap(),
        session_id: "0199ee6c-c777-7000-8000-000000004004"
            .parse::<SessionId>()
            .unwrap(),
    }
}

async fn seed_reauthenticated_admins(pool: &DatabasePool) {
    sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000004001','admin@example.test','admin@example.test','Admin',TRUE)")
        .execute(&mut *acquire(pool).await).await.unwrap();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000004002','0199ee6c-c777-7000-8000-000000004001',decode(repeat('11',32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
        .execute(&mut *acquire(pool).await).await.unwrap();
    sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000004003','admin-two@example.test','admin-two@example.test','Admin Two',TRUE)")
        .execute(&mut *acquire(pool).await).await.unwrap();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000004004','0199ee6c-c777-7000-8000-000000004003',decode(repeat('12',32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
        .execute(&mut *acquire(pool).await).await.unwrap();
}

async fn configure_smtp(pool: &DatabasePool, endpoint: &CaEndpointBinding) {
    for (key, value) in [
        ("smtp.enabled", "true".to_owned()),
        ("smtp.host", format!("\"{}\"", endpoint.host())),
        ("smtp.port", endpoint.port().to_string()),
        ("smtp.security", format!("\"{}\"", endpoint.transport())),
    ] {
        sqlx::query("UPDATE instance_settings SET value=$2::jsonb WHERE key=$1")
            .bind(key)
            .bind(value)
            .execute(&mut *acquire(pool).await)
            .await
            .unwrap();
    }
}

async fn smtp_password(
    repository: &IntegrationRepository,
    settings: &nuriteo_server::instance_settings::EffectiveInstanceSettings,
) -> String {
    repository
        .smtp_config("instance-01", settings, &TestEnvironment(vec![]), &NoFiles)
        .await
        .unwrap()
        .unwrap()
        .credentials()
        .unwrap()
        .password()
        .expose_secret()
        .to_owned()
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire().await.unwrap()
}
async fn reset_fixture(pool: &DatabasePool) {
    acquire(pool)
        .await
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
