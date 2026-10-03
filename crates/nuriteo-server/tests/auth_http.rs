use std::env;
use std::fs;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_TYPE, COOKIE, ORIGIN, SET_COOKIE};
use axum::http::{HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use nuriteo_server::app::build_router_with_services;
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::SessionPolicy;
use serde_json::{Value, json};
use tower::ServiceExt;
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const PASSWORD: &str = "correct horse battery staple";
const WRONG_PASSWORD: &str = "wrong horse battery staple";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";
const ACTIVE_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000401";
const DISABLED_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000402";
const NO_CREDENTIAL_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000403";
const ATOMIC_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000404";
const REQUEST_ID: &str = "request:auth-fixture";
const ORIGIN_VALUE: &str = "http://localhost:3000";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-auth/run.sh"]
async fn local_auth_http_slice_is_bounded_atomic_and_secret_free() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    migrate(&pool).await;
    seed_users(&pool).await;

    let auth = AuthService::production(
        pool.clone(),
        &Url::parse(ORIGIN_VALUE).unwrap(),
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let router = build_router_with_services(HealthService::unconfigured(), auth);

    verify_bounded_json_contract(&router).await;
    verify_generic_failures_and_audit(&router, &pool).await;
    verify_audit_failure_rolls_back_session(&router, &pool).await;
    let browser = login(&router, "admin@example.test", PASSWORD).await;
    verify_success_is_cookie_only_and_audited(&browser, &pool).await;
    verify_me_and_logout(&router, &pool, &browser).await;
    verify_expired_session_is_rejected(&router, &pool).await;
    verify_no_raw_secrets_are_persisted(&pool, &browser).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[derive(Clone)]
struct BrowserCredentials {
    cookie_header: String,
    csrf: String,
    session_wire: String,
}

async fn verify_bounded_json_contract(router: &Router) {
    let missing_type = send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/sessions")
            .header("x-request-id", REQUEST_ID)
            .body(Body::from("{}"))
            .unwrap(),
    )
    .await;
    assert_problem(missing_type, StatusCode::UNSUPPORTED_MEDIA_TYPE).await;

    let mut duplicate_type = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/auth/sessions")
        .header("x-request-id", REQUEST_ID)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    duplicate_type
        .headers_mut()
        .append(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    assert_problem(
        send(router, duplicate_type).await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
    )
    .await;

    let cross_origin = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/auth/sessions")
        .header("x-request-id", REQUEST_ID)
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, "https://preview.example.test")
        .body(Body::from(
            serde_json::to_vec(&json!({"email": "admin@example.test", "password": PASSWORD}))
                .unwrap(),
        ))
        .unwrap();
    assert_problem(send(router, cross_origin).await, StatusCode::FORBIDDEN).await;

    let invalid = post_login_raw(router, br#"{"email":"admin@example.test"}"#.to_vec()).await;
    assert_problem(invalid, StatusCode::UNPROCESSABLE_ENTITY).await;

    let oversized = post_login_raw(router, vec![b'x'; 4 * 1024 + 1]).await;
    assert_problem(oversized, StatusCode::PAYLOAD_TOO_LARGE).await;

    let duplicate_json_field = post_login_raw(
        router,
        format!(
            "{{\"email\":\"admin@example.test\",\"email\":\"other@example.test\",\"password\":\"{PASSWORD}\"}}"
        )
        .into_bytes(),
    )
    .await;
    assert_problem(duplicate_json_field, StatusCode::UNPROCESSABLE_ENTITY).await;
}

async fn verify_generic_failures_and_audit(router: &Router, pool: &DatabasePool) {
    let mut bodies = Vec::new();
    for (email, password) in [
        ("admin@example.test", WRONG_PASSWORD),
        ("unknown@example.test", PASSWORD),
        ("disabled@example.test", PASSWORD),
        ("oidc-only@example.test", PASSWORD),
    ] {
        let response = login_response(router, email, password).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 0);
        bodies.push(json_body(response).await);
    }
    for body in &bodies[1..] {
        assert_eq!(body["code"], bodies[0]["code"]);
        assert_eq!(body["title"], bodies[0]["title"]);
        assert_eq!(body["detail"], bodies[0]["detail"]);
    }
    assert_eq!(audit_count(pool, "auth.login_failed").await, 4);
}

async fn verify_audit_failure_rolls_back_session(router: &Router, pool: &DatabasePool) {
    execute(
        pool,
        "CREATE FUNCTION reject_login_audit() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.action_code = 'auth.login_succeeded' THEN \
         RAISE EXCEPTION 'fixture audit rejection'; END IF; RETURN NEW; END $$",
    )
    .await;
    execute(
        pool,
        "CREATE TRIGGER reject_login_audit BEFORE INSERT ON audit_events \
         FOR EACH ROW EXECUTE FUNCTION reject_login_audit()",
    )
    .await;

    let response = login_response(router, "atomic@example.test", PASSWORD).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(session_count(pool, ATOMIC_USER_ID).await, 0);

    execute(pool, "DROP TRIGGER reject_login_audit ON audit_events").await;
    execute(pool, "DROP FUNCTION reject_login_audit()").await;
}

async fn verify_success_is_cookie_only_and_audited(
    browser: &BrowserCredentials,
    pool: &DatabasePool,
) {
    assert!(browser.cookie_header.contains("nuriteo_dev_session="));
    assert!(browser.cookie_header.contains("nuriteo_dev_csrf="));
    assert!(!browser.cookie_header.contains("__Host-"));
    assert_eq!(session_count(pool, ACTIVE_USER_ID).await, 1);
    assert_eq!(audit_count(pool, "auth.login_succeeded").await, 1);
    let digest_length: i32 = sqlx::query_scalar(
        "SELECT octet_length(token_hash) FROM sessions WHERE user_id = $1::uuid",
    )
    .bind(ACTIVE_USER_ID)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(digest_length, 32);
}

async fn verify_me_and_logout(router: &Router, pool: &DatabasePool, browser: &BrowserCredentials) {
    let me = authenticated_request(router, Method::GET, "/api/v1/me", browser, None, None).await;
    assert_eq!(me.status(), StatusCode::OK);
    let body = json_body(me).await;
    assert_eq!(body["user"]["email"], "Admin@Example.test");
    assert_eq!(body["user"]["is_instance_admin"], true);
    let serialized = body.to_string();
    for secret in [
        PASSWORD,
        &browser.session_wire,
        &browser.csrf,
        "password_verifier",
    ] {
        assert!(!serialized.contains(secret));
    }

    let missing_csrf = authenticated_request(
        router,
        Method::DELETE,
        "/api/v1/auth/session",
        browser,
        Some(ORIGIN_VALUE),
        None,
    )
    .await;
    assert_problem(missing_csrf, StatusCode::FORBIDDEN).await;

    let cross_origin = authenticated_request(
        router,
        Method::DELETE,
        "/api/v1/auth/session",
        browser,
        Some("https://preview.example.test"),
        Some(&browser.csrf),
    )
    .await;
    assert_problem(cross_origin, StatusCode::FORBIDDEN).await;

    for (name, value) in [
        (ORIGIN, ORIGIN_VALUE),
        (
            HeaderName::from_static("x-csrf-token"),
            browser.csrf.as_str(),
        ),
        (COOKIE, browser.cookie_header.as_str()),
    ] {
        let mut request = Request::builder()
            .method(Method::DELETE)
            .uri("/api/v1/auth/session")
            .header("x-request-id", REQUEST_ID)
            .header(ORIGIN, ORIGIN_VALUE)
            .header("x-csrf-token", &browser.csrf)
            .header(COOKIE, &browser.cookie_header)
            .body(Body::empty())
            .unwrap();
        request
            .headers_mut()
            .append(name, HeaderValue::from_str(value).unwrap());
        assert_problem(send(router, request).await, StatusCode::FORBIDDEN).await;
    }

    let logout = authenticated_request(
        router,
        Method::DELETE,
        "/api/v1/auth/session",
        browser,
        Some(ORIGIN_VALUE),
        Some(&browser.csrf),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    let deletion = logout
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(deletion.len(), 2);
    assert!(deletion.iter().all(|value| value.contains("Max-Age=0")));
    assert_eq!(audit_count(pool, "auth.logout").await, 1);

    let revoked =
        authenticated_request(router, Method::GET, "/api/v1/me", browser, None, None).await;
    assert_problem(revoked, StatusCode::UNAUTHORIZED).await;
}

async fn verify_expired_session_is_rejected(router: &Router, pool: &DatabasePool) {
    let browser = login(router, "atomic@example.test", PASSWORD).await;
    sqlx::query(
        "UPDATE sessions SET created_at = transaction_timestamp() - INTERVAL '3 days', \
         last_seen_at = transaction_timestamp() - INTERVAL '3 days', \
         idle_expires_at = transaction_timestamp() - INTERVAL '2 days', \
         absolute_expires_at = transaction_timestamp() + INTERVAL '1 day' \
         WHERE user_id = $1::uuid",
    )
    .bind(ATOMIC_USER_ID)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    let expired =
        authenticated_request(router, Method::GET, "/api/v1/me", &browser, None, None).await;
    assert_problem(expired, StatusCode::UNAUTHORIZED).await;
}

async fn verify_no_raw_secrets_are_persisted(pool: &DatabasePool, browser: &BrowserCredentials) {
    let audit_text: String = sqlx::query_scalar(
        "SELECT COALESCE(string_agg(row_to_json(a)::text, ''), '') FROM audit_events a",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    for secret in [
        PASSWORD,
        WRONG_PASSWORD,
        &browser.session_wire,
        &browser.csrf,
    ] {
        assert!(
            !audit_text.contains(secret),
            "audit row leaked a raw secret"
        );
    }
    let raw_session_matches: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE encode(token_hash, 'escape') = $1")
            .bind(&browser.session_wire)
            .fetch_one(&mut *acquire(pool).await)
            .await
            .unwrap();
    assert_eq!(raw_session_matches, 0);
}

async fn login(router: &Router, email: &str, password: &str) -> BrowserCredentials {
    let response = login_response(router, email, password).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let cookies = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(cookies.len(), 2);
    assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap().len(), 0);
    let pairs = cookies
        .iter()
        .map(|value| value.split(';').next().unwrap().to_owned())
        .collect::<Vec<_>>();
    let csrf = pairs
        .iter()
        .find_map(|pair| pair.strip_prefix("nuriteo_dev_csrf="))
        .unwrap()
        .to_owned();
    let session_wire = pairs
        .iter()
        .find_map(|pair| pair.strip_prefix("nuriteo_dev_session="))
        .unwrap()
        .to_owned();
    BrowserCredentials {
        cookie_header: pairs.join("; "),
        csrf,
        session_wire,
    }
}

async fn login_response(router: &Router, email: &str, password: &str) -> Response<Body> {
    post_login_raw(
        router,
        serde_json::to_vec(&json!({"email": email, "password": password})).unwrap(),
    )
    .await
}

async fn post_login_raw(router: &Router, body: Vec<u8>) -> Response<Body> {
    send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/sessions")
            .header("x-request-id", REQUEST_ID)
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, ORIGIN_VALUE)
            .body(Body::from(body))
            .unwrap(),
    )
    .await
}

