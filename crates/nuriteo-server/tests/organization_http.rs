use std::{env, fs, time::Duration};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, LOCATION, ORIGIN, SET_COOKIE};
use axum::http::{Method, Request, Response, StatusCode};
use nuriteo_server::app::build_router_with_http_services;
use nuriteo_server::auth::{AuthPolicy, AuthService};
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::health::HealthService;
use nuriteo_server::identity::{SessionPolicy, UserId};
use nuriteo_server::invitations::InvitationHttpService;
use nuriteo_server::organization::{OrganizationHttpPolicy, OrganizationHttpService};
use serde_json::{Value, json};
use tower::ServiceExt;
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const ORIGIN_VALUE: &str = "http://localhost:3000";
const REQUEST_ID: &str = "request:organization-http-fixture";
const PASSWORD: &str = "correct horse battery staple";
const PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$a25vd24tc2FsdC12YWx1ZQ$yERZcGD1B/gLkNTYDHwutSjFbbs93oG/oqH/OErHrm0";

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-organization-http/run.sh"]
async fn organization_http_journey_is_authorized_versioned_and_secret_free() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    migrate(&pool).await;
    let migration_version: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success")
            .fetch_one(&mut *acquire(&pool).await)
            .await
            .unwrap();
    assert!(migration_version >= 8);
    let users = seed_users(&pool).await;
    let router = router(pool.clone());
    let owner = login(&router, "owner@example.test").await;
    let member = login(&router, "member@example.test").await;
    let owner_two = login(&router, "owner-two@example.test").await;
    let outsider = login(&router, "outsider@example.test").await;

    assert_problem(
        json_request(
            &router,
            None,
            Method::POST,
            "/api/v1/organizations",
            json!({"slug":"denied","displayName":"Denied"}),
            None,
        )
        .await,
        StatusCode::UNAUTHORIZED,
    )
    .await;

    let created = json_request(
        &router,
        Some(&owner),
        Method::POST,
        "/api/v1/organizations",
        json!({"slug":"acme","displayName":"Acme"}),
        None,
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()[ETAG], "\"org-v1\"");
    let location = created.headers()[LOCATION].to_str().unwrap().to_owned();
    let created_body = response_json(created).await;
    assert_eq!(created_body["slug"], "acme");

    let owner_get = empty_request(&router, &owner, Method::GET, &location, None).await;
    assert_eq!(owner_get.status(), StatusCode::OK);
    assert_eq!(owner_get.headers()[ETAG], "\"org-v1\"");
    assert_eq!(
        empty_request(&router, &outsider, Method::GET, &location, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );

    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::PATCH,
            &location,
            json!({"displayName":"No precondition"}),
            None,
        )
        .await,
        StatusCode::PRECONDITION_REQUIRED,
    )
    .await;
    let updated = json_request(
        &router,
        Some(&owner),
        Method::PATCH,
        &location,
        json!({"displayName":"Acme Engineering"}),
        Some("\"org-v1\""),
    )
    .await;
    assert_eq!(updated.status(), StatusCode::OK);
    assert_eq!(updated.headers()[ETAG], "\"org-v2\"");
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::PATCH,
            &location,
            json!({"displayName":"Stale"}),
            Some("\"org-v1\""),
        )
        .await,
        StatusCode::PRECONDITION_FAILED,
    )
    .await;

    let invitations_path = format!("{location}/invitations");
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &invitations_path,
            json!({"email":" member@example.test","role":"member"}),
            None,
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    let issued = json_request(
        &router,
        Some(&owner),
        Method::POST,
        &invitations_path,
        json!({"email":"MeMbEr@Example.Test","role":"member"}),
        None,
    )
    .await;
    assert_eq!(issued.status(), StatusCode::CREATED);
    let issued = response_json(issued).await;
    let token = invitation_token(issued["acceptUrl"].as_str().unwrap());
    assert!(
        issued["acceptUrl"]
            .as_str()
            .unwrap()
            .starts_with("http://localhost:3000/organization-invitations/accept?token=")
    );
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &invitations_path,
            json!({"email":"member@example.test","role":"member"}),
            None,
        )
        .await,
        StatusCode::CONFLICT,
    )
    .await;
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &invitations_path,
            json!({"inviteeUserId":users.outsider.to_string(),"role":"member"}),
            None,
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &invitations_path,
            json!({"email":"owner@example.test","role":"member"}),
            None,
        )
        .await,
        StatusCode::CONFLICT,
    )
    .await;

    let missing_problem = safe_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &invitations_path,
            json!({"email":"missing@example.test","role":"member"}),
            None,
        )
        .await,
        StatusCode::NOT_FOUND,
    )
    .await;
    let inactive_problem = safe_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &invitations_path,
            json!({"email":"inactive@example.test","role":"member"}),
            None,
        )
        .await,
        StatusCode::NOT_FOUND,
    )
    .await;
    assert_eq!(missing_problem, inactive_problem);

    let listed = empty_request(&router, &owner, Method::GET, &invitations_path, None).await;
    assert_eq!(listed.status(), StatusCode::OK);
    let listed = response_json(listed).await.to_string();
    assert!(!listed.contains(&token));
    assert!(!listed.contains("acceptUrl"));
    assert!(!listed.contains("normalizedEmail"));

    assert_problem(
        json_request(
            &router,
            Some(&member),
            Method::POST,
            "/api/v1/me/organization-invitations/accept",
            json!({"token":token,"email":"attacker@example.test"}),
            None,
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;

    let accept = json_request(
        &router,
        Some(&member),
        Method::POST,
        "/api/v1/me/organization-invitations/accept",
        json!({"token":token}),
        None,
    )
    .await;
    assert_eq!(accept.status(), StatusCode::OK);
    assert_problem(
        json_request(
            &router,
            Some(&member),
            Method::POST,
            "/api/v1/me/organization-invitations/accept",
            json!({"token":token}),
            None,
        )
        .await,
        StatusCode::CONFLICT,
    )
    .await;

    let members_path = format!("{location}/members");
    let members = empty_request(&router, &member, Method::GET, &members_path, None).await;
    assert_eq!(members.status(), StatusCode::OK);
    let members = response_json(members).await.to_string();
    assert!(members.contains("Member"));
    assert!(!members.contains("@example.test"));
    let unauthorized_problem = safe_problem(
        json_request(
            &router,
            Some(&member),
            Method::POST,
            &invitations_path,
            json!({"email":"outsider@example.test","role":"member"}),
            None,
        )
        .await,
        StatusCode::NOT_FOUND,
    )
    .await;
    assert_eq!(missing_problem, unauthorized_problem);

    let owner_item = format!("{members_path}/{}", users.owner);
    assert_problem(
        empty_request(&router, &owner, Method::DELETE, &owner_item, None).await,
        StatusCode::CONFLICT,
    )
    .await;
    let member_item = format!("{members_path}/{}", users.member);
    assert_eq!(
        json_request(
            &router,
            Some(&owner),
            Method::PATCH,
            &member_item,
            json!({"role":"owner"}),
            None,
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        json_request(
            &router,
            Some(&owner),
            Method::PATCH,
            &member_item,
            json!({"role":"member"}),
            None,
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );

    let replaceable = json_request(
        &router,
        Some(&owner),
        Method::POST,
        &invitations_path,
        json!({"email":"outsider@example.test","role":"member"}),
        None,
    )
    .await;
    assert_eq!(replaceable.status(), StatusCode::CREATED);
    let replaceable = response_json(replaceable).await;
    let invitation_id = replaceable["id"].as_str().unwrap();
    let old_token = invitation_token(replaceable["acceptUrl"].as_str().unwrap());
    let reissue_path = format!("{invitations_path}/{invitation_id}/reissue");
    let replacement = json_request(
        &router,
        Some(&owner),
        Method::POST,
        &reissue_path,
        json!({"role":"member"}),
        None,
    )
    .await;
    assert_eq!(replacement.status(), StatusCode::OK);
    let replacement = response_json(replacement).await;
    let replacement_id = replacement["id"].as_str().unwrap();
    let replacement_token = invitation_token(replacement["acceptUrl"].as_str().unwrap());
    assert_ne!(old_token, replacement_token);
    let second = json_request(
        &router,
        Some(&owner),
        Method::POST,
        "/api/v1/organizations",
        json!({"slug":"second","displayName":"Second"}),
        None,
    )
    .await;
    let second_location = second.headers()[LOCATION].to_str().unwrap().to_owned();
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &format!("{second_location}/invitations/{replacement_id}/reissue"),
            json!({"role":"member"}),
            None,
        )
        .await,
        StatusCode::NOT_FOUND,
    )
    .await;
    let revoke_path = format!("{invitations_path}/{replacement_id}");
    assert_eq!(
        empty_request(&router, &owner, Method::DELETE, &revoke_path, None)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_problem(
        json_request(
            &router,
            Some(&outsider),
            Method::POST,
            "/api/v1/me/organization-invitations/accept",
            json!({"token":replacement_token}),
            None,
        )
        .await,
        StatusCode::CONFLICT,
    )
    .await;

    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &invitations_path,
            json!({"email":"owner-two@example.test","role":"owner"}),
            None,
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;
    set_reauthenticated(&pool, users.owner).await;
    let owner_invitation = json_request(
        &router,
        Some(&owner),
        Method::POST,
        &invitations_path,
        json!({"email":"owner-two@example.test","role":"owner"}),
        None,
    )
    .await;
    assert_eq!(owner_invitation.status(), StatusCode::CREATED);
    let owner_invitation = response_json(owner_invitation).await;
    let owner_token = invitation_token(owner_invitation["acceptUrl"].as_str().unwrap());
    assert_eq!(
        json_request(
            &router,
            Some(&owner_two),
            Method::POST,
            "/api/v1/me/organization-invitations/decline",
            json!({"token":owner_token}),
            None,
        )
        .await
        .status(),
        StatusCode::OK
    );

    set_smtp_enabled(&pool, true).await;
    let email_queued = json_request(
        &router,
        Some(&owner),
        Method::POST,
        &invitations_path,
        json!({"email":"owner-two@example.test","role":"member"}),
        None,
    )
    .await;
    assert_eq!(email_queued.status(), StatusCode::CREATED);
    let email_queued = response_json(email_queued).await;
    assert_eq!(email_queued["delivery"], "email_queued");
    assert!(email_queued["acceptUrl"].is_null());
    let queued_reissue = json_request(
        &router,
        Some(&owner),
        Method::POST,
        &format!(
            "{invitations_path}/{}/reissue",
            email_queued["id"].as_str().unwrap()
        ),
        json!({"role":"member"}),
        None,
    )
    .await;
    assert_eq!(queued_reissue.status(), StatusCode::OK);
    let queued_reissue = response_json(queued_reissue).await;
    assert_eq!(queued_reissue["delivery"], "email_queued");
    assert!(queued_reissue["acceptUrl"].is_null());
    set_smtp_enabled(&pool, false).await;

    let archive_path = format!("{location}/archive");
    let archived = empty_request(
        &router,
        &owner,
        Method::POST,
        &archive_path,
        Some("\"org-v2\""),
    )
    .await;
    assert_eq!(archived.status(), StatusCode::OK);
    assert_eq!(archived.headers()[ETAG], "\"org-v3\"");
    assert_problem(
        json_request(
            &router,
            Some(&owner),
            Method::POST,
            &invitations_path,
            json!({"email":"outsider@example.test","role":"member"}),
            None,
        )
        .await,
        StatusCode::CONFLICT,
    )
    .await;

    verify_no_secret_persistence(
        &pool,
        &[&token, &owner_token, &old_token, &replacement_token],
    )
    .await;
    verify_issue_audit(&pool, invitation_id).await;
    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
}

struct Users {
    owner: UserId,
    member: UserId,
    owner_two: UserId,
    outsider: UserId,
    inactive: UserId,
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
    let organizations = OrganizationHttpService::production(
        pool,
        &external_url,
        OrganizationHttpPolicy::default(),
        SessionPolicy::default(),
    )
    .unwrap();
    build_router_with_http_services(
        HealthService::unconfigured(),
        auth,
        InvitationHttpService::unconfigured(),
        organizations,
    )
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
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned())
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

async fn assert_problem(response: Response<Body>, status: StatusCode) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    let rendered = response_json(response).await.to_string();
    for secret in [PASSWORD, PASSWORD_HASH, "nrt_org_inv_", "postgres://"] {
        assert!(!rendered.contains(secret));
    }
}

async fn safe_problem(response: Response<Body>, status: StatusCode) -> Value {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
    let problem = response_json(response).await;
    let rendered = problem.to_string();
    for private_value in [
        PASSWORD,
        PASSWORD_HASH,
        "nrt_org_inv_",
        "postgres://",
        "missing@example.test",
        "inactive@example.test",
        "outsider@example.test",
    ] {
        assert!(!rendered.contains(private_value));
    }
    problem
}

fn invitation_token(url: &str) -> String {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find_map(|(k, v)| (k == "token").then(|| v.into_owned()))
        .unwrap()
}

async fn seed_users(pool: &DatabasePool) -> Users {
    let users = Users {
        owner: UserId::new(),
        member: UserId::new(),
        owner_two: UserId::new(),
        outsider: UserId::new(),
        inactive: UserId::new(),
    };
    for (id, email, display) in [
        (users.owner, "owner@example.test", "Owner"),
        (users.member, "member@example.test", "Member"),
        (users.owner_two, "owner-two@example.test", "Owner Two"),
        (users.outsider, "outsider@example.test", "Outsider"),
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
        sqlx::query("INSERT INTO local_password_credentials (user_id,password_verifier) VALUES ($1::uuid,$2)").bind(id.to_string()).bind(PASSWORD_HASH).execute(&mut *acquire(pool).await).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO users \
         (id,email,normalized_email,display_name,status,disabled_at) \
         VALUES ($1::uuid,'inactive@example.test','inactive@example.test','Inactive','disabled',transaction_timestamp())",
    )
    .bind(users.inactive.to_string())
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    users
}

async fn set_reauthenticated(pool: &DatabasePool, user_id: UserId) {
    sqlx::query("UPDATE sessions SET last_seen_at=transaction_timestamp(), last_reauthenticated_at=transaction_timestamp() WHERE user_id=$1::uuid AND revoked_at IS NULL").bind(user_id.to_string()).execute(&mut *acquire(pool).await).await.unwrap();
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

async fn verify_no_secret_persistence(pool: &DatabasePool, secrets: &[&str]) {
    let durable: String = sqlx::query_scalar("SELECT COALESCE((SELECT string_agg(row_to_json(i)::text,'') FROM organization_invitations i),'') || COALESCE((SELECT string_agg(row_to_json(a)::text,'') FROM audit_events a),'')").fetch_one(&mut *acquire(pool).await).await.unwrap();
    for secret in secrets {
        assert!(!durable.contains(*secret), "durable state leaked token");
    }
}

async fn verify_issue_audit(pool: &DatabasePool, invitation_id: &str) {
    let (action, result, metadata): (String, String, String) = sqlx::query_as(
        "SELECT action_code, result, metadata::text FROM audit_events \
         WHERE target_type='organization_invitation' AND target_id=$1 \
           AND action_code='organization.invitation_issued'",
    )
    .bind(invitation_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(action, "organization.invitation_issued");
    assert_eq!(result, "succeeded");
    for private_identity in ["outsider@example.test", "invitee_user_id"] {
        assert!(!metadata.contains(private_identity));
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
