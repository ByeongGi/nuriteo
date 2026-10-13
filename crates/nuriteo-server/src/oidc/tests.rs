use super::*;

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::config::{Environment, FileReader, InstanceSettingBootstrap};
use crate::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use crate::identity::{
    IssuedSession, SessionId, SessionPolicy, SessionRotationKind, SessionService,
    SessionServiceError, SessionToken, UserId,
};
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

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-oidc-protocol/run.sh"]
async fn actual_authorization_code_pkce_is_one_time_and_rotation_fenced() {
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
    let repository = IntegrationRepository::new(pool.clone(), keyring(1, [61; 32], &[]));
    let providers = OidcProviderService::new(repository.clone());
    let created = providers
        .create_provider(
            actor(),
            &OidcProviderInput::new("Callback", &issuer, "protocol-client").unwrap(),
            &SecretValue::new(b"protocol-secret".to_vec()).unwrap(),
            "request:oidc3-create",
        )
        .await
        .unwrap();
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
        .stage_ca_candidate(actor(), &endpoint, ca, "request:oidc3-ca-stage")
        .await
        .unwrap();
    admin
        .activate_ca_candidate(
            actor(),
            staged.id,
            &endpoint,
            "request:oidc3-ca-activate",
            &ExactPreflight,
        )
        .await
        .unwrap();
    let validator = OidcEndpointValidator::allowing_test_addresses(Duration::from_secs(5)).unwrap();
    let active = providers
        .validate_and_activate(
            &validator,
            actor(),
            created.id,
            created.config_version,
            &format!("{issuer}/callback"),
            "request:oidc3-activate",
        )
        .await
        .unwrap();
    let user_id: UserId = "0199ee6c-c777-7000-8000-000000007097".parse().unwrap();
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name)
         VALUES($1::uuid,'oidc-user@example.test','oidc-user@example.test','OIDC User')",
    )
    .bind(user_id.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO oidc_identities(id,user_id,provider_id,subject,normalized_email_at_link,link_source)
         VALUES('0199ee6c-c777-7000-8000-000000007096',$1::uuid,$2::uuid,'fixture-subject',
                'oidc-user@example.test','preexisting')",
    )
    .bind(user_id.to_string())
    .bind(created.id.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let sessions = SessionService::new(pool.clone(), SessionPolicy::default());
    let login = login::OidcLoginService::new(providers.clone(), validator, sessions.clone());

    let request = login.begin(created.id).await.unwrap();
    let request_url = Url::parse(&request.url).unwrap();
    let parameters = request_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        parameters.get("code_challenge_method").map(|v| v.as_ref()),
        Some("S256")
    );
    let state = parameters.get("state").unwrap().to_string();
    let nonce = parameters.get("nonce").unwrap().to_string();
    assert!(!state.is_empty() && !nonce.is_empty());
    fs::write(control.join("nonce"), &nonce).unwrap();
    fs::write(
        control.join("pkce_challenge"),
        parameters.get("code_challenge").unwrap().as_bytes(),
    )
    .unwrap();
    let token_requests_before_binding_attack = token_request_count(&control);
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: &issuer,
                state: &state,
                code: "fixture-code-cross-browser",
                browser_binding: "attacker-browser-binding",
                existing_session: None,
                correlation_id: "request:oidc3-cross-browser",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    assert_eq!(
        token_request_count(&control),
        token_requests_before_binding_attack,
        "a callback from a different browser must fail before token exchange"
    );
    let fixed = sessions.issue(user_id).await.unwrap();
    let completed = login
        .callback(login::OidcCallbackInput {
            provider_id: created.id,
            issuer: &issuer,
            state: &state,
            code: "fixture-code-success",
            browser_binding: &request.browser_binding,
            existing_session: Some(fixed.token()),
            correlation_id: "request:oidc3-success",
        })
        .await
        .unwrap();
    assert_eq!(
        sessions.authenticate(fixed.token()).await.unwrap_err(),
        SessionServiceError::InvalidToken
    );
    sessions.authenticate(completed.token()).await.unwrap();
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: &issuer,
                state: &state,
                code: "fixture-code-success",
                browser_binding: &request.browser_binding,
                existing_session: None,
                correlation_id: "request:oidc3-state-replay",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );

    let other_user_id: UserId = "0199ee6c-c777-7000-8000-000000007095".parse().unwrap();
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name)
         VALUES($1::uuid,'other-user@example.test','other-user@example.test','Other User')",
    )
    .bind(other_user_id.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let account_switch = login.begin(created.id).await.unwrap();
    let account_switch_url = Url::parse(&account_switch.url).unwrap();
    let account_switch_parameters = account_switch_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    fs::write(
        control.join("nonce"),
        account_switch_parameters.get("nonce").unwrap().as_bytes(),
    )
    .unwrap();
    fs::write(
        control.join("pkce_challenge"),
        account_switch_parameters
            .get("code_challenge")
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let other_session = sessions.issue(other_user_id).await.unwrap();
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: &issuer,
                state: account_switch_parameters.get("state").unwrap(),
                code: "fixture-code-account-switch",
                browser_binding: &account_switch.browser_binding,
                existing_session: Some(other_session.token()),
                correlation_id: "request:oidc3-account-switch",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    sessions.authenticate(other_session.token()).await.unwrap();

    let key_rotation = login.begin(created.id).await.unwrap();
    let key_rotation_url = Url::parse(&key_rotation.url).unwrap();
    let key_rotation_parameters = key_rotation_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let key_rotation_state = key_rotation_parameters.get("state").unwrap().to_string();
    fs::write(
        control.join("nonce"),
        key_rotation_parameters.get("nonce").unwrap().as_bytes(),
    )
    .unwrap();
    fs::write(
        control.join("pkce_challenge"),
        key_rotation_parameters
            .get("code_challenge")
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let rotated_providers = OidcProviderService::new(IntegrationRepository::new(
        pool.clone(),
        keyring(2, [62; 32], &[(1, [61; 32])]),
    ));
    let rotated_login = login::OidcLoginService::new(
        rotated_providers,
        OidcEndpointValidator::allowing_test_addresses(Duration::from_secs(5)).unwrap(),
        sessions.clone(),
    );
    rotated_login
        .callback(login::OidcCallbackInput {
            provider_id: created.id,
            issuer: &issuer,
            state: &key_rotation_state,
            code: "fixture-code-key-rotation",
            browser_binding: &key_rotation.browser_binding,
            existing_session: None,
            correlation_id: "request:oidc3-key-rotation",
        })
        .await
        .unwrap();

    let missing_key = login.begin(created.id).await.unwrap();
    let missing_key_url = Url::parse(&missing_key.url).unwrap();
    let missing_key_parameters = missing_key_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let missing_key_state = missing_key_parameters.get("state").unwrap().to_string();
    let missing_key_login = login::OidcLoginService::new(
        OidcProviderService::new(IntegrationRepository::new(
            pool.clone(),
            keyring(2, [62; 32], &[]),
        )),
        OidcEndpointValidator::allowing_test_addresses(Duration::from_secs(5)).unwrap(),
        sessions.clone(),
    );
    assert_eq!(
        missing_key_login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: &issuer,
                state: &missing_key_state,
                code: "fixture-code-missing-previous-key",
                browser_binding: &missing_key.browser_binding,
                existing_session: None,
                correlation_id: "request:oidc3-missing-previous-key",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );

    let rollback_request = login.begin(created.id).await.unwrap();
    let rollback_url = Url::parse(&rollback_request.url).unwrap();
    let rollback_parameters = rollback_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let rollback_state = rollback_parameters.get("state").unwrap().to_string();
    fs::write(
        control.join("nonce"),
        rollback_parameters.get("nonce").unwrap().as_bytes(),
    )
    .unwrap();
    fs::write(
        control.join("pkce_challenge"),
        rollback_parameters
            .get("code_challenge")
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let rollback_session = sessions.issue(user_id).await.unwrap();
    sqlx::raw_sql(
        "CREATE FUNCTION reject_oidc_login_audit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action_code='auth.oidc_login_succeeded' THEN
             RAISE EXCEPTION 'forced audit failure';
           END IF;
           RETURN NEW;
         END;
         $$;
         CREATE TRIGGER reject_oidc_login_audit_trigger BEFORE INSERT ON audit_events
         FOR EACH ROW EXECUTE FUNCTION reject_oidc_login_audit();",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: &issuer,
                state: &rollback_state,
                code: "fixture-code-audit-rollback",
                browser_binding: &rollback_request.browser_binding,
                existing_session: Some(rollback_session.token()),
                correlation_id: "request:oidc3-audit-rollback",
            })
            .await
            .unwrap_err(),
        OidcProviderError::Unavailable
    );
    sessions
        .authenticate(rollback_session.token())
        .await
        .unwrap();
    let rollback_completed: bool = sqlx::query_scalar(
        "SELECT completed_at IS NOT NULL FROM oidc_login_attempts WHERE state_hash=$1",
    )
    .bind(Sha256::digest(rollback_state.as_bytes()).to_vec())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(!rollback_completed);
    sqlx::raw_sql(
        "DROP TRIGGER reject_oidc_login_audit_trigger ON audit_events;
         DROP FUNCTION reject_oidc_login_audit();",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let replay_code = login.begin(created.id).await.unwrap();
    let replay_url = Url::parse(&replay_code.url).unwrap();
    let replay_parameters = replay_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let replay_state = replay_parameters.get("state").unwrap().to_string();
    let replay_nonce = replay_parameters.get("nonce").unwrap().to_string();
    fs::write(control.join("nonce"), replay_nonce).unwrap();
    fs::write(
        control.join("pkce_challenge"),
        replay_parameters.get("code_challenge").unwrap().as_bytes(),
    )
    .unwrap();
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: &issuer,
                state: &replay_state,
                code: "fixture-code-success",
                browser_binding: &replay_code.browser_binding,
                existing_session: None,
                correlation_id: "request:oidc3-code-replay",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );

    for (mode, expected_nonce) in [
        ("wrong-aud", true),
        ("wrong-azp", true),
        ("wrong-issuer", true),
        ("wrong-alg", true),
        ("wrong-kid", true),
        ("bad-signature", true),
        ("future", true),
        ("expired", true),
        ("normal", false),
    ] {
        fs::write(control.join("token_mode"), mode).unwrap();
        let request = login.begin(created.id).await.unwrap();
        let url = Url::parse(&request.url).unwrap();
        let parameters = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        let state = parameters.get("state").unwrap().to_string();
        let nonce = parameters.get("nonce").unwrap().to_string();
        fs::write(
            control.join("nonce"),
            if expected_nonce {
                nonce.as_str()
            } else {
                "wrong-nonce"
            },
        )
        .unwrap();
        fs::write(
            control.join("pkce_challenge"),
            parameters.get("code_challenge").unwrap().as_bytes(),
        )
        .unwrap();
        assert_eq!(
            login
                .callback(login::OidcCallbackInput {
                    provider_id: created.id,
                    issuer: &issuer,
                    state: &state,
                    code: &format!("fixture-code-{mode}"),
                    browser_binding: &request.browser_binding,
                    existing_session: None,
                    correlation_id: &format!("request:oidc3-{mode}"),
                })
                .await
                .unwrap_err(),
            OidcProviderError::ValidationFailed,
            "{mode} must fail closed"
        );
    }
    fs::write(control.join("token_mode"), "normal").unwrap();

    fs::write(control.join("mode"), "too-many-keys").unwrap();
    let too_many_keys = login.begin(created.id).await.unwrap();
    let too_many_keys_url = Url::parse(&too_many_keys.url).unwrap();
    let too_many_keys_parameters = too_many_keys_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    fs::write(
        control.join("nonce"),
        too_many_keys_parameters.get("nonce").unwrap().as_bytes(),
    )
    .unwrap();
    fs::write(
        control.join("pkce_challenge"),
        too_many_keys_parameters
            .get("code_challenge")
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: &issuer,
                state: too_many_keys_parameters.get("state").unwrap(),
                code: "fixture-code-129-jwks",
                browser_binding: &too_many_keys.browser_binding,
                existing_session: None,
                correlation_id: "request:oidc3-129-jwks",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    fs::write(control.join("mode"), "normal").unwrap();

    let mixed = login.begin(created.id).await.unwrap();
    let mixed_url = Url::parse(&mixed.url).unwrap();
    let mixed_parameters = mixed_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let mixed_state = mixed_parameters.get("state").unwrap().to_string();
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: "https://mix-up.example.test",
                state: &mixed_state,
                code: "fixture-code-mixup",
                browser_binding: &mixed.browser_binding,
                existing_session: None,
                correlation_id: "request:oidc3-mixup",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );

    let second_provider = providers
        .create_provider(
            actor(),
            &OidcProviderInput::new(
                "Second callback provider",
                "https://other-issuer.example.test",
                "protocol-client",
            )
            .unwrap(),
            &SecretValue::new(b"protocol-secret".to_vec()).unwrap(),
            "request:oidc3-second-provider",
        )
        .await
        .unwrap();
    let second_attempt_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO oidc_login_attempts
         (id,provider_id,provider_config_version,provider_secret_version,state_hash,nonce_hash,
          browser_binding_hash,pkce_algorithm,pkce_key_version,pkce_nonce,pkce_ciphertext,
          redirect_uri,created_at,expires_at)
         SELECT $1::uuid,$2::uuid,$3,$4,decode(repeat('ab',32),'hex'),nonce_hash,
                decode(repeat('cd',32),'hex'),pkce_algorithm,pkce_key_version,pkce_nonce,
                pkce_ciphertext,redirect_uri,created_at,expires_at
         FROM oidc_login_attempts WHERE provider_id=$5::uuid AND state_hash=$6",
    )
    .bind(second_attempt_id.to_string())
    .bind(second_provider.id.to_string())
    .bind(i64::try_from(second_provider.config_version).unwrap())
    .bind(i64::try_from(second_provider.secret_version).unwrap())
    .bind(created.id.to_string())
    .bind(Sha256::digest(mixed_state.as_bytes()).to_vec())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let shared_code_hash = Sha256::digest(b"same-opaque-code-across-providers").to_vec();
    for (provider_id, attempt_id) in [
        (created.id, None),
        (second_provider.id, Some(second_attempt_id)),
    ] {
        let affected = if let Some(attempt_id) = attempt_id {
            sqlx::query(
                "UPDATE oidc_login_attempts SET consumed_at=transaction_timestamp(),
                 authorization_code_hash=$2 WHERE id=$1::uuid",
            )
            .bind(attempt_id.to_string())
            .bind(&shared_code_hash)
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap()
            .rows_affected()
        } else {
            sqlx::query(
                "UPDATE oidc_login_attempts SET consumed_at=transaction_timestamp(),
                 authorization_code_hash=$3 WHERE provider_id=$1::uuid AND state_hash=$2",
            )
            .bind(provider_id.to_string())
            .bind(Sha256::digest(mixed_state.as_bytes()).to_vec())
            .bind(&shared_code_hash)
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap()
            .rows_affected()
        };
        assert_eq!(affected, 1);
    }

    let concurrent = login.begin(created.id).await.unwrap();
    let concurrent_url = Url::parse(&concurrent.url).unwrap();
    let concurrent_parameters = concurrent_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let concurrent_state = concurrent_parameters.get("state").unwrap().to_string();
    let concurrent_nonce = concurrent_parameters.get("nonce").unwrap().to_string();
    fs::write(control.join("nonce"), concurrent_nonce).unwrap();
    fs::write(
        control.join("pkce_challenge"),
        concurrent_parameters
            .get("code_challenge")
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let first = login.clone();
    let second = login.clone();
    let first_state = concurrent_state.clone();
    let second_state = concurrent_state;
    let first_binding = concurrent.browser_binding.to_string();
    let second_binding = first_binding.clone();
    let first_issuer = issuer.clone();
    let second_issuer = issuer.clone();
    let (first, second) = tokio::join!(
        async move {
            first
                .callback(login::OidcCallbackInput {
                    provider_id: created.id,
                    issuer: &first_issuer,
                    state: &first_state,
                    code: "fixture-code-concurrent",
                    browser_binding: &first_binding,
                    existing_session: None,
                    correlation_id: "request:oidc3-concurrent-a",
                })
                .await
        },
        async move {
            second
                .callback(login::OidcCallbackInput {
                    provider_id: created.id,
                    issuer: &second_issuer,
                    state: &second_state,
                    code: "fixture-code-concurrent",
                    browser_binding: &second_binding,
                    existing_session: None,
                    correlation_id: "request:oidc3-concurrent-b",
                })
                .await
        }
    );
    assert!(matches!((first, second), (Ok(_), Err(_)) | (Err(_), Ok(_))));

    let stale = login.begin(created.id).await.unwrap();
    let stale_url = Url::parse(&stale.url).unwrap();
    let stale_parameters = stale_url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let stale_state = stale_parameters.get("state").unwrap().to_string();
    let stale_nonce = stale_parameters.get("nonce").unwrap().to_string();
    fs::write(control.join("nonce"), stale_nonce).unwrap();
    fs::write(
        control.join("pkce_challenge"),
        stale_parameters.get("code_challenge").unwrap().as_bytes(),
    )
    .unwrap();
    let disabled = providers
        .disable_provider(
            actor(),
            created.id,
            active.config_version,
            "request:oidc3-disable",
        )
        .await
        .unwrap();
    let rotated = providers
        .rotate_client_secret(
            actor(),
            created.id,
            disabled.config_version,
            &SecretValue::new(b"protocol-secret-rotated".to_vec()).unwrap(),
            "request:oidc3-secret-rotation",
        )
        .await
        .unwrap();
    let reactivated = providers
        .validate_and_activate(
            &OidcEndpointValidator::allowing_test_addresses(Duration::from_secs(5)).unwrap(),
            actor(),
            created.id,
            rotated.config_version,
            &format!("{issuer}/callback"),
            "request:oidc3-reactivate",
        )
        .await
        .unwrap();
    assert!(reactivated.config_version > active.config_version);
    let token_requests_before_stale_callback = token_request_count(&control);
    assert!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: created.id,
                issuer: &issuer,
                state: &stale_state,
                code: "fixture-code-stale-provider",
                browser_binding: &stale.browser_binding,
                existing_session: None,
                correlation_id: "request:oidc3-stale-provider",
            })
            .await
            .is_err()
    );
    assert_eq!(
        token_request_count(&control),
        token_requests_before_stale_callback,
        "an old attempt must not reach the newly activated token endpoint"
    );

    let raw: String = sqlx::query_scalar(
        "SELECT COALESCE(string_agg(encode(state_hash,'hex') || encode(nonce_hash,'hex') ||
          encode(browser_binding_hash,'hex') || encode(pkce_ciphertext,'hex'),' '),'')
         FROM oidc_login_attempts",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        !raw.contains(&state)
            && !raw.contains(&nonce)
            && !raw.contains(request.browser_binding.as_str())
    );
    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-oidc-protocol/run.sh"]
