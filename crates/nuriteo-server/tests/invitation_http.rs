use std::env;
use std::fs;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_TYPE, COOKIE, ORIGIN, SET_COOKIE};
use axum::http::{HeaderValue, Method, Request, Response, StatusCode};
use nuriteo_server::app::build_router_with_all_services;
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::{SessionPolicy, UserId};
use nuriteo_server::invitations::{InvitationHttpPolicy, InvitationHttpService};
use serde_json::{Value, json};
use tower::ServiceExt;
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const ORIGIN_VALUE: &str = "http://localhost:3000";
const REQUEST_ID: &str = "request:invitation-http-fixture";
const PASSWORD: &str = "correct horse battery staple";
const NEW_PASSWORD: &str = "new invited account password";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";

#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-invitation-http/run.sh"]
async fn invitation_http_slice_is_authorized_atomic_one_time_and_secret_free() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    migrate(&pool).await;
    let (admin_id, member_id) = seed_users(&pool).await;
    let router = router(pool.clone());
    let admin = login(&router, "admin@example.test", PASSWORD).await;
    let member = login(&router, "member@example.test", PASSWORD).await;

    verify_authorization(&router, &pool, &admin, &member, admin_id).await;
    verify_reissue_revoke_and_one_time_url(&router, &pool, &admin).await;
    verify_activation_login_and_replay(&router, &pool, &admin).await;
    verify_expiry(&router, &pool, &admin).await;
    verify_forced_rollback(&router, &pool, &admin).await;
    verify_no_secret_persistence(&pool).await;
    verify_email_queued_delivery_contract(&router, &pool, &admin).await;

    assert_eq!(user_exists(&pool, member_id).await, 1);
    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_email_queued_delivery_contract(
    router: &Router,
    pool: &DatabasePool,
    admin: &Browser,
) {
    set_smtp_enabled(pool, true).await;
    let issued = issue(router, admin, "mail-queued@example.test", 3_600).await;
    assert_eq!(issued["delivery"], "email_queued");
    assert!(issued["activation_url"].is_null());

    let replacement = admin_json(
        router,
        Some(admin),
        Method::POST,
        &format!(
            "/api/v1/admin/activation-invitations/{}/reissue",
            issued["id"].as_str().unwrap()
        ),
        json!({"expires_in_seconds": 3600}),
    )
    .await;
    assert_eq!(replacement.status(), StatusCode::OK);
    let replacement = json_body(replacement).await;
    assert_eq!(replacement["delivery"], "email_queued");
    assert!(replacement["activation_url"].is_null());

    let queued: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM email_outbox WHERE resource_type='activation_invitation'",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(queued, 2);
    set_smtp_enabled(pool, false).await;
}

async fn set_smtp_enabled(pool: &DatabasePool, enabled: bool) {
    sqlx::query(
        "UPDATE instance_settings SET value=to_jsonb($1::boolean), \
         updated_at=transaction_timestamp(), lock_version=lock_version+1 \
         WHERE key='smtp.enabled'",
    )
    .bind(enabled)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
}

#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
}

