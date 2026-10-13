use std::{env, fs, time::Duration};

use nuriteo_server::audit::AuditEventId;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::UserId;
use nuriteo_server::organization::OrganizationId;
use nuriteo_server::project::{ProjectId, ProjectRole};
use nuriteo_server::team::{
    TeamAuditContext, TeamDisplayName, TeamMembershipVersion, TeamPrincipal, TeamRole, TeamService,
    TeamServiceError, TeamServicePolicy, TeamSlug, TeamVersion,
};
use sqlx::Executor;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const OWNER: &str = "0199ee6c-c777-7000-8000-000000008001";
const MAINTAINER: &str = "0199ee6c-c777-7000-8000-000000008002";
const MEMBER: &str = "0199ee6c-c777-7000-8000-000000008003";
const DISABLED: &str = "0199ee6c-c777-7000-8000-000000008004";
const ADMIN: &str = "0199ee6c-c777-7000-8000-000000008005";
const ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000008010";
const SCOPE: &str = "0199ee6c-c777-7000-8000-000000008020";
const PROJECT: &str = "0199ee6c-c777-7000-8000-000000008030";
const PROJECT_TWO: &str = "0199ee6c-c777-7000-8000-000000008031";

#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-team-service/run.sh"]
async fn team_service_is_authorized_versioned_audited_and_concurrent() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(40));
    seed_fixture(&pool).await;

    let service = TeamService::new(pool.clone(), TeamServicePolicy::default());
    let owner = user(OWNER);
    let maintainer = user(MAINTAINER);
    let member = user(MEMBER);
    let organization = organization();

    let team = service
        .create(
            TeamPrincipal::User(owner),
            organization,
            slug("platform"),
            name("Platform"),
            &audit(owner),
        )
        .await
        .unwrap();
    service
        .add_member(
            TeamPrincipal::User(owner),
            team.id(),
            maintainer,
            TeamRole::Maintainer,
            &audit(owner),
        )
        .await
        .unwrap();
    let membership = service
        .add_member(
            TeamPrincipal::User(owner),
            team.id(),
            member,
            TeamRole::Member,
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(membership.lock_version(), membership_version(1));

    let renamed = service
        .rename(
            TeamPrincipal::User(maintainer),
            team.id(),
            team_version(1),
            name("Platform Core"),
            &audit(maintainer),
        )
        .await
        .unwrap();
    assert_eq!(renamed.lock_version(), team_version(2));
    assert_eq!(
        service
            .add_project_role(
                TeamPrincipal::User(maintainer),
                team.id(),
                project(),
                ProjectRole::Write,
                &audit(maintainer),
            )
            .await,
        Err(TeamServiceError::Unauthorized)
    );
    let grant = service
        .add_project_role(
            TeamPrincipal::User(owner),
            team.id(),
            project(),
            ProjectRole::Write,
            &audit(owner),
        )
        .await
        .unwrap();
    let changed_by_project_admin = service
        .change_project_role(
            TeamPrincipal::User(member),
            team.id(),
            project(),
            grant.lock_version(),
            ProjectRole::Admin,
            &audit(member),
        )
        .await
        .unwrap();
    assert_eq!(changed_by_project_admin.role(), ProjectRole::Admin);

    let team_two = service
        .create(
            TeamPrincipal::User(owner),
            organization,
            slug("delivery"),
            name("Delivery"),
            &audit(owner),
        )
        .await
        .unwrap();
    service
        .add_member(
            TeamPrincipal::User(owner),
            team_two.id(),
            member,
            TeamRole::Member,
            &audit(owner),
        )
        .await
        .unwrap();
    let grant_two = service
        .add_project_role(
            TeamPrincipal::User(owner),
            team_two.id(),
            project_two(),
            ProjectRole::Read,
            &audit(owner),
        )
        .await
        .unwrap();

    // Both requests resolve authority through both Team memberships. The
    // Organization-scoped binding lock must prevent a SHARE->UPDATE cycle.
    let first_service = service.clone();
    let second_service = service.clone();
    let first_team_id = team.id();
    let second_team_id = team_two.id();
    let binding_race = tokio::time::timeout(Duration::from_secs(3), async move {
        let first_audit = audit(member);
        let second_audit = audit(member);
        tokio::join!(
            first_service.change_project_role(
                TeamPrincipal::User(member),
                first_team_id,
                project(),
                changed_by_project_admin.lock_version(),
                ProjectRole::Read,
                &first_audit,
            ),
            second_service.change_project_role(
                TeamPrincipal::User(member),
                second_team_id,
                project_two(),
                grant_two.lock_version(),
                ProjectRole::Admin,
                &second_audit,
            )
        )
    })
    .await
    .expect("cross-Team binding mutations must remain bounded");
    assert!(
        binding_race.0.is_ok(),
        "first binding: {:?}",
        binding_race.0
    );
    assert!(
        binding_race.1.is_ok(),
        "second binding: {:?}",
        binding_race.1
    );

    let left_service = service.clone();
    let right_service = service.clone();
    let team_id = team.id();
    let left = tokio::spawn(async move {
        left_service
            .change_member_role(
                TeamPrincipal::User(owner),
                team_id,
                member,
                membership_version(1),
                TeamRole::Maintainer,
                &audit(owner),
            )
            .await
    });
    let right = tokio::spawn(async move {
        right_service
            .change_member_role(
                TeamPrincipal::User(owner),
                team_id,
                member,
                membership_version(1),
                TeamRole::Member,
                &audit(owner),
            )
            .await
    });
    let results = [left.await.unwrap(), right.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(TeamServiceError::StaleVersion)))
            .count(),
        1
    );

    assert_eq!(
        service
            .add_member(
                TeamPrincipal::User(owner),
                team.id(),
                user(DISABLED),
                TeamRole::Member,
                &audit(owner),
            )
            .await,
        Err(TeamServiceError::TeamUnavailable)
    );

    let repeated_event = AuditEventId::new();
    let first_audit = audit_with_event(owner, repeated_event);
    let renamed = service
        .rename(
            TeamPrincipal::User(owner),
            team.id(),
            team_version(2),
            name("Atomic One"),
            &first_audit,
        )
        .await
        .unwrap();
    assert_eq!(renamed.lock_version(), team_version(3));
    let duplicate_audit = audit_with_event(owner, repeated_event);
    assert_eq!(
        service
            .rename(
                TeamPrincipal::User(owner),
                team.id(),
                team_version(3),
                name("Must Roll Back"),
                &duplicate_audit,
            )
            .await,
        Err(TeamServiceError::AuditUnavailable)
    );
    let current = service
        .get(TeamPrincipal::User(owner), team.id())
        .await
        .unwrap();
    assert_eq!(current.display_name().as_str(), "Atomic One");
    assert_eq!(current.lock_version(), team_version(3));

    archive_project(&pool, project()).await;
    assert_eq!(
        service
            .remove_project_role(
                TeamPrincipal::User(member),
                team.id(),
                project(),
                project_role_version(3),
                &audit(member),
            )
            .await,
        Err(TeamServiceError::ProjectUnavailable)
    );
    assert_eq!(binding_count(&pool, team.id(), project()).await, 1);
    restore_project(&pool, project()).await;
    archive_organization(&pool).await;
    assert_eq!(
        service
            .remove_project_role(
                TeamPrincipal::InstanceAdministrator(user(ADMIN)),
                team.id(),
                project(),
                project_role_version(3),
                &audit(user(ADMIN)),
            )
            .await,
        Err(TeamServiceError::OrganizationUnavailable)
    );
    assert_eq!(binding_count(&pool, team.id(), project()).await, 1);

    assert!(
        service
            .get(TeamPrincipal::InstanceAdministrator(user(ADMIN)), team.id())
            .await
            .is_ok()
    );
    assert!(audit_count(&pool).await >= 7);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn seed_fixture(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users (id,email,normalized_email,display_name,is_instance_admin) VALUES \
         ($1::uuid,'owner@example.test','owner@example.test','Owner',false), \
         ($2::uuid,'maintainer@example.test','maintainer@example.test','Maintainer',false), \
         ($3::uuid,'member@example.test','member@example.test','Member',false), \
         ($4::uuid,'disabled@example.test','disabled@example.test','Disabled',false), \
         ($5::uuid,'admin@example.test','admin@example.test','Admin',true)",
    )
    .bind(OWNER)
    .bind(MAINTAINER)
    .bind(MEMBER)
    .bind(DISABLED)
    .bind(ADMIN)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organizations (id,slug,display_name) VALUES ($1::uuid,'fixture','Fixture')",
    )
    .bind(ORGANIZATION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    for (id, role) in [
        (OWNER, "owner"),
        (MAINTAINER, "member"),
        (MEMBER, "member"),
        (DISABLED, "member"),
    ] {
        sqlx::query("INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ($1::uuid,$2::uuid,$3)")
            .bind(ORGANIZATION).bind(id).bind(role).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    }
    sqlx::query("UPDATE users SET status='disabled', disabled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid")
        .bind(DISABLED).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::query("INSERT INTO storage_scopes (id,owner_organization_id) VALUES ($1::uuid,$2::uuid)")
        .bind(SCOPE)
        .bind(ORGANIZATION)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO projects (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
                 ($1::uuid,$3::uuid,$4::uuid,'fixture','Fixture'), \
                 ($2::uuid,$3::uuid,$4::uuid,'fixture-two','Fixture Two')",
    )
    .bind(PROJECT)
    .bind(PROJECT_TWO)
    .bind(ORGANIZATION)
    .bind(SCOPE)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO project_user_roles (project_id,organization_id,user_id,role) VALUES \
                 ($1::uuid,$3::uuid,$4::uuid,'admin'), ($2::uuid,$3::uuid,$4::uuid,'admin')",
    )
    .bind(PROJECT)
    .bind(PROJECT_TWO)
    .bind(ORGANIZATION)
    .bind(MEMBER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

fn audit(actor: UserId) -> TeamAuditContext {
    audit_with_event(actor, AuditEventId::new())
}

fn audit_with_event(actor: UserId, event_id: AuditEventId) -> TeamAuditContext {
    TeamAuditContext::new(
        event_id,
        actor,
        None,
        format!("team-service-{}", AuditEventId::new()),
        None,
    )
}

fn user(value: &str) -> UserId {
    value.parse().unwrap()
}

fn organization() -> OrganizationId {
    ORGANIZATION.parse().unwrap()
}

fn project() -> ProjectId {
    PROJECT.parse().unwrap()
}

fn project_two() -> ProjectId {
    PROJECT_TWO.parse().unwrap()
}

fn slug(value: &str) -> TeamSlug {
    TeamSlug::new(value.into()).unwrap()
}

fn name(value: &str) -> TeamDisplayName {
    TeamDisplayName::new(value.into()).unwrap()
}

fn team_version(value: i64) -> TeamVersion {
    TeamVersion::new(value).unwrap()
}

fn membership_version(value: i64) -> TeamMembershipVersion {
    TeamMembershipVersion::new(value).unwrap()
}

fn project_role_version(value: i64) -> nuriteo_server::team::TeamProjectRoleVersion {
    nuriteo_server::team::TeamProjectRoleVersion::new(value).unwrap()
}

async fn archive_project(pool: &DatabasePool, project_id: ProjectId) {
    sqlx::query("UPDATE projects SET state='archived', archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 WHERE id=$1::uuid")
        .bind(project_id.to_string()).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
}

async fn restore_project(pool: &DatabasePool, project_id: ProjectId) {
    sqlx::query("UPDATE projects SET state='active', archived_at=NULL, updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 WHERE id=$1::uuid")
        .bind(project_id.to_string()).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
}

async fn archive_organization(pool: &DatabasePool) {
    sqlx::query("UPDATE organizations SET status='archived', archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 WHERE id=$1::uuid")
        .bind(ORGANIZATION).execute(&mut *pool.acquire().await.unwrap()).await.unwrap();
}

async fn binding_count(
    pool: &DatabasePool,
    team_id: nuriteo_server::team::TeamId,
    project_id: ProjectId,
) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM team_project_roles WHERE team_id=$1::uuid AND project_id=$2::uuid",
    )
    .bind(team_id.to_string())
    .bind(project_id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn audit_count(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action_code LIKE 'team.%'")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca = fs::read(env::var(DATABASE_CA_ENV).unwrap()).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            database_url,
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
