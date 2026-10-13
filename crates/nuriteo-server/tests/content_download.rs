use std::env;
use std::ffi::OsString;
use std::fs;
use std::str::FromStr;
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_http_client::pool::{Client as PoolClient, ConnectionPool};
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{self, TlsContext, TrustStore};
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{
    CONTENT_LENGTH, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, ORIGIN, RANGE, SET_COOKIE,
};
use axum::http::{Method, Request, StatusCode};
use bytes::Bytes;
use nuriteo_server::app::build_router_with_project_service;
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::config::{Environment, SystemFileReader};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::{SessionPolicy, UserId};
use nuriteo_server::invitations::InvitationHttpService;
use nuriteo_server::object_storage::{
    ObjectKey, ObjectStorageConfig, OperationLimits, PutRequest, S3ObjectStore,
};
use nuriteo_server::organization::{OrganizationHttpService, OrganizationId};
use nuriteo_server::project::{ProjectHttpPolicy, ProjectHttpService, ProjectId, ProjectOwner};
use nuriteo_server::save::{ContentError, ContentService, ContentServicePolicy};
use nuriteo_server::setup::SetupStatusService;
use sha2::{Digest, Sha256};
use sqlx::Executor;
use tokio::io::AsyncReadExt as _;
use tower::ServiceExt as _;
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const S3_ENDPOINT_ENV: &str = "NURITEO_TEST_S3_ENDPOINT";
const S3_CA_ENV: &str = "NURITEO_TEST_S3_CA_FILE";
const BUCKET: &str = "nuriteo-save-003";
const ACCESS_KEY: &str = "save003-access";
const SECRET_KEY: &str = "save003-secret-0123456789";
const ORIGIN_VALUE: &str = "http://localhost:3000";
const PASSWORD: &str = "correct horse battery staple";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";

const OWNER: &str = "0199ee6c-c777-7000-8000-000000009001";
const ORG_OWNER: &str = "0199ee6c-c777-7000-8000-000000009002";
const DIRECT_READ: &str = "0199ee6c-c777-7000-8000-000000009003";
const ORG_MEMBER: &str = "0199ee6c-c777-7000-8000-000000009004";
const ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000009010";
const PERSONAL_SCOPE: &str = "0199ee6c-c777-7000-8000-000000009020";
const ORG_SCOPE: &str = "0199ee6c-c777-7000-8000-000000009021";
const PERSONAL_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009030";
const ORG_PROJECT: &str = "0199ee6c-c777-7000-8000-000000009031";
const PERSONAL_BUNDLE_A: &str = "0199ee6c-c777-7000-8000-000000009040";
const PERSONAL_BUNDLE_B: &str = "0199ee6c-c777-7000-8000-000000009041";
const ORG_BUNDLE: &str = "0199ee6c-c777-7000-8000-000000009042";
const PERSONAL_KEY_A: &str = "bundles/save010/personal-a.tar";
const PERSONAL_KEY_B: &str = "bundles/save010/personal-b.tar";
const ORG_KEY: &str = "bundles/save010/org.tar";
const PERSONAL_BODY_A: &[u8] = b"verified-personal-bundle-a";
const PERSONAL_BODY_B: &[u8] = b"verified-personal-bundle-b";
const ORG_BODY: &[u8] = b"verified-organization-bundle";

