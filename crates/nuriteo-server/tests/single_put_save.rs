use std::env;
use std::ffi::OsString;
use std::fs;
use std::str::FromStr;
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use bytes::Bytes;
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::UserId;
use nuriteo_server::object_storage::{
    BoundedPresignedRequest, ObjectStorageConfig, OperationLimits, PresignedPutRequest,
    S3ObjectStore, Sha256Checksum,
};
use nuriteo_server::project::{ProjectId, ProjectVersion};
use nuriteo_server::quota::EffectiveQuota;
use nuriteo_server::save::{
    CreateSinglePutSession, IdempotencyKey, IdempotencySecret, PutPresigner, SinglePutService,
    SinglePutServiceError, SinglePutServicePolicy,
};
use nuriteo_server::workspace::StorageScopeId;
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";
const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";
const BUCKET: &str = "nuriteo-save-003";
const ACCESS_KEY: &str = "save003-access";
const SECRET_KEY: &str = "save003-secret-0123456789";
const USER: &str = "0199ee6c-c777-7000-8000-000000008001";
const SCOPE: &str = "0199ee6c-c777-7000-8000-000000008010";
const PROJECT_A: &str = "0199ee6c-c777-7000-8000-000000008020";
const PROJECT_B: &str = "0199ee6c-c777-7000-8000-000000008021";
const PROJECT_FAIL: &str = "0199ee6c-c777-7000-8000-000000008022";
const PROJECT_TIMEOUT: &str = "0199ee6c-c777-7000-8000-000000008023";
const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000008002";
const ORG_OWNER: &str = "0199ee6c-c777-7000-8000-000000008003";
const ORG_READ: &str = "0199ee6c-c777-7000-8000-000000008004";
const ORG_WRITE: &str = "0199ee6c-c777-7000-8000-000000008005";
const ORG_MEMBER: &str = "0199ee6c-c777-7000-8000-000000008006";
const ORG_SCOPE: &str = "0199ee6c-c777-7000-8000-000000008031";
const ORG_PROJECT_OWNER: &str = "0199ee6c-c777-7000-8000-000000008040";
const ORG_PROJECT_READ: &str = "0199ee6c-c777-7000-8000-000000008041";
const ORG_PROJECT_WRITE: &str = "0199ee6c-c777-7000-8000-000000008042";
const ORG_PROJECT_MEMBER: &str = "0199ee6c-c777-7000-8000-000000008043";
const ORG_PROJECT_OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000008044";

struct FixtureEnvironment {
    endpoint: String,
    ca_file: String,
}

impl Environment for FixtureEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        [
            ("NURITEO_S3_ENDPOINT", self.endpoint.as_str()),
            ("NURITEO_S3_REGION", "us-east-1"),
            ("NURITEO_S3_BUCKET", BUCKET),
            ("NURITEO_S3_ADDRESSING_STYLE", "path"),
            ("NURITEO_S3_CREDENTIAL_PROVIDER", "static"),
            ("NURITEO_S3_ACCESS_KEY_ID", ACCESS_KEY),
            ("NURITEO_S3_SECRET_ACCESS_KEY", SECRET_KEY),
            ("NURITEO_S3_CA_FILE", self.ca_file.as_str()),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect()
    }
}

