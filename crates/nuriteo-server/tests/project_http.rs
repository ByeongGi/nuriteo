use std::{env, fs, time::Duration};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, ORIGIN, SET_COOKIE};
use axum::http::{Method, Request, Response, StatusCode};
use nuriteo_server::app::build_router_with_project_service;
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::{SessionPolicy, UserId};
use nuriteo_server::invitations::InvitationHttpService;
use nuriteo_server::organization::{OrganizationHttpService, OrganizationId};
use nuriteo_server::project::{ProjectHttpPolicy, ProjectHttpService};
use nuriteo_server::setup::SetupStatusService;
use nuriteo_server::workspace::StorageScopeId;
use serde_json::{Value, json};
use tower::ServiceExt;
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const ORIGIN_VALUE: &str = "http://localhost:3000";
const REQUEST_ID: &str = "request:project-http-fixture";
const PASSWORD: &str = "correct horse battery staple";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-project-http/run.sh"]
async fn project_http_journey_is_authorized_versioned_and_audited() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(13));
    let fixture = seed_fixture(&pool).await;
    let router = router(pool.clone());
    let owner = login(&router, "owner@example.test").await;
    let member = login(&router, "member@example.test").await;
    let admin = login(&router, "admin@example.test").await;
    let outsider = login(&router, "outsider@example.test").await;

    let personal_collection = format!("/api/v1/workspaces/users/{}/projects", fixture.owner);
    assert_problem(
        json_request(
            &router,
            None,
            Method::POST,
            &personal_collection,
            json!({"slug":"denied","name":"Denied"}),
            None,
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "AUTHENTICATION_FAILED",
    )
    .await;
    let personal = create(
        &router,
        &owner,
        &personal_collection,
        "personal",
        "Personal",
    )
    .await;
    let personal_location = personal.headers()[LOCATION].to_str().unwrap().to_owned();
    assert_eq!(personal.headers()[ETAG], "\"project-v1\"");
    assert_eq!(response_json(personal).await["state"], "active");
    assert_eq!(
        empty_request(&router, &outsider, Method::GET, &personal_location, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );

    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::PATCH,
            &personal_location,
            json!({"name":"No precondition"}),
            None,
        )
        .await,
        StatusCode::PRECONDITION_REQUIRED,
        "PRECONDITION_REQUIRED",
    )
    .await;
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::PATCH,
            &personal_location,
            json!({"name":"Weak"}),
            Some("W/\"project-v1\""),
        )
        .await,
        StatusCode::PRECONDITION_FAILED,
        "PRECONDITION_FAILED",
    )
    .await;
    let renamed = json_request(
        &router,
        Some(&owner),
        Method::PATCH,
        &personal_location,
        json!({"name":"Personal Renamed"}),
        Some("\"project-v1\""),
    )
    .await;
    assert_eq!(renamed.status(), StatusCode::OK);
    assert_eq!(renamed.headers()[ETAG], "\"project-v2\"");
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::PATCH,
            &personal_location,
            json!({"name":"Stale"}),
            Some("\"project-v1\""),
        )
        .await,
        StatusCode::PRECONDITION_FAILED,
        "PRECONDITION_FAILED",
    )
    .await;
    let archived = empty_request(
        &router,
        &owner,
        Method::POST,
        &format!("{personal_location}/archive"),
        Some("\"project-v2\""),
    )
    .await;
    assert_eq!(archived.status(), StatusCode::OK);
    assert_eq!(archived.headers()[ETAG], "\"project-v3\"");
    let active_list = empty_request(
        &router,
        &owner,
        Method::GET,
        &format!("{personal_collection}?state=active"),
        None,
    )
    .await;
    assert_eq!(
        response_json(active_list).await["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let restored = empty_request(
        &router,
        &owner,
        Method::POST,
        &format!("{personal_location}/restore"),
        Some("\"project-v3\""),
    )
    .await;
    assert_eq!(restored.headers()[ETAG], "\"project-v4\"");

    create(
        &router,
        &owner,
        &personal_collection,
        "personal-two",
        "Personal Two",
    )
    .await;
    let page = empty_request(
        &router,
        &owner,
        Method::GET,
        &format!("{personal_collection}?state=all&pageSize=1"),
        None,
    )
    .await;
    assert_eq!(page.status(), StatusCode::OK);
    let page = response_json(page).await;
    let cursor = page["nextCursor"].as_str().unwrap();
    assert!(cursor.starts_with("nrt_project_cursor_"));
    for uri in [
        format!("{personal_collection}?state=active&pageSize=1&cursor={cursor}"),
        format!("{personal_collection}?state=all&pageSize=2&cursor={cursor}"),
        format!(
            "/api/v1/workspaces/users/{}/projects?state=all&pageSize=1&cursor={cursor}",
            fixture.outsider
        ),
    ] {
        assert_problem(
            empty_request(&router, &owner, Method::GET, &uri, None).await,
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
        )
        .await;
    }
    assert_problem(
        empty_request(
            &router,
            &outsider,
            Method::GET,
            &format!("{personal_collection}?state=all&pageSize=1&cursor={cursor}"),
            None,
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION_FAILED",
    )
    .await;
    let mut tampered = cursor.to_owned();
    tampered.push('A');
    assert_problem(
        empty_request(
            &router,
            &owner,
            Method::GET,
            &format!("{personal_collection}?state=all&pageSize=1&cursor={tampered}"),
            None,
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION_FAILED",
    )
    .await;

    let org_collection = format!(
        "/api/v1/workspaces/organizations/{}/projects",
        fixture.organization
    );
    let shared = create(&router, &owner, &org_collection, "shared", "Shared").await;
    let shared_location = shared.headers()[LOCATION].to_str().unwrap().to_owned();
    let project_id = response_json(shared).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let roles = format!("{shared_location}/roles");
    let granted = json_request(
        &router,
        Some(&owner),
        Method::POST,
        &roles,
        json!({"userId":fixture.member,"role":"admin"}),
        Some("\"project-v1\""),
    )
    .await;
    assert_eq!(granted.status(), StatusCode::CREATED);
    assert_eq!(granted.headers()[ETAG], "\"project-v2\"");
    assert_problem(
        empty_request(&router, &member, Method::GET, &roles, None).await,
        StatusCode::FORBIDDEN,
        "REQUEST_FORBIDDEN",
    )
    .await;
    assert_problem(
        json_request(
            &router,
            Some(&member),
            Method::POST,
            &roles,
            json!({"userId":fixture.admin,"role":"read"}),
            Some("\"project-v2\""),
        )
        .await,
        StatusCode::FORBIDDEN,
        "REQUEST_FORBIDDEN",
    )
    .await;
    let listed = empty_request(&router, &owner, Method::GET, &roles, None).await;
    assert_eq!(response_json(listed).await["items"][0]["role"], "admin");
    let role = format!("{roles}/{}", fixture.member);
    let changed = json_request(
        &router,
        Some(&owner),
        Method::PATCH,
        &role,
        json!({"role":"write"}),
        Some("\"project-v2\""),
    )
    .await;
    assert_eq!(changed.headers()[ETAG], "\"project-v3\"");
    assert_problem(
        json_request(
            &router,
            Some(&admin),
            Method::POST,
            &roles,
            json!({"userId":fixture.admin,"role":"read"}),
            Some("\"project-v3\""),
        )
        .await,
        StatusCode::FORBIDDEN,
        "REQUEST_FORBIDDEN",
    )
    .await;
    let revoked = empty_request(
        &router,
        &owner,
        Method::DELETE,
        &role,
        Some("\"project-v3\""),
    )
    .await;
    assert_eq!(revoked.headers()[ETAG], "\"project-v4\"");
    assert_eq!(
        empty_request(&router, &member, Method::GET, &shared_location, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_problem(
        empty_request(&router, &admin, Method::GET, &roles, None).await,
        StatusCode::FORBIDDEN,
        "REQUEST_FORBIDDEN",
    )
    .await;

    set_reauthenticated(&pool, fixture.owner).await;
    let deleted = json_request(
        &router,
        Some(&owner),
        Method::DELETE,
        &personal_location,
        json!({"name":"Personal Renamed"}),
        Some("\"project-v4\""),
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    assert!(audit_count(&pool).await >= 8);
    assert_eq!(project_row_count(&pool, &project_id).await, 1);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

struct Fixture {
    owner: UserId,
    member: UserId,
    admin: UserId,
    outsider: UserId,
    organization: OrganizationId,
}

#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
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
    let projects = ProjectHttpService::production(
        pool,
        &external_url,
        ProjectHttpPolicy::default(),
        SessionPolicy::default(),
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

async fn create(
    router: &Router,
    browser: &Browser,
    collection: &str,
    slug: &str,
    name: &str,
) -> Response<Body> {
    let response = json_request(
        router,
        Some(browser),
        Method::POST,
        collection,
        json!({"slug":slug,"name":name}),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    response
}

async fn login(router: &Router, email: &str) -> Browser {
    let response = send(
        router,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/sessions")
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, ORIGIN_VALUE)
            .body(Body::from(
                serde_json::to_vec(&json!({"email":email,"password":PASSWORD})).unwrap(),
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

async fn json_request(
    router: &Router,
    browser: Option<&Browser>,
    method: Method,
    uri: &str,
    body: Value,
    etag: Option<&str>,
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-request-id", REQUEST_ID)
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, ORIGIN_VALUE);
    if let Some(browser) = browser {
        builder = builder
            .header(COOKIE, &browser.cookie)
            .header("x-csrf-token", &browser.csrf);
    }
    if let Some(etag) = etag {
        builder = builder.header(IF_MATCH, etag);
    }
    send(
        router,
        builder
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
    )
    .await
}

async fn empty_request(
    router: &Router,
    browser: &Browser,
    method: Method,
    uri: &str,
    etag: Option<&str>,
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-request-id", REQUEST_ID)
        .header(ORIGIN, ORIGIN_VALUE)
        .header(COOKIE, &browser.cookie)
        .header("x-csrf-token", &browser.csrf);
    if let Some(etag) = etag {
        builder = builder.header(IF_MATCH, etag);
    }
    send(router, builder.body(Body::empty()).unwrap()).await
}

async fn send(router: &Router, request: Request<Body>) -> Response<Body> {
    router.clone().oneshot(request).await.unwrap()
}

async fn response_json(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 128 * 1024).await.unwrap()).unwrap()
}

async fn assert_problem(response: Response<Body>, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    let body = response_json(response).await;
    assert_eq!(body["code"], code);
    let rendered = body.to_string();
    for secret in [
        PASSWORD,
        PASSWORD_HASH,
        "nrt_project_cursor_",
        "postgres://",
    ] {
        assert!(!rendered.contains(secret));
    }
}

async fn seed_fixture(pool: &DatabasePool) -> Fixture {
    let fixture = Fixture {
        owner: UserId::new(),
        member: UserId::new(),
        admin: UserId::new(),
        outsider: UserId::new(),
        organization: OrganizationId::new(),
    };
    for (id, email, display) in [
        (fixture.owner, "owner@example.test", "Owner"),
        (fixture.member, "member@example.test", "Member"),
        (fixture.admin, "admin@example.test", "Admin"),
        (fixture.outsider, "outsider@example.test", "Outsider"),
    ] {
        sqlx::query(
            "INSERT INTO users (id,email,normalized_email,display_name) VALUES ($1::uuid,$2,$2,$3)",
        )
        .bind(id.to_string())
        .bind(email)
        .bind(display)
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
        sqlx::query("INSERT INTO local_password_credentials (user_id,password_verifier) VALUES ($1::uuid,$2)")
            .bind(id.to_string()).bind(PASSWORD_HASH).execute(&mut *acquire(pool).await).await.unwrap();
    }
    sqlx::query("INSERT INTO organizations (id,slug,display_name) VALUES ($1::uuid,'project-http','Project HTTP')")
        .bind(fixture.organization.to_string()).execute(&mut *acquire(pool).await).await.unwrap();
    for (user, role) in [
        (fixture.owner, "owner"),
        (fixture.member, "member"),
        (fixture.admin, "member"),
    ] {
        sqlx::query("INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ($1::uuid,$2::uuid,$3)")
            .bind(fixture.organization.to_string()).bind(user.to_string()).bind(role).execute(&mut *acquire(pool).await).await.unwrap();
    }
    for user in [fixture.owner, fixture.outsider] {
        sqlx::query("INSERT INTO storage_scopes (id,owner_user_id) VALUES ($1::uuid,$2::uuid)")
            .bind(StorageScopeId::new().to_string())
            .bind(user.to_string())
            .execute(&mut *acquire(pool).await)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO storage_scopes (id,owner_organization_id) VALUES ($1::uuid,$2::uuid)")
        .bind(StorageScopeId::new().to_string())
        .bind(fixture.organization.to_string())
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    fixture
}

async fn set_reauthenticated(pool: &DatabasePool, user_id: UserId) {
    sqlx::query("UPDATE sessions SET last_seen_at=transaction_timestamp(), last_reauthenticated_at=created_at WHERE user_id=$1::uuid AND revoked_at IS NULL")
        .bind(user_id.to_string()).execute(&mut *acquire(pool).await).await.unwrap();
}

async fn audit_count(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action_code LIKE 'project.%'")
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap()
}

async fn project_row_count(pool: &DatabasePool, id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE id=$1::uuid")
        .bind(id)
        .fetch_one(&mut *acquire(pool).await)
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

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire().await.unwrap()
}
