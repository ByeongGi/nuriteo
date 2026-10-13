use std::env;
use std::fs;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_TYPE, COOKIE, ORIGIN, SET_COOKIE};
use axum::http::{HeaderValue, Method, Request, Response, StatusCode};
use nuriteo_server::app::build_router_with_services;
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::SessionPolicy;
use serde_json::{Value, json};
use sqlx::Acquire;
use tower::ServiceExt;
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const PASSWORD: &str = "correct horse battery staple";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";
const USER_ID: &str = "0199ee6c-c777-7000-8000-000000000601";
const SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000000602";
const DUPLICATE_SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000000603";
const ORG_ALPHA_ID: &str = "0199ee6c-c777-7000-8000-000000000611";
const ORG_ALPHA_SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000000612";
const ORG_ZETA_ID: &str = "0199ee6c-c777-7000-8000-000000000613";
const ORG_ZETA_SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000000614";
const ORG_DUPLICATE_SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000000615";
const OTHER_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000616";
const OTHER_ORG_ID: &str = "0199ee6c-c777-7000-8000-000000000617";
const OTHER_ORG_SCOPE_ID: &str = "0199ee6c-c777-7000-8000-000000000618";
const REQUEST_ID: &str = "request:workspace-fixture";
const ORIGIN_VALUE: &str = "http://localhost:3000";
const WORKSPACES_PATH: &str = "/api/v1/me/workspaces";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-workspaces-http/run.sh"]
async fn workspace_http_route_projects_personal_and_organizations_fail_closed() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    verify_migration_backfill(&pool).await;
    reset_fixture(&pool).await;
    migrate(&pool).await;
    seed_user(&pool).await;

    let auth = AuthService::production(
        pool.clone(),
        &Url::parse(ORIGIN_VALUE).unwrap(),
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let router = build_router_with_services(HealthService::unconfigured(), auth);

    verify_generic_authentication_failures(&router).await;
    let browser = login(&router).await;
    verify_personal_projection(&router, &browser).await;
    seed_organizations(&pool).await;
    verify_organization_projection(&router, &pool, &browser).await;
    verify_committed_state_visibility(&router, &pool, &browser).await;
    verify_revoked_session_is_rejected(&router, &pool, &browser).await;
    verify_scope_invariants_fail_closed(&router, &pool, &browser).await;
    verify_disabled_user_is_rejected(&router, &pool, &browser).await;
    verify_expired_session_is_rejected(&router, &pool, &browser).await;
    verify_missing_user_is_rejected(&router, &pool, &browser).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_committed_state_visibility(
    router: &Router,
    pool: &DatabasePool,
    browser: &BrowserCredentials,
) {
    let mut connection = acquire(pool).await;
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query("DELETE FROM organization_memberships WHERE organization_id = $1::uuid AND user_id = $2::uuid")
        .bind(ORG_ALPHA_ID).bind(USER_ID).execute(&mut *transaction).await.unwrap();
    let before_commit =
        json_body(workspace_request(router, Some(&browser.cookie), &[]).await).await;
    assert_eq!(before_commit["workspaces"].as_array().unwrap().len(), 3);
    transaction.commit().await.unwrap();
    let after_commit = json_body(workspace_request(router, Some(&browser.cookie), &[]).await).await;
    assert_eq!(after_commit["workspaces"].as_array().unwrap().len(), 2);
    execute(pool, "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ('0199ee6c-c777-7000-8000-000000000611'::uuid, '0199ee6c-c777-7000-8000-000000000601'::uuid, 'owner')").await;

    let mut connection = acquire(pool).await;
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query("UPDATE organizations SET status = 'archived', archived_at = transaction_timestamp(), updated_at = transaction_timestamp(), lock_version = lock_version + 1 WHERE id = $1::uuid")
        .bind(ORG_ZETA_ID).execute(&mut *transaction).await.unwrap();
    let before_commit =
        json_body(workspace_request(router, Some(&browser.cookie), &[]).await).await;
    assert_eq!(before_commit["workspaces"].as_array().unwrap().len(), 3);
    transaction.commit().await.unwrap();
    let after_commit = json_body(workspace_request(router, Some(&browser.cookie), &[]).await).await;
    assert_eq!(after_commit["workspaces"].as_array().unwrap().len(), 2);
}

async fn verify_migration_backfill(pool: &DatabasePool) {
    for migration in [
        include_str!("../migrations/0001_framework_baseline.sql"),
        include_str!("../migrations/0002_identity_core.sql"),
        include_str!("../migrations/0003_sessions_and_audit.sql"),
        include_str!("../migrations/0004_activation_invitations.sql"),
        include_str!("../migrations/0005_auth_lockout.sql"),
        include_str!("../migrations/0006_personal_storage_scopes.sql"),
        include_str!("../migrations/0007_organizations.sql"),
        include_str!("../migrations/0008_organization_invitations.sql"),
    ] {
        sqlx::raw_sql(migration)
            .execute(&mut *acquire(pool).await)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO users (id, email, normalized_email, display_name) VALUES ($1::uuid, 'legacy@example.test', 'legacy@example.test', 'Legacy User')")
        .bind(USER_ID).execute(&mut *acquire(pool).await).await.unwrap();
    insert_scope(pool, SCOPE_ID).await;
    sqlx::query("INSERT INTO organizations (id, slug, display_name) VALUES ($1::uuid, 'legacy-team', 'Legacy Team')")
        .bind(ORG_ALPHA_ID).execute(&mut *acquire(pool).await).await.unwrap();

    sqlx::raw_sql(include_str!(
        "../migrations/0009_organization_storage_scopes.sql"
    ))
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    let personal_id: String =
        sqlx::query_scalar("SELECT id::text FROM storage_scopes WHERE owner_user_id = $1::uuid")
            .bind(USER_ID)
            .fetch_one(&mut *acquire(pool).await)
            .await
            .unwrap();
    assert_eq!(personal_id, SCOPE_ID);
    let organization_scope: (String, String) = sqlx::query_as(
        "SELECT id::text, owner_organization_id::text FROM storage_scopes WHERE owner_organization_id = $1::uuid",
    ).bind(ORG_ALPHA_ID).fetch_one(&mut *acquire(pool).await).await.unwrap();
    assert_eq!(organization_scope.1, ORG_ALPHA_ID);
    assert_eq!(organization_scope.0.chars().nth(14), Some('7'));
    assert!(matches!(
        organization_scope.0.chars().nth(19),
        Some('8'..='b')
    ));

    assert!(
        sqlx::query("INSERT INTO storage_scopes (id) VALUES ($1::uuid)")
            .bind(ORG_DUPLICATE_SCOPE_ID)
            .execute(&mut *acquire(pool).await)
            .await
            .is_err()
    );
    assert!(sqlx::query("INSERT INTO storage_scopes (id, owner_user_id, owner_organization_id) VALUES ($1::uuid, $2::uuid, $3::uuid)")
        .bind(ORG_DUPLICATE_SCOPE_ID).bind(USER_ID).bind(ORG_ALPHA_ID)
        .execute(&mut *acquire(pool).await).await.is_err());
}

async fn verify_organization_projection(
    router: &Router,
    pool: &DatabasePool,
    browser: &BrowserCredentials,
) {
    let response = workspace_request(router, Some(&browser.cookie), &[]).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["workspaces"][0]["ownerType"], "user");
    assert_eq!(
        body["workspaces"][1],
        json!({
            "ownerType": "organization", "ownerId": ORG_ALPHA_ID,
            "displayLabel": "Alpha Team", "storageScopeId": ORG_ALPHA_SCOPE_ID
        })
    );
    assert_eq!(
        body["workspaces"][2],
        json!({
            "ownerType": "organization", "ownerId": ORG_ZETA_ID,
            "displayLabel": "Zeta Team", "storageScopeId": ORG_ZETA_SCOPE_ID
        })
    );
    assert_eq!(body["workspaces"].as_array().unwrap().len(), 3);

    execute(pool, "UPDATE organizations SET status = 'archived', archived_at = transaction_timestamp(), updated_at = transaction_timestamp(), lock_version = lock_version + 1 WHERE id = '0199ee6c-c777-7000-8000-000000000613'::uuid").await;
    execute(pool, "DELETE FROM organization_memberships WHERE organization_id = '0199ee6c-c777-7000-8000-000000000611'::uuid AND user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid").await;
    let excluded = json_body(workspace_request(router, Some(&browser.cookie), &[]).await).await;
    assert_eq!(excluded["workspaces"].as_array().unwrap().len(), 1);

    execute(pool, "UPDATE organizations SET status = 'active', archived_at = NULL, updated_at = transaction_timestamp(), lock_version = lock_version + 1 WHERE id = '0199ee6c-c777-7000-8000-000000000613'::uuid").await;
    execute(pool, "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ('0199ee6c-c777-7000-8000-000000000611'::uuid, '0199ee6c-c777-7000-8000-000000000601'::uuid, 'owner')").await;
    execute(pool, "DELETE FROM storage_scopes WHERE owner_organization_id = '0199ee6c-c777-7000-8000-000000000611'::uuid").await;
    assert_problem(
        workspace_request(router, Some(&browser.cookie), &[]).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    insert_organization_scope(pool, ORG_ALPHA_SCOPE_ID, ORG_ALPHA_ID).await;

    execute(
        pool,
        "ALTER TABLE storage_scopes DROP CONSTRAINT storage_scopes_owner_organization_unique",
    )
    .await;
    insert_organization_scope(pool, ORG_DUPLICATE_SCOPE_ID, ORG_ALPHA_ID).await;
    assert_problem(
        workspace_request(router, Some(&browser.cookie), &[]).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    execute(
        pool,
        "DELETE FROM storage_scopes WHERE id = '0199ee6c-c777-7000-8000-000000000615'::uuid",
    )
    .await;
    execute(pool, "ALTER TABLE storage_scopes ADD CONSTRAINT storage_scopes_owner_organization_unique UNIQUE (owner_organization_id)").await;
}

async fn verify_generic_authentication_failures(router: &Router) {
    let missing = workspace_request(router, None, &[]).await;
    let invalid = workspace_request(router, Some("nuriteo_dev_session=invalid"), &[]).await;
    let oversized = format!("unrelated={}", "x".repeat(8 * 1024 + 1));
    let oversized = workspace_request(router, Some(&oversized), &[]).await;
    let bodies = [
        assert_problem(missing, StatusCode::UNAUTHORIZED).await,
        assert_problem(invalid, StatusCode::UNAUTHORIZED).await,
        assert_problem(oversized, StatusCode::UNAUTHORIZED).await,
    ];
    for body in &bodies[1..] {
        assert_eq!(body["code"], bodies[0]["code"]);
        assert_eq!(body["title"], bodies[0]["title"]);
        assert_eq!(body["detail"], bodies[0]["detail"]);
    }
}

async fn verify_personal_projection(router: &Router, browser: &BrowserCredentials) {
    let response = workspace_request(router, Some(&browser.cookie), &[]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()["x-request-id"], REQUEST_ID);
    let body = json_body(response).await;
    assert_eq!(
        body,
        json!({
            "workspaces": [{
                "ownerType": "user",
                "ownerId": USER_ID,
                "displayLabel": "Ada Lovelace",
                "storageScopeId": SCOPE_ID
            }]
        })
    );
    let serialized = body.to_string();
    for forbidden in [
        PASSWORD,
        PASSWORD_HASH,
        browser.session_wire.as_str(),
        "password",
        "token",
        "isInstanceAdmin",
        "quota",
    ] {
        assert!(!serialized.contains(forbidden));
    }

    let duplicate = workspace_request(router, Some(&browser.cookie), &[&browser.cookie]).await;
    assert_problem(duplicate, StatusCode::UNAUTHORIZED).await;
}

async fn verify_revoked_session_is_rejected(
    router: &Router,
    pool: &DatabasePool,
    browser: &BrowserCredentials,
) {
    execute(
        pool,
        "UPDATE sessions SET revoked_at = transaction_timestamp(), revocation_reason = 'fixture' WHERE user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid",
    )
    .await;
    let response = workspace_request(router, Some(&browser.cookie), &[]).await;
    assert_problem(response, StatusCode::UNAUTHORIZED).await;
    execute(
        pool,
        "UPDATE sessions SET revoked_at = NULL, revocation_reason = NULL WHERE user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid",
    )
    .await;
}

async fn verify_scope_invariants_fail_closed(
    router: &Router,
    pool: &DatabasePool,
    browser: &BrowserCredentials,
) {
    execute(pool, "DELETE FROM storage_scopes WHERE owner_user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid").await;
    let missing = workspace_request(router, Some(&browser.cookie), &[]).await;
    assert_problem(missing, StatusCode::INTERNAL_SERVER_ERROR).await;

    insert_scope(pool, SCOPE_ID).await;
    execute(
        pool,
        "ALTER TABLE storage_scopes DROP CONSTRAINT storage_scopes_owner_user_unique",
    )
    .await;
    insert_scope(pool, DUPLICATE_SCOPE_ID).await;
    let duplicate = workspace_request(router, Some(&browser.cookie), &[]).await;
    assert_problem(duplicate, StatusCode::INTERNAL_SERVER_ERROR).await;
    execute(
        pool,
        "DELETE FROM storage_scopes WHERE id = '0199ee6c-c777-7000-8000-000000000603'::uuid",
    )
    .await;
    execute(
        pool,
        "ALTER TABLE storage_scopes ADD CONSTRAINT storage_scopes_owner_user_unique UNIQUE (owner_user_id)",
    )
    .await;
}

async fn verify_disabled_user_is_rejected(
    router: &Router,
    pool: &DatabasePool,
    browser: &BrowserCredentials,
) {
    execute(
        pool,
        "UPDATE users SET status = 'disabled', disabled_at = transaction_timestamp(), updated_at = transaction_timestamp() WHERE id = '0199ee6c-c777-7000-8000-000000000601'::uuid",
    )
    .await;
    let response = workspace_request(router, Some(&browser.cookie), &[]).await;
    assert_problem(response, StatusCode::UNAUTHORIZED).await;
    execute(
        pool,
        "UPDATE users SET status = 'active', disabled_at = NULL, updated_at = transaction_timestamp() WHERE id = '0199ee6c-c777-7000-8000-000000000601'::uuid",
    )
    .await;
}

async fn verify_expired_session_is_rejected(
    router: &Router,
    pool: &DatabasePool,
    browser: &BrowserCredentials,
) {
    execute(
        pool,
        "UPDATE sessions SET created_at = transaction_timestamp() - INTERVAL '3 days', last_seen_at = transaction_timestamp() - INTERVAL '3 days', idle_expires_at = transaction_timestamp() - INTERVAL '2 days', absolute_expires_at = transaction_timestamp() + INTERVAL '1 day' WHERE user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid",
    )
    .await;
    let response = workspace_request(router, Some(&browser.cookie), &[]).await;
    assert_problem(response, StatusCode::UNAUTHORIZED).await;
    execute(
        pool,
        "UPDATE sessions SET created_at = transaction_timestamp(), last_seen_at = transaction_timestamp(), idle_expires_at = transaction_timestamp() + INTERVAL '1 day', absolute_expires_at = transaction_timestamp() + INTERVAL '2 days' WHERE user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid",
    )
    .await;
}

async fn verify_missing_user_is_rejected(
    router: &Router,
    pool: &DatabasePool,
    browser: &BrowserCredentials,
) {
    execute(pool, "DELETE FROM local_password_credentials WHERE user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid").await;
    execute(pool, "DELETE FROM organization_memberships WHERE user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid").await;
    execute(pool, "DELETE FROM storage_scopes WHERE owner_user_id = '0199ee6c-c777-7000-8000-000000000601'::uuid").await;
    execute(
        pool,
        "ALTER TABLE sessions DROP CONSTRAINT sessions_user_fk",
    )
    .await;
    execute(
        pool,
        "DELETE FROM users WHERE id = '0199ee6c-c777-7000-8000-000000000601'::uuid",
    )
    .await;
    let response = workspace_request(router, Some(&browser.cookie), &[]).await;
    assert_problem(response, StatusCode::UNAUTHORIZED).await;
}

struct BrowserCredentials {
    cookie: String,
    session_wire: String,
}

async fn login(router: &Router) -> BrowserCredentials {
    let response = send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/sessions")
            .header("x-request-id", REQUEST_ID)
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, ORIGIN_VALUE)
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "email": "ada@example.test",
                    "password": PASSWORD
                }))
                .unwrap(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let pairs = response
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
        .collect::<Vec<_>>();
    let session_wire = pairs
        .iter()
        .find_map(|pair| pair.strip_prefix("nuriteo_dev_session="))
        .unwrap()
        .to_owned();
    BrowserCredentials {
        cookie: pairs.join("; "),
        session_wire,
    }
}

