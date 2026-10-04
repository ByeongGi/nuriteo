use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::audit::AuditEventId;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::UserId;
use nuriteo_server::organization::{
    MembershipAddResult, MembershipChangeResult, MembershipRemoveResult, OrganizationAuditContext,
    OrganizationPrincipal, OrganizationRole, OrganizationService, OrganizationServiceError,
    OrganizationServicePolicy, OrganizationStatus, OrganizationVersion,
};
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const OWNER_ONE: &str = "0199ee6c-c777-7000-8000-000000000801";
const OWNER_TWO: &str = "0199ee6c-c777-7000-8000-000000000802";
const MEMBER: &str = "0199ee6c-c777-7000-8000-000000000803";
const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000000804";
const ADMIN: &str = "0199ee6c-c777-7000-8000-000000000805";

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-organization-service/run.sh"]
async fn organization_service_is_atomic_authorized_and_serialized() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    migrate(&pool).await;
    insert_users(&pool).await;
    let service = OrganizationService::new(pool.clone(), OrganizationServicePolicy::default());

    let create_audit = audit(OWNER_ONE);
    let organization = service
        .create(
            user_id(OWNER_ONE),
            "service-team".into(),
            "Service Team".into(),
            &create_audit,
        )
        .await
        .unwrap_or_else(|error| panic!("organization create must succeed: {error}"));
    let organization_id = organization.id();
    assert_eq!(owner_count(&pool, &organization_id.to_string()).await, 1);
    assert_eq!(
        organization_scope_count(&pool, &organization_id.to_string()).await,
        1
    );
    assert_eq!(audit_count(&pool, "organization.created").await, 1);

    assert_eq!(
        service
            .create(
                user_id(OWNER_ONE),
                "service-team".into(),
                "Duplicate".into(),
                &audit(OWNER_ONE),
            )
            .await,
        Err(OrganizationServiceError::DuplicateSlug)
    );
    assert_eq!(organization_count(&pool, "service-team").await, 1);
    assert_eq!(
        service
            .create(
                user_id(OWNER_ONE),
                "rolled-back-team".into(),
                "Rolled Back Team".into(),
                &create_audit,
            )
            .await,
        Err(OrganizationServiceError::AuditUnavailable)
    );
    assert_eq!(organization_count(&pool, "rolled-back-team").await, 0);
    assert_eq!(
        organization_scope_count_by_slug(&pool, "rolled-back-team").await,
        0
    );

    assert_eq!(
        service
            .add_member(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                user_id(MEMBER),
                OrganizationRole::Member,
                &audit(OWNER_ONE),
            )
            .await,
        Ok(MembershipAddResult::Added)
    );
    assert_eq!(
        service
            .add_member(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                user_id(MEMBER),
                OrganizationRole::Owner,
                &audit(OWNER_ONE),
            )
            .await,
        Ok(MembershipAddResult::AlreadyMember)
    );
    assert_eq!(
        service
            .add_member(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                user_id(OUTSIDER),
                OrganizationRole::Member,
                &audit(OWNER_ONE),
            )
            .await,
        Ok(MembershipAddResult::Added)
    );
    assert_eq!(
        service
            .remove_member(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                user_id(OUTSIDER),
                &audit(OWNER_ONE),
            )
            .await,
        Ok(MembershipRemoveResult::Removed)
    );
    assert_eq!(
        service
            .remove_member(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                user_id(OUTSIDER),
                &audit(OWNER_ONE),
            )
            .await,
        Ok(MembershipRemoveResult::AlreadyAbsent)
    );

    assert!(
        service
            .get(
                OrganizationPrincipal::Owner(user_id(MEMBER)),
                organization_id
            )
            .await
            .is_ok()
    );
    assert_eq!(
        service
            .update_display_name(
                OrganizationPrincipal::Owner(user_id(MEMBER)),
                organization_id,
                version(1),
                "Unauthorized".into(),
                &audit(MEMBER),
            )
            .await,
        Err(OrganizationServiceError::Unauthorized)
    );
    assert_eq!(
        service
            .get(
                OrganizationPrincipal::Owner(user_id(OUTSIDER)),
                organization_id,
            )
            .await,
        Err(OrganizationServiceError::NotFound)
    );

    let updated = service
        .update_display_name(
            OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
            organization_id,
            version(1),
            "Updated Team".into(),
            &audit(OWNER_ONE),
        )
        .await
        .unwrap_or_else(|error| panic!("owner update must succeed: {error}"));
    assert_eq!(updated.lock_version(), version(2));
    assert_eq!(
        service
            .update_display_name(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                version(1),
                "Stale".into(),
                &audit(OWNER_ONE),
            )
            .await,
        Err(OrganizationServiceError::StaleVersion)
    );

    assert_eq!(
        service
            .update_display_name(
                OrganizationPrincipal::Owner(user_id(ADMIN)),
                organization_id,
                version(2),
                "Implicit Admin".into(),
                &audit(ADMIN),
            )
            .await,
        Err(OrganizationServiceError::Unauthorized)
    );
    let admin_updated = service
        .update_display_name(
            OrganizationPrincipal::InstanceAdministrator(user_id(ADMIN)),
            organization_id,
            version(2),
            "Explicit Admin".into(),
            &audit(ADMIN),
        )
        .await
        .unwrap_or_else(|error| panic!("explicit administrator update must succeed: {error}"));
    assert_eq!(admin_updated.lock_version(), version(3));

    verify_audit_rollback(&pool, &service, organization_id).await;
    verify_member_limit(&pool, &service).await;
    verify_concurrent_last_owner(&pool, &service).await;

    let archived = service
        .archive(
            OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
            organization_id,
            version(3),
            &audit(OWNER_ONE),
        )
        .await
        .unwrap_or_else(|error| panic!("archive must succeed: {error}"));
    assert_eq!(archived.status(), OrganizationStatus::Archived);
    assert_eq!(archived.lock_version(), version(4));
    assert_eq!(
        membership_count(&pool, &organization_id.to_string()).await,
        3
    );
    assert_eq!(
        service
            .add_member(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                user_id(OUTSIDER),
                OrganizationRole::Member,
                &audit(OWNER_ONE),
            )
            .await,
        Err(OrganizationServiceError::Archived)
    );

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|_| panic!("organization service fixture pool must close"));
    assert_eq!(
        service
            .create(
                user_id(OWNER_ONE),
                "Invalid Slug".into(),
                "Valid Display Name".into(),
                &audit(OWNER_ONE),
            )
            .await,
        Err(OrganizationServiceError::InvalidInput),
        "slug validation must not acquire a database connection"
    );
    assert_eq!(
        service
            .create(
                user_id(OWNER_ONE),
                "valid-slug".into(),
                " Invalid Display Name".into(),
                &audit(OWNER_ONE),
            )
            .await,
        Err(OrganizationServiceError::InvalidInput),
        "display-name validation must not acquire a database connection"
    );
    assert_eq!(
        service
            .update_display_name(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                version(4),
                " Invalid Display Name".into(),
                &audit(OWNER_ONE),
            )
            .await,
        Err(OrganizationServiceError::InvalidInput),
        "update display-name validation must not acquire a database connection"
    );
}