#[tokio::test]
#[ignore = "requires tests/fixtures/single-put-save/run.sh"]
async fn single_put_is_atomic_idempotent_bounded_and_compensated() {
    let pool = fixture_pool().await;
    reset_and_seed(&pool).await;
    let endpoint = env::var(S3_ENDPOINT_ENV).unwrap();
    let ca_file = env::var(S3_CA_ENV).unwrap();
    create_bucket(&endpoint, &ca_file).await;
    let config = ObjectStorageConfig::load(
        &FixtureEnvironment {
            endpoint: endpoint.clone(),
            ca_file: ca_file.clone(),
        },
        &SystemFileReader,
    )
    .unwrap();
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap();
    let secret = IdempotencySecret::new([0x5a; 32]).unwrap();
    let service = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        secret.clone(),
    )
    .unwrap();
    let body = Bytes::from_static(b"bounded-single-put-body");
    let main_request = request(PROJECT_A, "single-put-retry-0001", &body);
    let created = service.create(main_request.clone()).await.unwrap();
    assert!(!created.is_idempotent_retry());
    verify_authorization(&service, &body).await;

    // A separately constructed service models a process restart with the same
    // stable secret. It must converge to the persisted active session.
    let restarted = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        secret,
    )
    .unwrap();
    let retried = restarted.create(main_request.clone()).await.unwrap();
    assert!(retried.is_idempotent_retry());
    assert_eq!(retried.session_id(), created.session_id());
    assert_eq!(
        reservation_count(&pool, created.session_id().to_string()).await,
        1
    );
    let failing_retry = SinglePutService::new(
        pool.clone(),
        FailingPresigner,
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        failing_retry
            .create(main_request.clone())
            .await
            .unwrap_err(),
        SinglePutServiceError::ObjectStorageUnavailable
    );
    let preserved_state: String =
        sqlx::query_scalar("SELECT state FROM save_sessions WHERE id=$1::uuid")
            .bind(created.session_id().to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(preserved_state, "created");
    assert_eq!(
        reservation_count(&pool, created.session_id().to_string()).await,
        1
    );
    sqlx::query(
        "UPDATE projects SET lock_version=lock_version+1,updated_at=CURRENT_TIMESTAMP \
         WHERE id=$1::uuid",
    )
    .bind(PROJECT_A)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let advanced_retry = restarted.create(main_request.clone()).await.unwrap();
    assert_eq!(advanced_retry.session_id(), created.session_id());

    let mut conflict = main_request.clone();
    conflict.expected_physical_bytes += 1;
    assert_eq!(
        restarted.create(conflict).await.unwrap_err(),
        SinglePutServiceError::IdempotencyConflict
    );
    let mut stale = request(PROJECT_B, "single-put-stale-0001", &body);
    stale.expected_project_version = ProjectVersion::new(2).unwrap();
    assert_eq!(
        restarted.create(stale).await.unwrap_err(),
        SinglePutServiceError::StaleProjectVersion
    );
    let expiring_request = request(PROJECT_B, "single-put-expiry-0001", &body);
    let expiring = restarted.create(expiring_request.clone()).await.unwrap();
    force_session_expiry(
        &pool,
        &expiring.session_id().to_string(),
        "created_at + interval '1 microsecond'",
    )
    .await;
    assert_eq!(
        restarted.create(expiring_request).await.unwrap_err(),
        SinglePutServiceError::SessionTerminal
    );
    let (expired_state, expired_reservations): (String, i64) = sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations r WHERE r.save_session_id=s.id) \
         FROM save_sessions s WHERE id=$1::uuid",
    )
    .bind(expiring.session_id().to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(expired_state, "expired");
    assert_eq!(expired_reservations, 0);
    let rotated = SinglePutService::new(
        pool.clone(),
        store.clone(),
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x6b; 32]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        rotated
            .create(request(PROJECT_B, "single-put-rotation-01", &body))
            .await
            .unwrap_err(),
        SinglePutServiceError::IdempotencyConfigurationMismatch
    );

    store
        .execute_presigned(created.capability().request(), Some(body.clone()))
        .await
        .unwrap();
    let signed_expiry_seconds = url::Url::parse(created.capability().request().expose_bearer_url())
        .unwrap()
        .query_pairs()
        .find_map(|(name, value)| (name == "X-Amz-Expires").then(|| value.parse::<i64>().unwrap()))
        .unwrap();
    assert!(signed_expiry_seconds >= 300);
    assert!(
        signed_expiry_seconds
            <= (created.expires_at() - time::OffsetDateTime::now_utc()).whole_seconds()
    );
    let tampered = Bytes::from(vec![b'x'; body.len()]);
    assert!(
        store
            .execute_presigned(created.capability().request(), Some(tampered))
            .await
            .is_err()
    );
    let client = fixture_http_client(&ca_file);
    assert!(
        !send_with_mutation(
            &client,
            created.capability().request(),
            &body[..body.len() - 1],
            None,
            None,
        )
        .await
    );
    assert!(
        !send_with_mutation(
            &client,
            created.capability().request(),
            &body,
            Some(("content-type", "application/octet-stream")),
            None,
        )
        .await
    );

    force_session_expiry(
        &pool,
        &created.session_id().to_string(),
        "CURRENT_TIMESTAMP + interval '4 minutes'",
    )
    .await;
    assert_eq!(
        restarted.create(main_request.clone()).await.unwrap_err(),
        SinglePutServiceError::SessionNearExpiry
    );
    assert_eq!(
        reservation_count(&pool, created.session_id().to_string()).await,
        1
    );
    assert!(
        !send_with_mutation(
            &client,
            created.capability().request(),
            &body,
            None,
            Some(("X-Amz-Expires=300", "X-Amz-Expires=1")),
        )
        .await
    );
    assert!(
        !send_with_mutation(
            &client,
            created.capability().request(),
            &body,
            None,
            Some((PROJECT_A, PROJECT_B)),
        )
        .await
    );

    let key: String =
        sqlx::query_scalar("SELECT staging_object_key FROM save_sessions WHERE id=$1::uuid")
            .bind(created.session_id().to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(
        key,
        format!(
            "staging/{SCOPE}/{PROJECT_A}/{}.bundle",
            created.session_id()
        )
    );
    assert!(!key.contains("single-put-retry-0001"));

    let failing = SinglePutService::new(
        pool.clone(),
        FailingPresigner,
        SinglePutServicePolicy::new(Duration::from_secs(5), 5).unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        failing
            .create(request(PROJECT_FAIL, "single-put-failure-001", &body))
            .await
            .unwrap_err(),
        SinglePutServiceError::ObjectStorageUnavailable
    );
    let (state, reservations): (String, i64) = sqlx::query_as(
        "SELECT state,(SELECT COUNT(*) FROM storage_reservations r \
         WHERE r.save_session_id=s.id) FROM save_sessions s WHERE project_id=$1::uuid",
    )
    .bind(PROJECT_FAIL)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(state, "failed");
    assert_eq!(reservations, 0);

    let hanging = SinglePutService::new(
        pool.clone(),
        HangingPresigner,
        SinglePutServicePolicy::new(Duration::from_millis(100), 5).unwrap(),
        IdempotencySecret::new([0x5a; 32]).unwrap(),
    )
    .unwrap();
    let timeout_request = request(PROJECT_TIMEOUT, "single-put-timeout-001", &body);
    assert_eq!(
        hanging.create(timeout_request.clone()).await.unwrap_err(),
        SinglePutServiceError::PresignTimeoutReconciliationRequired
    );
    assert!(matches!(
        restarted.reconcile(&timeout_request).await.unwrap(),
        nuriteo_server::save::ReconciliationState::Active(_)
    ));

    let rendered = format!(
        "{created:?} {:?}",
        restarted.reconcile(&main_request).await.unwrap()
    );
    for prohibited in [
        endpoint.as_str(),
        ca_file.as_str(),
        ACCESS_KEY,
        SECRET_KEY,
        "X-Amz-Signature",
        "single-put-retry-0001",
        key.as_str(),
    ] {
        assert!(!rendered.contains(prohibited));
    }
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[derive(Clone)]
struct FailingPresigner;

impl PutPresigner for FailingPresigner {
    type Error = ();

    async fn presign(
        &self,
        _request: PresignedPutRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        Err(())
    }
}

#[derive(Clone)]
struct HangingPresigner;

impl PutPresigner for HangingPresigner {
    type Error = ();

    async fn presign(
        &self,
        _request: PresignedPutRequest,
    ) -> Result<BoundedPresignedRequest, Self::Error> {
        std::future::pending().await
    }
}

fn request(project: &str, idempotency: &str, body: &[u8]) -> CreateSinglePutSession {
    request_for(SCOPE, project, USER, idempotency, body)
}

fn request_for(
    storage_scope: &str,
    project: &str,
    actor: &str,
    idempotency: &str,
    body: &[u8],
) -> CreateSinglePutSession {
    CreateSinglePutSession {
        storage_scope_id: StorageScopeId::from_str(storage_scope).unwrap(),
        project_id: ProjectId::from_str(project).unwrap(),
        actor_user_id: UserId::from_str(actor).unwrap(),
        expected_project_version: ProjectVersion::new(1).unwrap(),
        expected_physical_bytes: body.len() as u64,
        expected_sha256: Sha256Checksum::calculate(body),
        effective_quota: EffectiveQuota::limited(1_000_000).unwrap(),
        idempotency_key: IdempotencyKey::new(idempotency.to_owned()).unwrap(),
    }
}

async fn verify_authorization(service: &SinglePutService, body: &[u8]) {
    assert_eq!(
        service
            .create(request_for(
                SCOPE,
                PROJECT_B,
                OUTSIDER,
                "personal-outsider-01",
                body,
            ))
            .await
            .unwrap_err(),
        SinglePutServiceError::ProjectNotFound
    );
    service
        .create(request_for(
            ORG_SCOPE,
            ORG_PROJECT_OWNER,
            ORG_OWNER,
            "org-owner-save-0001",
            body,
        ))
        .await
        .unwrap();
    service
        .create(request_for(
            ORG_SCOPE,
            ORG_PROJECT_WRITE,
            ORG_WRITE,
            "org-write-save-0001",
            body,
        ))
        .await
        .unwrap();
    for (project, actor, key) in [
        (ORG_PROJECT_READ, ORG_READ, "org-read-denied-001"),
        (ORG_PROJECT_MEMBER, ORG_MEMBER, "org-member-denied1"),
        (ORG_PROJECT_OUTSIDER, OUTSIDER, "org-outsider-deny1"),
    ] {
        assert_eq!(
            service
                .create(request_for(ORG_SCOPE, project, actor, key, body))
                .await
                .unwrap_err(),
            SinglePutServiceError::ProjectNotFound
        );
    }
}

async fn send_with_mutation(
    client: &reqwest::Client,
    capability: &BoundedPresignedRequest,
    body: &[u8],
    header_override: Option<(&str, &str)>,
    url_replacement: Option<(&str, &str)>,
) -> bool {
    let url = if let Some((from, to)) = url_replacement {
        let changed = capability.expose_bearer_url().replace(from, to);
        assert_ne!(changed, capability.expose_bearer_url());
        changed
    } else {
        capability.expose_bearer_url().to_owned()
    };
    let mut request = client.put(url);
    for (name, value) in capability.signed_headers() {
        if header_override.is_none_or(|(override_name, _)| override_name != name) {
            request = request.header(name, value);
        }
    }
    if let Some((name, value)) = header_override {
        request = request.header(name, value);
    }
    request
        .body(body.to_vec())
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn fixture_http_client(ca_file: &str) -> reqwest::Client {
    let certificate = reqwest::Certificate::from_pem(&fs::read(ca_file).unwrap()).unwrap();
    reqwest::Client::builder()
        .add_root_certificate(certificate)
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}

async fn reset_and_seed(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    connection.execute("INSERT INTO users (id,email,normalized_email,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008001','save@example.test','save@example.test','Save Owner'),\
        ('0199ee6c-c777-7000-8000-000000008002','outside@example.test','outside@example.test','Outside'),\
        ('0199ee6c-c777-7000-8000-000000008003','org-owner@example.test','org-owner@example.test','Org Owner'),\
        ('0199ee6c-c777-7000-8000-000000008004','org-read@example.test','org-read@example.test','Org Read'),\
        ('0199ee6c-c777-7000-8000-000000008005','org-write@example.test','org-write@example.test','Org Write'),\
        ('0199ee6c-c777-7000-8000-000000008006','org-member@example.test','org-member@example.test','Org Member')").await.unwrap();
    connection
        .execute(
            "INSERT INTO organizations (id,slug,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008030','save-org','Save Org')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO organization_memberships (organization_id,user_id,role) VALUES \
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008003','owner'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008004','member'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','member'),\
        ('0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008006','member')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_scopes (id,owner_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000008010','0199ee6c-c777-7000-8000-000000008001')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_scopes (id,owner_organization_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000008031','0199ee6c-c777-7000-8000-000000008030')",
        )
        .await
        .unwrap();
    connection.execute("INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008020','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-a','Save A'),\
        ('0199ee6c-c777-7000-8000-000000008021','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-b','Save B'),\
        ('0199ee6c-c777-7000-8000-000000008022','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-fail','Save Fail'),\
        ('0199ee6c-c777-7000-8000-000000008023','0199ee6c-c777-7000-8000-000000008001','0199ee6c-c777-7000-8000-000000008010','save-timeout','Save Timeout')").await.unwrap();
    connection.execute("INSERT INTO projects (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000008040','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-owner-save','Owner Save'),\
        ('0199ee6c-c777-7000-8000-000000008041','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-read-save','Read Save'),\
        ('0199ee6c-c777-7000-8000-000000008042','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-write-save','Write Save'),\
        ('0199ee6c-c777-7000-8000-000000008043','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-member-save','Member Save'),\
        ('0199ee6c-c777-7000-8000-000000008044','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008031','org-outsider-save','Outsider Save')").await.unwrap();
    connection.execute("INSERT INTO project_user_roles (project_id,organization_id,user_id,role) VALUES \
        ('0199ee6c-c777-7000-8000-000000008041','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008004','read'),\
        ('0199ee6c-c777-7000-8000-000000008042','0199ee6c-c777-7000-8000-000000008030','0199ee6c-c777-7000-8000-000000008005','write')").await.unwrap();
}

async fn reservation_count(pool: &DatabasePool, session: String) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=$1::uuid")
        .bind(session)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn force_session_expiry(pool: &DatabasePool, session: &str, expression: &'static str) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("ALTER TABLE save_sessions DISABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE save_sessions SET expires_at={expression} WHERE id=$1::uuid"
    )))
    .bind(session)
    .execute(&mut *connection)
    .await
    .unwrap();
    connection
        .execute("ALTER TABLE save_sessions ENABLE TRIGGER save_sessions_update_invariants")
        .await
        .unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            url,
            0,
            12,
            Duration::from_secs(5),
            Duration::from_secs(2),
            DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap(),
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

async fn create_bucket(endpoint: &str, ca_file: &str) {
    let context = TlsContext::builder()
        .with_trust_store(TrustStore::default().with_pem_certificate(fs::read(ca_file).unwrap()))
        .build()
        .unwrap();
    let pool = ConnectionPool::builder()
        .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
        .tls_context(context)
        .build_https()
        .unwrap();
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(endpoint)
            .region(Region::new("us-east-1"))
            .force_path_style(true)
            .credentials_provider(Credentials::new(
                ACCESS_KEY,
                SECRET_KEY,
                None,
                None,
                "save003-fixture",
            ))
            .http_client(PoolClient::new(&pool).unwrap())
            .build(),
    );
    if let Err(error) = client.create_bucket().bucket(BUCKET).send().await {
        let exists = error
            .as_service_error()
            .and_then(aws_sdk_s3::error::ProvideErrorMetadata::code)
            .is_some_and(|code| matches!(code, "BucketAlreadyExists" | "BucketAlreadyOwnedByYou"));
        assert!(exists);
    }
}
