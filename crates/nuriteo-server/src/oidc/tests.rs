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
use crate::integration::{
    CaCandidatePreflight, CaEndpointBinding, CaPreflightProof, IntegrationAdminActor,
    IntegrationAdminService, IntegrationError, MasterKeyring, ValidatedCaBundle,
};
use std::future::Future;
use std::pin::Pin;
use url::Url;

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

    let repository = IntegrationRepository::new(pool.clone(), keyring(1, [31; 32], &[]));
    let service = OidcProviderService::new(repository.clone());
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
        service
            .active_provider_for_test(provider.id)
            .await
            .unwrap_err(),
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
    let proof_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO oidc_validation_proofs
         (id,provider_id,config_version,secret_version,authorization_endpoint,token_endpoint,
          jwks_uri,redirect_uri,validation_fingerprint,validation_ca_fingerprint,
          jwks_fingerprint,expires_at,used_at,attestation_key_version,activation_attestation)
         VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,decode(repeat('11',32),'hex'),$9,
                decode(repeat('22',32),'hex'),CURRENT_TIMESTAMP+INTERVAL '5 minutes',NULL,
                1,decode(repeat('33',32),'hex'))",
    )
    .bind(proof_id.to_string())
    .bind(provider.id.to_string())
    .bind(i64::try_from(provider.config_version).unwrap())
    .bind(i64::try_from(provider.secret_version).unwrap())
    .bind("https://runtime.example.test/authorize")
    .bind("https://runtime.example.test/token")
    .bind("https://runtime.example.test/jwks")
    .bind("https://runtime.example.test/callback")
    .bind(protocol::trust_fingerprint(None).to_vec())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE oidc_providers SET status='active',disabled_at=NULL,
          config_version=config_version+1,
          authorization_endpoint='https://runtime.example.test/authorize',
          token_endpoint='https://runtime.example.test/token',
          jwks_uri='https://runtime.example.test/jwks',
          redirect_uri='https://runtime.example.test/callback',
          validation_config_version=config_version,validation_secret_version=secret_version,
          validation_fingerprint=decode(repeat('11',32),'hex'),
          validation_ca_fingerprint=$2,jwks_fingerprint=decode(repeat('22',32),'hex'),
          validation_proof_id=$3::uuid,validated_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
    )
    .bind(provider.id.to_string())
    .bind(protocol::trust_fingerprint(None).to_vec())
    .bind(proof_id.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .active_provider_for_test(provider.id)
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed,
        "a DB-shaped proof without the external-key attestation is not functional activation"
    );
    let expires_at: OffsetDateTime =
        sqlx::query_scalar("SELECT expires_at FROM oidc_validation_proofs WHERE id=$1::uuid")
            .bind(proof_id.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    let forged_proof = protocol::OidcValidationProof {
        id: proof_id,
        config_version: provider.config_version,
        secret_version: provider.secret_version,
        authorization_endpoint: "https://runtime.example.test/authorize".to_owned(),
        token_endpoint: "https://runtime.example.test/token".to_owned(),
        jwks_uri: "https://runtime.example.test/jwks".to_owned(),
        redirect_uri: "https://runtime.example.test/callback".to_owned(),
        validation_fingerprint: [0x11; 32],
        jwks_fingerprint: [0x22; 32],
        ca_fingerprint: protocol::trust_fingerprint(None),
    };
    let fields = activation_attestation_fields(&ActivationAttestationInput {
        provider_id: provider.id,
        proof_id,
        config_version: provider.config_version,
        secret_version: provider.secret_version,
        issuer: &provider.issuer,
        client_id: &provider.client_id,
        proof: &forged_proof,
        expires_at,
    });
    let refs = fields.iter().map(Vec::as_slice).collect::<Vec<_>>();
    let (key_version, attestation) = repository
        .attest_scoped(ACTIVATION_ATTESTATION_DOMAIN, &refs)
        .unwrap();
    sqlx::query(
        "ALTER TABLE oidc_validation_proofs DISABLE TRIGGER oidc_validation_proofs_update_guard",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("UPDATE oidc_validation_proofs SET attestation_key_version=$2,activation_attestation=$3 WHERE id=$1::uuid")
        .bind(proof_id.to_string())
        .bind(i32::try_from(key_version).unwrap())
        .bind(attestation.to_vec())
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::query(
        "ALTER TABLE oidc_validation_proofs ENABLE TRIGGER oidc_validation_proofs_update_guard",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let runtime = service.active_provider_for_test(provider.id).await.unwrap();
    assert_eq!(runtime.metadata.secret_version, 1);
    assert_eq!(runtime.client_secret.expose(), b"runtime-secret");
    let wrong = OidcProviderService::new(IntegrationRepository::new(
        pool.clone(),
        keyring(1, [41; 32], &[]),
    ));
    assert_eq!(
        wrong
            .active_provider_for_test(provider.id)
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    let missing = OidcProviderService::new(IntegrationRepository::new(
        pool.clone(),
        keyring(2, [42; 32], &[]),
    ));
    assert_eq!(
        missing
            .active_provider_for_test(provider.id)
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    let rotated = OidcProviderService::new(IntegrationRepository::new(
        pool.clone(),
        keyring(2, [42; 32], &[(1, [31; 32])]),
    ));
    assert_eq!(
        rotated
            .active_provider_for_test(provider.id)
            .await
            .unwrap()
            .client_secret
            .expose(),
        b"runtime-secret"
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
        service
            .active_provider_for_test(provider.id)
            .await
            .unwrap_err(),
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
        service
            .active_provider_for_test(provider.id)
            .await
            .unwrap_err(),
        OidcProviderError::CredentialUnavailable
    );

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-oidc-protocol/run.sh"]
async fn actual_protocol_validation_is_pinned_bounded_and_generation_fenced() {
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

    let issuer = env::var("NURITEO_TEST_OIDC_ISSUER").unwrap();
    let control = Path::new(&env::var("NURITEO_TEST_OIDC_CONTROL_DIR").unwrap()).to_path_buf();
    let ca = ValidatedCaBundle::parse(fs::read(env::var("NURITEO_TEST_OIDC_CA").unwrap()).unwrap())
        .unwrap();
    let repository = IntegrationRepository::new(pool.clone(), keyring(1, [51; 32], &[]));
    let service = OidcProviderService::new(repository.clone());
    let created = service
        .create_provider(
            actor(),
            &OidcProviderInput::new("Protocol", &issuer, "protocol-client").unwrap(),
            &SecretValue::new(b"protocol-secret".to_vec()).unwrap(),
            "request:oidc-protocol-create",
        )
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000007099','backup-admin@example.test','backup-admin@example.test','Backup Admin',TRUE)")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::query("UPDATE users SET is_instance_admin=FALSE WHERE id=$1::uuid")
        .bind(actor().user_id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let requests_before = fs::read_to_string(control.join("requests"))
        .unwrap()
        .lines()
        .count();
    assert_eq!(
        service
            .validate_and_activate(
                &OidcEndpointValidator::allowing_test_addresses(Duration::from_secs(3)).unwrap(),
                actor(),
                created.id,
                created.config_version,
                &format!("{issuer}/callback"),
                "request:oidc-unauthorized-admin",
            )
            .await
            .unwrap_err(),
        OidcProviderError::ReauthenticationRequired
    );
    assert_eq!(
        requests_before,
        fs::read_to_string(control.join("requests"))
            .unwrap()
            .lines()
            .count(),
        "unauthorized admin actor must fail before DNS, TLS or HTTP"
    );
    sqlx::query("UPDATE users SET is_instance_admin=TRUE WHERE id=$1::uuid")
        .bind(actor().user_id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000007098','0199ee6c-c777-7000-8000-000000007099',decode(repeat('32',32),'hex'),CURRENT_TIMESTAMP-INTERVAL '1 hour',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP-INTERVAL '1 hour')")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    let stale_actor = IntegrationAdminActor {
        user_id: "0199ee6c-c777-7000-8000-000000007099"
            .parse::<UserId>()
            .unwrap(),
        session_id: "0199ee6c-c777-7000-8000-000000007098"
            .parse::<SessionId>()
            .unwrap(),
    };
    let requests_before = fs::read_to_string(control.join("requests"))
        .unwrap()
        .lines()
        .count();
    assert_eq!(
        service
            .validate_and_activate(
                &OidcEndpointValidator::allowing_test_addresses(Duration::from_secs(3)).unwrap(),
                stale_actor,
                created.id,
                created.config_version,
                &format!("{issuer}/callback"),
                "request:oidc-stale-admin",
            )
            .await
            .unwrap_err(),
        OidcProviderError::ReauthenticationRequired
    );
    assert_eq!(
        requests_before,
        fs::read_to_string(control.join("requests"))
            .unwrap()
            .lines()
            .count(),
        "stale reauthentication must fail before DNS, TLS or HTTP"
    );
    let production = OidcEndpointValidator::new(Duration::from_secs(3)).unwrap();
    assert_eq!(
        service
            .validate_and_activate(
                &production,
                actor(),
                created.id,
                created.config_version,
                &format!("{issuer}/callback"),
                "request:oidc-production-ssrf",
            )
            .await
            .unwrap_err(),
        OidcProviderError::NetworkDenied
    );
    let azure = service
        .create_provider(
            actor(),
            &OidcProviderInput::new(
                "Blocked Azure WireServer",
                "https://168.63.129.16",
                "blocked-client",
            )
            .unwrap(),
            &SecretValue::new(b"blocked-secret".to_vec()).unwrap(),
            "request:oidc-azure-create",
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .validate_and_activate(
                &production,
                actor(),
                azure.id,
                azure.config_version,
                "https://app.example.test/callback",
                "request:oidc-azure-wireserver",
            )
            .await
            .unwrap_err(),
        OidcProviderError::NetworkDenied
    );
    let validator = OidcEndpointValidator::allowing_test_addresses(Duration::from_secs(5)).unwrap();
    assert_eq!(
        service
            .validate_and_activate(
                &validator,
                actor(),
                created.id,
                created.config_version,
                &format!("{issuer}/callback"),
                "request:oidc-wrong-ca",
            )
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );

    let parsed = Url::parse(&issuer).unwrap();
    let endpoint = CaEndpointBinding::new(
        "oidc",
        created.id.to_string(),
        parsed.host_str().unwrap(),
        parsed.port_or_known_default().unwrap(),
        "https",
    )
    .unwrap();
    let admin = IntegrationAdminService::new(repository);
    let staged = admin
        .stage_ca_candidate(actor(), &endpoint, ca.clone(), "request:oidc-ca-stage")
        .await
        .unwrap();
    admin
        .activate_ca_candidate(
            actor(),
            staged.id,
            &endpoint,
            "request:oidc-ca-activate",
            &ExactPreflight,
        )
        .await
        .unwrap();

    fs::write(control.join("mode"), "mismatch").unwrap();
    assert_eq!(
        service
            .validate_and_activate(
                &validator,
                actor(),
                created.id,
                created.config_version,
                &format!("{issuer}/callback"),
                "request:oidc-issuer-mismatch",
            )
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    fs::write(control.join("mode"), "normal").unwrap();
    assert_eq!(
        service
            .validate_and_activate(
                &validator,
                actor(),
                created.id,
                created.config_version,
                &format!("{issuer}/callback?next=unsafe"),
                "request:oidc-redirect-invalid",
            )
            .await
            .unwrap_err(),
        OidcProviderError::InvalidInput
    );
    for mode in ["redirect", "oversize", "cross-host", "too-many-keys"] {
        fs::write(control.join("mode"), mode).unwrap();
        assert!(
            service
                .validate_and_activate(
                    &validator,
                    actor(),
                    created.id,
                    created.config_version,
                    &format!("{issuer}/callback"),
                    &format!("request:oidc-{mode}"),
                )
                .await
                .is_err(),
            "{mode} must fail closed"
        );
    }
    fs::write(control.join("mode"), "normal").unwrap();

    assert!(
        sqlx::query(
            "UPDATE oidc_providers SET status='active',disabled_at=NULL,
             config_version=config_version+1,
             authorization_endpoint=$2,token_endpoint=$3,jwks_uri=$4,redirect_uri=$5,
             validation_config_version=config_version,validation_secret_version=secret_version,
             validation_fingerprint=decode(repeat('11',32),'hex'),
             validation_ca_fingerprint=$6,jwks_fingerprint=decode(repeat('22',32),'hex'),
             validation_proof_id=$7::uuid,validated_at=CURRENT_TIMESTAMP,
             updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(created.id.to_string())
        .bind(format!("{issuer}/authorize"))
        .bind(format!("{issuer}/token"))
        .bind(format!("{issuer}/jwks"))
        .bind(format!("{issuer}/callback"))
        .bind(protocol::trust_fingerprint(Some(&ca)).to_vec())
        .bind(Uuid::now_v7().to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err(),
        "well-shaped activation without a committed validation record must be rejected"
    );

    let jwks_uri = Url::parse(&format!("{issuer}/jwks")).unwrap();
    let first = validator
        .jwks_fingerprint_for_test(created.id, created.config_version, &jwks_uri, &ca)
        .await
        .unwrap();
    fs::write(
        control.join("jwks.json"),
        r#"{"keys":[{"kty":"RSA","kid":"rotated","n":"AQAB","e":"AQAB"}]}"#,
    )
    .unwrap();
    let cached = validator
        .jwks_fingerprint_for_test(created.id, created.config_version, &jwks_uri, &ca)
        .await
        .unwrap();
    assert_eq!(first, cached, "same generation must use the bounded cache");
    let rotated = validator
        .jwks_fingerprint_for_test(created.id, created.config_version + 1, &jwks_uri, &ca)
        .await
        .unwrap();
    assert_ne!(first, rotated, "new generation must observe JWKS rotation");

    fs::write(control.join("delay"), "1").unwrap();
    let validating_service = service.clone();
    let validating_validator = validator.clone();
    let redirect = format!("{issuer}/callback");
    let provider_id = created.id;
    let version = created.config_version;
    let validating = tokio::spawn(async move {
        validating_service
            .validate_and_activate(
                &validating_validator,
                actor(),
                provider_id,
                version,
                &redirect,
                "request:oidc-stale-proof",
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let rotated_secret = service
        .rotate_client_secret(
            actor(),
            created.id,
            created.config_version,
            &SecretValue::new(b"rotated-secret".to_vec()).unwrap(),
            "request:oidc-secret-race",
        )
        .await
        .unwrap();
    assert_eq!(
        validating.await.unwrap().unwrap_err(),
        OidcProviderError::Conflict
    );
    fs::write(control.join("delay"), "0").unwrap();
    let active = service
        .validate_and_activate(
            &validator,
            actor(),
            created.id,
            rotated_secret.config_version,
            &format!("{issuer}/callback"),
            "request:oidc-activate",
        )
        .await
        .unwrap();
    assert_eq!(active.state, OidcProviderState::Active);
    let runtime = validator
        .active_runtime(&service, created.id)
        .await
        .unwrap();
    assert_eq!(runtime.secret_for_test(), b"rotated-secret");

    let audit: String = sqlx::query_scalar(
        "SELECT metadata::text || changed_fields::text FROM audit_events WHERE action_code='oidc.provider_activated'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(!audit.contains("protocol-secret") && !audit.contains("rotated-secret"));
    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

struct ExactPreflight;

impl CaCandidatePreflight for ExactPreflight {
    fn preflight<'a>(
        &'a self,
        _: &'a ValidatedCaBundle,
        endpoint: &'a CaEndpointBinding,
    ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(CaPreflightProof {
                endpoint_fingerprint: endpoint.fingerprint(),
            })
        })
    }
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