async fn verify_audit_rollback(
    pool: &DatabasePool,
    service: &OrganizationService,
    organization_id: nuriteo_server::organization::OrganizationId,
) {
    let reused = audit(OWNER_ONE);
    service
        .add_member(
            OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
            organization_id,
            user_id(OWNER_TWO),
            OrganizationRole::Member,
            &reused,
        )
        .await
        .unwrap_or_else(|error| panic!("setup membership must succeed: {error}"));
    let before = role(pool, &organization_id.to_string(), OWNER_TWO).await;
    assert_eq!(before.as_deref(), Some("member"));
    assert_eq!(
        service
            .change_member_role(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                user_id(OWNER_TWO),
                OrganizationRole::Owner,
                &reused,
            )
            .await,
        Err(OrganizationServiceError::AuditUnavailable)
    );
    assert_eq!(
        role(pool, &organization_id.to_string(), OWNER_TWO).await,
        before
    );
}

async fn verify_concurrent_last_owner(pool: &DatabasePool, service: &OrganizationService) {
    let organization = service
        .create(
            user_id(OWNER_ONE),
            "concurrent-team".into(),
            "Concurrent Team".into(),
            &audit(OWNER_ONE),
        )
        .await
        .unwrap_or_else(|error| panic!("concurrency organization must create: {error}"));
    let id = organization.id();
    service
        .add_member(
            OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
            id,
            user_id(OWNER_TWO),
            OrganizationRole::Owner,
            &audit(OWNER_ONE),
        )
        .await
        .unwrap_or_else(|error| panic!("second owner must add: {error}"));

    let first_service = service.clone();
    let first = tokio::spawn(async move {
        first_service
            .change_member_role(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                id,
                user_id(OWNER_ONE),
                OrganizationRole::Member,
                &audit(OWNER_ONE),
            )
            .await
    });
    let second_service = service.clone();
    let second = tokio::spawn(async move {
        second_service
            .change_member_role(
                OrganizationPrincipal::Owner(user_id(OWNER_TWO)),
                id,
                user_id(OWNER_TWO),
                OrganizationRole::Member,
                &audit(OWNER_TWO),
            )
            .await
    });
    let first = first
        .await
        .unwrap_or_else(|_| panic!("first race must join"));
    let second = second
        .await
        .unwrap_or_else(|_| panic!("second race must join"));
    assert!(matches!(
        (first, second),
        (
            Ok(MembershipChangeResult::Changed),
            Err(OrganizationServiceError::LastOwner)
        ) | (
            Err(OrganizationServiceError::LastOwner),
            Ok(MembershipChangeResult::Changed)
        )
    ));
    assert_eq!(owner_count(pool, &id.to_string()).await, 1);
    let remaining_owner: String = sqlx::query_scalar(
        "SELECT user_id::text FROM organization_memberships \
         WHERE organization_id = $1::uuid AND role = 'owner'",
    )
    .bind(id.to_string())
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("remaining owner must be readable"));
    let remaining_owner = user_id(&remaining_owner);
    assert_eq!(
        service
            .remove_member(
                OrganizationPrincipal::Owner(remaining_owner),
                id,
                remaining_owner,
                &OrganizationAuditContext::new(
                    AuditEventId::new(),
                    remaining_owner,
                    None,
                    format!("org-test:{}", AuditEventId::new()),
                    None,
                ),
            )
            .await,
        Err(OrganizationServiceError::LastOwner)
    );
}

