#![allow(unused_imports)]
use super::*;
use super::settings::*;
use std::env;

use std::ffi::OsString;

use std::fs;

use std::io;

use std::path::Path;

use std::time::Duration;


use axum::Router;

use axum::body::{Body, to_bytes};

use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ETAG, IF_MATCH, ORIGIN, SET_COOKIE};

use axum::http::{Method, Request, Response, StatusCode};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

use nuriteo_server::admin::{AdminHttpPolicy, AdminHttpService};

use nuriteo_server::app::{MfaHttpService, build_router_with_mfa_service};

use nuriteo_server::audit::AuditEventId;

use nuriteo_server::auth::{AuthPolicy, AuthService};

use nuriteo_server::config::{Environment, FileReader, InstanceSettingBootstrap};

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use nuriteo_server::health::HealthService;

use nuriteo_server::identity::{SessionPolicy, UserId};

use nuriteo_server::instance_settings::InstanceSettingsRepository;

use nuriteo_server::integration::MasterKeyring;

use nuriteo_server::invitations::InvitationHttpService;

use nuriteo_server::organization::OrganizationHttpService;

use nuriteo_server::project::ProjectHttpService;

use nuriteo_server::save::{CleanupOperationsPolicy, CleanupOperationsService, SaveHttpService};

use nuriteo_server::setup::SetupStatusService;

use nuriteo_server::team::TeamHttpService;

use serde_json::{Value, json};

use tower::ServiceExt;

use url::Url;
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, ORIGIN_VALUE, REQUEST_ID, PASSWORD, PASSWORD_HASH, SETTING_PATH, Browser, TestEnvironment, NoFiles};



