#![allow(unused_imports)]
use super::*;
use super::forward_migrations::*;
use super::schema_probes::*;
use std::borrow::Cow;

use std::env;

use std::fs;

use std::str::FromStr;


use sqlx::migrate::{Migration, MigrationType};

use sqlx::{Acquire, SqlSafeStr};


use super::super::*;

use crate::database::{DatabasePoolConfig, DatabaseTlsConfig};

use crate::identity::UserId;

use crate::project::ProjectId;

use crate::published_example::{
    CreatePublishedExample, PublishedExampleDeleteConfirmation, PublishedExampleError,
    PublishedExampleName, PublishedExampleService, PublishedExampleServicePolicy,
    PublishedExampleState, PublishedExampleVisibility,
};

use crate::save::ProjectVersionId;
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, TEST_MIGRATION_VERSION, TIMEOUT_MIGRATION_VERSION};



pub(crate) async fn verify_access_token_invariants(pool: &DatabasePool) {    const USER: &str = "0199ee6c-c777-7000-8000-000000009001";
    const TOKEN: &str = "0199ee6c-c777-7000-8000-000000009101";
    const DISABLE_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009102";
    const PROJECT_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009105";
    const PROJECT: &str = "0199ee6c-c777-7000-8000-000000009020";
    const DELETED_USER: &str = "0199ee6c-c777-7000-8000-000000009107";
    const DELETED_USER_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009108";
    const FAMILY: &str = "0199ee6c-c777-7000-8000-000000009110";

    let insert = |id: &'static str, suffix: u8| {
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,created_by_user_id,scopes,token_prefix,\
              secret_hash,expires_at,rotation_family_id) \
             VALUES ($1::uuid,'personal','CLI',$2::uuid,$2::uuid,$2::uuid,\
                     ARRAY['project:read'],$3,decode(repeat($4,32),'hex'),\
                     transaction_timestamp()+interval '90 days',$5::uuid)",
        )
        .bind(id)
        .bind(USER)
        .bind(format!("nur_pat_{id}_"))
        .bind(format!("{suffix:02x}"))
        .bind(FAMILY)
    };

    insert(TOKEN, 0x11)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,project_id,created_by_user_id,scopes,token_prefix,\
          secret_hash,expires_at,rotation_family_id) \
         VALUES ($1::uuid,'project','CI',$2::uuid,$2::uuid,$3::uuid,ARRAY['project:publish'],\
                 $4,decode(repeat('55',32),'hex'),transaction_timestamp()+interval '90 days',$5::uuid)",
    )
    .bind(PROJECT_TOKEN)
    .bind(PROJECT)
    .bind(USER)
    .bind(format!("nur_prj_{PROJECT_TOKEN}_"))
    .bind(FAMILY)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009103','personal','Too Long',$1::uuid,$1::uuid,\
                     ARRAY['project:read'],'nur_pat_0199ee6c-c777-7000-8000-000000009103_',\
                     decode(repeat('33',32),'hex'),transaction_timestamp()+interval '366 days',$2::uuid)",
        )
        .bind(USER)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );
    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,project_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009106','project','Git Escape',$1::uuid,$1::uuid,\
                     ARRAY['git:read'],'nur_prj_0199ee6c-c777-7000-8000-000000009106_',\
                     decode(repeat('66',32),'hex'),transaction_timestamp()+interval '90 days',$2::uuid)",
        )
        .bind(PROJECT)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );
    assert_constraint_rejected(
        sqlx::query(
            "INSERT INTO access_tokens \
             (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
             VALUES ('0199ee6c-c777-7000-8000-000000009104','personal','Bad Scope',$1::uuid,$1::uuid,\
                     ARRAY['project:read','project:read'],'nur_pat_0199ee6c-c777-7000-8000-000000009104_',\
                     decode(repeat('44',32),'hex'),transaction_timestamp()+interval '90 days',$2::uuid)",
        )
        .bind(USER)
        .bind(FAMILY)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );

    verify_access_token_runtime(pool, USER, PROJECT).await;
    verify_access_token_management(pool, USER, PROJECT).await;

    sqlx::query(
        "UPDATE access_tokens SET state='revoked',secret_hash=NULL,revoked_at=clock_timestamp(),\
         revoke_reason='operator_revoked',updated_at=clock_timestamp(),lock_version=lock_version+1 \
         WHERE id=$1::uuid",
    )
    .bind(TOKEN)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_constraint_rejected(
        sqlx::query(
            "UPDATE access_tokens SET state='active',secret_hash=decode(repeat('11',32),'hex'),\
             revoked_at=NULL,revoke_reason=NULL,updated_at=clock_timestamp(),lock_version=lock_version+1 \
             WHERE id=$1::uuid",
        )
        .bind(TOKEN)
        .execute(&mut *pool.acquire().await.unwrap())
        .await,
    );

    insert(DISABLE_TOKEN, 0x22)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE users SET status='disabled',disabled_at=clock_timestamp(),updated_at=clock_timestamp() \
         WHERE id=$1::uuid",
    )
    .bind(USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let lifecycle: (String, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,revoke_reason FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(DISABLE_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(lifecycle, ("revoked".into(), true, "user_disabled".into()));

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO project_tombstones(former_project_id,owner_user_id,slug) \
         VALUES ($1::uuid,$2::uuid,'lease-fence')",
    )
    .bind(PROJECT)
    .bind(USER)
    .execute(&mut *transaction)
    .await
    .unwrap();
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(PROJECT)
        .execute(&mut *transaction)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    let project_lifecycle: (String, bool, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,project_id IS NULL,revoke_reason \
         FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(PROJECT_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        project_lifecycle,
        ("revoked".into(), true, true, "project_deleted".into())
    );

    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name) \
         VALUES ($1::uuid,'deleted-token-user@example.test','deleted-token-user@example.test','Delete Me')",
    )
    .bind(DELETED_USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
         VALUES ($1::uuid,'personal','Delete Lifecycle',$2::uuid,$2::uuid,ARRAY['project:read'],$3,\
                 decode(repeat('77',32),'hex'),transaction_timestamp()+interval '90 days',$4::uuid)",
    )
    .bind(DELETED_USER_TOKEN)
    .bind(DELETED_USER)
    .bind(format!("nur_pat_{DELETED_USER_TOKEN}_"))
    .bind(FAMILY)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query("DELETE FROM users WHERE id=$1::uuid")
        .bind(DELETED_USER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let deletion_lifecycle: (String, bool, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,owner_user_id IS NULL,revoke_reason \
         FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(DELETED_USER_TOKEN)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        deletion_lifecycle,
        ("revoked".into(), true, true, "user_deleted".into())
    );
}


pub(crate) async fn verify_access_token_runtime(pool: &DatabasePool, user: &str, project: &str) {    use crate::access_token::{
        AccessTokenAuthenticator, AccessTokenKind, AccessTokenPrincipal, AccessTokenRequest,
        AccessTokenScope, AccessTokenServiceError, ApiCategory, ApiIdempotencyRepository,
        IdempotencyReservation, generate_access_token,
    };
    use crate::project::ProjectId;
    use uuid::Uuid;

    let generated =
        generate_access_token(AccessTokenKind::Personal, [AccessTokenScope::ProjectRead]).unwrap();
    let family = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,created_by_user_id,scopes,token_prefix,\
          secret_hash,expires_at,rotation_family_id) \
         VALUES($1::uuid,'personal','Runtime',$2::uuid,$2::uuid,$2::uuid,ARRAY['project:read'],\
                $3,$4,transaction_timestamp()+interval '90 days',$5::uuid)",
    )
    .bind(generated.id.to_string())
    .bind(user)
    .bind(&generated.token_prefix)
    .bind(generated.secret_hash.as_bytes().as_slice())
    .bind(family.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let authenticator = AccessTokenAuthenticator::new(pool.clone());
    let project_id = project.parse::<ProjectId>().unwrap();
    let source_ip = "192.0.2.44".parse().unwrap();

    let expired =
        generate_access_token(AccessTokenKind::Personal, [AccessTokenScope::ProjectRead]).unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,\
          rotation_family_id,created_at,updated_at) \
         VALUES($1::uuid,'personal','Expired',$2::uuid,$2::uuid,ARRAY['project:read'],$3,$4,\
                transaction_timestamp()-interval '1 second',$5::uuid,\
                transaction_timestamp()-interval '1 day',transaction_timestamp()-interval '1 day')",
    )
    .bind(expired.id.to_string())
    .bind(user)
    .bind(&expired.token_prefix)
    .bind(expired.secret_hash.as_bytes().as_slice())
    .bind(Uuid::now_v7().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        authenticator
            .authenticate(AccessTokenRequest {
                bearer: expired.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectRead,
                project_id: Some(project_id),
                source_ip: Some(source_ip),
                category: ApiCategory::Read,
            })
            .await,
        Err(AccessTokenServiceError::AuthenticationFailed)
    );
    let expired_state: (String, bool) =
        sqlx::query_as("SELECT state,secret_hash IS NULL FROM access_tokens WHERE id=$1::uuid")
            .bind(expired.id.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(expired_state, ("revoked".into(), true));

    for index in 0..30 {
        let observed_ip = std::net::IpAddr::V4(std::net::Ipv4Addr::new(
            192,
            0,
            2,
            40 + u8::try_from(index.min(5)).unwrap(),
        ));
        let principal = authenticator
            .authenticate(AccessTokenRequest {
                bearer: generated.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectRead,
                project_id: Some(project_id),
                source_ip: Some(observed_ip),
                category: ApiCategory::Integration,
            })
            .await
            .unwrap();
        assert!(matches!(principal, AccessTokenPrincipal::User(_)));
    }
    assert_eq!(
        authenticator
            .authenticate(AccessTokenRequest {
                bearer: generated.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectRead,
                project_id: Some(project_id),
                source_ip: Some(source_ip),
                category: ApiCategory::Integration,
            })
            .await,
        Err(AccessTokenServiceError::RateLimited)
    );
    let usage: (i64, i32, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM access_token_source_ips WHERE token_id=$1::uuid),\
                (SELECT used_points FROM api_rate_limit_buckets WHERE subject_kind='token' AND subject_id=$1::uuid),\
                (SELECT COUNT(*) FROM access_tokens WHERE id=$1::uuid AND last_api_category='integration')",
    )
    .bind(generated.id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(usage, (5, 600, 1));

    let project_token = generate_access_token(
        AccessTokenKind::Project,
        [
            AccessTokenScope::ProjectRead,
            AccessTokenScope::ProjectWrite,
        ],
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,project_id,created_by_user_id,scopes,token_prefix,\
          secret_hash,expires_at,rotation_family_id) \
         VALUES($1::uuid,'project','Archive Runtime',$2::uuid,$2::uuid,$3::uuid,\
                ARRAY['project:read','project:write'],$4,$5,\
                transaction_timestamp()+interval '90 days',$6::uuid)",
    )
    .bind(project_token.id.to_string())
    .bind(project)
    .bind(user)
    .bind(&project_token.token_prefix)
    .bind(project_token.secret_hash.as_bytes().as_slice())
    .bind(Uuid::now_v7().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE projects SET state='archived',archived_at=clock_timestamp(),\
         updated_at=clock_timestamp(),lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(project)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        authenticator
            .authenticate(AccessTokenRequest {
                bearer: project_token.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectRead,
                project_id: Some(project_id),
                source_ip: Some(source_ip),
                category: ApiCategory::Read,
            })
            .await
            .unwrap(),
        AccessTokenPrincipal::Project(project_id)
    );
    assert_eq!(
        authenticator
            .authenticate(AccessTokenRequest {
                bearer: project_token.plaintext.expose_once(),
                required_scope: AccessTokenScope::ProjectWrite,
                project_id: Some(project_id),
                source_ip: Some(source_ip),
                category: ApiCategory::Write,
            })
            .await,
        Err(AccessTokenServiceError::Forbidden)
    );
    sqlx::query(
        "UPDATE projects SET state='active',archived_at=NULL,updated_at=clock_timestamp(),\
         lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(project)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let principal_id = Uuid::parse_str(user).unwrap();
    let fingerprint = [0x42; 32];
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert_eq!(
        ApiIdempotencyRepository::reserve(
            &mut transaction,
            principal_id,
            generated.id,
            "POST",
            "/api/v1/projects",
            "runtime-idempotency-key-0001",
            &fingerprint,
        )
        .await
        .unwrap(),
        IdempotencyReservation::New
    );
    let body = serde_json::json!({"id":"project-result"});
    ApiIdempotencyRepository::complete(
        &mut transaction,
        principal_id,
        "POST",
        "/api/v1/projects",
        "runtime-idempotency-key-0001",
        201,
        &body,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert_eq!(
        ApiIdempotencyRepository::reserve(
            &mut transaction,
            principal_id,
            generated.id,
            "POST",
            "/api/v1/projects",
            "runtime-idempotency-key-0001",
            &fingerprint,
        )
        .await
        .unwrap(),
        IdempotencyReservation::Replay { status: 201, body }
    );
    assert_eq!(
        ApiIdempotencyRepository::reserve(
            &mut transaction,
            principal_id,
            generated.id,
            "POST",
            "/api/v1/projects",
            "runtime-idempotency-key-0001",
            &[0x43; 32],
        )
        .await
        .unwrap(),
        IdempotencyReservation::Conflict
    );
    transaction.commit().await.unwrap();
}


pub(crate) async fn verify_access_token_management(pool: &DatabasePool, user: &str, project: &str) {    use crate::access_token::{
        AccessTokenManagementError, AccessTokenManagementService, AccessTokenScope,
        AccessTokenTarget,
    };
    use crate::config::InstanceSettingBootstrap;
    use crate::identity::{
        BrowserCookieBoundary, BrowserMethod, BrowserRequestHeaders, SessionPolicy, SessionService,
        UserId,
    };
    use crate::instance_settings::InstanceSettingsRepository;
    use crate::project::ProjectId;
    use url::Url;
    use uuid::Uuid;

    let user_id = user.parse::<UserId>().unwrap();
    let project_id = project.parse::<ProjectId>().unwrap();
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    let issued_session = SessionService::new(pool.clone(), SessionPolicy::default())
        .issue(user_id)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE sessions SET last_reauthenticated_at=transaction_timestamp(),\
         last_seen_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(issued_session.session().id().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let csrf = format!("nrt_csrf_{}", "A".repeat(43));
    let cookies = format!(
        "nuriteo_dev_session={}; nuriteo_dev_csrf={csrf}",
        issued_session.token().expose()
    );
    let origins = ["http://127.0.0.1:8080"];
    let cookie_headers = [cookies.as_str()];
    let csrf_headers = [csrf.as_str()];
    let request = |method| BrowserRequestHeaders {
        method,
        origins: &origins,
        cookie_headers: &cookie_headers,
        csrf_headers: &csrf_headers,
    };
    BrowserCookieBoundary::new(&Url::parse("http://127.0.0.1:8080").unwrap())
        .unwrap()
        .validate(request(BrowserMethod::Post))
        .unwrap();
    SessionService::new(pool.clone(), SessionPolicy::default())
        .authenticate(issued_session.token())
        .await
        .unwrap();
    let service = AccessTokenManagementService::production(
        pool.clone(),
        &Url::parse("http://127.0.0.1:8080").unwrap(),
        SessionPolicy::default(),
    )
    .unwrap();

    let issued = service
        .issue(
            request(BrowserMethod::Post),
            AccessTokenTarget::Personal,
            "Fixture CLI",
            vec![AccessTokenScope::ProjectRead],
            Some(30),
            "token-management-fixture-issue",
        )
        .await
        .unwrap();
    assert!(issued.plaintext.starts_with("nur_pat_"));
    assert!(!format!("{issued:?}").contains(&issued.plaintext));
    let stored: (bool, i32) = sqlx::query_as(
        "SELECT secret_hash IS NOT NULL,octet_length(secret_hash) FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(&issued.token.id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(stored, (true, 32));

    let rotated = service
        .rotate(
            request(BrowserMethod::Post),
            AccessTokenTarget::Personal,
            Uuid::parse_str(&issued.token.id).unwrap(),
            Some(7),
            "token-management-fixture-rotate",
        )
        .await
        .unwrap();
    assert_ne!(rotated.plaintext, issued.plaintext);
    let lineage: (String, bool, Option<String>) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,rotated_from_id::text FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(&rotated.token.id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(lineage.0, "active");
    assert!(!lineage.1);
    assert_eq!(lineage.2.as_deref(), Some(issued.token.id.as_str()));
    let old: (String, bool, String) = sqlx::query_as(
        "SELECT state,secret_hash IS NULL,revoke_reason FROM access_tokens WHERE id=$1::uuid",
    )
    .bind(&issued.token.id)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(old, ("revoked".into(), true, "rotated".into()));

    let project_token = service
        .issue(
            request(BrowserMethod::Post),
            AccessTokenTarget::Project(project_id),
            "Fixture Project CI",
            vec![
                AccessTokenScope::ProjectRead,
                AccessTokenScope::ProjectWrite,
            ],
            None,
            "token-management-fixture-project",
        )
        .await
        .unwrap();
    assert!(project_token.plaintext.starts_with("nur_prj_"));
    let revoked = service
        .revoke(
            request(BrowserMethod::Delete),
            AccessTokenTarget::Project(project_id),
            Uuid::parse_str(&project_token.token.id).unwrap(),
            "token-management-fixture-revoke",
        )
        .await
        .unwrap();
    assert_eq!(revoked.status, "revoked");

    const OTHER_USER: &str = "0199ee6c-c777-7000-8000-000000009119";
    const OTHER_TOKEN: &str = "0199ee6c-c777-7000-8000-000000009120";
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name) VALUES \
         ($1::uuid,'token-other@example.test','token-other@example.test','Other Token User')",
    )
    .bind(OTHER_USER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_tokens \
         (id,kind,name,principal_id,owner_user_id,scopes,token_prefix,secret_hash,expires_at,rotation_family_id) \
         VALUES($1::uuid,'personal','Not Mine',$2::uuid,$2::uuid,ARRAY['project:read'],$3,\
                decode(repeat('88',32),'hex'),transaction_timestamp()+interval '30 days',$4::uuid)",
    )
    .bind(OTHER_TOKEN)
    .bind(OTHER_USER)
    .bind(format!("nur_pat_{OTHER_TOKEN}_"))
    .bind(Uuid::now_v7().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .revoke(
                request(BrowserMethod::Delete),
                AccessTokenTarget::Personal,
                Uuid::parse_str(OTHER_TOKEN).unwrap(),
                "token-management-fixture-cross-user",
            )
            .await,
        Err(AccessTokenManagementError::NotFound)
    );
    let other_active: (String, bool) =
        sqlx::query_as("SELECT state,secret_hash IS NOT NULL FROM access_tokens WHERE id=$1::uuid")
            .bind(OTHER_TOKEN)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(other_active, ("active".into(), true));

    let visible = service
        .list(request(BrowserMethod::Get), AccessTokenTarget::Personal)
        .await
        .unwrap();
    assert!(visible.iter().any(|token| token.id == rotated.token.id));
    assert!(!visible.iter().any(|token| token.id == OTHER_TOKEN));
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE correlation_id LIKE 'token-management-fixture-%'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(audit_count, 4);
    let notification_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notifications WHERE recipient_user_id=$1::uuid \
         AND event_code IN ('access_token.created','access_token.rotated','access_token.revoked') \
         AND resource_type='access_token' AND NOT notification_payload_has_sensitive_key(rendering_data)",
    )
    .bind(user)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(notification_count, 4);
}


pub(crate) fn assert_constraint_rejected(result: Result<sqlx::postgres::PgQueryResult, sqlx::Error>) {    let error = result.expect_err("constraint violation must be rejected");
    assert_eq!(
        error.as_database_error().and_then(|error| error.code()),
        Some(Cow::Borrowed("23514"))
    );
}


pub(crate) fn options(lock_wait_timeout: Duration, execution_timeout: Duration) -> MigrationOptions {    MigrationOptions::new(lock_wait_timeout, execution_timeout)
        .unwrap_or_else(|error| panic!("test migration options must be valid: {error}"))
}


pub(crate) fn test_migrator(additional: Migration) -> Migrator {    let mut migrations: Vec<_> = embedded_migrator().iter().cloned().collect();
    migrations.push(additional);
    migrator_without_driver_lock(migrations)
}


pub(crate) fn project_bundle_rollback_probe_migrator() -> Migrator {    let mut migrations: Vec<_> = embedded_migrator()
        .iter()
        .filter(|migration| migration.version < 14)
        .cloned()
        .collect();
    let rollback_sql: &'static str =
        Box::leak(format!("{PROJECT_BUNDLES_SQL}\nSELECT 1 / 0;").into_boxed_str());
    migrations.push(Migration::new(
        14,
        Cow::Borrowed("project bundles rollback probe"),
        MigrationType::Simple,
        rollback_sql.into_sql_str(),
        false,
    ));
    migrator_without_driver_lock(migrations)
}


pub(crate) async fn fixture_pool() -> DatabasePool {    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by the fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by the fixture"));
    let ca =
        fs::read(ca_path).unwrap_or_else(|error| panic!("fixture CA must be readable: {error}"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|error| panic!("fixture TLS must be valid: {error}"));
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap_or_else(|error| panic!("fixture database config must be valid: {error}"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|error| panic!("fixture database must connect: {error}"))
}


pub(crate) async fn reset_fixture(pool: &DatabasePool) {    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("fixture reset must acquire a connection: {error}"));
    for statement in [
        "DROP TABLE IF EXISTS db002_transaction_probe",
        "DROP TABLE IF EXISTS _sqlx_migrations",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap_or_else(|error| panic!("fixture reset statement must succeed: {error}"));
    }
}


pub(crate) async fn migration_row_count(pool: &DatabasePool, version: i64) -> i64 {    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("history query must acquire a connection: {error}"));
    sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = $1")
        .bind(version)
        .fetch_one(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("history count must succeed: {error}"))
}


pub(crate) async fn relation_exists(pool: &DatabasePool, relation: &str) -> bool {    let mut connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("relation query must acquire a connection: {error}"));
    sqlx::query_scalar::<_, Option<String>>("SELECT to_regclass($1)::text")
        .bind(format!("public.{relation}"))
        .fetch_one(&mut *connection)
        .await
        .unwrap_or_else(|error| panic!("relation query must succeed: {error}"))
        .is_some()
}