async fn verify_member_limit(pool: &DatabasePool, service: &OrganizationService) {
    let organization = service
        .create(
            user_id(OWNER_ONE),
            "capacity-team".into(),
            "Capacity Team".into(),
            &audit(OWNER_ONE),
        )
        .await
        .unwrap_or_else(|error| panic!("capacity organization must create: {error}"));
    let organization_id = organization.id();
    sqlx::query(
        "WITH inserted_users AS (\
           INSERT INTO users (id, email, normalized_email, display_name) \
           SELECT ('0199ee6c-c777-7000-8002-' || lpad(sequence::text, 12, '0'))::uuid, \
                  'capacity-' || sequence || '@example.test', \
                  'capacity-' || sequence || '@example.test', \
                  'Capacity Member ' || sequence \
           FROM generate_series(1, 99) AS generated(sequence) \
           RETURNING id \
         ) \
         INSERT INTO organization_memberships (organization_id, user_id, role) \
         SELECT $1::uuid, id, 'member' FROM inserted_users",
    )
    .bind(organization_id.to_string())
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("capacity members must insert: {error}"));
    assert_eq!(
        membership_count(pool, &organization_id.to_string()).await,
        100,
        "the creating owner must count toward the member cap"
    );
    sqlx::query(
        "UPDATE users SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP, \
         updated_at = CURRENT_TIMESTAMP \
         WHERE id = '0199ee6c-c777-7000-8002-000000000001'::uuid",
    )
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("capacity member must disable: {error}"));
    assert_eq!(
        service
            .add_member(
                OrganizationPrincipal::Owner(user_id(OWNER_ONE)),
                organization_id,
                user_id(OUTSIDER),
                OrganizationRole::Member,
                &audit(OWNER_ONE),
            )
            .await,
        Err(OrganizationServiceError::MemberLimitReached)
    );
    assert_eq!(
        membership_count(pool, &organization_id.to_string()).await,
        100
    );
}

