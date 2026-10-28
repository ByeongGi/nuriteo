#![allow(unused_imports)]
use super::*;
use super::audit::*;
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



#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-admin-http/run.sh"]
pub(crate) async fn admin_settings_audit_and_operations_http_are_safe_and_transactional() {    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(51));
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
    assert_eq!(listed["registryVersion"], 4);
    assert_eq!(listed["items"].as_array().unwrap().len(), 40);
    let invitation_metadata = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["key"] == "invitations.default_expiry_hours")
        .unwrap();
    assert_eq!(invitation_metadata["defaultValue"], 168);
    assert_eq!(invitation_metadata["policyCategory"], "identity");
    assert_eq!(
        invitation_metadata["constraint"]["kind"],
        "unsigned_integer"
    );
    assert_eq!(invitation_metadata["constraint"]["minimum"], 1);
    assert_eq!(invitation_metadata["constraint"]["maximum"], 720);
    assert!(!listed.to_string().contains("smtp.password"));

    assert_problem(
        request(
            &router,
            Some(&member),
            Method::GET,
            "/api/v1/admin/operations",
            None,
            None,
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;
    let operations = request(
        &router,
        Some(&admin),
        Method::GET,
        "/api/v1/admin/operations",
        None,
        None,
    )
    .await;
    assert_eq!(operations.status(), StatusCode::OK);
    assert_eq!(operations.headers()[CACHE_CONTROL], "private, no-store");
    let operations = json_body(operations).await;
    assert_eq!(operations["overallState"], "degraded");
    assert_eq!(operations["dependencies"]["state"], "degraded");
    assert_eq!(operations["dependencies"]["category"], "configuration");
    assert_eq!(operations["cleanup"]["state"], "nominal");
    assert_eq!(operations["cleanup"]["queueDepth"], 0);
    assert_eq!(operations["usage"]["state"], "nominal");
    assert_eq!(operations["usage"]["activeUsers"], 2);
    assert_eq!(operations["usage"]["activeOrganizations"], 0);
    assert_eq!(operations["usage"]["activeProjects"], 0);
    assert_eq!(operations["usage"]["verifiedBundles"], 0);
    assert_eq!(operations["usage"]["trackedPhysicalBytes"], "0");
    assert_eq!(operations["usage"]["reservedBytes"], "0");
    let serialized_operations = operations.to_string();
    for forbidden in ["object_key", "endpoint", "credential", "sql", "password"] {
        assert!(!serialized_operations.contains(forbidden));
    }

    assert_problem(
        request(
            &router,
            Some(&member),
            Method::GET,
            "/api/v1/admin/support-bundle",
            None,
            None,
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;
    let bundle = request(
        &router,
        Some(&admin),
        Method::GET,
        "/api/v1/admin/support-bundle",
        None,
        None,
    )
    .await;
    assert_eq!(bundle.status(), StatusCode::OK);
    assert_eq!(bundle.headers()[CACHE_CONTROL], "private, no-store");
    let bundle = json_body(bundle).await;
    assert_eq!(bundle["schemaVersion"], 1);
    assert_eq!(bundle["format"], "nuriteo-support-bundle-v1+json");
    assert_eq!(bundle["configuration"]["databaseSchemaVersion"], 51);
    assert_eq!(bundle["configuration"]["settingRegistryVersion"], 4);
    assert_eq!(bundle["integrations"].as_array().unwrap().len(), 3);
    assert_eq!(
        bundle["diagnostics"].as_array().unwrap().last().unwrap()["operationId"],
        REQUEST_ID
    );
    assert_eq!(bundle["retainedUntil"], Value::Null);
    let serialized_bundle = bundle.to_string();
    assert!(serialized_bundle.len() < 65_536);
    for forbidden in [
        PASSWORD,
        PASSWORD_HASH,
        "admin@example.test",
        "member@example.test",
    ] {
        assert!(!serialized_bundle.contains(forbidden));
    }

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
        StatusCode::PRECONDITION_FAILED,
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

    verify_complete_snapshot_validation(&router, &pool, &admin).await;
    verify_concurrent_cross_field_updates(&router, &pool, &admin).await;
    verify_setting_audit_rollback(&router, &pool, &admin).await;

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
            "/api/v1/admin/settings/security.reauthentication_window_minutes",
            Some(json!({"value": 30})),
            Some("\"setting-v1\""),
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
    assert_eq!(status["schemaVersion"], 51);
    assert_eq!(status["settingRegistryVersion"], 4);
    assert_eq!(status["settingCount"], 40);
    assert_eq!(status["restartRequired"], false);

    verify_audit_query_export_and_retention(&router, &pool, &admin, &member, admin_id).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}


pub(crate) async fn verify_complete_snapshot_validation(    router: &Router,
    pool: &DatabasePool,
    admin: &Browser,
) {
    sqlx::query(
        "UPDATE instance_settings SET value = '\"invalid\"'::jsonb WHERE key = 'smtp.port'",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_problem(
        request(
            router,
            Some(admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 337})),
            Some("\"setting-v2\""),
        )
        .await,
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    sqlx::query("UPDATE instance_settings SET value = '587'::jsonb WHERE key = 'smtp.port'")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();

    sqlx::query("DELETE FROM instance_settings WHERE key = 'smtp.port'")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    assert_problem(
        request(
            router,
            Some(admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 337})),
            Some("\"setting-v2\""),
        )
        .await,
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    sqlx::query(
        "INSERT INTO instance_settings (key, registry_version, value, bootstrap_origin) \
         VALUES ('smtp.port', 4, '587'::jsonb, 'default')",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO instance_settings (key, registry_version, value, bootstrap_origin) \
         VALUES ('unknown.fixture', 4, 'true'::jsonb, 'default')",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_problem(
        request(
            router,
            Some(admin),
            Method::PATCH,
            SETTING_PATH,
            Some(json!({"value": 337})),
            Some("\"setting-v2\""),
        )
        .await,
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    sqlx::query("DELETE FROM instance_settings WHERE key = 'unknown.fixture'")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();

    let unchanged: (String, i64) = sqlx::query_as(
        "SELECT value::text, lock_version FROM instance_settings \
         WHERE key = 'invitations.default_expiry_hours'",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(unchanged, ("336".into(), 2));
}


pub(crate) async fn verify_concurrent_cross_field_updates(    router: &Router,
    pool: &DatabasePool,
    admin: &Browser,
) {
    let default_update = request(
        router,
        Some(admin),
        Method::PATCH,
        "/api/v1/admin/settings/tokens.default_expiry_days",
        Some(json!({"value": 300})),
        Some("\"setting-v1\""),
    );
    let maximum_update = request(
        router,
        Some(admin),
        Method::PATCH,
        "/api/v1/admin/settings/tokens.maximum_expiry_days",
        Some(json!({"value": 200})),
        Some("\"setting-v1\""),
    );
    let (default_response, maximum_response) = tokio::join!(default_update, maximum_update);
    let statuses = [default_response.status(), maximum_response.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::UNPROCESSABLE_ENTITY)
            .count(),
        1
    );
    let values: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value::text FROM instance_settings \
         WHERE key IN ('tokens.default_expiry_days', 'tokens.maximum_expiry_days') ORDER BY key",
    )
    .fetch_all(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert!(
        values
            == vec![
                ("tokens.default_expiry_days".into(), "300".into()),
                ("tokens.maximum_expiry_days".into(), "365".into())
            ]
            || values
                == vec![
                    ("tokens.default_expiry_days".into(), "30".into()),
                    ("tokens.maximum_expiry_days".into(), "200".into())
                ]
    );
}


pub(crate) async fn verify_setting_audit_rollback(router: &Router, pool: &DatabasePool, admin: &Browser) {    sqlx::query(
        "CREATE FUNCTION reject_setting_audit() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.action_code = 'instance.setting_updated' THEN RAISE EXCEPTION 'fixture rejection'; \
         END IF; RETURN NEW; END $$",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_setting_audit BEFORE INSERT ON audit_events \
         FOR EACH ROW EXECUTE FUNCTION reject_setting_audit()",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_problem(
        request(
            router,
            Some(admin),
            Method::PATCH,
            "/api/v1/admin/settings/audit.retention_days",
            Some(json!({"value": 366})),
            Some("\"setting-v1\""),
        )
        .await,
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    let persisted: (String, i64) = sqlx::query_as(
        "SELECT value::text, lock_version FROM instance_settings WHERE key = 'audit.retention_days'",
    )
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap();
    assert_eq!(persisted, ("365".into(), 1));
    sqlx::query("DROP TRIGGER reject_setting_audit ON audit_events")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION reject_setting_audit()")
        .execute(&mut *acquire(pool).await)
        .await
        .unwrap();
}