async fn authenticated_request(
    router: &Router,
    method: Method,
    uri: &str,
    browser: &BrowserCredentials,
    origin: Option<&str>,
    csrf: Option<&str>,
) -> Response<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-request-id", REQUEST_ID)
        .header(COOKIE, &browser.cookie_header);
    if let Some(origin) = origin {
        request = request.header(ORIGIN, origin);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    send(router, request.body(Body::empty()).unwrap()).await
}

async fn send(router: &Router, request: Request<Body>) -> Response<Body> {
    router.clone().oneshot(request).await.unwrap()
}

async fn assert_problem(response: Response<Body>, status: StatusCode) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    let body = json_body(response).await;
    assert_eq!(body["status"], status.as_u16());
    assert_eq!(body["request_id"], REQUEST_ID);
    let serialized = body.to_string();
    for secret in [PASSWORD, WRONG_PASSWORD, PASSWORD_HASH, "postgres://"] {
        assert!(!serialized.contains(secret));
    }
}

async fn json_body(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 16 * 1024).await.unwrap()).unwrap()
}

async fn seed_users(pool: &DatabasePool) {
    for (id, email, normalized, display, status, disabled, credential) in [
        (
            ACTIVE_USER_ID,
            "Admin@Example.test",
            "admin@example.test",
            "Admin",
            "active",
            false,
            true,
        ),
        (
            DISABLED_USER_ID,
            "disabled@example.test",
            "disabled@example.test",
            "Disabled",
            "disabled",
            true,
            true,
        ),
        (
            NO_CREDENTIAL_USER_ID,
            "oidc-only@example.test",
            "oidc-only@example.test",
            "OIDC only",
            "active",
            false,
            false,
        ),
        (
            ATOMIC_USER_ID,
            "atomic@example.test",
            "atomic@example.test",
            "Atomic",
            "active",
            false,
            true,
        ),
    ] {
        sqlx::query(
            "INSERT INTO users \
             (id, email, normalized_email, display_name, status, is_instance_admin, disabled_at, updated_at) \
             VALUES ($1::uuid, $2, $3, $4, $5, $6, \
                     CASE WHEN $7 THEN transaction_timestamp() ELSE NULL END, transaction_timestamp())",
        )
        .bind(id)
        .bind(email)
        .bind(normalized)
        .bind(display)
        .bind(status)
        .bind(id == ACTIVE_USER_ID)
        .bind(disabled)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
        if credential {
            sqlx::query(
                "INSERT INTO local_password_credentials (user_id, password_verifier) \
                 VALUES ($1::uuid, $2)",
            )
            .bind(id)
            .bind(PASSWORD_HASH)
            .execute(&mut *acquire(pool).await)
            .await
            .unwrap();
        }
    }
}

async fn audit_count(pool: &DatabasePool, action: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action_code = $1")
        .bind(action)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn session_count(pool: &DatabasePool, user_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1::uuid")
        .bind(user_id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn execute(pool: &DatabasePool, statement: &'static str) {
    sqlx::query(statement)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
}

async fn migrate(pool: &DatabasePool) {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
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
