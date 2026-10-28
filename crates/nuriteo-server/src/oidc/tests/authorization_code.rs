#![allow(unused_imports)]
use super::*;
use super::provider_validation::*;
use super::identity_linking::*;
use super::super::*;


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
use super::{ExactPreflight, TestEnvironment, NoFiles};



#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-oidc-protocol/run.sh"]
pub(crate) async fn actual_authorization_code_pkce_is_one_time_and_rotation_fenced() {    let pool = fixture_pool().await;
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