#[tokio::test]
#[ignore = "requires tests/fixtures/content-download/run.sh"]
async fn content_download_is_authorized_fenced_bounded_and_redacted() {
    let pool = fixture_pool().await;
    reset_schema(&pool).await;
    let endpoint = env::var(S3_ENDPOINT_ENV).unwrap();
    let ca_file = env::var(S3_CA_ENV).unwrap();
    create_bucket(&endpoint, &ca_file).await;
    let config = ObjectStorageConfig::load(
        &FixtureEnvironment {
            endpoint,
            ca_file: ca_file.clone(),
        },
        &SystemFileReader,
    )
    .unwrap();
    let store = S3ObjectStore::new(&config, OperationLimits::default())
        .await
        .unwrap();
    put(&store, PERSONAL_KEY_A, PERSONAL_BODY_A).await;
    put(&store, PERSONAL_KEY_B, PERSONAL_BODY_B).await;
    put(&store, ORG_KEY, ORG_BODY).await;
    seed(&pool).await;

    let service = ContentService::new(
        pool.clone(),
        store.clone(),
        ContentServicePolicy::new(Duration::from_secs(5)).unwrap(),
    );
    let owner = user(OWNER);
    let personal_owner = ProjectOwner::User(owner);
    let personal_project = project(PERSONAL_PROJECT);
    let descriptor = service
        .describe(owner, personal_owner, personal_project)
        .await
        .unwrap();
    assert_eq!(descriptor.bundle_id(), PERSONAL_BUNDLE_A);
    assert_eq!(descriptor.project_version(), 2);
    assert_eq!(descriptor.physical_bytes(), PERSONAL_BODY_A.len() as u64);
    assert_eq!(descriptor.logical_bytes(), 77);
    assert_eq!(descriptor.file_count(), 3);
    assert_eq!(descriptor.checksum(), digest(PERSONAL_BODY_A));
    assert!(!descriptor.download_url().contains(PERSONAL_KEY_A));

    let download = service
        .download(
            owner,
            personal_owner,
            personal_project,
            descriptor.bundle_id(),
            descriptor.etag(),
        )
        .await
        .unwrap();
    let debug = format!("{download:?} {store:?}");
    for prohibited in [PERSONAL_KEY_A, "X-Amz-Signature", ACCESS_KEY, SECRET_KEY] {
        assert!(!debug.contains(prohibited));
    }
    let (_, mut reader) = download.into_parts();
    let mut downloaded = Vec::new();
    reader.read_to_end(&mut downloaded).await.unwrap();
    assert_eq!(downloaded, PERSONAL_BODY_A);

    // Poll only a prefix and drop the reader. The following HTTP download must
    // still succeed, proving cancellation drops the SDK stream without a
    // background task retaining or buffering the remainder.
    let cancellation = service
        .download(
            owner,
            personal_owner,
            personal_project,
            descriptor.bundle_id(),
            descriptor.etag(),
        )
        .await
        .unwrap();
    let (_, mut cancellation_reader) = cancellation.into_parts();
    let mut prefix = [0_u8; 4];
    cancellation_reader.read_exact(&mut prefix).await.unwrap();
    assert_eq!(&prefix, &PERSONAL_BODY_A[..4]);
    drop(cancellation_reader);

    // Exercise the real browser-facing Axum path. The Project API returns the
    // descriptor, then streams the verified Bundle on the same origin; no S3
    // redirect, bucket CORS, object key, or bearer URL is involved.
    let router = content_router(pool.clone(), store.clone());
    let cookie = login(&router, "owner@save010.test").await;
    let descriptor_path =
        format!("/api/v1/workspaces/users/{OWNER}/projects/{PERSONAL_PROJECT}/content");
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(&descriptor_path)
            .header(COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response_etag = response.headers()[ETAG].to_str().unwrap().to_owned();
    let view: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    assert_eq!(view["bundleId"], PERSONAL_BUNDLE_A);
    assert_eq!(view["checksum"], digest(PERSONAL_BODY_A));
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(view["downloadUrl"].as_str().unwrap())
            .header(COOKIE, &cookie)
            .header(IF_MATCH, &response_etag)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/octet-stream");
    assert_eq!(
        response.headers()[CONTENT_LENGTH],
        PERSONAL_BODY_A.len().to_string()
    );
    assert_eq!(
        to_bytes(response.into_body(), PERSONAL_BODY_A.len() + 1)
            .await
            .unwrap(),
        PERSONAL_BODY_A
    );
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(view["downloadUrl"].as_str().unwrap())
            .header(COOKIE, &cookie)
            .header(IF_MATCH, &response_etag)
            .header(RANGE, "bytes=0-3")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_problem_code(
        response,
        StatusCode::RANGE_NOT_SATISFIABLE,
        "RANGE_NOT_SATISFIABLE",
    )
    .await;

    assert_eq!(
        service
            .describe(
                owner,
                ProjectOwner::Organization(organization(ORGANIZATION)),
                personal_project,
            )
            .await
            .unwrap_err(),
        ContentError::NotFound
    );

    let org_owner = ProjectOwner::Organization(organization(ORGANIZATION));
    let org_project = project(ORG_PROJECT);
    assert_eq!(
        service
            .describe(user(ORG_OWNER), org_owner, org_project)
            .await
            .unwrap()
            .bundle_id(),
        ORG_BUNDLE
    );
    let direct_descriptor = service
        .describe(user(DIRECT_READ), org_owner, org_project)
        .await
        .unwrap();
    assert_eq!(
        service
            .describe(user(ORG_MEMBER), org_owner, org_project)
            .await
            .unwrap_err(),
        ContentError::Unauthorized
    );
    let member_cookie = login(&router, "member@save010.test").await;
    let org_descriptor_path =
        format!("/api/v1/workspaces/organizations/{ORGANIZATION}/projects/{ORG_PROJECT}/content");
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(&org_descriptor_path)
            .header(COOKIE, &member_cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_problem_code(response, StatusCode::NOT_FOUND, "ROUTE_NOT_FOUND").await;
    let direct_cookie = login(&router, "reader@save010.test").await;
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(&org_descriptor_path)
            .header(COOKIE, &direct_cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let direct_etag = response.headers()[ETAG].to_str().unwrap().to_owned();
    let direct_view: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    let direct_download_path = direct_view["downloadUrl"].as_str().unwrap().to_owned();

    sqlx::query("DELETE FROM project_user_roles WHERE project_id=$1::uuid AND user_id=$2::uuid")
        .bind(ORG_PROJECT)
        .bind(DIRECT_READ)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        service
            .download(
                user(DIRECT_READ),
                org_owner,
                org_project,
                direct_descriptor.bundle_id(),
                direct_descriptor.etag(),
            )
            .await
            .unwrap_err(),
        ContentError::Unauthorized
    );
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(direct_download_path)
            .header(COOKIE, &direct_cookie)
            .header(IF_MATCH, direct_etag)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_problem_code(response, StatusCode::NOT_FOUND, "ROUTE_NOT_FOUND").await;

    sqlx::query(
        "UPDATE projects SET working_head_bundle_id=$2::uuid,lock_version=lock_version+1,\
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(PERSONAL_PROJECT)
    .bind(PERSONAL_BUNDLE_B)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .download(
                owner,
                personal_owner,
                personal_project,
                descriptor.bundle_id(),
                descriptor.etag(),
            )
            .await
            .unwrap_err(),
        ContentError::StaleDescriptor
    );
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(view["downloadUrl"].as_str().unwrap())
            .header(COOKIE, &cookie)
            .header(IF_MATCH, &response_etag)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_problem_code(
        response,
        StatusCode::PRECONDITION_FAILED,
        "PRECONDITION_FAILED",
    )
    .await;
    let current = service
        .describe(owner, personal_owner, personal_project)
        .await
        .unwrap();
    assert_eq!(current.bundle_id(), PERSONAL_BUNDLE_B);
    assert_eq!(current.project_version(), 3);

    put(&store, PERSONAL_KEY_B, b"wrong-size").await;
    assert_eq!(
        service
            .download(
                owner,
                personal_owner,
                personal_project,
                current.bundle_id(),
                current.etag(),
            )
            .await
            .unwrap_err(),
        ContentError::ObjectMismatch
    );
    put(&store, PERSONAL_KEY_B, PERSONAL_BODY_B).await;

    sqlx::query(
        "UPDATE projects SET state='archived',archived_at=transaction_timestamp(),\
         updated_at=transaction_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(PERSONAL_PROJECT)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .describe(owner, personal_owner, personal_project)
            .await
            .unwrap_err(),
        ContentError::ProjectUnavailable
    );
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(&descriptor_path)
            .header(COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_problem_code(response, StatusCode::CONFLICT, "RESOURCE_CONFLICT").await;

    let mut connection = pool.acquire().await.unwrap();
    connection.execute("BEGIN").await.unwrap();
    sqlx::query(
        "UPDATE projects SET working_head_bundle_id=NULL,lock_version=lock_version+1,\
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(PERSONAL_PROJECT)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query("DELETE FROM project_bundle_admissions WHERE project_id=$1::uuid")
        .bind(PERSONAL_PROJECT)
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(PERSONAL_PROJECT)
        .execute(&mut *connection)
        .await
        .unwrap();
    connection.execute("COMMIT").await.unwrap();
    assert_eq!(
        service
            .describe(owner, personal_owner, personal_project)
            .await
            .unwrap_err(),
        ContentError::NotFound
    );
    let response = send(
        &router,
        Request::builder()
            .method(Method::GET)
            .uri(descriptor_path)
            .header(COOKIE, cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_problem_code(response, StatusCode::NOT_FOUND, "ROUTE_NOT_FOUND").await;
}

async fn put(store: &S3ObjectStore, key: &str, body: &'static [u8]) {
    store
        .put(PutRequest {
            key: ObjectKey::parse(key).unwrap(),
            body: Bytes::from_static(body),
            content_type: Some("application/x-tar".to_owned()),
        })
        .await
        .unwrap();
}

fn user(value: &str) -> UserId {
    UserId::from_str(value).unwrap()
}

fn organization(value: &str) -> OrganizationId {
    OrganizationId::from_str(value).unwrap()
}

fn project(value: &str) -> ProjectId {
    ProjectId::from_str(value).unwrap()
}

fn digest(body: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(body))
}

async fn reset_schema(pool: &DatabasePool) {
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
}

async fn seed(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute(
            "INSERT INTO users (id,email,normalized_email,display_name) VALUES \
             ('0199ee6c-c777-7000-8000-000000009001','owner@save010.test','owner@save010.test','Owner'),\
             ('0199ee6c-c777-7000-8000-000000009002','org-owner@save010.test','org-owner@save010.test','Org Owner'),\
             ('0199ee6c-c777-7000-8000-000000009003','reader@save010.test','reader@save010.test','Reader'),\
             ('0199ee6c-c777-7000-8000-000000009004','member@save010.test','member@save010.test','Member')",
        )
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO local_password_credentials (user_id,password_verifier) \
         VALUES ($1::uuid,$2),($3::uuid,$2),($4::uuid,$2)",
    )
    .bind(OWNER)
    .bind(PASSWORD_HASH)
    .bind(DIRECT_READ)
    .bind(ORG_MEMBER)
    .execute(&mut *connection)
    .await
    .unwrap();
    connection
        .execute(
            "INSERT INTO organizations (id,slug,display_name) VALUES \
             ('0199ee6c-c777-7000-8000-000000009010','save010-org','SAVE-010 Org')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO organization_memberships (organization_id,user_id,role) VALUES \
             ('0199ee6c-c777-7000-8000-000000009010','0199ee6c-c777-7000-8000-000000009002','owner'),\
             ('0199ee6c-c777-7000-8000-000000009010','0199ee6c-c777-7000-8000-000000009003','member'),\
             ('0199ee6c-c777-7000-8000-000000009010','0199ee6c-c777-7000-8000-000000009004','member')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_scopes (id,owner_user_id) VALUES \
             ('0199ee6c-c777-7000-8000-000000009020','0199ee6c-c777-7000-8000-000000009001')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_scopes (id,owner_organization_id) VALUES \
             ('0199ee6c-c777-7000-8000-000000009021','0199ee6c-c777-7000-8000-000000009010')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) VALUES \
             ('0199ee6c-c777-7000-8000-000000009030','0199ee6c-c777-7000-8000-000000009001',\
              '0199ee6c-c777-7000-8000-000000009020','personal','Personal')",
        )
        .await
        .unwrap();
    connection
        .execute(
            "INSERT INTO projects (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
             ('0199ee6c-c777-7000-8000-000000009031','0199ee6c-c777-7000-8000-000000009010',\
              '0199ee6c-c777-7000-8000-000000009021','organization','Organization')",
        )
        .await
        .unwrap();

    for (id, key, body, logical, files, source, project, scope, actor) in [
        (
            PERSONAL_BUNDLE_A,
            PERSONAL_KEY_A,
            PERSONAL_BODY_A,
            77_i64,
            3_i32,
            "0199ee6c-c777-7000-8000-000000009050",
            PERSONAL_PROJECT,
            PERSONAL_SCOPE,
            OWNER,
        ),
        (
            PERSONAL_BUNDLE_B,
            PERSONAL_KEY_B,
            PERSONAL_BODY_B,
            81_i64,
            4_i32,
            "0199ee6c-c777-7000-8000-000000009051",
            PERSONAL_PROJECT,
            PERSONAL_SCOPE,
            OWNER,
        ),
        (
            ORG_BUNDLE,
            ORG_KEY,
            ORG_BODY,
            91_i64,
            5_i32,
            "0199ee6c-c777-7000-8000-000000009052",
            ORG_PROJECT,
            ORG_SCOPE,
            ORG_OWNER,
        ),
    ] {
        let checksum = Sha256::digest(body).to_vec();
        sqlx::query(
            "INSERT INTO save_sessions \
             (id,project_id,storage_scope_id,actor_user_id,expected_project_version,\
              expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes,\
              expected_file_count,staging_object_key,upload_mode,expires_at) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,$5,$6,$7,$8,$9,'single',\
                     transaction_timestamp()+interval '1 hour')",
        )
        .bind(source)
        .bind(project)
        .bind(scope)
        .bind(actor)
        .bind(&checksum)
        .bind(i64::try_from(body.len()).unwrap())
        .bind(logical)
        .bind(files)
        .bind(key)
        .execute(&mut *connection)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE save_sessions SET state='uploading',updated_at=transaction_timestamp() \
             WHERE id=$1::uuid",
        )
        .bind(source)
        .execute(&mut *connection)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE save_sessions SET state='verifying',updated_at=transaction_timestamp() \
             WHERE id=$1::uuid",
        )
        .bind(source)
        .execute(&mut *connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO bundles (id,sha256,object_key,physical_bytes,logical_bytes,file_count,\
             format,verified_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,'project-bundle-v1',transaction_timestamp())",
        )
        .bind(id)
        .bind(&checksum)
        .bind(key)
        .bind(i64::try_from(body.len()).unwrap())
        .bind(logical)
        .bind(files)
        .execute(&mut *connection)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE save_sessions SET state='committed',committed_bundle_id=$2::uuid,\
             terminal_at=transaction_timestamp(),updated_at=transaction_timestamp() \
             WHERE id=$1::uuid",
        )
        .bind(source)
        .bind(id)
        .execute(&mut *connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO project_bundle_admissions \
             (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$4::uuid)",
        )
        .bind(project)
        .bind(scope)
        .bind(id)
        .bind(source)
        .execute(&mut *connection)
        .await
        .unwrap();
    }
    sqlx::query(
        "UPDATE projects SET working_head_bundle_id=$2::uuid,lock_version=lock_version+1,\
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(PERSONAL_PROJECT)
    .bind(PERSONAL_BUNDLE_A)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE projects SET working_head_bundle_id=$2::uuid,lock_version=lock_version+1,\
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(ORG_PROJECT)
    .bind(ORG_BUNDLE)
    .execute(&mut *connection)
    .await
    .unwrap();
    connection
        .execute(
            "INSERT INTO project_user_roles (project_id,organization_id,user_id,role) VALUES \
             ('0199ee6c-c777-7000-8000-000000009031','0199ee6c-c777-7000-8000-000000009010',\
              '0199ee6c-c777-7000-8000-000000009003','read')",
        )
        .await
        .unwrap();
}

fn content_router(pool: DatabasePool, store: S3ObjectStore) -> Router {
    let external_url = Url::parse(ORIGIN_VALUE).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let projects = ProjectHttpService::production_with_content(
        pool,
        &external_url,
        ProjectHttpPolicy::default(),
        SessionPolicy::default(),
        store,
        ContentServicePolicy::default(),
    )
    .unwrap();
    build_router_with_project_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        projects,
        SetupStatusService::unconfigured(),
    )
}

async fn login(router: &Router, email: &str) -> String {
    let response = send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/sessions")
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, ORIGIN_VALUE)
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "email":email,
                    "password":PASSWORD
                }))
                .unwrap(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| {
            value
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("; ")
}

async fn assert_problem_code(response: axum::response::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    assert_eq!(body["code"], code);
}

async fn send(router: &Router, request: Request<Body>) -> axum::response::Response {
    router.clone().oneshot(request).await.unwrap()
}

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
                "save010-fixture",
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