async fn verify_authorization(
    router: &Router,
    pool: &DatabasePool,
    admin: &Browser,
    member: &Browser,
    admin_id: UserId,
) {
    assert_problem(
        admin_json(
            router,
            None,
            Method::POST,
            "/api/v1/admin/activation-invitations",
            json!({"email":"missing@example.test"}),
        )
        .await,
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_problem(
        admin_json(
            router,
            Some(member),
            Method::POST,
            "/api/v1/admin/activation-invitations",
            json!({"email":"member-denied@example.test"}),
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;

    let no_csrf = send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/admin/activation-invitations")
            .header("x-request-id", REQUEST_ID)
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, ORIGIN_VALUE)
            .header(COOKIE, &admin.cookie)
            .body(Body::from(r#"{"email":"csrf-denied@example.test"}"#))
            .unwrap(),
    )
    .await;
    assert_problem(no_csrf, StatusCode::FORBIDDEN).await;

    let mut duplicate_cookie = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/admin/activation-invitations")
        .header("x-request-id", REQUEST_ID)
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, ORIGIN_VALUE)
        .header("x-csrf-token", &admin.csrf)
        .header(COOKIE, &admin.cookie)
        .body(Body::from(r#"{"email":"duplicate@example.test"}"#))
        .unwrap();
    duplicate_cookie
        .headers_mut()
        .append(COOKIE, HeaderValue::from_str(&admin.cookie).unwrap());
    assert_problem(send(router, duplicate_cookie).await, StatusCode::FORBIDDEN).await;

    sqlx::query("UPDATE users SET status = 'disabled', disabled_at = transaction_timestamp(), updated_at = transaction_timestamp() WHERE id = $1::uuid")
        .bind(admin_id.to_string()).execute(&mut *acquire(pool).await).await.unwrap();
    assert_problem(
        admin_empty(
            router,
            admin,
            Method::GET,
            "/api/v1/admin/activation-invitations",
        )
        .await,
        StatusCode::UNAUTHORIZED,
    )
    .await;
    sqlx::query("UPDATE users SET status = 'active', disabled_at = NULL, updated_at = transaction_timestamp() WHERE id = $1::uuid")
        .bind(admin_id.to_string()).execute(&mut *acquire(pool).await).await.unwrap();
}

async fn verify_reissue_revoke_and_one_time_url(
    router: &Router,
    pool: &DatabasePool,
    admin: &Browser,
) {
    let issued = issue(router, admin, "replace@example.test", 3_600).await;
    let original_url = issued["activation_url"].as_str().unwrap().to_owned();
    let original_token = activation_token(&original_url);
    assert!(original_url.starts_with("http://localhost:3000/activate?token="));
    let id = issued["id"].as_str().unwrap();

    let listed = admin_empty(
        router,
        admin,
        Method::GET,
        "/api/v1/admin/activation-invitations",
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let listed = json_body(listed).await;
    let serialized = listed.to_string();
    assert!(serialized.contains("replace@example.test"));
    assert!(!serialized.contains(&original_token));
    assert!(!serialized.contains("activation_url"));

    let replacement = admin_json(
        router,
        Some(admin),
        Method::POST,
        &format!("/api/v1/admin/activation-invitations/{id}/reissue"),
        json!({"expires_in_seconds": 7200}),
    )
    .await;
    assert_eq!(replacement.status(), StatusCode::OK);
    let replacement = json_body(replacement).await;
    let replacement_id = replacement["id"].as_str().unwrap();
    let replacement_token = activation_token(replacement["activation_url"].as_str().unwrap());
    assert_ne!(original_token, replacement_token);
    assert_eq!(invitation_status(pool, id).await, "superseded");

    let old_activation = activate(
        router,
        &original_token,
        "replace@example.test",
        NEW_PASSWORD,
    )
    .await;
    assert_problem(old_activation, StatusCode::UNPROCESSABLE_ENTITY).await;

    let revoked = admin_empty(
        router,
        admin,
        Method::DELETE,
        &format!("/api/v1/admin/activation-invitations/{replacement_id}"),
    )
    .await;
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let revoked_activation = activate(
        router,
        &replacement_token,
        "replace@example.test",
        NEW_PASSWORD,
    )
    .await;
    assert_problem(revoked_activation, StatusCode::UNPROCESSABLE_ENTITY).await;
}

async fn verify_activation_login_and_replay(router: &Router, pool: &DatabasePool, admin: &Browser) {
    let issued = issue(router, admin, "Invited@Example.test", 604_800).await;
    let token = activation_token(issued["activation_url"].as_str().unwrap());
    let response = activate(router, &token, "Invited@Example.test", NEW_PASSWORD).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 0);
    assert!(
        to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty()
    );

    let (user_count, credential_count, scope_count): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM users WHERE normalized_email = 'invited@example.test'), \
                (SELECT COUNT(*) FROM local_password_credentials c JOIN users u ON u.id = c.user_id WHERE u.normalized_email = 'invited@example.test'), \
                (SELECT COUNT(*) FROM storage_scopes s JOIN users u ON u.id = s.owner_user_id WHERE u.normalized_email = 'invited@example.test')",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!((user_count, credential_count, scope_count), (1, 1, 1));
    let invited = login(router, "invited@example.test", NEW_PASSWORD).await;
    assert!(invited.cookie.contains("nuriteo_dev_session="));

    let replay = activate(router, &token, "Invited@Example.test", NEW_PASSWORD).await;
    assert_problem(replay, StatusCode::UNPROCESSABLE_ENTITY).await;
}

async fn verify_expiry(router: &Router, pool: &DatabasePool, admin: &Browser) {
    let issued = issue(router, admin, "expired@example.test", 3_600).await;
    let token = activation_token(issued["activation_url"].as_str().unwrap());
    let id = issued["id"].as_str().unwrap();
    execute(pool, "ALTER TABLE activation_invitations DISABLE TRIGGER activation_invitations_forward_only_update").await;
    sqlx::query("UPDATE activation_invitations SET created_at = transaction_timestamp() - INTERVAL '2 hours', expires_at = transaction_timestamp() - INTERVAL '1 hour' WHERE id = $1::uuid")
        .bind(id).execute(&mut *acquire(pool).await).await.unwrap();
    execute(pool, "ALTER TABLE activation_invitations ENABLE TRIGGER activation_invitations_forward_only_update").await;
    let response = activate(router, &token, "expired@example.test", NEW_PASSWORD).await;
    assert_problem(response, StatusCode::UNPROCESSABLE_ENTITY).await;
    assert_eq!(invitation_status(pool, id).await, "expired");
}

async fn verify_forced_rollback(router: &Router, pool: &DatabasePool, admin: &Browser) {
    let issued = issue(router, admin, "rollback@example.test", 604_800).await;
    let token = activation_token(issued["activation_url"].as_str().unwrap());
    let id = issued["id"].as_str().unwrap();
    execute(pool, "CREATE FUNCTION reject_activation_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_user_id AND normalized_email = 'rollback@example.test') THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$").await;
    execute(pool, "CREATE TRIGGER reject_activation_scope BEFORE INSERT ON storage_scopes FOR EACH ROW EXECUTE FUNCTION reject_activation_scope()").await;
    let response = activate(router, &token, "rollback@example.test", NEW_PASSWORD).await;
    assert_problem(response, StatusCode::UNPROCESSABLE_ENTITY).await;
    assert_eq!(email_user_count(pool, "rollback@example.test").await, 0);
    assert_eq!(invitation_status(pool, id).await, "pending");
    execute(
        pool,
        "DROP TRIGGER reject_activation_scope ON storage_scopes",
    )
    .await;
    execute(pool, "DROP FUNCTION reject_activation_scope()").await;
}

async fn verify_no_secret_persistence(pool: &DatabasePool) {
    let durable: String = sqlx::query_scalar(
        "SELECT COALESCE((SELECT string_agg(row_to_json(i)::text, '') FROM activation_invitations i), '') || COALESCE((SELECT string_agg(row_to_json(a)::text, '') FROM audit_events a), '')",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    for secret in [PASSWORD, NEW_PASSWORD, "nrt_inv_"] {
        assert!(!durable.contains(secret), "durable state leaked {secret}");
    }
}

fn router(pool: DatabasePool) -> Router {
    let external_url = Url::parse(ORIGIN_VALUE).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let invitations = InvitationHttpService::production(
        pool,
        &external_url,
        InvitationHttpPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    build_router_with_all_services(HealthService::unconfigured(), auth, invitations)
}

async fn issue(router: &Router, admin: &Browser, email: &str, expiry: u64) -> Value {
    let response = admin_json(
        router,
        Some(admin),
        Method::POST,
        "/api/v1/admin/activation-invitations",
        json!({"email": email, "expires_in_seconds": expiry}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    json_body(response).await
}

async fn activate(router: &Router, token: &str, email: &str, password: &str) -> Response<Body> {
    send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/activation")
            .header("x-request-id", REQUEST_ID)
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, ORIGIN_VALUE)
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "token": token,
                    "email": email,
                    "display_name": "Invited member",
                    "password": password
                }))
                .unwrap(),
            ))
            .unwrap(),
    )
    .await
}

