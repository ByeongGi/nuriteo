use std::{env, fs, time::Duration};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_TYPE, COOKIE, ETAG, ORIGIN, SET_COOKIE};
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use nuriteo_server::admin::AdminHttpService;
use nuriteo_server::app::{build_router, build_router_with_team_service};
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::{SessionPolicy, UserId};
use nuriteo_server::invitations::InvitationHttpService;
use nuriteo_server::organization::{OrganizationHttpService, OrganizationId};
use nuriteo_server::project::ProjectHttpService;
use nuriteo_server::save::SaveHttpService;
use nuriteo_server::setup::SetupStatusService;
use nuriteo_server::team::{TeamHttpPolicy, TeamHttpService};
use serde_json::{Value, json};
use tower::ServiceExt;
use url::Url;

const ORGANIZATION_ID: &str = "0199ee6c-c777-7000-8000-000000000001";
const TEAM_ID: &str = "0199ee6c-c777-7000-8000-000000000002";
const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const ORIGIN_VALUE: &str = "http://localhost:3000";
const PASSWORD: &str = "correct horse battery staple";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";

#[tokio::test]
async fn team_routes_fail_closed_before_an_unconfigured_service_is_reached() {
    let cases = [
        (
            "GET",
            format!("/api/v1/organizations/{ORGANIZATION_ID}/teams?unknown=true"),
            None,
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
        ),
        (
            "PATCH",
            format!("/api/v1/organizations/{ORGANIZATION_ID}/teams/{TEAM_ID}"),
            Some(r#"{"displayName":"Platform"}"#),
            StatusCode::PRECONDITION_REQUIRED,
            "PRECONDITION_REQUIRED",
        ),
        (
            "POST",
            format!("/api/v1/organizations/{ORGANIZATION_ID}/teams"),
            Some(r#"{"slug":"platform","displayName":"Platform","extra":true}"#),
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
        ),
    ];

    for (method, uri, body, expected_status, expected_code) in cases {
        let mut request = Request::builder().method(method).uri(uri);
        if body.is_some() {
            request = request.header(CONTENT_TYPE, "application/json");
        }
        let response = build_router()
            .oneshot(request.body(Body::from(body.unwrap_or_default())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected_status);
        let problem = json_body(response).await;
        assert_eq!(problem["code"], expected_code);
        assert!(!problem.to_string().contains("team service"));
    }
}

#[tokio::test]
async fn team_mutation_rejects_non_json_before_authentication() {
    let response = build_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/organizations/{ORGANIZATION_ID}/teams/{TEAM_ID}/members"
                ))
                .header(CONTENT_TYPE, "text/plain")
                .body(Body::from("not-json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-team-http/run.sh"]
async fn team_http_journey_is_session_csrf_version_and_audit_safe() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    let owner = UserId::new();
    let member = UserId::new();
    let organization = OrganizationId::new();
    let other_organization = OrganizationId::new();
    for (id, email, name) in [
        (owner, "owner@example.test", "Owner"),
        (member, "member@example.test", "Member"),
    ] {
        sqlx::query(
            "INSERT INTO users (id,email,normalized_email,display_name) VALUES ($1::uuid,$2,$2,$3)",
        )
        .bind(id.to_string())
        .bind(email)
        .bind(name)
        .execute(&mut *acquire(&pool).await)
        .await
        .unwrap();
        sqlx::query("INSERT INTO local_password_credentials (user_id,password_verifier) VALUES ($1::uuid,$2)")
            .bind(id.to_string()).bind(PASSWORD_HASH)
            .execute(&mut *acquire(&pool).await).await.unwrap();
    }
    sqlx::query("INSERT INTO organizations (id,slug,display_name) VALUES ($1::uuid,'acme','Acme')")
        .bind(organization.to_string())
        .execute(&mut *acquire(&pool).await)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO organizations (id,slug,display_name) VALUES ($1::uuid,'other','Other')",
    )
    .bind(other_organization.to_string())
    .execute(&mut *acquire(&pool).await)
    .await
    .unwrap();
    for (user, role) in [(owner, "owner"), (member, "member")] {
        sqlx::query("INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ($1::uuid,$2::uuid,$3)")
            .bind(organization.to_string()).bind(user.to_string()).bind(role)
            .execute(&mut *acquire(&pool).await).await.unwrap();
    }
    sqlx::query("INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ($1::uuid,$2::uuid,'owner')")
        .bind(other_organization.to_string()).bind(owner.to_string())
        .execute(&mut *acquire(&pool).await).await.unwrap();

    let router = actual_router(pool.clone());
    let browser = login(&router).await;
    let collection = format!("/api/v1/organizations/{organization}/teams");
    let missing_csrf = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(&collection)
                .header(CONTENT_TYPE, "application/json")
                .header(ORIGIN, ORIGIN_VALUE)
                .header(COOKIE, &browser.cookie)
                .body(Body::from(
                    r#"{"slug":"platform","displayName":"Platform"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);

    let created = actual_json_request(
        &router,
        &browser,
        Method::POST,
        &collection,
        json!({"slug":"platform","displayName":"Platform"}),
        None,
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()[ETAG], "\"team-v1\"");
    assert_eq!(created.headers()["cache-control"], "private, no-store");
    let location = created.headers()["location"].to_str().unwrap().to_owned();
    let team_id = json_body(created).await["id"].as_str().unwrap().to_owned();
    let wrong_scope = format!("/api/v1/organizations/{other_organization}/teams/{team_id}");
    assert_eq!(
        actual_empty_request(&router, &browser, Method::GET, &wrong_scope, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        actual_json_request(
            &router,
            &browser,
            Method::PATCH,
            &wrong_scope,
            json!({"displayName":"Must Not Change"}),
            Some("\"team-v1\"")
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );

    let add = actual_json_request(
        &router,
        &browser,
        Method::POST,
        &format!("{location}/members"),
        json!({"userId":member.to_string(),"role":"member"}),
        None,
    )
    .await;
    assert_eq!(add.status(), StatusCode::CREATED);
    assert_eq!(add.headers()[ETAG], "\"team-member-v1\"");
    let changed = actual_json_request(
        &router,
        &browser,
        Method::PATCH,
        &format!("{location}/members/{member}"),
        json!({"role":"maintainer"}),
        Some("\"team-member-v1\""),
    )
    .await;
    assert_eq!(changed.status(), StatusCode::OK);
    assert_eq!(changed.headers()[ETAG], "\"team-member-v2\"");
    let stale = actual_json_request(
        &router,
        &browser,
        Method::PATCH,
        &format!("{location}/members/{member}"),
        json!({"role":"member"}),
        Some("\"team-member-v1\""),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::PRECONDITION_FAILED);
    let audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE target_type IN ('team','team_membership') AND target_id IN ($1,$2)")
        .bind(&team_id).bind(member.to_string()).fetch_one(&mut *acquire(&pool).await).await.unwrap();
    assert!(audit_count >= 3);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
}

fn actual_router(pool: DatabasePool) -> Router {
    let external_url = Url::parse(ORIGIN_VALUE).unwrap();
    let auth = AuthService::production(
        pool.clone(),
        &external_url,
        AuthPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    let teams = TeamHttpService::production(
        pool,
        &external_url,
        TeamHttpPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    build_router_with_team_service(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        ProjectHttpService::unconfigured(),
        SaveHttpService::unconfigured(),
        SetupStatusService::unconfigured(),
        AdminHttpService::unconfigured(),
        teams,
    )
}

async fn login(router: &Router) -> Browser {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/auth/sessions")
                .header(CONTENT_TYPE, "application/json")
                .header(ORIGIN, ORIGIN_VALUE)
                .body(Body::from(
                    serde_json::to_vec(&json!({"email":"owner@example.test","password":PASSWORD}))
                        .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
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

async fn actual_json_request(
    router: &Router,
    browser: &Browser,
    method: Method,
    uri: &str,
    body: Value,
    etag: Option<&str>,
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, ORIGIN_VALUE)
        .header(COOKIE, &browser.cookie)
        .header("x-csrf-token", &browser.csrf);
    if let Some(etag) = etag {
        builder = builder.header("if-match", etag);
    }
    router
        .clone()
        .oneshot(
            builder
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn actual_empty_request(
    router: &Router,
    browser: &Browser,
    method: Method,
    uri: &str,
    etag: Option<&str>,
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(ORIGIN, ORIGIN_VALUE)
        .header(COOKIE, &browser.cookie)
        .header("x-csrf-token", &browser.csrf);
    if let Some(etag) = etag {
        builder = builder.header("if-match", etag);
    }
    router
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn fixture_pool() -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(
        None,
        Some(fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap()),
        None,
    )
    .unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            env::var(DATABASE_URL_ENV).unwrap(),
            0,
            12,
            Duration::from_secs(5),
            Duration::from_secs(2),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
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
async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire().await.unwrap()
}

async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap()
}
