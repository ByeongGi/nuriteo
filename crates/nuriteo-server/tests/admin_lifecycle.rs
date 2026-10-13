use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::admin::{
    AdminLifecycleActor, AdminLifecycleAuditContext, AdminLifecycleChange, AdminLifecycleError,
    AdminLifecyclePolicy, AdminLifecycleService,
};
use nuriteo_server::audit::AuditEventId;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{SessionId, UserId};
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-admin-lifecycle/run.sh"]
async fn admin_lifecycle_is_reauthenticated_serialized_and_session_safe() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(40));

    let admin = seed_user(&pool, "admin@example.test", true).await;
    let member = seed_user(&pool, "member@example.test", false).await;
    let admin_session = seed_session(&pool, admin, true, 1).await;
    let stale_session = seed_session(&pool, admin, false, 2).await;
    let member_session = seed_session(&pool, member, true, 3).await;
    let service = AdminLifecycleService::new(pool.clone(), AdminLifecyclePolicy::default());

    assert_eq!(
        service
            .promote(
                AdminLifecycleActor::new(admin, stale_session),
                member,
                &audit(admin, "stale-reauth"),
            )
            .await,
        Err(AdminLifecycleError::ReauthenticationRequired)
    );
    assert_eq!(
        service
            .promote(
                AdminLifecycleActor::new(member, member_session),
                member,
                &audit(member, "non-admin"),
            )
            .await,
        Err(AdminLifecycleError::Unauthorized)
    );
    assert_eq!(
        service
            .demote(
                AdminLifecycleActor::new(admin, admin_session),
                admin,
                &audit(admin, "last-admin"),
            )
            .await,
        Err(AdminLifecycleError::LastAdministrator)
    );

    assert_eq!(
        service
            .promote(
                AdminLifecycleActor::new(admin, admin_session),
                member,
                &audit(admin, "promote-member"),
            )
            .await,
        Ok(AdminLifecycleChange::Changed {
            revoked_sessions: 0
        })
    );
    let member_admin_session = seed_session(&pool, member, true, 4).await;
    verify_concurrent_demotion_retains_an_administrator(
        &pool,
        admin,
        admin_session,
        member,
        member_admin_session,
    )
    .await;

    sqlx::query("UPDATE users SET is_instance_admin = TRUE WHERE id = $1::uuid")
        .bind(admin.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_instance_admin = FALSE WHERE id = $1::uuid")
        .bind(member.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    let ordinary = seed_user(&pool, "ordinary@example.test", false).await;
    seed_session(&pool, ordinary, true, 5).await;
    seed_session(&pool, ordinary, true, 6).await;
    let disabled = service
        .disable(
            AdminLifecycleActor::new(admin, admin_session),
            ordinary,
            &audit(admin, "disable-ordinary"),
        )
        .await
        .unwrap();
    assert_eq!(
        disabled,
        AdminLifecycleChange::Changed {
            revoked_sessions: 2
        }
    );
    assert_eq!(active_session_count(&pool, ordinary).await, 0);
    assert_eq!(user_status(&pool, ordinary).await, "disabled");
    assert_eq!(
        service
            .reactivate(
                AdminLifecycleActor::new(admin, admin_session),
                ordinary,
                &audit(admin, "reactivate-ordinary"),
            )
            .await,
        Ok(AdminLifecycleChange::Changed {
            revoked_sessions: 0
        })
    );
    assert_eq!(active_session_count(&pool, ordinary).await, 0);

    verify_last_active_owner_boundary(&pool, &service, admin, admin_session).await;
    verify_database_last_admin_constraint(&pool).await;
    assert_eq!(successful_audit_count(&pool).await, 5);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_concurrent_demotion_retains_an_administrator(
    pool: &DatabasePool,
    first: UserId,
    first_session: SessionId,
    second: UserId,
    second_session: SessionId,
) {
    let first_service = AdminLifecycleService::new(pool.clone(), AdminLifecyclePolicy::default());
    let second_service = first_service.clone();
    let first_audit = audit(first, "concurrent-demote-first");
    let second_audit = audit(second, "concurrent-demote-second");
    let (first_result, second_result) = tokio::join!(
        first_service.demote(
            AdminLifecycleActor::new(first, first_session),
            second,
            &first_audit,
        ),
        second_service.demote(
            AdminLifecycleActor::new(second, second_session),
            first,
            &second_audit,
        )
    );
    assert!(
        matches!(
            first_result,
            Ok(AdminLifecycleChange::Changed { .. })
                | Err(AdminLifecycleError::Unauthorized)
                | Err(AdminLifecycleError::LastAdministrator)
        ) && matches!(
            second_result,
            Ok(AdminLifecycleChange::Changed { .. })
                | Err(AdminLifecycleError::Unauthorized)
                | Err(AdminLifecycleError::LastAdministrator)
        )
    );
    assert_eq!(active_admin_count(pool).await, 1);
}

async fn verify_last_active_owner_boundary(
    pool: &DatabasePool,
    service: &AdminLifecycleService,
    admin: UserId,
    admin_session: SessionId,
) {
    let owner = seed_user(pool, "owner@example.test", false).await;
    let replacement = seed_user(pool, "replacement@example.test", false).await;
    let organization_id = uuid::Uuid::now_v7();
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query(
        "INSERT INTO organizations (id, slug, display_name) \
         VALUES ($1::uuid, 'owner-boundary', 'Owner boundary')",
    )
    .bind(organization_id.to_string())
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) \
         VALUES ($1::uuid, $2::uuid, 'owner')",
    )
    .bind(organization_id.to_string())
    .bind(owner.to_string())
    .execute(&mut *connection)
    .await
    .unwrap();
    drop(connection);

    assert_eq!(
        service
            .disable(
                AdminLifecycleActor::new(admin, admin_session),
                owner,
                &audit(admin, "last-owner"),
            )
            .await,
        Err(AdminLifecycleError::LastOrganizationOwner)
    );
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) \
         VALUES ($1::uuid, $2::uuid, 'owner')",
    )
    .bind(organization_id.to_string())
    .bind(replacement.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        service
            .disable(
                AdminLifecycleActor::new(admin, admin_session),
                owner,
                &audit(admin, "disable-owner"),
            )
            .await
            .is_ok()
    );
    assert_eq!(membership_count(pool, organization_id).await, 2);

    let direct = sqlx::query(
        "UPDATE organization_memberships SET role = 'member' \
         WHERE organization_id = $1::uuid AND user_id = $2::uuid",
    )
    .bind(organization_id.to_string())
    .bind(replacement.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await;
    assert!(direct.is_err());
}

