use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use git2::{Oid, Repository, Signature};
use sqlx::Row;
use uuid::Uuid;

use super::super::*;
use crate::config::{Environment, FileReader, SystemFileReader};
use crate::database::{
    DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use crate::integration::{
    CaCandidatePreflight, CaEndpointBinding, CaPreflightProof, IntegrationAdminActor,
    IntegrationAdminService, IntegrationError, ValidatedCaBundle,
};
use crate::object_storage::{ObjectStorageConfig, OperationLimits};

const BUCKET: &str = "nuriteo-git-002";
const ACCESS_KEY: &str = "integration-access";
const SECRET_KEY: &str = "integration-secret-0123456789";

#[tokio::test]
#[ignore = "requires tests/fixtures/git-https/run.sh"]
async fn production_service_actual_https_journey() {
    let pool = fixture_pool().await;
    reset_schema(&pool).await;
    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();

    let endpoint = required("NURITEO_TEST_S3_ENDPOINT");
    let s3_ca = required("NURITEO_TEST_S3_CA_FILE");
    create_bucket(&endpoint, &fs::read(&s3_ca).unwrap()).await;
    let store = object_store(&endpoint, &s3_ca).await;
    let git_url = required("NURITEO_TEST_GIT_URL");
    let redirect_url = required("NURITEO_TEST_GIT_REDIRECT_URL");
    let git_ca_path = required("NURITEO_TEST_GIT_CA");
    let git_ca = fs::read(&git_ca_path).unwrap();
    let repository_path = required("NURITEO_TEST_GIT_REPOSITORY");
    let parsed = url::Url::parse(&git_url).unwrap();
    let port = parsed.port().unwrap();

    let user_id = UserId::new();
    let session_id = SessionId::new();
    let scope_id = StorageScopeId::new();
    let project_id = ProjectId::new();
    let redirect_project_id = ProjectId::new();
    seed_principal_and_projects(
        &pool,
        user_id,
        session_id,
        scope_id,
        &[project_id, redirect_project_id],
    )
    .await;

    let keyring = fixture_keyring();
    let integrations = IntegrationRepository::new(pool.clone(), keyring);
    let provider_id = seed_provider(&pool, port).await;
    activate_ca(
        &integrations,
        user_id,
        session_id,
        provider_id,
        port,
        git_ca,
    )
    .await;
    let guard = transport_security::GitHttpsTransportGuard::new(integrations.clone())
        .allowing_test_addresses();
    let executor = Arc::new(embedded::EmbeddedGitRemoteExecutor::new(guard));
    let heads = Arc::new(working_head::S3GitWorkingHeadStore::new(
        pool.clone(),
        store,
        EffectiveQuota::unlimited(),
    ));
    let service = GitOperationService::new(integrations, executor).with_working_head_store(heads);
    service
        .connect(
            user_id,
            session_id,
            provider_id,
            &SecretValue::new(required("NURITEO_TEST_GIT_TOKEN").into_bytes()).unwrap(),
            "git002-connect",
        )
        .await
        .unwrap();

    let (binding, imported) = service
        .import(user_id, project_id, &git_url, "main", "git002-import")
        .await
        .unwrap();
    assert_eq!(binding.remote_head_sha, imported.head_sha());
    assert_head_is_verified_and_admitted(&pool, project_id).await;

    let pulled_oid = append_remote_commit(Path::new(&repository_path), b"pulled\n", "fixture pull");
    let (binding, pulled) = service
        .pull(user_id, project_id, imported.head_sha(), "git002-pull")
        .await
        .unwrap();
    assert_eq!(pulled.head_sha(), pulled_oid.to_string());
    assert_eq!(binding.remote_head_sha, pulled.head_sha());
    assert_eq!(recovery_count(&pool, project_id).await, 1);

    let (binding, pushed) = service
        .commit_and_push(
            user_id,
            project_id,
            pulled.head_sha(),
            "embedded push",
            "git002-push",
        )
        .await
        .unwrap();
    assert_eq!(binding.remote_head_sha, pushed.head_sha());
    assert_eq!(
        remote_head(Path::new(&repository_path)).to_string(),
        pushed.head_sha()
    );

    let competing = append_remote_commit(
        Path::new(&repository_path),
        b"competing\n",
        "competing remote commit",
    );
    let non_fast_forward = service
        .commit_and_push(
            user_id,
            project_id,
            pushed.head_sha(),
            "must not overwrite",
            "git002-nff",
        )
        .await
        .unwrap_err();
    assert_eq!(non_fast_forward, GitOperationError::NonFastForward);
    assert_eq!(remote_head(Path::new(&repository_path)), competing);

    let (_, reconciled) = service
        .pull(user_id, project_id, pushed.head_sha(), "git002-reconcile")
        .await
        .unwrap();
    install_remote_finalize_failure(&pool).await;
    let unknown = service
        .commit_and_push(
            user_id,
            project_id,
            reconciled.head_sha(),
            "remote succeeds local finalize fails",
            "git002-unknown",
        )
        .await
        .unwrap_err();
    assert_eq!(unknown, GitOperationError::CommitOutcomeUnknown);
    assert_ne!(
        remote_head(Path::new(&repository_path)).to_string(),
        reconciled.head_sha()
    );
    remove_remote_finalize_failure(&pool).await;

    let redirect_error = service
        .import(
            user_id,
            redirect_project_id,
            &redirect_url,
            "main",
            "git002-redirect",
        )
        .await
        .unwrap_err();
    assert!(matches!(
        redirect_error,
        GitOperationError::Unavailable | GitOperationError::InvalidInput
    ));
    let ca = reqwest::Certificate::from_pem(&fs::read(git_ca_path).unwrap()).unwrap();
    let forwarded = reqwest::Client::builder()
        .add_root_certificate(ca)
        .no_proxy()
        .build()
        .unwrap()
        .get(format!(
            "{}/__redirect-auth-count",
            required("NURITEO_TEST_GIT_CONTROL_URL")
        ))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(forwarded, "0");
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn seed_principal_and_projects(
    pool: &DatabasePool,
    user: UserId,
    session: SessionId,
    scope: StorageScopeId,
    projects: &[ProjectId],
) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES($1::uuid,'git-owner@example.test','git-owner@example.test','Git Owner',TRUE)")
        .bind(user.to_string()).execute(&mut *connection).await.unwrap();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,idle_expires_at,absolute_expires_at,last_reauthenticated_at) VALUES($1::uuid,$2::uuid,decode(repeat('42',32),'hex'),CURRENT_TIMESTAMP+INTERVAL '1 hour',CURRENT_TIMESTAMP+INTERVAL '2 hour',CURRENT_TIMESTAMP)")
        .bind(session.to_string()).bind(user.to_string()).execute(&mut *connection).await.unwrap();
    sqlx::query("INSERT INTO instance_settings(key,registry_version,value,bootstrap_origin) VALUES('security.reauthentication_window_minutes',1,'15'::jsonb,'default')")
        .execute(&mut *connection).await.unwrap();
    sqlx::query("INSERT INTO storage_scopes(id,owner_user_id) VALUES($1::uuid,$2::uuid)")
        .bind(scope.to_string())
        .bind(user.to_string())
        .execute(&mut *connection)
        .await
        .unwrap();
    for (index, project) in projects.iter().enumerate() {
        sqlx::query("INSERT INTO projects(id,owner_user_id,storage_scope_id,slug,name) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)")
            .bind(project.to_string()).bind(user.to_string()).bind(scope.to_string())
            .bind(format!("git-fixture-{index}")).bind(format!("Git Fixture {index}"))
            .execute(&mut *connection).await.unwrap();
    }
}