async fn workspace_request(
    router: &Router,
    cookie: Option<&str>,
    extra_cookies: &[&str],
) -> Response<Body> {
    let mut request = Request::builder()
        .method(Method::GET)
        .uri(WORKSPACES_PATH)
        .header("x-request-id", REQUEST_ID)
        .body(Body::empty())
        .unwrap();
    if let Some(cookie) = cookie {
        request
            .headers_mut()
            .append(COOKIE, HeaderValue::from_str(cookie).unwrap());
    }
    for cookie in extra_cookies {
        request
            .headers_mut()
            .append(COOKIE, HeaderValue::from_str(cookie).unwrap());
    }
    send(router, request).await
}

async fn send(router: &Router, request: Request<Body>) -> Response<Body> {
    router.clone().oneshot(request).await.unwrap()
}

async fn assert_problem(response: Response<Body>, status: StatusCode) -> Value {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    assert_eq!(response.headers()["x-request-id"], REQUEST_ID);
    let body = json_body(response).await;
    assert_eq!(body["status"], status.as_u16());
    assert_eq!(body["request_id"], REQUEST_ID);
    let serialized = body.to_string();
    for secret in [
        PASSWORD,
        PASSWORD_HASH,
        "postgres://",
        "nuriteo_dev_session=",
    ] {
        assert!(!serialized.contains(secret));
    }
    body
}

