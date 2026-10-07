use std::env;
use std::fs;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, ORIGIN, SET_COOKIE};
use axum::http::{Method, Request, Response, StatusCode};
use nuriteo_server::admin::{AdminHttpPolicy, AdminHttpService};
use nuriteo_server::app::build_router_with_admin_service;
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::config::InstanceSettingBootstrap;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::{SessionPolicy, UserId};
use nuriteo_server::instance_settings::InstanceSettingsRepository;
use nuriteo_server::invitations::InvitationHttpService;
use nuriteo_server::organization::OrganizationHttpService;
use nuriteo_server::project::ProjectHttpService;
use nuriteo_server::save::SaveHttpService;
use nuriteo_server::setup::SetupStatusService;
use serde_json::{Value, json};
use tower::ServiceExt;
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const ORIGIN_VALUE: &str = "http://localhost:3000";
const REQUEST_ID: &str = "request:admin-http-fixture";
const PASSWORD: &str = "correct horse battery staple";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";
const SETTING_PATH: &str = "/api/v1/admin/settings/invitations.default_expiry_hours";

#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-admin-http/run.sh"]
async fn admin_settings_http_is_authorized_reauthenticated_versioned_and_audited() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(23));
    let admin_id = seed_user(&pool, "admin@example.test", true).await;
    seed_user(&pool, "member@example.test", false).await;
    let settings = InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    let router = router(pool.clone(), settings);
    let admin = login(&router, "admin@example.test").await;
    let member = login(&router, "member@example.test").await;

    assert_problem(
        request(
            &router,
            None,
            Method::GET,
            "/api/v1/admin/settings",
            None,
            None,
        )
        .await,
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_problem(
        request(
            &router,
            Some(&member),
            Method::GET,
            "/api/v1/admin/settings",
            None,
            None,
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;

    let response = request(
        &router,
        Some(&admin),
        Method::GET,
        "/api/v1/admin/settings",
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[CACHE_CONTROL], "private, no-store");
    let listed = json_body(response).await;
    assert_eq!(listed["registryVersion"], 1);
    assert_eq!(listed["items"].as_array().unwrap().len(), 10);
    assert!(!listed.to_string().contains("password"));

    assert_problem(
        request(
            &router,
            Some(&admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 336})),
            None,
        )
        .await,
        StatusCode::PRECONDITION_REQUIRED,
    )
    .await;
    let mut bad_csrf = admin.clone();
    bad_csrf.csrf = "wrong-csrf".into();
    assert_problem(
        request(
            &router,
            Some(&bad_csrf),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 336})),
            Some("\"setting-v1\""),
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;
    assert_problem(
        request(
            &router,
            Some(&admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 336})),
            Some("\"setting-v9\""),
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;

    sqlx::query(
        "UPDATE sessions SET last_seen_at = transaction_timestamp(), \
             last_reauthenticated_at = transaction_timestamp() \
         WHERE user_id = $1::uuid AND revoked_at IS NULL",
    )
    .bind(admin_id.to_string())
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    assert_problem(
        request(
            &router,
            Some(&admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 336})),
            Some("\"setting-v9\""),
        )
        .await,
        StatusCode::PRECONDITION_FAILED,
    )
    .await;
    assert_problem(
        request(
            &router,
            Some(&admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 9999})),
            Some("\"setting-v1\""),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    assert_problem(
        request(
            &router,
            Some(&admin),
            Method::PATCH,
            "/api/v1/admin/settings/not.registered",
            Some(json!({"value": 1})),
            Some("\"setting-v1\""),
        )
        .await,
        StatusCode::NOT_FOUND,
    )
    .await;

    let updated = request(
        &router,
        Some(&admin),
        Method::PATCH,
        SETTING_PATH,
        Some(json!({"value": 336})),
        Some("\"setting-v1\""),
    )
    .await;
    assert_eq!(updated.status(), StatusCode::OK);
    assert_eq!(updated.headers()[ETAG], "\"setting-v2\"");
    assert_eq!(updated.headers()[CACHE_CONTROL], "private, no-store");
    let updated = json_body(updated).await;
    assert_eq!(updated["value"], 336);
    assert_eq!(updated["version"], 2);
    assert_eq!(updated["applyMode"], "live");

    assert_problem(
        request(
            &router,
            Some(&admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 168})),
            Some("\"setting-v1\""),
        )
        .await,
        StatusCode::PRECONDITION_FAILED,
    )
    .await;
    let persisted: (String, i64) = sqlx::query_as(
        "SELECT value::text, lock_version FROM instance_settings \
         WHERE key = 'invitations.default_expiry_hours'",
    )
    .fetch_one(&mut *acquire(&pool).await)
    .await
    .unwrap();
    assert_eq!(persisted, ("336".into(), 2));
    let audit: (i64, String, Vec<String>) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(MAX(metadata::text), '{}'), \
                COALESCE(MAX(changed_fields), ARRAY[]::text[]) \
         FROM audit_events WHERE action_code = 'instance.setting_updated'",
    )
    .fetch_one(&mut *acquire(&pool).await)
    .await
    .unwrap();
    assert_eq!(audit.0, 1);
    assert_eq!(
        serde_json::from_str::<Value>(&audit.1).unwrap(),
        json!({"source": "admin-settings-api"})
    );
    assert_eq!(audit.2, vec!["invitations.default_expiry_hours"]);

    sqlx::query(
        "UPDATE instance_settings SET value = '15'::jsonb \
         WHERE key = 'security.reauthentication_window_minutes'",
    )
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE sessions SET created_at = transaction_timestamp() - INTERVAL '1 hour', \
             last_reauthenticated_at = transaction_timestamp() - INTERVAL '20 minutes', \
             last_seen_at = transaction_timestamp() \
         WHERE user_id = $1::uuid AND revoked_at IS NULL",
    )
    .bind(admin_id.to_string())
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    assert_problem(
        request(
            &router,
            Some(&admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 337})),
            Some("\"setting-v2\""),
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;

    let status = request(
        &router,
        Some(&admin),
        Method::GET,
        "/api/v1/admin/status",
        None,
        None,
    )
    .await;
    assert_eq!(status.status(), StatusCode::OK);
    let status = json_body(status).await;
    assert_eq!(status["schemaVersion"], 23);
    assert_eq!(status["settingRegistryVersion"], 1);
    assert_eq!(status["settingCount"], 10);
    assert_eq!(status["restartRequired"], false);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
}

