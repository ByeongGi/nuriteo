//! Host-bound Git provider configuration and outbound preflight.
//!
//! This module deliberately does not expose Git credentials or execute Git.
//! GIT-002 consumes an active provider through the exact repository URL lookup.

use std::collections::BTreeMap;

use std::fmt;

use std::net::{IpAddr, SocketAddr};

use std::str::FromStr;

use std::time::Duration;

use ::time::OffsetDateTime;

use reqwest::{Certificate, Client};

use sha2::{Digest, Sha256};

use sqlx::{Acquire, Postgres, Row, Transaction};

use tokio::net::lookup_host;

use tokio::time;

use url::Url;

use uuid::Uuid;

use crate::integration::{
    CaEndpointBinding, IntegrationAdminActor, IntegrationError, IntegrationRepository,
    ValidatedCaBundle, authorize_recent_admin,
};

const INTEGRATION_TYPE: &str = "git";

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

const MIN_TIMEOUT: Duration = Duration::from_millis(250);

const MAX_TIMEOUT: Duration = Duration::from_secs(30);

const DNS_TIMEOUT: Duration = Duration::from_secs(3);

const MAX_DNS_ADDRESSES: usize = 16;

const RESPONSE_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitProviderKind {
    GitHub,
    GitHubEnterprise,
    GitLab,
    GitLabSelfManaged,
    Generic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitProviderState {
    Active,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProviderInput {
    display_name: String,
    kind: GitProviderKind,
    canonical_host: String,
    canonical_port: u16,
    api_base_url: String,
    oauth_authorization_url: Option<String>,
    oauth_token_url: Option<String>,
    oauth_client_id: Option<String>,
    allows_read: bool,
    allows_write: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProviderUpdate {
    display_name: String,
    api_base_url: String,
    oauth_authorization_url: Option<String>,
    oauth_token_url: Option<String>,
    oauth_client_id: Option<String>,
    allows_read: bool,
    allows_write: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProviderMetadata {
    pub id: Uuid,
    pub display_name: String,
    pub kind: GitProviderKind,
    pub canonical_host: String,
    pub canonical_port: u16,
    pub api_base_url: String,
    pub oauth_authorization_url: Option<String>,
    pub oauth_token_url: Option<String>,
    pub oauth_client_id: Option<String>,
    pub state: GitProviderState,
    pub allows_read: bool,
    pub allows_write: bool,
    pub config_version: u64,
    pub validated_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Clone)]
pub struct GitProviderService {
    integrations: IntegrationRepository,
    timeout: Duration,
}

#[derive(Clone)]
pub struct GitProviderValidator {
    timeout: Duration,
    allow_test_addresses: bool,
}

#[derive(Debug)]
pub(crate) struct GitPreflightProof {
    config_version: u64,
    endpoint_fingerprint: [u8; 32],
    ca_fingerprint: [u8; 32],
}

const fn map_integration_error(error: IntegrationError) -> GitProviderError {
    match error {
        IntegrationError::InvalidInput => GitProviderError::InvalidInput,
        IntegrationError::ReauthenticationRequired => GitProviderError::ReauthenticationRequired,
        IntegrationError::Conflict => GitProviderError::Conflict,
        IntegrationError::InvalidCaBundle | IntegrationError::PreflightFailed => {
            GitProviderError::ValidationFailed
        }
        IntegrationError::KeyConfiguration
        | IntegrationError::CredentialUnavailable
        | IntegrationError::Unavailable => GitProviderError::Unavailable,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitProviderError {
    InvalidInput,
    ReauthenticationRequired,
    NotFound,
    MustDisable,
    HostAlreadyRegistered,
    Conflict,
    NetworkDenied,
    ValidationFailed,
    Unavailable,
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::ffi::OsString;
    use std::fs;
    use std::io;
    use std::path::Path;
    use std::pin::Pin;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;
    use crate::config::{Environment, FileReader, InstanceSettingBootstrap};
    use crate::database::{
        DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions,
        run_embedded_migrations,
    };
    use crate::identity::{SessionId, UserId};
    use crate::instance_settings::InstanceSettingsRepository;
    use crate::integration::{
        CaCandidatePreflight, CaPreflightProof, IntegrationAdminService, MasterKeyring,
    };

    fn github() -> GitProviderInput {
        GitProviderInput::new(
            "GitHub",
            GitProviderKind::GitHub,
            "github.com",
            443,
            "https://api.github.com/",
            Some("https://github.com/login/oauth/authorize".into()),
            Some("https://github.com/login/oauth/access_token".into()),
            Some("client-id".into()),
            true,
            true,
        )
        .unwrap()
    }

    #[test]
    fn accepts_exact_public_provider_contracts() {
        let github = github();
        assert_eq!(github.kind, GitProviderKind::GitHub);
        let gitlab = GitProviderInput::new(
            "GitLab",
            GitProviderKind::GitLab,
            "gitlab.com",
            443,
            "https://gitlab.com/api/v4",
            Some("https://gitlab.com/oauth/authorize".into()),
            Some("https://gitlab.com/oauth/token".into()),
            Some("client-id".into()),
            true,
            false,
        );
        assert!(gitlab.is_ok());
    }

    #[test]
    fn rejects_cross_host_oauth_and_generic_credentials() {
        let cross_host = GitProviderInput::new(
            "GitLab",
            GitProviderKind::GitLab,
            "gitlab.com",
            443,
            "https://gitlab.com/api/v4",
            Some("https://attacker.example/oauth".into()),
            Some("https://gitlab.com/oauth/token".into()),
            Some("client-id".into()),
            true,
            false,
        );
        assert_eq!(cross_host.unwrap_err(), GitProviderError::InvalidInput);
        let generic_oauth = GitProviderInput::new(
            "Forge",
            GitProviderKind::Generic,
            "git.example.test",
            443,
            "https://git.example.test/",
            Some("https://git.example.test/oauth".into()),
            Some("https://git.example.test/token".into()),
            Some("client".into()),
            true,
            false,
        );
        assert_eq!(generic_oauth.unwrap_err(), GitProviderError::InvalidInput);
    }

    #[test]
    fn repository_urls_are_https_credential_free_and_path_bound() {
        assert!(validate_repository_url("https://git.example.test/acme/app.git").is_ok());
        for invalid in [
            "http://git.example.test/acme/app.git",
            "https://token@git.example.test/acme/app.git",
            "https://git.example.test/",
            "https://git.example.test/acme/../admin",
            "https://git.example.test/acme/app.git?token=value",
        ] {
            assert!(validate_repository_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn blocks_private_and_metadata_networks() {
        for value in [
            "127.0.0.1:443",
            "10.0.0.1:443",
            "169.254.169.254:443",
            "168.63.129.16:443",
            "[::1]:443",
        ] {
            let address: SocketAddr = value.parse().unwrap();
            assert!(!is_public_ip(address.ip()), "{value}");
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn test_validator_is_explicitly_scoped() {
        let validator = GitProviderValidator::allowing_test_addresses(Duration::from_secs(1));
        assert!(validator.is_ok());
    }

    #[tokio::test]
    #[ignore = "requires tests/fixtures/postgres-git-provider/run.sh"]
    async fn actual_provider_preflight_is_host_bound_tls_pinned_and_no_fallback() {
        let pool = fixture_pool().await;
        reset_fixture(&pool).await;
        let report = run_embedded_migrations(
            &pool,
            MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(report.latest_version, Some(40));
        InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
            .unwrap()
            .materialize(&InstanceSettingBootstrap::empty())
            .await
            .unwrap();
        seed_admin(&pool).await;

        let port = env::var("NURITEO_TEST_GIT_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let control = env::var("NURITEO_TEST_GIT_CONTROL_DIR").unwrap();
        let repository = IntegrationRepository::new(pool.clone(), keyring());
        let service = GitProviderService::new(repository.clone());
        let input = GitProviderInput::new(
            "Internal Forge",
            GitProviderKind::Generic,
            "localhost",
            port,
            format!("https://localhost:{port}/api"),
            None,
            None,
            None,
            true,
            true,
        )
        .unwrap();
        let created = service
            .create(actor(), &input, "request:git-create")
            .await
            .unwrap();
        assert_eq!(created.state, GitProviderState::Disabled);

        assert_eq!(
            service
                .create(actor(), &input, "request:git-duplicate")
                .await
                .unwrap_err(),
            GitProviderError::HostAlreadyRegistered
        );
        assert!(
            sqlx::query(
                "INSERT INTO git_providers(id,display_name,provider_kind,canonical_host,
                 canonical_port,api_base_url,status,disabled_at,allows_read,allows_write)
                 VALUES($1::uuid,'Bypass','generic','bypass.example.test',443,
                 'https://bypass.example.test/','active',NULL,TRUE,FALSE)",
            )
            .bind(Uuid::now_v7().to_string())
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
            "providers must be inserted disabled and unvalidated"
        );

        let production = GitProviderValidator::new(Duration::from_secs(3)).unwrap();
        assert_eq!(
            production
                .validate_and_activate(
                    &service,
                    actor(),
                    created.id,
                    created.config_version,
                    "request:git-ssrf",
                )
                .await
                .unwrap_err(),
            GitProviderError::NetworkDenied
        );
        let test_validator =
            GitProviderValidator::allowing_test_addresses(Duration::from_secs(3)).unwrap();
        assert_eq!(
            test_validator
                .validate_and_activate(
                    &service,
                    actor(),
                    created.id,
                    created.config_version,
                    "request:git-wrong-ca",
                )
                .await
                .unwrap_err(),
            GitProviderError::ValidationFailed
        );

        let ca =
            ValidatedCaBundle::parse(fs::read(env::var("NURITEO_TEST_GIT_CA").unwrap()).unwrap())
                .unwrap();
        let endpoint = endpoint_binding(&created).unwrap();
        let admin = IntegrationAdminService::new(repository);
        let staged = admin
            .stage_ca_candidate(actor(), &endpoint, ca, "request:git-ca-stage")
            .await
            .unwrap();
        admin
            .activate_ca_candidate(
                actor(),
                staged.id,
                &endpoint,
                "request:git-ca-activate",
                &ExactPreflight,
            )
            .await
            .unwrap();

        for mode in ["redirect", "oversize"] {
            fs::write(Path::new(&control).join("mode"), mode).unwrap();
            assert_eq!(
                test_validator
                    .validate_and_activate(
                        &service,
                        actor(),
                        created.id,
                        created.config_version,
                        "request:git-negative-preflight",
                    )
                    .await
                    .unwrap_err(),
                GitProviderError::ValidationFailed,
                "{mode}"
            );
        }
        fs::write(Path::new(&control).join("mode"), "normal").unwrap();
        let active = test_validator
            .validate_and_activate(
                &service,
                actor(),
                created.id,
                created.config_version,
                "request:git-activate",
            )
            .await
            .unwrap();
        assert_eq!(active.state, GitProviderState::Active);
        assert_eq!(active.config_version, created.config_version + 1);
        assert!(
            sqlx::query(
                "UPDATE git_providers SET display_name='Bypass Active Mutation',
                 config_version=config_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
            )
            .bind(active.id.to_string())
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
            "active configuration cannot be changed through raw SQL"
        );

        let resolved = service
            .resolve_active_repository(&format!(
                "https://localhost:{port}/organization/project.git"
            ))
            .await
            .unwrap();
        assert_eq!(resolved.id, active.id);
        assert_eq!(
            service
                .resolve_active_repository(&format!(
                    "https://localhost:{}/organization/project.git",
                    port + 1
                ))
                .await
                .unwrap_err(),
            GitProviderError::NotFound,
            "an exact-host miss must not fall back to another provider"
        );
        assert_eq!(
            service
                .update(
                    actor(),
                    active.id,
                    active.config_version,
                    &GitProviderUpdate::new(
                        "Changed",
                        format!("https://localhost:{port}/api"),
                        None,
                        None,
                        None,
                        true,
                        false,
                    )
                    .unwrap(),
                    "request:git-active-update",
                )
                .await
                .unwrap_err(),
            GitProviderError::MustDisable
        );
        let disabled = service
            .disable(
                actor(),
                active.id,
                active.config_version,
                "request:git-disable",
            )
            .await
            .unwrap();
        assert_eq!(disabled.state, GitProviderState::Disabled);
        assert_eq!(
            service
                .resolve_active_repository(&format!(
                    "https://localhost:{port}/organization/project.git"
                ))
                .await
                .unwrap_err(),
            GitProviderError::NotFound
        );

        let audit_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE target_type='git_provider' AND target_id=$1",
        )
        .bind(created.id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
        assert_eq!(audit_count, 3);
        reset_fixture(&pool).await;
        pool.close(Duration::from_secs(2)).await.unwrap();
    }

    struct ExactPreflight;

    impl CaCandidatePreflight for ExactPreflight {
        fn preflight<'a>(
            &'a self,
            _: &'a ValidatedCaBundle,
            endpoint: &'a CaEndpointBinding,
        ) -> Pin<Box<dyn Future<Output = Result<CaPreflightProof, IntegrationError>> + Send + 'a>>
        {
            Box::pin(async move {
                Ok(CaPreflightProof {
                    endpoint_fingerprint: endpoint.fingerprint(),
                })
            })
        }
    }

    fn actor() -> IntegrationAdminActor {
        IntegrationAdminActor {
            user_id: "0199ee6c-c777-7000-8000-000000009001"
                .parse::<UserId>()
                .unwrap(),
            session_id: "0199ee6c-c777-7000-8000-000000009002"
                .parse::<SessionId>()
                .unwrap(),
        }
    }

    async fn seed_admin(pool: &DatabasePool) {
        sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000009001','git-admin@example.test','git-admin@example.test','Git Admin',TRUE)")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
        sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000009002','0199ee6c-c777-7000-8000-000000009001',decode(repeat('71',32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
        sqlx::query("INSERT INTO local_password_credentials(user_id,password_verifier) VALUES('0199ee6c-c777-7000-8000-000000009001','$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    }

    fn keyring() -> MasterKeyring {
        MasterKeyring::load(
            &TestEnvironment(vec![
                (
                    "NURITEO_MASTER_KEY".into(),
                    URL_SAFE_NO_PAD.encode([91; 32]).into(),
                ),
                ("NURITEO_MASTER_KEY_VERSION".into(), "1".into()),
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
        sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
            .execute(&mut *pool.acquire().await.unwrap())
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
}

mod providers;
pub(crate) use providers::*;
mod endpoint;
pub(crate) use endpoint::*;