fn audit(actor: &str) -> OrganizationAuditContext {
    let event_id = AuditEventId::new();
    OrganizationAuditContext::new(
        event_id,
        user_id(actor),
        None,
        format!("org-test:{event_id}"),
        None,
    )
}

fn user_id(value: &str) -> UserId {
    value
        .parse()
        .unwrap_or_else(|error| panic!("fixture user id: {error}"))
}

fn version(value: i64) -> OrganizationVersion {
    OrganizationVersion::new(value).unwrap_or_else(|error| panic!("fixture version: {error}"))
}

async fn insert_users(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users \
         (id, email, normalized_email, display_name, is_instance_admin) VALUES \
         ($1::uuid, 'owner1@example.test', 'owner1@example.test', 'Owner One', FALSE), \
         ($2::uuid, 'owner2@example.test', 'owner2@example.test', 'Owner Two', FALSE), \
         ($3::uuid, 'member@example.test', 'member@example.test', 'Member', FALSE), \
         ($4::uuid, 'outsider@example.test', 'outsider@example.test', 'Outsider', FALSE), \
         ($5::uuid, 'admin@example.test', 'admin@example.test', 'Administrator', TRUE)",
    )
    .bind(OWNER_ONE)
    .bind(OWNER_TWO)
    .bind(MEMBER)
    .bind(OUTSIDER)
    .bind(ADMIN)
    .execute(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|error| panic!("fixture users must insert: {error}"));
}

async fn owner_count(pool: &DatabasePool, organization_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships \
         WHERE organization_id = $1::uuid AND role = 'owner'",
    )
    .bind(organization_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("owner count must read"))
}

async fn membership_count(pool: &DatabasePool, organization_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1::uuid",
    )
    .bind(organization_id)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("membership count must read"))
}

async fn organization_count(pool: &DatabasePool, slug: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE slug = $1")
        .bind(slug)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("organization count must read"))
}

async fn organization_scope_count(pool: &DatabasePool, organization_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM storage_scopes WHERE owner_organization_id = $1::uuid")
        .bind(organization_id)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("organization scope count must read"))
}

async fn organization_scope_count_by_slug(pool: &DatabasePool, slug: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM storage_scopes s \
         JOIN organizations o ON o.id = s.owner_organization_id WHERE o.slug = $1",
    )
    .bind(slug)
    .fetch_one(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("organization scope count must read"))
}

async fn audit_count(pool: &DatabasePool, action: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action_code = $1")
        .bind(action)
        .fetch_one(&mut *acquire(pool).await)
        .await
        .unwrap_or_else(|_| panic!("audit count must read"))
}

async fn role(pool: &DatabasePool, organization_id: &str, user_id: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT role FROM organization_memberships \
         WHERE organization_id = $1::uuid AND user_id = $2::uuid",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_optional(&mut *acquire(pool).await)
    .await
    .unwrap_or_else(|_| panic!("membership role must read"))
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_URL_ENV} must be set by fixture"));
    let ca_path = env::var(DATABASE_CA_ENV)
        .unwrap_or_else(|_| panic!("{DATABASE_CA_ENV} must be set by fixture"));
    let ca = fs::read(ca_path).unwrap_or_else(|_| panic!("fixture CA must be readable"));
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None)
        .unwrap_or_else(|_| panic!("fixture TLS must be valid"));
    let config = DatabasePoolConfig::new(
        database_url,
        1,
        12,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .unwrap_or_else(|_| panic!("fixture database config must be valid"));
    DatabasePool::connect(config)
        .await
        .unwrap_or_else(|_| panic!("fixture database must connect"))
}

async fn migrate(pool: &DatabasePool) {
    run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30))
            .unwrap_or_else(|_| panic!("fixture migration options must be valid")),
    )
    .await
    .unwrap_or_else(|_| panic!("fixture migrations must succeed"));
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = acquire(pool).await;
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap_or_else(|_| panic!("fixture schema must drop"));
    connection
        .execute("CREATE SCHEMA public")
        .await
        .unwrap_or_else(|_| panic!("fixture schema must recreate"));
}

async fn acquire(pool: &DatabasePool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    pool.acquire()
        .await
        .unwrap_or_else(|_| panic!("fixture connection must be available"))
}