fn router(
    pool: DatabasePool,
    settings: nuriteo_server::instance_settings::EffectiveInstanceSettings,
) -> Router {
    let external_url = Url::parse(ORIGIN_VALUE).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let admin = AdminHttpService::production(
        pool,
        &external_url,
        AdminHttpPolicy::default(),
        SessionPolicy::default(),
        settings,
    )
    .unwrap();
    build_router_with_admin_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        ProjectHttpService::unconfigured(),
        SaveHttpService::unconfigured(),
        SetupStatusService::unconfigured(),
        admin,
    )
}

async fn login(router: &Router, email: &str) -> Browser {
    let response = send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/sessions")
            .header("x-request-id", REQUEST_ID)
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, ORIGIN_VALUE)
            .body(Body::from(
                serde_json::to_vec(&json!({"email": email, "password": PASSWORD})).unwrap(),
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

async fn request(
    router: &Router,
    browser: Option<&Browser>,
    method: Method,
    uri: &str,
    body: Option<Value>,
    if_match: Option<&str>,
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method.clone())
        .uri(uri)
        .header("x-request-id", REQUEST_ID);
    if let Some(browser) = browser {
        builder = builder.header(COOKIE, &browser.cookie);
        if method != Method::GET {
            builder = builder
                .header(ORIGIN, ORIGIN_VALUE)
                .header("x-csrf-token", &browser.csrf);
        }
    }
    if let Some(value) = if_match {
        builder = builder.header(IF_MATCH, value);
    }
    let body = match body {
        Some(value) => {
            builder = builder.header(CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&value).unwrap())
        }
        None => Body::empty(),
    };
    send(router, builder.body(body).unwrap()).await
}

async fn send(router: &Router, request: Request<Body>) -> Response<Body> {
    router.clone().oneshot(request).await.unwrap()
}

async fn assert_problem(response: Response<Body>, status: StatusCode) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    let body = json_body(response).await;
    assert_eq!(body["status"], status.as_u16());
    assert!(!body.to_string().contains(PASSWORD));
}

async fn json_body(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap()
}

async fn seed_user(pool: &DatabasePool, email: &str, admin: bool) -> UserId {
    let id = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, email, normalized_email, display_name, is_instance_admin) \
         VALUES ($1::uuid, $2, $2, $3, $4)",
    )
    .bind(id.to_string())
    .bind(email)
    .bind(email)
    .bind(admin)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO local_password_credentials (user_id, password_verifier) VALUES ($1::uuid, $2)",
    )
    .bind(id.to_string())
    .bind(PASSWORD_HASH)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    id
}

async fn reset_fixture(pool: &DatabasePool) {
    sqlx::query("DROP SCHEMA public CASCADE")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    sqlx::query("CREATE SCHEMA public")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
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