pub(crate) async fn verify_audit_query_export_and_retention(    router: &Router,
    pool: &DatabasePool,
    admin: &Browser,
    member: &Browser,
    admin_id: UserId,
) {
    assert_problem(
        request(
            router,
            Some(member),
            Method::GET,
            "/api/v1/admin/audit-events",
            None,
            None,
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;

    let mut ids = Vec::new();
    for (index, target_id) in ["=formula", "safe-two", "safe-three"].iter().enumerate() {
        let id = AuditEventId::new();
        ids.push(id.to_string());
        sqlx::query(
            "INSERT INTO audit_events (id, occurred_at, actor_type, actor_id, actor_user_id, \
             actor_display_name, action_code, target_type, target_id, scope_type, scope_id, \
             result, correlation_id, metadata) VALUES ( \
             $1::uuid, transaction_timestamp() - INTERVAL '400 days' + make_interval(secs => $2), \
             'user', $3, $3::uuid, 'Fixture Administrator', 'fixture.audit', 'fixture', $4, \
             'instance', 'instance', 'succeeded', $5, '{\"safe\":true}'::jsonb)",
        )
        .bind(id.to_string())
        .bind(i32::try_from(index).unwrap())
        .bind(admin_id.to_string())
        .bind(target_id)
        .bind(format!("fixture:audit-{index}"))
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE audit_events SET actor_user_id = NULL WHERE id = $1::uuid")
        .bind(&ids[0])
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();

    let first = request(
        router,
        Some(admin),
        Method::GET,
        "/api/v1/admin/audit-events?actionCode=fixture.audit&limit=2",
        None,
        None,
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()[CACHE_CONTROL], "private, no-store");
    let first = json_body(first).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 2);
    let cursor = first["nextCursor"].as_str().unwrap();
    assert!(!cursor.contains('=') && !cursor.contains('/'));
    let first_ids = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();

    let second = request(
        router,
        Some(admin),
        Method::GET,
        &format!("/api/v1/admin/audit-events?actionCode=fixture.audit&limit=2&cursor={cursor}"),
        None,
        None,
    )
    .await;
    assert_eq!(second.status(), StatusCode::OK);
    let second = json_body(second).await;
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert!(second["nextCursor"].is_null());
    let mut listed_ids = first_ids;
    listed_ids.push(second["items"][0]["id"].as_str().unwrap().to_owned());
    listed_ids.sort();
    ids.sort();
    assert_eq!(listed_ids, ids);

    let detail = request(
        router,
        Some(admin),
        Method::GET,
        &format!("/api/v1/admin/audit-events/{}", ids[0]),
        None,
        None,
    )
    .await;
    assert_eq!(detail.status(), StatusCode::OK);
    assert_eq!(json_body(detail).await["actionCode"], "fixture.audit");
    assert_problem(
        request(
            router,
            Some(admin),
            Method::GET,
            "/api/v1/admin/audit-events?cursor=not-canonical",
            None,
            None,
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
    )
    .await;

    let unsafe_id = AuditEventId::new();
    sqlx::query(
        "INSERT INTO audit_events (id, actor_type, actor_id, action_code, target_type, target_id, \
         scope_type, scope_id, result, correlation_id, metadata) VALUES ( \
         $1::uuid, 'system', 'fixture', 'fixture.unsafe', 'fixture', 'fixture', 'instance', \
         'instance', 'succeeded', 'fixture:unsafe', '{\"password\":\"must-not-leak\"}'::jsonb)",
    )
    .bind(unsafe_id.to_string())
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    let unsafe_response = request(
        router,
        Some(admin),
        Method::GET,
        "/api/v1/admin/audit-events?actionCode=fixture.unsafe",
        None,
        None,
    )
    .await;
    assert_eq!(unsafe_response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let unsafe_body = to_bytes(unsafe_response.into_body(), 64 * 1024)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&unsafe_body).contains("must-not-leak"));

    let jsonl = request(
        router,
        Some(admin),
        Method::POST,
        "/api/v1/admin/audit-events/export",
        Some(json!({"actionCode": "fixture.audit", "format": "jsonl"})),
        None,
    )
    .await;
    assert_eq!(jsonl.status(), StatusCode::OK);
    assert_eq!(
        jsonl.headers()[CONTENT_TYPE],
        "application/x-ndjson; charset=utf-8"
    );
    assert_eq!(
        jsonl.headers()["content-disposition"],
        "attachment; filename=\"nuriteo-audit.jsonl\""
    );
    let jsonl_body = to_bytes(jsonl.into_body(), 1024 * 1024).await.unwrap();
    let lines = String::from_utf8(jsonl_body.to_vec()).unwrap();
    assert_eq!(lines.lines().count(), 3);
    for line in lines.lines() {
        let event: Value = serde_json::from_str(line).unwrap();
        assert_eq!(event["actionCode"], "fixture.audit");
        assert!(!line.contains(PASSWORD));
    }

    let csv = request(
        router,
        Some(admin),
        Method::POST,
        "/api/v1/admin/audit-events/export",
        Some(json!({"actionCode": "fixture.audit", "format": "csv"})),
        None,
    )
    .await;
    assert_eq!(csv.status(), StatusCode::OK);
    assert_eq!(csv.headers()[CONTENT_TYPE], "text/csv; charset=utf-8");
    let csv_body = String::from_utf8(
        to_bytes(csv.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(csv_body.contains("\"'=formula\""));
    assert!(!csv_body.contains("\"=formula\""));
    let exported_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action_code = 'audit.exported'",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(exported_count, 2);
    sqlx::query(
        "CREATE FUNCTION reject_audit_export() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.action_code = 'audit.exported' THEN RAISE EXCEPTION 'fixture rejection'; \
         END IF; RETURN NEW; END $$",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_audit_export BEFORE INSERT ON audit_events \
         FOR EACH ROW EXECUTE FUNCTION reject_audit_export()",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_problem(
        request(
            router,
            Some(admin),
            Method::POST,
            "/api/v1/admin/audit-events/export",
            Some(json!({"actionCode": "fixture.audit", "format": "jsonl"})),
            None,
        )
        .await,
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    sqlx::query("DROP TRIGGER reject_audit_export ON audit_events")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION reject_audit_export()")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();

    let preview = request(
        router,
        Some(admin),
        Method::GET,
        "/api/v1/admin/audit-retention/preview?retentionDays=180",
        None,
        None,
    )
    .await;
    assert_eq!(preview.status(), StatusCode::OK);
    let preview = json_body(preview).await;
    assert_eq!(preview["retentionDays"], 180);
    assert_eq!(preview["deleteCount"], 3);
    assert_eq!(preview["shortRetentionWarning"], false);
    let short_preview = request(
        router,
        Some(admin),
        Method::GET,
        "/api/v1/admin/audit-retention/preview?retentionDays=179",
        None,
        None,
    )
    .await;
    assert_eq!(
        json_body(short_preview).await["shortRetentionWarning"],
        true
    );

    assert_problem(
        request(
            router,
            Some(admin),
            Method::POST,
            "/api/v1/admin/audit-retention/prune",
            Some(json!({"limit": 2})),
            None,
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
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "CREATE FUNCTION reject_audit_prune() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.action_code = 'audit.retention_pruned' THEN RAISE EXCEPTION 'fixture rejection'; \
         END IF; RETURN NEW; END $$",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_audit_prune BEFORE INSERT ON audit_events \
         FOR EACH ROW EXECUTE FUNCTION reject_audit_prune()",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_problem(
        request(
            router,
            Some(admin),
            Method::POST,
            "/api/v1/admin/audit-retention/prune",
            Some(json!({"limit": 2})),
            None,
        )
        .await,
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    let old_after_rollback: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events \
         WHERE action_code = 'fixture.audit' AND occurred_at < transaction_timestamp() - INTERVAL '365 days'",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(old_after_rollback, 3);
    sqlx::query("DROP TRIGGER reject_audit_prune ON audit_events")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION reject_audit_prune()")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    let first_prune = request(
        router,
        Some(admin),
        Method::POST,
        "/api/v1/admin/audit-retention/prune",
        Some(json!({"limit": 2})),
        None,
    )
    .await;
    assert_eq!(first_prune.status(), StatusCode::OK);
    let first_prune = json_body(first_prune).await;
    assert_eq!(first_prune["retentionDays"], 365);
    assert_eq!(first_prune["deletedCount"], 2);
    assert_eq!(first_prune["moreExpiredEvents"], true);

    let final_prune = request(
        router,
        Some(admin),
        Method::POST,
        "/api/v1/admin/audit-retention/prune",
        Some(json!({"limit": 1000})),
        None,
    )
    .await;
    assert_eq!(final_prune.status(), StatusCode::OK);
    let final_prune = json_body(final_prune).await;
    assert_eq!(final_prune["deletedCount"], 1);
    assert_eq!(final_prune["moreExpiredEvents"], false);
    let prune_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action_code = 'audit.retention_pruned'",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(prune_audits, 2);
}


pub(crate) fn router(    pool: DatabasePool,
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
    let health = HealthService::unconfigured();
    let cleanup = CleanupOperationsService::new(
        pool.clone(),
        CleanupOperationsPolicy::new(Duration::from_secs(600), 2, Duration::from_secs(1)).unwrap(),
    );
    let admin = AdminHttpService::production(
        pool.clone(),
        &external_url,
        AdminHttpPolicy::default(),
        SessionPolicy::default(),
        settings,
        health.clone(),
        cleanup,
    )
    .unwrap();
    let mfa = MfaHttpService::production(
        pool,
        &external_url,
        fixture_keyring(),
        SessionPolicy::default(),
    )
    .unwrap();
    build_router_with_mfa_service(
        health,
        auth,
        InvitationHttpService::unconfigured(),
        OrganizationHttpService::unconfigured(),
        ProjectHttpService::unconfigured(),
        SaveHttpService::unconfigured(),
        SetupStatusService::unconfigured(),
        admin,
        TeamHttpService::unconfigured(),
        mfa,
    )
}


pub(crate) fn fixture_keyring() -> MasterKeyring {    MasterKeyring::load(
        &TestEnvironment(vec![
            (
                "NURITEO_MASTER_KEY".into(),
                URL_SAFE_NO_PAD.encode([91_u8; 32]).into(),
            ),
            ("NURITEO_MASTER_KEY_VERSION".into(), "1".into()),
        ]),
        &NoFiles,
    )
    .unwrap()
}


impl Environment for TestEnvironment { fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}


impl FileReader for NoFiles { fn read(&self, _: &Path, _: usize) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::NotFound.into())
    }
}


pub(crate) async fn login(router: &Router, email: &str) -> Browser {    let response = send(
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


pub(crate) async fn request(    router: &Router,
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


pub(crate) async fn send(router: &Router, request: Request<Body>) -> Response<Body> {    router.clone().oneshot(request).await.unwrap()
}


pub(crate) async fn assert_problem(response: Response<Body>, status: StatusCode) {    let actual = response.status();
    let content_type = response.headers().get(CONTENT_TYPE).cloned();
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let body = serde_json::from_slice::<Value>(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    assert_eq!(actual, status, "unexpected problem response: {body}");
    assert_eq!(
        content_type.as_ref().and_then(|value| value.to_str().ok()),
        Some("application/problem+json"),
        "unexpected problem response: {body}"
    );
    assert_eq!(body["status"], status.as_u16());
    assert!(!body.to_string().contains(PASSWORD));
}


pub(crate) async fn json_body(response: Response<Body>) -> Value {    serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap()
}


pub(crate) async fn seed_user(pool: &DatabasePool, email: &str, admin: bool) -> UserId {    let id = UserId::new();
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


pub(crate) async fn reset_fixture(pool: &DatabasePool) {    sqlx::query("DROP SCHEMA public CASCADE")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    sqlx::query("CREATE SCHEMA public")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
}


pub(crate) async fn fixture_pool() -> DatabasePool {    let database_url = env::var(DATABASE_URL_ENV).unwrap();
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


pub(crate) async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {    pool.acquire().await.unwrap()
}

