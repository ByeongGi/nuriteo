#![allow(unused_imports)]
use super::*;
use super::provider_validation::*;
use super::authorization_code::*;
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
pub(crate) async fn actual_invited_identity_linking_is_provisioned_and_atomic() {    let pool = fixture_pool().await;
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


pub(crate) async fn oidc_callback_for_email(    login: &login::OidcLoginService,
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


pub(crate) async fn prepare_oidc_callback(    login: &login::OidcLoginService,
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


pub(crate) fn token_request_count(control: &Path) -> usize {    fs::read_to_string(control.join("requests"))
        .unwrap_or_default()
        .lines()
        .filter(|path| *path == "/token")
        .count()
}


impl CaCandidatePreflight for ExactPreflight { fn preflight<'a>(
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


pub(crate) fn actor() -> IntegrationAdminActor {    IntegrationAdminActor {
        user_id: "0199ee6c-c777-7000-8000-000000007001"
            .parse::<UserId>()
            .unwrap(),
        session_id: "0199ee6c-c777-7000-8000-000000007002"
            .parse::<SessionId>()
            .unwrap(),
    }
}


pub(crate) async fn seed_admin(pool: &DatabasePool) {    sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000007001','runtime-admin@example.test','runtime-admin@example.test','Runtime Admin',TRUE)")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000007002','0199ee6c-c777-7000-8000-000000007001',decode(repeat('31',32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::query("INSERT INTO local_password_credentials(user_id,password_verifier) VALUES('0199ee6c-c777-7000-8000-000000007001','$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
}


pub(crate) fn keyring(current: u32, key: [u8; 32], previous: &[(u32, [u8; 32])]) -> MasterKeyring {    let previous = serde_json::to_string(
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


impl Environment for TestEnvironment { fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}


impl FileReader for NoFiles { fn read(&self, _: &Path, _: usize) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::NotFound.into())
    }
}


pub(crate) async fn reset_fixture(pool: &DatabasePool) {    let mut connection = pool.acquire().await.unwrap();
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&mut *connection)
        .await
        .unwrap();
}


pub(crate) async fn fixture_pool() -> DatabasePool {    let tls = DatabaseTlsConfig::verify_full(
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