async fn actual_invited_identity_linking_is_provisioned_and_atomic() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert!(report.latest_version.is_some_and(|version| version >= 34));
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
    let repository = IntegrationRepository::new(pool.clone(), keyring(1, [61; 32], &[]));
    let providers = OidcProviderService::new(repository.clone());
    let created = providers
        .create_provider(
            actor(),
            &OidcProviderInput::new("Identity linking", &issuer, "protocol-client").unwrap(),
            &SecretValue::new(b"protocol-secret".to_vec()).unwrap(),
            "request:oidc4-create",
        )
        .await
        .unwrap();
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
        .stage_ca_candidate(actor(), &endpoint, ca, "request:oidc4-ca-stage")
        .await
        .unwrap();
    admin
        .activate_ca_candidate(
            actor(),
            staged.id,
            &endpoint,
            "request:oidc4-ca-activate",
            &ExactPreflight,
        )
        .await
        .unwrap();
    let validator = OidcEndpointValidator::allowing_test_addresses(Duration::from_secs(5)).unwrap();
    let active = providers
        .validate_and_activate(
            &validator,
            actor(),
            created.id,
            created.config_version,
            &format!("{issuer}/callback"),
            "request:oidc4-activate",
        )
        .await
        .unwrap();
    let sessions = SessionService::new(pool.clone(), SessionPolicy::default());
    let login = login::OidcLoginService::new(providers.clone(), validator, sessions.clone());

    // No matching account or invitation: generic failure and no JIT account.
    assert_eq!(
        oidc_callback_for_email(
            &login,
            active.id,
            &issuer,
            &control,
            ("unknown-subject", "unknown@example.test", "oidc4-no-jit"),
            None,
        )
        .await
        .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    let unknown_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE normalized_email='unknown@example.test')",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(!unknown_exists);

    // A syntactically valid but unverified email is never an account-linking
    // credential and is intentionally indistinguishable from no invitation.
    let (unverified_request, unverified_state) = prepare_oidc_callback(
        &login,
        active.id,
        &control,
        "unverified-subject",
        "unknown@example.test",
        "oidc4-unverified",
        "unverified-email",
    )
    .await
    .unwrap();
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: active.id,
                issuer: &issuer,
                state: &unverified_state,
                code: "oidc4-unverified",
                browser_binding: unverified_request.browser_binding.as_str(),
                existing_session: None,
                correlation_id: "request:oidc4-unverified",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );

    let local_user: UserId = "0199ee6c-c777-7000-8000-000000007081".parse().unwrap();
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name)
         VALUES($1::uuid,'Local.Link@Example.test','local.link@example.test','Local Link')",
    )
    .bind(local_user.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO local_password_credentials(user_id,password_verifier)
         VALUES($1::uuid,'$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')",
    )
    .bind(local_user.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let local_login = oidc_callback_for_email(
        &login,
        active.id,
        &issuer,
        &control,
        (
            "local-subject",
            "Local.Link@Example.test",
            "oidc4-local-link",
        ),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        sessions
            .authenticate(local_login.token())
            .await
            .unwrap()
            .user_id(),
        local_user
    );
    let administrator: UserId = "0199ee6c-c777-7000-8000-000000007001".parse().unwrap();
    let unrelated_session = sessions.issue(administrator).await.unwrap();
    assert_eq!(
        oidc_callback_for_email(
            &login,
            active.id,
            &issuer,
            &control,
            (
                "collision-subject",
                "local.link@example.test",
                "oidc4-account-collision",
            ),
            Some(unrelated_session.token()),
        )
        .await
        .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM oidc_identities
         WHERE provider_id=$1::uuid AND subject='collision-subject')",
        )
        .bind(active.id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
    );

    sqlx::query(
        "INSERT INTO activation_invitations
         (id,normalized_email,invited_by_user_id,token_hash,expires_at)
         VALUES('0199ee6c-c777-7000-8000-000000007082','invited@example.test',
                '0199ee6c-c777-7000-8000-000000007001',decode(repeat('42',32),'hex'),
                transaction_timestamp()+INTERVAL '7 days')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let invited_login = oidc_callback_for_email(
        &login,
        active.id,
        &issuer,
        &control,
        (
            "invited-subject",
            "invited@example.test",
            "oidc4-invited-link",
        ),
        None,
    )
    .await
    .unwrap();
    let invited_user = sessions
        .authenticate(invited_login.token())
        .await
        .unwrap()
        .user_id();
    let invitation_status: String = sqlx::query_scalar(
        "SELECT status FROM activation_invitations WHERE id='0199ee6c-c777-7000-8000-000000007082'::uuid",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(invitation_status, "accepted");

    // Two independent browsers may complete the same invited identity at the
    // same time. The provider+subject advisory fence makes both resolve to one
    // user and one immutable identity; the invitation is consumed once.
    sqlx::query(
        "INSERT INTO activation_invitations
         (id,normalized_email,invited_by_user_id,token_hash,expires_at)
         VALUES('0199ee6c-c777-7000-8000-000000007083','race@example.test',
                '0199ee6c-c777-7000-8000-000000007001',decode(repeat('43',32),'hex'),
                transaction_timestamp()+INTERVAL '7 days')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let (race_request_a, race_state_a) = prepare_oidc_callback(
        &login,
        active.id,
        &control,
        "race-subject",
        "Race@Example.test",
        "oidc4-race-a",
        "normal",
    )
    .await
    .unwrap();
    let (race_request_b, race_state_b) = prepare_oidc_callback(
        &login,
        active.id,
        &control,
        "race-subject",
        "race@example.test",
        "oidc4-race-b",
        "normal",
    )
    .await
    .unwrap();
    let (race_a, race_b) = tokio::join!(
        login.callback(login::OidcCallbackInput {
            provider_id: active.id,
            issuer: &issuer,
            state: &race_state_a,
            code: "oidc4-race-a",
            browser_binding: race_request_a.browser_binding.as_str(),
            existing_session: None,
            correlation_id: "request:oidc4-race-a",
        }),
        login.callback(login::OidcCallbackInput {
            provider_id: active.id,
            issuer: &issuer,
            state: &race_state_b,
            code: "oidc4-race-b",
            browser_binding: race_request_b.browser_binding.as_str(),
            existing_session: None,
            correlation_id: "request:oidc4-race-b",
        })
    );
    let race_user_a = sessions
        .authenticate(race_a.unwrap().token())
        .await
        .unwrap()
        .user_id();
    let race_user_b = sessions
        .authenticate(race_b.unwrap().token())
        .await
        .unwrap()
        .user_id();
    assert_eq!(race_user_a, race_user_b);
    let race_counts: (i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM users WHERE normalized_email='race@example.test'),
           (SELECT count(*) FROM oidc_identities WHERE provider_id=$1::uuid AND subject='race-subject')",
    )
    .bind(active.id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(race_counts, (1, 1));

    // OIDC-only invitation accounts cannot unlink their final credential.
    let reauthenticated_invited = sessions
        .rotate(invited_login.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    assert_eq!(
        login
            .unlink_self(
                reauthenticated_invited.token(),
                active.id,
                "request:oidc4-last-credential",
            )
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM oidc_identities WHERE user_id=$1::uuid)",
        )
        .bind(invited_user.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
    );

    let reauthenticated_local = sessions
        .rotate(local_login.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    // Begin a callback before unlink, but leave it in flight until the unlink
    // commits. Its verified email must not be able to recreate the binding.
    let (stale_request, stale_state) = prepare_oidc_callback(
        &login,
        active.id,
        &control,
        "local-subject",
        "local.link@example.test",
        "oidc4-stale-after-unlink",
        "normal",
    )
    .await
    .unwrap();
    let (unlink_a, unlink_b) = tokio::join!(
        login.unlink_self(
            reauthenticated_local.token(),
            active.id,
            "request:oidc4-unlink-a",
        ),
        login.unlink_self(
            reauthenticated_local.token(),
            active.id,
            "request:oidc4-unlink-b",
        )
    );
    assert_ne!(unlink_a.is_ok(), unlink_b.is_ok());
    let replacement = unlink_a.or(unlink_b).unwrap();
    sessions.authenticate(replacement.token()).await.unwrap();
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM oidc_identities WHERE user_id=$1::uuid)",
        )
        .bind(local_user.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
    );
    assert_eq!(
        login
            .callback(login::OidcCallbackInput {
                provider_id: active.id,
                issuer: &issuer,
                state: &stale_state,
                code: "oidc4-stale-after-unlink",
                browser_binding: stale_request.browser_binding.as_str(),
                existing_session: None,
                correlation_id: "request:oidc4-stale-after-unlink",
            })
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    let stale_code_hash: [u8; 32] = Sha256::digest(b"oidc4-stale-after-unlink").into();
    let stale_attempt_completed: bool = sqlx::query_scalar(
        "SELECT completed_at IS NOT NULL OR session_id IS NOT NULL
         FROM oidc_login_attempts
         WHERE provider_id=$1::uuid AND authorization_code_hash=$2",
    )
    .bind(active.id.to_string())
    .bind(stale_code_hash.to_vec())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(!stale_attempt_completed);
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM oidc_identities
             WHERE provider_id=$1::uuid AND subject='local-subject')",
        )
        .bind(active.id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
    );

    // The active provider is the administrator's only usable credential, so
    // both raw SQL and the supported service boundary reject disabling it.
    sqlx::query(
        "INSERT INTO oidc_identities
           (id,user_id,provider_id,subject,normalized_email_at_link,link_source)
         VALUES('0199ee6c-c777-7000-8000-000000007084',
                '0199ee6c-c777-7000-8000-000000007001',$1::uuid,
                'admin-subject','runtime-admin@example.test','preexisting')",
    )
    .bind(active.id.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM local_password_credentials
         WHERE user_id='0199ee6c-c777-7000-8000-000000007001'::uuid",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE oidc_providers
             SET status='disabled',disabled_at=transaction_timestamp(),
                 config_version=config_version+1,updated_at=transaction_timestamp()
             WHERE id=$1::uuid",
        )
        .bind(active.id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err()
    );
    assert_eq!(
        providers
            .disable_provider(
                actor(),
                active.id,
                active.config_version,
                "request:oidc4-disable-last-admin",
            )
            .await
            .unwrap_err(),
        OidcProviderError::ValidationFailed
    );
    sqlx::query(
        "INSERT INTO local_password_credentials(user_id,password_verifier)
         VALUES('0199ee6c-c777-7000-8000-000000007001'::uuid,
                '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    providers
        .disable_provider(
            actor(),
            active.id,
            active.config_version,
            "request:oidc4-disable",
        )
        .await
        .unwrap();
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM oidc_identities WHERE user_id=$1::uuid)",
        )
        .bind(invited_user.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
    );
    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn oidc_callback_for_email(
    login: &login::OidcLoginService,
    provider_id: Uuid,
    issuer: &str,
    control: &Path,
    identity: (&str, &str, &str),
    existing_session: Option<&SessionToken>,
) -> Result<IssuedSession, OidcProviderError> {
    let (subject, email, code) = identity;
    let (request, state) =
        prepare_oidc_callback(login, provider_id, control, subject, email, code, "normal").await?;
    login
        .callback(login::OidcCallbackInput {
            provider_id,
            issuer,
            state: &state,
            code,
            browser_binding: request.browser_binding.as_str(),
            existing_session,
            correlation_id: "request:oidc4-callback",
        })
        .await
}

async fn prepare_oidc_callback(
    login: &login::OidcLoginService,
    provider_id: Uuid,
    control: &Path,
    subject: &str,
    email: &str,
    code: &str,
    mode: &str,
) -> Result<(login::OidcAuthorizationRequest, String), OidcProviderError> {
    let request = login.begin(provider_id).await?;
    let url = Url::parse(&request.url).map_err(|_| OidcProviderError::Unavailable)?;
    let parameters = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    fs::write(control.join(format!("subject-{code}")), subject)
        .map_err(|_| OidcProviderError::Unavailable)?;
    fs::write(control.join(format!("email-{code}")), email)
        .map_err(|_| OidcProviderError::Unavailable)?;
    fs::write(control.join(format!("token_mode-{code}")), mode)
        .map_err(|_| OidcProviderError::Unavailable)?;
    fs::write(
        control.join(format!("nonce-{code}")),
        parameters
            .get("nonce")
            .ok_or(OidcProviderError::Unavailable)?
            .as_bytes(),
    )
    .map_err(|_| OidcProviderError::Unavailable)?;
    fs::write(
        control.join(format!("pkce_challenge-{code}")),
        parameters
            .get("code_challenge")
            .ok_or(OidcProviderError::Unavailable)?
            .as_bytes(),
    )
    .map_err(|_| OidcProviderError::Unavailable)?;
    Ok((
        request,
        parameters
            .get("state")
            .ok_or(OidcProviderError::Unavailable)?
            .to_string(),
    ))
}

fn token_request_count(control: &Path) -> usize {
    fs::read_to_string(control.join("requests"))
        .unwrap_or_default()
        .lines()
        .filter(|path| *path == "/token")
        .count()
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
    sqlx::query("INSERT INTO local_password_credentials(user_id,password_verifier) VALUES('0199ee6c-c777-7000-8000-000000007001','$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')")
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
