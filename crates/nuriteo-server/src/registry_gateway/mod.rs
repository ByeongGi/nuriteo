//! Multi-registry npm gateway with exact scope routing and no fallback.

use std::fmt;

use std::net::{IpAddr, SocketAddr};

use std::str::FromStr;

use std::time::Duration;

use ::time::OffsetDateTime;

use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};

use reqwest::{Certificate, Client, StatusCode};

use sha2::{Digest, Sha256};

use sqlx::{Acquire, Postgres, Row, Transaction};

use tokio::net::lookup_host;

use tokio::time;

use url::Url;

use uuid::Uuid;

use crate::integration::{
    CaEndpointBinding, CredentialIdentity, IntegrationAdminActor, IntegrationError,
    IntegrationRepository, SecretValue, ValidatedCaBundle, authorize_recent_admin,
};

mod http_routes;

mod http_service;

pub(crate) use http_routes::openapi_router;

pub use http_service::RegistryHttpService;

pub(crate) use http_service::{RegistryAdminView, RegistryCollectionView};

const INTEGRATION_TYPE: &str = "registry";

const CREDENTIAL_KIND: &str = "auth_token";

const INSTANCE_ID: &str = "instance";

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

const DNS_TIMEOUT: Duration = Duration::from_secs(3);

const MAX_DNS_ADDRESSES: usize = 16;

const PREFLIGHT_LIMIT: usize = 64 * 1024;

const METADATA_LIMIT: usize = 2 * 1024 * 1024;