async fn json_body(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 16 * 1024).await.unwrap()).unwrap()
}

async fn seed_user(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users (id, email, normalized_email, display_name, status, is_instance_admin) \
         VALUES ($1::uuid, $2, $3, $4, 'active', TRUE)",
    )
    .bind(USER_ID)
    .bind("Ada@Example.test")
    .bind("ada@example.test")
    .bind("Ada Lovelace")
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO local_password_credentials (user_id, password_verifier) VALUES ($1::uuid, $2)",
    )
    .bind(USER_ID)
    .bind(PASSWORD_HASH)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    insert_scope(pool, SCOPE_ID).await;
}

async fn insert_scope(pool: &DatabasePool, scope_id: &str) {
    sqlx::query("INSERT INTO storage_scopes (id, owner_user_id) VALUES ($1::uuid, $2::uuid)")
        .bind(scope_id)
        .bind(USER_ID)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
}

async fn seed_organizations(pool: &DatabasePool) {
    sqlx::query("INSERT INTO users (id, email, normalized_email, display_name) VALUES ($1::uuid, 'other@example.test', 'other@example.test', 'Other User')")
        .bind(OTHER_USER_ID).execute(&mut *acquire(pool).await).await.unwrap();
    for (id, slug, display_name) in [
        (ORG_ZETA_ID, "zeta-team", "Zeta Team"),
        (ORG_ALPHA_ID, "alpha-team", "Alpha Team"),
        (OTHER_ORG_ID, "other-team", "Other Team"),
    ] {
        sqlx::query("INSERT INTO organizations (id, slug, display_name) VALUES ($1::uuid, $2, $3)")
            .bind(id)
            .bind(slug)
            .bind(display_name)
            .execute(&mut *acquire(pool).await)
            .await
            .unwrap();
    }
    for (organization_id, user_id, role) in [
        (ORG_ALPHA_ID, USER_ID, "owner"),
        (ORG_ZETA_ID, USER_ID, "member"),
        (OTHER_ORG_ID, OTHER_USER_ID, "owner"),
    ] {
        sqlx::query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3)")
            .bind(organization_id).bind(user_id).bind(role)
            .execute(&mut *acquire(pool).await).await.unwrap();
    }
    insert_organization_scope(pool, ORG_ALPHA_SCOPE_ID, ORG_ALPHA_ID).await;
    insert_organization_scope(pool, ORG_ZETA_SCOPE_ID, ORG_ZETA_ID).await;
    insert_organization_scope(pool, OTHER_ORG_SCOPE_ID, OTHER_ORG_ID).await;
}

async fn insert_organization_scope(pool: &DatabasePool, scope_id: &str, organization_id: &str) {
    sqlx::query(
        "INSERT INTO storage_scopes (id, owner_organization_id) VALUES ($1::uuid, $2::uuid)",
    )
    .bind(scope_id)
    .bind(organization_id)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
}

async fn execute(pool: &DatabasePool, statement: &'static str) {
    sqlx::query(statement)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
}

async fn migrate(pool: &DatabasePool) {
    let report = run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(15));
    assert_eq!(report.known_migrations, 15);
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    sqlx::query("DROP SCHEMA public CASCADE")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("CREATE SCHEMA public")
        .execute(&mut *connection)
        .await
        .unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca_path = env::var(DATABASE_CA_ENV).unwrap();
    let ca = fs::read(ca_path).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap();
    DatabasePool::connect(config).await.unwrap()
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire().await.unwrap()
}