async fn verify_database_last_admin_constraint(pool: &DatabasePool) {
    let current_admin: String = sqlx::query_scalar(
        "SELECT id::text FROM users WHERE status = 'active' AND is_instance_admin LIMIT 1",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let direct = sqlx::query("UPDATE users SET is_instance_admin = FALSE WHERE id = $1::uuid")
        .bind(current_admin)
        .execute(&mut *pool.acquire().await.unwrap())
        .await;
    assert!(direct.is_err());
    assert_eq!(active_admin_count(pool).await, 1);
}

async fn seed_user(pool: &DatabasePool, email: &str, admin: bool) -> UserId {
    let id = UserId::new();
    sqlx::query(
        "INSERT INTO users \
         (id, email, normalized_email, display_name, status, is_instance_admin) \
         VALUES ($1::uuid, $2, $2, $2, 'active', $3)",
    )
    .bind(id.to_string())
    .bind(email)
    .bind(admin)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    id
}

async fn seed_session(pool: &DatabasePool, user_id: UserId, recent: bool, marker: u8) -> SessionId {
    let id = SessionId::new();
    let query = if recent {
        sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, token_hash, created_at, last_seen_at, idle_expires_at, \
              absolute_expires_at, last_reauthenticated_at) \
             VALUES ($1::uuid, $2::uuid, $3, transaction_timestamp() - INTERVAL '4 hours', \
                     transaction_timestamp(), transaction_timestamp() + INTERVAL '1 day', \
                     transaction_timestamp() + INTERVAL '7 days', transaction_timestamp())",
        )
    } else {
        sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, token_hash, created_at, last_seen_at, idle_expires_at, \
              absolute_expires_at, last_reauthenticated_at) \
             VALUES ($1::uuid, $2::uuid, $3, transaction_timestamp() - INTERVAL '4 hours', \
                     transaction_timestamp(), transaction_timestamp() + INTERVAL '1 day', \
                     transaction_timestamp() + INTERVAL '7 days', \
                     transaction_timestamp() - INTERVAL '3 hours')",
        )
    };
    query
        .bind(id.to_string())
        .bind(user_id.to_string())
        .bind(vec![marker; 32])
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    id
}

fn audit(actor_user_id: UserId, correlation: &str) -> AdminLifecycleAuditContext {
    AdminLifecycleAuditContext::new(AuditEventId::new(), actor_user_id, correlation.into(), None)
}

async fn active_admin_count(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE status = 'active' AND is_instance_admin")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn active_session_count(pool: &DatabasePool, user_id: UserId) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM sessions WHERE user_id = $1::uuid AND revoked_at IS NULL",
    )
    .bind(user_id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn user_status(pool: &DatabasePool, user_id: UserId) -> String {
    sqlx::query_scalar("SELECT status FROM users WHERE id = $1::uuid")
        .bind(user_id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn membership_count(pool: &DatabasePool, organization_id: uuid::Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1::uuid",
    )
    .bind(organization_id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn successful_audit_count(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action_code LIKE 'instance.%' AND result = 'succeeded'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        8,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap();
    DatabasePool::connect(config).await.unwrap()
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
}