async fn seed_provider(pool: &DatabasePool, port: u16) -> Uuid {
    let id = Uuid::now_v7();
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("INSERT INTO git_providers(id,display_name,provider_kind,canonical_host,canonical_port,api_base_url,allows_read,allows_write) VALUES($1::uuid,'Fixture Git','generic','localhost',$2,$3,TRUE,TRUE)")
        .bind(id.to_string()).bind(i32::from(port)).bind(format!("https://localhost:{port}/api"))
        .execute(&mut *connection).await.unwrap();
    sqlx::query("UPDATE git_providers SET status='active',config_version=2,validation_config_version=1,validation_endpoint_fingerprint=decode(repeat('11',32),'hex'),validation_ca_fingerprint=decode(repeat('22',32),'hex'),validated_at=CURRENT_TIMESTAMP,disabled_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid")
        .bind(id.to_string()).execute(&mut *connection).await.unwrap();
    id
}

async fn activate_ca(
    integrations: &IntegrationRepository,
    user: UserId,
    session: SessionId,
    provider: Uuid,
    port: u16,
    pem: Vec<u8>,
) {
    let admin = IntegrationAdminService::new(integrations.clone());
    let actor = IntegrationAdminActor {
        user_id: user,
        session_id: session,
    };
    let endpoint =
        CaEndpointBinding::new("git", provider.to_string(), "localhost", port, "https").unwrap();
    let candidate = admin
        .stage_ca_candidate(
            actor,
            &endpoint,
            ValidatedCaBundle::parse(pem).unwrap(),
            "git002-ca-stage",
        )
        .await
        .unwrap();
    admin
        .activate_ca_candidate(
            actor,
            candidate.id,
            &endpoint,
            "git002-ca-activate",
            &ExactPreflight,
        )
        .await
        .unwrap();
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

fn append_remote_commit(path: &Path, contents: &[u8], message: &str) -> Oid {
    let repository = Repository::open_bare(path).unwrap();
    let parent = repository.find_commit(remote_head(path)).unwrap();
    let blob = repository.blob(contents).unwrap();
    let mut builder = repository.treebuilder(None).unwrap();
    builder.insert("README.md", blob, 0o100644).unwrap();
    let tree_id = builder.write().unwrap();
    let tree = repository.find_tree(tree_id).unwrap();
    let signature = Signature::now("Fixture User", "fixture@example.test").unwrap();
    repository
        .commit(
            Some("refs/heads/main"),
            &signature,
            &signature,
            message,
            &tree,
            &[&parent],
        )
        .unwrap()
}

fn remote_head(path: &Path) -> Oid {
    Repository::open_bare(path)
        .unwrap()
        .refname_to_id("refs/heads/main")
        .unwrap()
}

async fn assert_head_is_verified_and_admitted(pool: &DatabasePool, project: ProjectId) {
    let row = sqlx::query("SELECT bundle.verification_state,COUNT(admission.bundle_id) AS admissions FROM projects project JOIN bundles bundle ON bundle.id=project.working_head_bundle_id LEFT JOIN project_bundle_admissions admission ON admission.project_id=project.id AND admission.bundle_id=bundle.id WHERE project.id=$1::uuid GROUP BY bundle.verification_state")
        .bind(project.to_string()).fetch_one(&mut *pool.acquire().await.unwrap()).await.unwrap();
    assert_eq!(row.get::<String, _>("verification_state"), "verified");
    assert_eq!(row.get::<i64, _>("admissions"), 1);
}

async fn recovery_count(pool: &DatabasePool, project: ProjectId) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM project_bundle_refs WHERE project_id=$1::uuid AND kind='recovery'",
    )
    .bind(project.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn install_remote_finalize_failure(pool: &DatabasePool) {
    sqlx::raw_sql("CREATE FUNCTION git002_fail_finalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture finalize failure'; END; $$; CREATE TRIGGER git002_fail_finalize BEFORE UPDATE ON project_git_remotes FOR EACH ROW EXECUTE FUNCTION git002_fail_finalize();")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
}

async fn remove_remote_finalize_failure(pool: &DatabasePool) {
    sqlx::raw_sql("DROP TRIGGER git002_fail_finalize ON project_git_remotes; DROP FUNCTION git002_fail_finalize();")
        .execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(
        None,
        Some(fs::read(required("NURITEO_TEST_DATABASE_CA")).unwrap()),
        None,
    )
    .unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            required("NURITEO_TEST_DATABASE_URL"),
            1,
            6,
            Duration::from_secs(5),
            Duration::from_secs(5),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn reset_schema(pool: &DatabasePool) {
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

struct StorageEnvironment(Vec<(OsString, OsString)>);
impl Environment for StorageEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

async fn object_store(endpoint: &str, ca: &str) -> S3ObjectStore {
    let values = [
        ("NURITEO_S3_ENDPOINT", endpoint),
        ("NURITEO_S3_REGION", "us-east-1"),
        ("NURITEO_S3_BUCKET", BUCKET),
        ("NURITEO_S3_ADDRESSING_STYLE", "path"),
        ("NURITEO_S3_CREDENTIAL_PROVIDER", "static"),
        ("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY),
        ("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY),
        ("NURITEO_S3_CA_FILE", ca),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value.into()))
    .collect();
    let config = ObjectStorageConfig::load(&StorageEnvironment(values), &SystemFileReader).unwrap();
    S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap()
}

fn fixture_s3_client(endpoint: &str, ca: &[u8]) -> aws_sdk_s3::Client {
    let mut trust = TrustStore::default();
    trust.add_pem_certificate(ca.to_vec());
    let context = TlsContext::builder()
        .with_trust_store(trust)
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .max_connections_per_host(4)
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
    let http = PoolClient::new(&pool).unwrap();
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(endpoint)
        .region(Region::new("us-east-1"))
        .force_path_style(true)
        .credentials_provider(Credentials::new(
            ACCESS_KEY, SECRET_KEY, None, None, "git002",
        ))
        .http_client(http)
        .build();
    aws_sdk_s3::Client::from_conf(config)
}

async fn create_bucket(endpoint: &str, ca: &[u8]) {
    fixture_s3_client(endpoint, ca)
        .create_bucket()
        .bucket(BUCKET)
        .send()
        .await
        .unwrap();
}

fn fixture_keyring() -> MasterKeyring {
    MasterKeyring::load(
        &StorageEnvironment(vec![
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
struct NoFiles;
impl FileReader for NoFiles {
    fn read(&self, _: &Path, _: usize) -> std::io::Result<Vec<u8>> {
        Err(std::io::ErrorKind::NotFound.into())
    }
}
fn required(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} missing; run git-https/run.sh"))
}
