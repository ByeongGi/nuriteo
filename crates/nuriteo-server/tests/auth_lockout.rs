use std::env;
use std::fs;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_TYPE, ORIGIN, SET_COOKIE};
use axum::http::{Method, Request, Response, StatusCode};
use nuriteo_server::app::build_router_with_services;
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::SessionPolicy;
use serde_json::{Value, json};
use tokio::task::JoinSet;
use tower::ServiceExt;
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const PASSWORD: &str = "correct horse battery staple";
const WRONG_PASSWORD: &str = "wrong horse battery staple";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";
const ORIGIN_VALUE: &str = "http://localhost:3000";
const THRESHOLD_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000501";
const CONCURRENT_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000502";
const RESET_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000503";
const ROLLBACK_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000504";
const SUCCESS_ROLLBACK_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000505";
const DISABLED_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000506";
const NO_CREDENTIAL_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000507";
const WINDOW_USER_ID: &str = "0199ee6c-c777-7000-8000-000000000508";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-auth-lockout/run.sh"]
async fn local_auth_lockout_is_atomic_bounded_and_enumeration_safe() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    migrate(&pool).await;
    seed_users(&pool).await;
    install_audit_rejection_trigger(&pool).await;

    let auth = AuthService::production(
        pool.clone(),
        &Url::parse(ORIGIN_VALUE).unwrap(),
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let router = build_router_with_services(HealthService::unconfigured(), auth);

    verify_unknown_and_ineligible_are_not_tracked(&router, &pool).await;
    verify_expired_window_starts_at_one(&router, &pool).await;
    verify_threshold_lock_and_expiry(&router, &pool).await;
    verify_success_resets_failure_state(&router, &pool).await;
    verify_concurrent_failures_converge(&router, &pool).await;
    verify_failure_audit_rollback(&router, &pool).await;
    verify_lock_audit_rollback(&router, &pool).await;
    verify_success_audit_rollback(&router, &pool).await;
    verify_persistence_is_secret_free(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_expired_window_starts_at_one(router: &Router, pool: &DatabasePool) {
    assert_generic_unauthorized(
        login_response(
            router,
            "window@example.test",
            WRONG_PASSWORD,
            "request:window-first",
        )
        .await,
    )
    .await;
    sqlx::query(
        "UPDATE local_auth_failures \
         SET window_started_at = transaction_timestamp() - INTERVAL '16 minutes', \
             last_failed_at = transaction_timestamp() - INTERVAL '16 minutes', \
             updated_at = transaction_timestamp() - INTERVAL '16 minutes' \
         WHERE user_id = $1::uuid",
    )
    .bind(WINDOW_USER_ID)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();

    assert_generic_unauthorized(
        login_response(
            router,
            "window@example.test",
            WRONG_PASSWORD,
            "request:window-expired",
        )
        .await,
    )
    .await;
    assert_eq!(failure_count(pool, WINDOW_USER_ID).await, Some(1));
    assert!(!is_locked(pool, WINDOW_USER_ID).await);
}

async fn verify_unknown_and_ineligible_are_not_tracked(router: &Router, pool: &DatabasePool) {
    let mut problems = Vec::new();
    for (email, password) in [
        ("unknown-lockout@example.test", PASSWORD),
        ("disabled-lockout@example.test", PASSWORD),
        ("oidc-lockout@example.test", PASSWORD),
        ("threshold@example.test", WRONG_PASSWORD),
    ] {
        let response = login_response(router, email, password, "request:generic").await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 0);
        problems.push(json_body(response).await);
    }
    for problem in &problems[1..] {
        assert_eq!(problem["code"], problems[0]["code"]);
        assert_eq!(problem["title"], problems[0]["title"]);
        assert_eq!(problem["detail"], problems[0]["detail"]);
    }
    assert_eq!(state_count(pool, DISABLED_USER_ID).await, 0);
    assert_eq!(state_count(pool, NO_CREDENTIAL_USER_ID).await, 0);
    assert_eq!(failure_count(pool, THRESHOLD_USER_ID).await, Some(1));
}

async fn verify_threshold_lock_and_expiry(router: &Router, pool: &DatabasePool) {
    for expected in 2..=5 {
        assert_generic_unauthorized(
            login_response(
                router,
                "threshold@example.test",
                WRONG_PASSWORD,
                "request:threshold",
            )
            .await,
        )
        .await;
        assert_eq!(failure_count(pool, THRESHOLD_USER_ID).await, Some(expected));
    }
    assert!(is_locked(pool, THRESHOLD_USER_ID).await);
    assert_eq!(lock_audit_count(pool, THRESHOLD_USER_ID).await, 1);
    let initial_locked_until = locked_until(pool, THRESHOLD_USER_ID).await;

    assert_generic_unauthorized(
        login_response(
            router,
            "threshold@example.test",
            PASSWORD,
            "request:locked-correct",
        )
        .await,
    )
    .await;
    assert_eq!(failure_count(pool, THRESHOLD_USER_ID).await, Some(5));
    assert_eq!(
        locked_until(pool, THRESHOLD_USER_ID).await,
        initial_locked_until
    );
    assert_eq!(lock_audit_count(pool, THRESHOLD_USER_ID).await, 1);

    sqlx::query(
        "UPDATE local_auth_failures \
         SET window_started_at = transaction_timestamp() - INTERVAL '31 minutes', \
             last_failed_at = transaction_timestamp() - INTERVAL '16 minutes', \
             locked_at = transaction_timestamp() - INTERVAL '16 minutes', \
             locked_until = transaction_timestamp() - INTERVAL '1 minute', \
             updated_at = transaction_timestamp() - INTERVAL '1 minute' \
         WHERE user_id = $1::uuid",
    )
    .bind(THRESHOLD_USER_ID)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();

    let response = login_response(
        router,
        "threshold@example.test",
        PASSWORD,
        "request:expired-lock",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 2);
    assert_eq!(state_count(pool, THRESHOLD_USER_ID).await, 0);
    assert_eq!(session_count(pool, THRESHOLD_USER_ID).await, 1);
}

async fn verify_success_resets_failure_state(router: &Router, pool: &DatabasePool) {
    for sequence in 0..2 {
        assert_generic_unauthorized(
            login_response(
                router,
                "reset@example.test",
                WRONG_PASSWORD,
                &format!("request:reset-failure-{sequence}"),
            )
            .await,
        )
        .await;
    }
    assert_eq!(failure_count(pool, RESET_USER_ID).await, Some(2));
    let response = login_response(
        router,
        "reset@example.test",
        PASSWORD,
        "request:reset-success",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(state_count(pool, RESET_USER_ID).await, 0);
    assert_eq!(session_count(pool, RESET_USER_ID).await, 1);
}

async fn verify_concurrent_failures_converge(router: &Router, pool: &DatabasePool) {
    let mut requests = JoinSet::new();
    for sequence in 0..12 {
        let router = router.clone();
        requests.spawn(async move {
            login_response(
                &router,
                "concurrent@example.test",
                WRONG_PASSWORD,
                &format!("request:concurrent-{sequence}"),
            )
            .await
            .status()
        });
    }
    while let Some(result) = requests.join_next().await {
        assert_eq!(result.unwrap(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(failure_count(pool, CONCURRENT_USER_ID).await, Some(5));
    assert!(is_locked(pool, CONCURRENT_USER_ID).await);
    assert_eq!(lock_audit_count(pool, CONCURRENT_USER_ID).await, 1);
}

async fn verify_failure_audit_rollback(router: &Router, pool: &DatabasePool) {
    set_audit_rejection(pool, "auth.login_failed", "request:failure-rollback").await;
    let response = login_response(
        router,
        "rollback@example.test",
        WRONG_PASSWORD,
        "request:failure-rollback",
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(state_count(pool, ROLLBACK_USER_ID).await, 0);
    assert_eq!(
        correlation_audit_count(pool, "request:failure-rollback").await,
        0
    );
    clear_audit_rejection(pool).await;
}

async fn verify_lock_audit_rollback(router: &Router, pool: &DatabasePool) {
    for sequence in 0..4 {
        assert_generic_unauthorized(
            login_response(
                router,
                "rollback@example.test",
                WRONG_PASSWORD,
                &format!("request:lock-precondition-{sequence}"),
            )
            .await,
        )
        .await;
    }
    assert_eq!(failure_count(pool, ROLLBACK_USER_ID).await, Some(4));
    set_audit_rejection(pool, "auth.login_locked", "request:lock-rollback").await;
    let response = login_response(
        router,
        "rollback@example.test",
        WRONG_PASSWORD,
        "request:lock-rollback",
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(failure_count(pool, ROLLBACK_USER_ID).await, Some(4));
    assert!(!is_locked(pool, ROLLBACK_USER_ID).await);
    assert_eq!(
        correlation_audit_count(pool, "request:lock-rollback").await,
        0
    );
    clear_audit_rejection(pool).await;
}

async fn verify_success_audit_rollback(router: &Router, pool: &DatabasePool) {
    for sequence in 0..2 {
        assert_generic_unauthorized(
            login_response(
                router,
                "success-rollback@example.test",
                WRONG_PASSWORD,
                &format!("request:success-precondition-{sequence}"),
            )
            .await,
        )
        .await;
    }
    set_audit_rejection(pool, "auth.login_succeeded", "request:success-rollback").await;
    let response = login_response(
        router,
        "success-rollback@example.test",
        PASSWORD,
        "request:success-rollback",
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(failure_count(pool, SUCCESS_ROLLBACK_USER_ID).await, Some(2));
    assert_eq!(session_count(pool, SUCCESS_ROLLBACK_USER_ID).await, 0);
    assert_eq!(
        correlation_audit_count(pool, "request:success-rollback").await,
        0
    );
    clear_audit_rejection(pool).await;
}

async fn verify_persistence_is_secret_free(pool: &DatabasePool) {
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = 'local_auth_failures' \
         ORDER BY ordinal_position",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(
        columns,
        [
            "user_id",
            "failure_count",
            "window_started_at",
            "last_failed_at",
            "locked_at",
            "locked_until",
            "updated_at",
        ]
    );
    let audit_text: String = sqlx::query_scalar(
        "SELECT COALESCE(string_agg(row_to_json(a)::text, ''), '') FROM audit_events a",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    for secret in [
        PASSWORD,
        WRONG_PASSWORD,
        PASSWORD_HASH,
        "unknown-lockout@example.test",
    ] {
        assert!(!audit_text.contains(secret));
    }
}

async fn install_audit_rejection_trigger(pool: &DatabasePool) {
    sqlx::query("CREATE TABLE fixture_audit_rejection (action_code text, correlation_id text)")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    sqlx::query(
        "CREATE FUNCTION reject_selected_auth_audit() RETURNS trigger \
         LANGUAGE plpgsql AS $function$ \
         BEGIN \
           IF EXISTS ( \
             SELECT 1 FROM fixture_audit_rejection r \
             WHERE r.action_code = NEW.action_code \
               AND r.correlation_id = NEW.correlation_id \
           ) \
           THEN RAISE EXCEPTION 'fixture audit rejection'; END IF; \
           RETURN NEW; \
         END \
         $function$",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_selected_auth_audit BEFORE INSERT ON audit_events \
         FOR EACH ROW EXECUTE FUNCTION reject_selected_auth_audit()",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
}

async fn set_audit_rejection(pool: &DatabasePool, action: &str, correlation_id: &str) {
    clear_audit_rejection(pool).await;
    sqlx::query(
        "INSERT INTO fixture_audit_rejection (action_code, correlation_id) VALUES ($1, $2)",
    )
    .bind(action)
    .bind(correlation_id)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
}

async fn clear_audit_rejection(pool: &DatabasePool) {
    sqlx::query("DELETE FROM fixture_audit_rejection")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
}

async fn login_response(
    router: &Router,
    email: &str,
    password: &str,
    request_id: &str,
) -> Response<Body> {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/auth/sessions")
                .header("x-request-id", request_id)
                .header(CONTENT_TYPE, "application/json")
                .header(ORIGIN, ORIGIN_VALUE)
                .body(Body::from(
                    serde_json::to_vec(&json!({"email": email, "password": password})).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn assert_generic_unauthorized(response: Response<Body>) {
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = json_body(response).await;
    assert_eq!(body["code"], "AUTHENTICATION_FAILED");
    let serialized = body.to_string();
    for secret in [PASSWORD, WRONG_PASSWORD, PASSWORD_HASH, "postgres://"] {
        assert!(!serialized.contains(secret));
    }
}

async fn json_body(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 16 * 1024).await.unwrap()).unwrap()
}

async fn failure_count(pool: &DatabasePool, user_id: &str) -> Option<i16> {
    sqlx::query_scalar("SELECT failure_count FROM local_auth_failures WHERE user_id = $1::uuid")
        .bind(user_id)
        .fetch_optional(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn locked_until(pool: &DatabasePool, user_id: &str) -> Option<time::OffsetDateTime> {
    sqlx::query_scalar("SELECT locked_until FROM local_auth_failures WHERE user_id = $1::uuid")
        .bind(user_id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn is_locked(pool: &DatabasePool, user_id: &str) -> bool {
    sqlx::query_scalar(
        "SELECT locked_until IS NOT NULL AND locked_until > transaction_timestamp() \
         FROM local_auth_failures WHERE user_id = $1::uuid",
    )
    .bind(user_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap()
}

async fn state_count(pool: &DatabasePool, user_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM local_auth_failures WHERE user_id = $1::uuid")
        .bind(user_id)
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

async fn lock_audit_count(pool: &DatabasePool, user_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events \
         WHERE action_code = 'auth.login_locked' AND target_id = $1",
    )
    .bind(user_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap()
}

async fn correlation_audit_count(pool: &DatabasePool, correlation_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE correlation_id = $1")
        .bind(correlation_id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn seed_users(pool: &DatabasePool) {
    for (id, email, display, status, disabled, credential) in [
        (
            THRESHOLD_USER_ID,
            "threshold@example.test",
            "Threshold",
            "active",
            false,
            true,
        ),
        (
            CONCURRENT_USER_ID,
            "concurrent@example.test",
            "Concurrent",
            "active",
            false,
            true,
        ),
        (
            RESET_USER_ID,
            "reset@example.test",
            "Reset",
            "active",
            false,
            true,
        ),
        (
            ROLLBACK_USER_ID,
            "rollback@example.test",
            "Rollback",
            "active",
            false,
            true,
        ),
        (
            SUCCESS_ROLLBACK_USER_ID,
            "success-rollback@example.test",
            "Success rollback",
            "active",
            false,
            true,
        ),
        (
            DISABLED_USER_ID,
            "disabled-lockout@example.test",
            "Disabled",
            "disabled",
            true,
            true,
        ),
        (
            NO_CREDENTIAL_USER_ID,
            "oidc-lockout@example.test",
            "OIDC only",
            "active",
            false,
            false,
        ),
        (
            WINDOW_USER_ID,
            "window@example.test",
            "Window",
            "active",
            false,
            true,
        ),
    ] {
        sqlx::query(
            "INSERT INTO users \
             (id, email, normalized_email, display_name, status, disabled_at, updated_at) \
             VALUES ($1::uuid, $2, lower($2), $3, $4, \
                     CASE WHEN $5 THEN transaction_timestamp() ELSE NULL END, \
                     transaction_timestamp())",
        )
        .bind(id)
        .bind(email)
        .bind(display)
        .bind(status)
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
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        16,
        Duration::from_secs(5),
        Duration::from_secs(2),
        DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap(),
    )
    .unwrap();
    DatabasePool::connect(config).await.unwrap()
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire().await.unwrap()
}