const PACKAGE_SEGMENT: &AsciiSet = &CONTROLS.add(b'/').add(b'?').add(b'#').add(b'%').add(b' ');

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryState {
    Active,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryConnectionInput {
    display_name: String,
    base_url: String,
    canonical_host: String,
    canonical_port: u16,
    base_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryConnectionMetadata {
    pub id: Uuid,
    pub display_name: String,
    pub base_url: String,
    pub canonical_host: String,
    pub canonical_port: u16,
    pub base_path: String,
    pub state: RegistryState,
    pub is_default: bool,
    pub config_version: u64,
    pub credential_version: u64,
    pub validated_at: Option<OffsetDateTime>,
}

pub struct RegistryPayload {
    pub connection_id: Uuid,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Clone)]
pub struct RegistryGatewayService {
    integrations: IntegrationRepository,
    timeout: Duration,
    allow_test_addresses: bool,
}

pub(crate) struct RegistryRuntime {
    metadata: RegistryConnectionMetadata,
    token: SecretValue,
    ca: Option<ValidatedCaBundle>,
    ca_fingerprint: [u8; 32],
    binding: CaEndpointBinding,
}

pub(crate) struct BoundedResponse {
    content_type: Option<String>,
    body: Vec<u8>,
}

const fn map_integration_error(error: IntegrationError) -> RegistryError {
    match error {
        IntegrationError::InvalidInput => RegistryError::InvalidInput,
        IntegrationError::ReauthenticationRequired => RegistryError::ReauthenticationRequired,
        IntegrationError::Conflict => RegistryError::Conflict,
        IntegrationError::CredentialUnavailable | IntegrationError::KeyConfiguration => {
            RegistryError::CredentialUnavailable
        }
        IntegrationError::InvalidCaBundle | IntegrationError::PreflightFailed => {
            RegistryError::ValidationFailed
        }
        IntegrationError::Unavailable => RegistryError::Unavailable,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryError {
    AuthenticationFailed,
    Forbidden,
    InvalidInput,
    InvalidPackage,
    ReauthenticationRequired,
    NotFound,
    Disabled,
    MustDisable,
    Conflict,
    CredentialUnavailable,
    RouteUnavailable,
    NetworkDenied,
    ValidationFailed,
    UpstreamNotFound { connection_id: Uuid },
    UpstreamAuthentication { connection_id: Uuid },
    UpstreamUnavailable { connection_id: Uuid },
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
    #[test]
    fn package_and_scope_are_canonical() {
        for ok in ["react", "@company/widget", "a-b"] {
            assert!(validate_package(ok).is_ok(), "{ok}")
        }
        for bad in [
            "React",
            "@Company/widget",
            "@scope/",
            "../react",
            "@scope/a/b",
            "",
        ] {
            assert!(validate_package(bad).is_err(), "{bad}")
        }
    }
    #[test]
    fn endpoint_and_path_are_credential_free() {
        assert!(RegistryConnectionInput::new("npm", "https://registry.example.test/npm/").is_ok());
        for bad in [
            "http://registry.example.test/",
            "https://token@registry.example.test/",
            "https://registry.example.test/npm?token=x",
            "https://registry.example.test/a/../b",
        ] {
            assert!(RegistryConnectionInput::new("bad", bad).is_err(), "{bad}")
        }
    }
    #[test]
    fn metadata_path_encodes_scoped_separator() {
        let input =
            RegistryConnectionInput::new("npm", "https://registry.example.test/npm").unwrap();
        let metadata = RegistryConnectionMetadata {
            id: Uuid::now_v7(),
            display_name: input.display_name,
            base_url: input.base_url,
            canonical_host: input.canonical_host,
            canonical_port: 443,
            base_path: input.base_path,
            state: RegistryState::Active,
            is_default: true,
            config_version: 3,
            credential_version: 1,
            validated_at: None,
        };
        assert_eq!(
            metadata_url(&metadata, "@company/widget").unwrap().as_str(),
            "https://registry.example.test/npm/@company%2Fwidget"
        )
    }
    #[test]
    fn private_networks_are_denied() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "168.63.129.16",
            "::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}")
        }
    }
    #[test]
    fn debug_never_renders_payload_or_token() {
        let payload = RegistryPayload {
            connection_id: Uuid::now_v7(),
            content_type: Some("application/json".into()),
            body: b"secret-body".to_vec(),
        };
        assert!(!format!("{payload:?}").contains("secret-body"));
        let _ = RegistryGatewayService::new as fn(IntegrationRepository) -> RegistryGatewayService;
    }

    #[tokio::test]
    #[ignore = "requires tests/fixtures/postgres-registry-gateway/run.sh"]
    async fn actual_gateway_is_tls_pinned_scope_exact_and_never_falls_back() {
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
        let port = env::var("NURITEO_TEST_REGISTRY_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let control = env::var("NURITEO_TEST_REGISTRY_CONTROL_DIR").unwrap();
        let repository = IntegrationRepository::new(pool.clone(), keyring());
        let production = RegistryGatewayService::new(repository.clone());
        let gateway = production.clone().allowing_test_addresses();
        let default = gateway
            .create(
                actor(),
                &RegistryConnectionInput::new(
                    "Default",
                    format!("https://localhost:{port}/default"),
                )
                .unwrap(),
                &SecretValue::new(b"default-token".to_vec()).unwrap(),
                "request:registry-default-create",
            )
            .await
            .unwrap();
        let scoped = gateway
            .create(
                actor(),
                &RegistryConnectionInput::new(
                    "Company",
                    format!("https://localhost:{port}/private"),
                )
                .unwrap(),
                &SecretValue::new(b"scope-token".to_vec()).unwrap(),
                "request:registry-scope-create",
            )
            .await
            .unwrap();
        assert_eq!(
            production
                .validate_and_activate(
                    actor(),
                    default.id,
                    default.config_version,
                    "request:registry-ssrf",
                )
                .await
                .unwrap_err(),
            RegistryError::NetworkDenied
        );
        assert_eq!(
            gateway
                .validate_and_activate(
                    actor(),
                    default.id,
                    default.config_version,
                    "request:registry-wrong-ca",
                )
                .await
                .unwrap_err(),
            RegistryError::UpstreamUnavailable {
                connection_id: default.id
            }
        );
        let ca = ValidatedCaBundle::parse(
            fs::read(env::var("NURITEO_TEST_REGISTRY_CA").unwrap()).unwrap(),
        )
        .unwrap();
        let admin = IntegrationAdminService::new(repository);
        for connection in [&default, &scoped] {
            let binding = endpoint_binding(connection).unwrap();
            let staged = admin
                .stage_ca_candidate(actor(), &binding, ca.clone(), "request:registry-ca-stage")
                .await
                .unwrap();
            admin
                .activate_ca_candidate(
                    actor(),
                    staged.id,
                    &binding,
                    "request:registry-ca-activate",
                    &ExactPreflight,
                )
                .await
                .unwrap();
        }
        fs::write(Path::new(&control).join("mode"), "redirect").unwrap();
        assert_eq!(
            gateway
                .validate_and_activate(
                    actor(),
                    default.id,
                    default.config_version,
                    "request:registry-redirect",
                )
                .await
                .unwrap_err(),
            RegistryError::NetworkDenied
        );
        fs::write(Path::new(&control).join("mode"), "normal").unwrap();
        let default = gateway
            .validate_and_activate(
                actor(),
                default.id,
                default.config_version,
                "request:registry-default-activate",
            )
            .await
            .unwrap();
        let scoped = gateway
            .validate_and_activate(
                actor(),
                scoped.id,
                scoped.config_version,
                "request:registry-scope-activate",
            )
            .await
            .unwrap();
        let default = gateway
            .set_default(
                actor(),
                default.id,
                default.config_version,
                "request:registry-set-default",
            )
            .await
            .unwrap();
        assert!(default.is_default);
        gateway
            .map_scope(actor(), "@company", scoped.id, "request:registry-map-scope")
            .await
            .unwrap();

        let public = gateway.fetch_metadata("react").await.unwrap();
        assert_eq!(public.connection_id, default.id);
        assert!(
            String::from_utf8(public.body)
                .unwrap()
                .contains("sha512-fixture")
        );
        let private = gateway.fetch_metadata("@company/widget").await.unwrap();
        assert_eq!(private.connection_id, scoped.id);

        fs::write(Path::new(&control).join("mode"), "scoped-404").unwrap();
        let before = fs::read_to_string(Path::new(&control).join("requests")).unwrap();
        assert_eq!(
            gateway
                .fetch_metadata("@company/missing")
                .await
                .unwrap_err(),
            RegistryError::UpstreamNotFound {
                connection_id: scoped.id
            }
        );
        let after = fs::read_to_string(Path::new(&control).join("requests")).unwrap();
        let delta = &after[before.len()..];
        assert!(delta.contains("/private/"));
        assert!(
            !delta.contains("/default/"),
            "mapped 404 must not fall back"
        );
        assert!(after.lines().all(|line| !line.contains("token")));

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
            user_id: "0199ee6c-c777-7000-8000-000000010001"
                .parse::<UserId>()
                .unwrap(),
            session_id: "0199ee6c-c777-7000-8000-000000010002"
                .parse::<SessionId>()
                .unwrap(),
        }
    }
    async fn seed_admin(pool: &DatabasePool) {
        sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES('0199ee6c-c777-7000-8000-000000010001','registry-admin@example.test','registry-admin@example.test','Registry Admin',TRUE)")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
        sqlx::query("INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES('0199ee6c-c777-7000-8000-000000010002','0199ee6c-c777-7000-8000-000000010001',decode(repeat('81',32),'hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
            .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    }
    fn keyring() -> MasterKeyring {
        MasterKeyring::load(
            &TestEnvironment(vec![
                (
                    "NURITEO_MASTER_KEY".into(),
                    URL_SAFE_NO_PAD.encode([101; 32]).into(),
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

mod connections;
pub(crate) use connections::*;
mod endpoint;
pub(crate) use endpoint::*;