async fn admin_json(
    router: &Router,
    browser: Option<&Browser>,
    method: Method,
    uri: &str,
    body: Value,
) -> Response<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-request-id", REQUEST_ID)
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, ORIGIN_VALUE);
    if let Some(browser) = browser {
        request = request
            .header(COOKIE, &browser.cookie)
            .header("x-csrf-token", &browser.csrf);
    }
    send(
        router,
        request
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
    )
    .await
}

async fn admin_empty(
    router: &Router,
    browser: &Browser,
    method: Method,
    uri: &str,
) -> Response<Body> {
    send(
        router,
        Request::builder()
            .method(method)
            .uri(uri)
            .header("x-request-id", REQUEST_ID)
            .header(ORIGIN, ORIGIN_VALUE)
            .header(COOKIE, &browser.cookie)
            .header("x-csrf-token", &browser.csrf)
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

async fn login(router: &Router, email: &str, password: &str) -> Browser {
    let response = send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/sessions")
            .header("x-request-id", REQUEST_ID)
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, ORIGIN_VALUE)
            .body(Body::from(
                serde_json::to_vec(&json!({"email": email, "password": password})).unwrap(),
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
    let csrf = pairs
        .iter()
        .find_map(|pair| pair.strip_prefix("nuriteo_dev_csrf="))
        .unwrap()
        .to_owned();
    Browser {
        cookie: pairs.join("; "),
        csrf,
    }
}

fn activation_token(url: &str) -> String {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
        .unwrap()
}

async fn send(router: &Router, request: Request<Body>) -> Response<Body> {
    router.clone().oneshot(request).await.unwrap()
}

async fn assert_problem(response: Response<Body>, status: StatusCode) {
    if response.status() != status {
        let actual = response.status();
        let body = json_body(response).await;
        panic!("expected {status}, got {actual}: {body}");
    }
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    let body = json_body(response).await;
    assert_eq!(body["status"], status.as_u16());
    let rendered = body.to_string();
    for secret in [
        PASSWORD,
        NEW_PASSWORD,
        PASSWORD_HASH,
        "nrt_inv_",
        "postgres://",
    ] {
        assert!(!rendered.contains(secret), "problem leaked {secret}");
    }
}

async fn json_body(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap()
}

async fn seed_users(pool: &DatabasePool) -> (UserId, UserId) {
    let admin = UserId::new();
    let member = UserId::new();
    for (id, email, display, admin_flag) in [
        (admin, "admin@example.test", "Admin", true),
        (member, "member@example.test", "Member", false),
    ] {
        sqlx::query("INSERT INTO users (id, email, normalized_email, display_name, is_instance_admin) VALUES ($1::uuid, $2, $2, $3, $4)")
            .bind(id.to_string()).bind(email).bind(display).bind(admin_flag)
            .execute(&mut *acquire(pool).await).await.unwrap();
        sqlx::query("INSERT INTO local_password_credentials (user_id, password_verifier) VALUES ($1::uuid, $2)")
            .bind(id.to_string()).bind(PASSWORD_HASH)
            .execute(&mut *acquire(pool).await).await.unwrap();
    }
    (admin, member)
}

async fn invitation_status(pool: &DatabasePool, id: &str) -> String {
    sqlx::query_scalar("SELECT status FROM activation_invitations WHERE id = $1::uuid")
        .bind(id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn email_user_count(pool: &DatabasePool, email: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE normalized_email = $1")
        .bind(email)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn user_exists(pool: &DatabasePool, id: UserId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1::uuid")
        .bind(id.to_string())
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
    execute(pool, "DROP SCHEMA public CASCADE").await;
    execute(pool, "CREATE SCHEMA public").await;
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        12,
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
