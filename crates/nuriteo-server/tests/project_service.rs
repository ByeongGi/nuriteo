use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::audit::AuditEventId;
use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::UserId;
use nuriteo_server::organization::OrganizationId;
use nuriteo_server::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectAuditContext,
    ProjectDeleteConfirmation, ProjectId, ProjectName, ProjectOwner, ProjectPageLimit,
    ProjectRepository, ProjectRepositoryError, ProjectRole, ProjectRoleMutationResult,
    ProjectRolePageLimit, ProjectService, ProjectServiceError, ProjectServicePolicy, ProjectSlug,
    ProjectState, ProjectVersion,
};
use sqlx::{Acquire, Executor, Postgres, Transaction};
use tokio::time as tokio_time;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const OWNER: &str = "0199ee6c-c777-7000-8000-000000006001";
const MEMBER: &str = "0199ee6c-c777-7000-8000-000000006002";
const MEMBER_TWO: &str = "0199ee6c-c777-7000-8000-000000006003";
const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000006004";
const DISABLED: &str = "0199ee6c-c777-7000-8000-000000006005";
const ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000006010";
const PERSONAL_SCOPE: &str = "0199ee6c-c777-7000-8000-000000006020";
const ORGANIZATION_SCOPE: &str = "0199ee6c-c777-7000-8000-000000006021";

#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-project-service/run.sh"]
async fn project_service_is_authorized_versioned_audited_and_atomic() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(15));
    assert_eq!(report.known_migrations, 15);
    seed_fixture(&pool).await;

    let service = ProjectService::new(pool.clone(), ProjectServicePolicy::default());
    let owner = user_id(OWNER);
    let member = user_id(MEMBER);
    let member_two = user_id(MEMBER_TWO);
    let outsider = user_id(OUTSIDER);
    let organization = organization_id();
    let organization_owner = ProjectOwner::Organization(organization);
    let personal_owner = ProjectOwner::User(owner);

    let personal = service
        .create(
            owner,
            personal_owner,
            slug("personal-alpha"),
            name("Personal Alpha"),
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(personal.lock_version(), version(1));
    assert_eq!(
        service
            .create(
                outsider,
                personal_owner,
                slug("personal-denied"),
                name("Personal Denied"),
                &audit(outsider),
            )
            .await,
        Err(ProjectServiceError::Unauthorized)
    );

    let project = service
        .create(
            owner,
            organization_owner,
            slug("shared-alpha"),
            name("Shared Alpha"),
            &audit(owner),
        )
        .await
        .unwrap();
    let project_id = project.id();
    assert_eq!(project.lock_version(), version(1));
    assert_eq!(
        service
            .create(
                member,
                organization_owner,
                slug("member-create"),
                name("Member Create"),
                &audit(member),
            )
            .await,
        Err(ProjectServiceError::Unauthorized)
    );
    assert_eq!(project_count(&pool, "member-create").await, 0);

    assert_eq!(
        service.get(member, organization_owner, project_id).await,
        Err(ProjectServiceError::NotFound)
    );
    assert!(
        service
            .get(owner, ProjectOwner::User(owner), project_id)
            .await
            .is_err_and(|error| error == ProjectServiceError::NotFound)
    );

    let grant = service
        .grant_role(
            owner,
            organization_owner,
            project_id,
            version(1),
            member,
            ProjectRole::Read,
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(grant.role(), ProjectRole::Read);
    assert_eq!(project_version(&pool, project_id).await, 2);
    let grants = service
        .list_direct_roles(
            owner,
            organization_owner,
            project_id,
            ProjectRolePageLimit::new(1).unwrap(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(grants.grants().len(), 1);
    assert_eq!(grants.grants()[0].user_id(), member);
    assert!(!grants.has_more());
    assert_eq!(
        service
            .list_direct_roles(
                member,
                organization_owner,
                project.id(),
                ProjectRolePageLimit::default(),
                None,
            )
            .await,
        Err(ProjectServiceError::Unauthorized)
    );
    assert_eq!(
        service
            .grant_role(
                owner,
                organization_owner,
                project_id,
                version(1),
                member_two,
                ProjectRole::Read,
                &audit(owner),
            )
            .await,
        Err(ProjectServiceError::StaleVersion)
    );
    assert_eq!(role_count(&pool, project_id, member_two).await, 0);

    let member_page = service
        .list(
            member,
            organization_owner,
            ProjectPageLimit::new(1).unwrap(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(member_page.projects().len(), 1);
    assert_eq!(member_page.projects()[0].id(), project_id);
    assert!(!member_page.has_more());
    assert_eq!(
        service
            .list(
                member_two,
                organization_owner,
                ProjectPageLimit::default(),
                None,
            )
            .await
            .unwrap()
            .projects()
            .len(),
        0
    );
    assert_eq!(
        service
            .rename(
                member,
                organization_owner,
                project_id,
                version(2),
                name("Read Cannot Rename"),
                &audit(member),
            )
            .await,
        Err(ProjectServiceError::Unauthorized)
    );

    let renamed = service
        .rename(
            owner,
            organization_owner,
            project_id,
            version(2),
            name("Shared Renamed"),
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(renamed.lock_version(), version(3));
    assert_eq!(renamed.name().as_str(), "Shared Renamed");
    assert_eq!(
        service
            .rename(
                owner,
                organization_owner,
                project_id,
                version(2),
                name("Stale Rename"),
                &audit(owner),
            )
            .await,
        Err(ProjectServiceError::StaleVersion)
    );

    let changed = service
        .change_role(
            owner,
            organization_owner,
            project_id,
            version(3),
            member,
            ProjectRole::Admin,
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(changed.role(), ProjectRole::Admin);
    assert_eq!(project_version(&pool, project_id).await, 4);
    assert_eq!(
        service
            .grant_role(
                member,
                organization_owner,
                project_id,
                version(4),
                member_two,
                ProjectRole::Read,
                &audit(member),
            )
            .await,
        Err(ProjectServiceError::Unauthorized)
    );

    let renamed_by_admin = service
        .rename(
            member,
            organization_owner,
            project_id,
            version(4),
            name("Direct Admin Rename"),
            &audit(member),
        )
        .await
        .unwrap();
    assert_eq!(renamed_by_admin.lock_version(), version(5));
    let archived = service
        .archive(
            member,
            organization_owner,
            project_id,
            version(5),
            &audit(member),
        )
        .await
        .unwrap();
    assert_eq!(archived.state(), ProjectState::Archived);
    assert_eq!(archived.lock_version(), version(6));
    assert!(
        service
            .get(member, organization_owner, project_id)
            .await
            .is_ok()
    );
    assert_eq!(
        service
            .rename(
                member,
                organization_owner,
                project_id,
                version(6),
                name("Archived Rename"),
                &audit(member),
            )
            .await,
        Err(ProjectServiceError::Archived)
    );
    let restored = service
        .restore(
            member,
            organization_owner,
            project_id,
            version(6),
            &audit(member),
        )
        .await
        .unwrap();
    assert_eq!(restored.state(), ProjectState::Active);
    assert_eq!(restored.lock_version(), version(7));
    let archived = service
        .archive(
            owner,
            organization_owner,
            project_id,
            version(7),
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(archived.lock_version(), version(8));
    assert_eq!(
        service
            .revoke_role(
                owner,
                organization_owner,
                project_id,
                version(8),
                member,
                &audit(owner),
            )
            .await,
        Ok(ProjectRoleMutationResult::Changed)
    );
    assert_eq!(project_version(&pool, project_id).await, 9);
    assert_eq!(
        service
            .revoke_role(
                owner,
                organization_owner,
                project_id,
                version(9),
                member,
                &audit(owner),
            )
            .await,
        Ok(ProjectRoleMutationResult::AlreadyAbsent)
    );
    assert_eq!(project_version(&pool, project_id).await, 9);
    assert_eq!(
        service.get(member, organization_owner, project_id).await,
        Err(ProjectServiceError::NotFound)
    );
    let restored = service
        .restore(
            owner,
            organization_owner,
            project_id,
            version(9),
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(restored.lock_version(), version(10));

    assert_eq!(
        service
            .delete(
                owner,
                organization_owner,
                project_id,
                version(10),
                &ProjectDeleteConfirmation::new(name("Wrong Name"), true),
                &audit(owner),
            )
            .await,
        Err(ProjectServiceError::ConfirmationRequired)
    );
    assert_eq!(project_version(&pool, project_id).await, 10);
    service
        .delete(
            owner,
            organization_owner,
            project_id,
            version(10),
            &ProjectDeleteConfirmation::new(name("Direct Admin Rename"), true),
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(project_rows(&pool, project_id).await, 0);
    assert_eq!(tombstone_rows(&pool, project_id).await, 1);
    assert_eq!(
        service
            .create(
                owner,
                organization_owner,
                slug("shared-alpha"),
                name("Hijack Attempt"),
                &audit(owner),
            )
            .await,
        Err(ProjectServiceError::NamespaceUnavailable)
    );

    verify_audit_failure_rolls_back_and_denial_fails_closed(&pool, &service, owner).await;
    verify_persistence_timeouts_remain_typed(&pool, &service, owner, organization_owner).await;
    verify_direct_service_query_timeout_remains_typed(&pool, &service, owner).await;
    verify_failure_audit_uses_single_deadline(&pool, &service, owner).await;
    verify_commit_resolution_is_bounded_and_explicit(&pool, owner).await;
    verify_direct_role_pagination(
        &pool,
        &service,
        owner,
        member,
        member_two,
        organization_owner,
    )
    .await;
    verify_same_version_role_mutations_serialize(
        &pool,
        &service,
        owner,
        member,
        member_two,
        organization_owner,
    )
    .await;
    verify_update_authorization_blocks_without_lock_upgrade(
        &pool,
        &service,
        owner,
        organization_owner,
    )
    .await;
    verify_get_reloads_after_archive_race(&pool, &service, owner, organization_owner).await;
    verify_disabled_removed_and_archived_boundaries(&pool, &service, owner, organization_owner)
        .await;

    assert!(audit_count(&pool, "project.created", "succeeded").await >= 4);
    assert!(audit_count(&pool, "project.renamed", "denied").await >= 1);
    assert!(audit_count(&pool, "project.renamed", "failed").await >= 1);
    assert_eq!(secret_like_audit_metadata(&pool).await, 0);

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_direct_role_pagination(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
    member: UserId,
    member_two: UserId,
    organization_owner: ProjectOwner,
) {
    let project = service
        .create(
            owner,
            organization_owner,
            slug("role-list"),
            name("Role List"),
            &audit(owner),
        )
        .await
        .unwrap();
    service
        .grant_role(
            owner,
            organization_owner,
            project.id(),
            version(1),
            member,
            ProjectRole::Read,
            &audit(owner),
        )
        .await
        .unwrap();
    service
        .grant_role(
            owner,
            organization_owner,
            project.id(),
            version(2),
            member_two,
            ProjectRole::Write,
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(project_version(pool, project.id()).await, 3);

    let first = service
        .list_direct_roles(
            owner,
            organization_owner,
            project.id(),
            ProjectRolePageLimit::new(1).unwrap(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(first.grants().len(), 1);
    assert_eq!(first.grants()[0].user_id(), member);
    assert!(first.has_more());
    let second = service
        .list_direct_roles(
            owner,
            organization_owner,
            project.id(),
            ProjectRolePageLimit::new(1).unwrap(),
            first.next_key(),
        )
        .await
        .unwrap();
    assert_eq!(second.grants().len(), 1);
    assert_eq!(second.grants()[0].user_id(), member_two);
    assert!(!second.has_more());
}

async fn verify_audit_failure_rolls_back_and_denial_fails_closed(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
) {
    let reused_id = AuditEventId::new();
    let reused = ProjectAuditContext::new(reused_id, owner, None, "reused-audit".into(), None);
    service
        .create(
            owner,
            ProjectOwner::User(owner),
            slug("audit-anchor"),
            name("Audit Anchor"),
            &reused,
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .create(
                owner,
                ProjectOwner::User(owner),
                slug("audit-rollback"),
                name("Audit Rollback"),
                &reused,
            )
            .await,
        Err(ProjectServiceError::AuditUnavailable)
    );
    assert_eq!(project_count(pool, "audit-rollback").await, 0);

    let project = service
        .create(
            owner,
            ProjectOwner::User(owner),
            slug("denial-anchor"),
            name("Denial Anchor"),
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .rename(
                user_id(OUTSIDER),
                ProjectOwner::User(owner),
                project.id(),
                version(1),
                name("Denied"),
                &ProjectAuditContext::new(
                    reused_id,
                    user_id(OUTSIDER),
                    None,
                    "duplicate-denial".into(),
                    None,
                ),
            )
            .await,
        Err(ProjectServiceError::AuditUnavailable)
    );
    assert_eq!(project_name(pool, project.id()).await, "Denial Anchor");
}

async fn verify_failure_audit_uses_single_deadline(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
) {
    let project = service
        .create(
            owner,
            ProjectOwner::User(owner),
            slug("audit-deadline"),
            name("Audit Deadline"),
            &audit(owner),
        )
        .await
        .unwrap();
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    holder
        .execute("LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let mut project_holder_connection = pool.acquire().await.unwrap();
    let mut project_holder = project_holder_connection.begin().await.unwrap();
    let project_holder_pid = backend_pid(&mut project_holder).await;
    sqlx::query("SELECT id FROM projects WHERE id=$1::uuid FOR UPDATE")
        .bind(project.id().to_string())
        .execute(&mut *project_holder)
        .await
        .unwrap();
    let bounded = ProjectService::new(
        pool.clone(),
        ProjectServicePolicy::new(Duration::from_millis(300)).unwrap(),
    );
    let project_id = project.id();
    let started = tokio_time::Instant::now();
    let contender = tokio::spawn(async move {
        bounded
            .rename(
                user_id(OUTSIDER),
                ProjectOwner::User(owner),
                project_id,
                version(1),
                name("Denied"),
                &audit(user_id(OUTSIDER)),
            )
            .await
    });
    assert!(
        wait_for_project_update_block(pool, project_holder_pid).await,
        "primary denial must first consume the shared deadline on authorization"
    );
    tokio_time::sleep(Duration::from_millis(150)).await;
    project_holder.rollback().await.unwrap();
    let result = contender.await.unwrap();
    let elapsed = started.elapsed();
    holder.rollback().await.unwrap();
    assert_eq!(result, Err(ProjectServiceError::AuditUnavailable));
    assert!(
        elapsed >= Duration::from_millis(250),
        "failure audit must consume the remainder of the original budget: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_millis(400),
        "failure audit must not receive a fresh operation budget: {elapsed:?}"
    );
    assert_eq!(project_name(pool, project_id).await, "Audit Deadline");
}

async fn verify_commit_resolution_is_bounded_and_explicit(pool: &DatabasePool, owner: UserId) {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION project_service_slow_commit() RETURNS trigger \
         LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "CREATE CONSTRAINT TRIGGER project_service_slow_commit \
         AFTER INSERT ON projects DEFERRABLE INITIALLY DEFERRED \
         FOR EACH ROW EXECUTE FUNCTION project_service_slow_commit()",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let bounded = ProjectService::new(
        pool.clone(),
        ProjectServicePolicy::new(Duration::from_millis(200)).unwrap(),
    );
    let started = tokio_time::Instant::now();
    let result = bounded
        .create(
            owner,
            ProjectOwner::User(owner),
            slug("commit-deadline"),
            name("Commit Deadline"),
            &audit(owner),
        )
        .await;
    let elapsed = started.elapsed();
    sqlx::query("DROP TRIGGER project_service_slow_commit ON projects")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION project_service_slow_commit()")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(result, Err(ProjectServiceError::CommitOutcomeUnknown));
    assert!(
        elapsed >= Duration::from_millis(1_800),
        "COMMIT must wait near the configured resolution grace: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_millis(2_750),
        "COMMIT response loss must have a bounded resolution grace: {elapsed:?}"
    );
}

async fn verify_persistence_timeouts_remain_typed(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
    organization_owner: ProjectOwner,
) {
    let project = service
        .create(
            owner,
            organization_owner,
            slug("typed-timeout"),
            name("Typed Timeout"),
            &audit(owner),
        )
        .await
        .unwrap();
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    sqlx::query("SELECT id FROM projects WHERE id=$1::uuid FOR UPDATE")
        .bind(project.id().to_string())
        .execute(&mut *holder)
        .await
        .unwrap();

    let mut access_connection = pool.acquire().await.unwrap();
    let mut access_transaction = access_connection.begin().await.unwrap();
    access_transaction
        .execute("SET LOCAL lock_timeout = '100ms'")
        .await
        .unwrap();
    assert_eq!(
        ProjectAccessRepository::resolve_effective_role_for_update(
            &mut access_transaction,
            project.id(),
            owner,
        )
        .await,
        Err(ProjectAccessError::OperationTimeout)
    );
    access_transaction.rollback().await.unwrap();

    let mut repository_connection = pool.acquire().await.unwrap();
    let mut repository_transaction = repository_connection.begin().await.unwrap();
    repository_transaction
        .execute("SET LOCAL lock_timeout = 0")
        .await
        .unwrap();
    repository_transaction
        .execute("SET LOCAL statement_timeout = '100ms'")
        .await
        .unwrap();
    assert_eq!(
        ProjectRepository::lock_by_id(&mut repository_transaction, project.id()).await,
        Err(ProjectRepositoryError::OperationTimeout)
    );
    repository_transaction.rollback().await.unwrap();

    let bounded = ProjectService::new(
        pool.clone(),
        ProjectServicePolicy::new(Duration::from_millis(200)).unwrap(),
    );
    let started = tokio_time::Instant::now();
    assert_eq!(
        bounded
            .rename(
                owner,
                organization_owner,
                project.id(),
                version(1),
                name("Must Time Out"),
                &audit(owner),
            )
            .await,
        Err(ProjectServiceError::OperationTimeout)
    );
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "service lock timeout must remain bounded"
    );
    holder.rollback().await.unwrap();
}

async fn verify_direct_service_query_timeout_remains_typed(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
) {
    let project = service
        .create(
            owner,
            ProjectOwner::User(owner),
            slug("direct-query-timeout"),
            name("Direct Query Timeout"),
            &audit(owner),
        )
        .await
        .unwrap();
    sqlx::query(
        "CREATE OR REPLACE FUNCTION project_service_slow_direct_update() RETURNS trigger \
         LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER project_service_slow_direct_update \
         BEFORE UPDATE OF name ON projects \
         FOR EACH ROW WHEN (NEW.name = 'Must Time Out') \
         EXECUTE FUNCTION project_service_slow_direct_update()",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    let bounded = ProjectService::new(
        pool.clone(),
        ProjectServicePolicy::new(Duration::from_millis(200)).unwrap(),
    );
    let started = tokio_time::Instant::now();
    let result = bounded
        .rename(
            owner,
            ProjectOwner::User(owner),
            project.id(),
            version(1),
            name("Must Time Out"),
            &audit(owner),
        )
        .await;
    let elapsed = started.elapsed();
    sqlx::query("DROP TRIGGER project_service_slow_direct_update ON projects")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION project_service_slow_direct_update()")
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();

    assert_eq!(result, Err(ProjectServiceError::OperationTimeout));
    assert!(
        elapsed >= Duration::from_millis(125) && elapsed < Duration::from_millis(400),
        "direct service UPDATE must preserve PostgreSQL statement timeout: {elapsed:?}"
    );
    assert_eq!(
        project_name(pool, project.id()).await,
        "Direct Query Timeout"
    );
}

async fn verify_same_version_role_mutations_serialize(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
    member: UserId,
    member_two: UserId,
    organization_owner: ProjectOwner,
) {
    let project = service
        .create(
            owner,
            organization_owner,
            slug("role-race"),
            name("Role Race"),
            &audit(owner),
        )
        .await
        .unwrap();
    let project_id = project.id();
    let left_service = service.clone();
    let right_service = service.clone();
    let left = tokio::spawn(async move {
        left_service
            .grant_role(
                owner,
                organization_owner,
                project_id,
                version(1),
                member,
                ProjectRole::Write,
                &audit(owner),
            )
            .await
    });
    let right = tokio::spawn(async move {
        right_service
            .grant_role(
                owner,
                organization_owner,
                project_id,
                version(1),
                member_two,
                ProjectRole::Read,
                &audit(owner),
            )
            .await
    });
    let results = [left.await.unwrap(), right.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(ProjectServiceError::StaleVersion)))
            .count(),
        1
    );
    assert_eq!(project_version(pool, project_id).await, 2);
    assert_eq!(
        role_count(pool, project_id, member).await + role_count(pool, project_id, member_two).await,
        1
    );
}

async fn verify_update_authorization_blocks_without_lock_upgrade(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
    organization_owner: ProjectOwner,
) {
    let project = service
        .create(
            owner,
            organization_owner,
            slug("update-lock-race"),
            name("Update Lock Race"),
            &audit(owner),
        )
        .await
        .unwrap();
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    let holder_pid = backend_pid(&mut holder).await;
    assert_eq!(
        ProjectAccessRepository::resolve_effective_role_for_update(
            &mut holder,
            project.id(),
            owner,
        )
        .await
        .unwrap(),
        EffectiveProjectRole::Admin
    );

    let contender_service = service.clone();
    let project_id = project.id();
    let contender = tokio::spawn(async move {
        contender_service
            .rename(
                owner,
                organization_owner,
                project_id,
                version(1),
                name("Serialized Rename"),
                &audit(owner),
            )
            .await
    });
    if !wait_for_project_update_block(pool, holder_pid).await {
        holder.rollback().await.unwrap();
        contender.abort();
        let _ = contender.await;
        panic!("Project mutation must wait on the update authorization lock");
    }
    holder.commit().await.unwrap();
    let renamed = tokio_time::timeout(Duration::from_secs(2), contender)
        .await
        .expect("Project mutation must proceed after update-lock release")
        .expect("Project mutation task must join")
        .expect("Project mutation must succeed");
    assert_eq!(renamed.lock_version(), version(2));
}

async fn verify_get_reloads_after_archive_race(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
    organization_owner: ProjectOwner,
) {
    let project = service
        .create(
            owner,
            organization_owner,
            slug("get-archive-race"),
            name("Get Archive Race"),
            &audit(owner),
        )
        .await
        .unwrap();
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    let holder_pid = backend_pid(&mut holder).await;
    sqlx::query("SELECT id FROM projects WHERE id=$1::uuid FOR UPDATE")
        .bind(project.id().to_string())
        .execute(&mut *holder)
        .await
        .unwrap();

    let reader_service = service.clone();
    let project_id = project.id();
    let reader = tokio::spawn(async move {
        reader_service
            .get(owner, organization_owner, project_id)
            .await
    });
    if !wait_for_project_share_block(pool, holder_pid).await {
        holder.rollback().await.unwrap();
        reader.abort();
        let _ = reader.await;
        panic!("Project get must lock after its initial namespace probe");
    }
    sqlx::query(
        "UPDATE projects SET state='archived', archived_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(project.id().to_string())
    .execute(&mut *holder)
    .await
    .unwrap();
    holder.commit().await.unwrap();

    let current = tokio_time::timeout(Duration::from_secs(2), reader)
        .await
        .expect("Project get must proceed after archive commit")
        .expect("Project get task must join")
        .expect("archived Project remains readable");
    assert_eq!(current.state(), ProjectState::Archived);
    assert_eq!(current.lock_version(), version(2));
}

async fn verify_disabled_removed_and_archived_boundaries(
    pool: &DatabasePool,
    service: &ProjectService,
    owner: UserId,
    organization_owner: ProjectOwner,
) {
    let project = service
        .create(
            owner,
            organization_owner,
            slug("boundary-project"),
            name("Boundary Project"),
            &audit(owner),
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .grant_role(
                owner,
                organization_owner,
                project.id(),
                version(1),
                user_id(DISABLED),
                ProjectRole::Read,
                &audit(owner),
            )
            .await,
        Err(ProjectServiceError::MemberUnavailable)
    );
    sqlx::query(
        "DELETE FROM organization_memberships \
         WHERE organization_id=$1::uuid AND user_id=$2::uuid",
    )
    .bind(ORGANIZATION)
    .bind(MEMBER_TWO)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .grant_role(
                owner,
                organization_owner,
                project.id(),
                version(1),
                user_id(MEMBER_TWO),
                ProjectRole::Read,
                &audit(owner),
            )
            .await,
        Err(ProjectServiceError::MemberUnavailable)
    );
    sqlx::query(
        "UPDATE organizations SET status='archived', archived_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 WHERE id=$1::uuid",
    )
    .bind(ORGANIZATION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service.get(owner, organization_owner, project.id()).await,
        Err(ProjectServiceError::NotFound)
    );
    assert!(
        service
            .list(owner, organization_owner, ProjectPageLimit::default(), None,)
            .await
            .is_err_and(|error| error == ProjectServiceError::Archived)
    );
}

async fn seed_fixture(pool: &DatabasePool) {
    for (id, label, status) in [
        (OWNER, "owner", "active"),
        (MEMBER, "member", "active"),
        (MEMBER_TWO, "member-two", "active"),
        (OUTSIDER, "outsider", "active"),
        (DISABLED, "disabled", "disabled"),
    ] {
        let email = format!("{label}@example.test");
        sqlx::query(
            "INSERT INTO users \
             (id,email,normalized_email,display_name,status,disabled_at,updated_at) VALUES \
             ($1::uuid,$2,$2,$3,$4,CASE WHEN $4='disabled' THEN CURRENT_TIMESTAMP END, \
              CURRENT_TIMESTAMP)",
        )
        .bind(id)
        .bind(email)
        .bind(label)
        .bind(status)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO organizations (id,slug,display_name) VALUES \
         ($1::uuid,'service-org','Service Org')",
    )
    .bind(ORGANIZATION)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    for (user, role) in [
        (OWNER, "owner"),
        (MEMBER, "member"),
        (MEMBER_TWO, "member"),
        (DISABLED, "member"),
    ] {
        sqlx::query(
            "INSERT INTO organization_memberships (organization_id,user_id,role) \
             VALUES ($1::uuid,$2::uuid,$3)",
        )
        .bind(ORGANIZATION)
        .bind(user)
        .bind(role)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO storage_scopes (id,owner_user_id) VALUES ($1::uuid,$2::uuid)")
        .bind(PERSONAL_SCOPE)
        .bind(OWNER)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query("INSERT INTO storage_scopes (id,owner_organization_id) VALUES ($1::uuid,$2::uuid)")
        .bind(ORGANIZATION_SCOPE)
        .bind(ORGANIZATION)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

fn audit(user_id: UserId) -> ProjectAuditContext {
    ProjectAuditContext::new(
        AuditEventId::new(),
        user_id,
        None,
        format!("project-service-{}", AuditEventId::new()),
        None,
    )
}

fn user_id(value: &str) -> UserId {
    value.parse().unwrap()
}

fn organization_id() -> OrganizationId {
    ORGANIZATION.parse().unwrap()
}

fn slug(value: &str) -> ProjectSlug {
    ProjectSlug::new(value.into()).unwrap()
}

fn name(value: &str) -> ProjectName {
    ProjectName::new(value.into()).unwrap()
}

fn version(value: i64) -> ProjectVersion {
    ProjectVersion::new(value).unwrap()
}

async fn project_version(pool: &DatabasePool, project_id: ProjectId) -> i64 {
    sqlx::query_scalar("SELECT lock_version FROM projects WHERE id=$1::uuid")
        .bind(project_id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn project_name(pool: &DatabasePool, project_id: ProjectId) -> String {
    sqlx::query_scalar("SELECT name FROM projects WHERE id=$1::uuid")
        .bind(project_id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn project_rows(pool: &DatabasePool, project_id: ProjectId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE id=$1::uuid")
        .bind(project_id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn tombstone_rows(pool: &DatabasePool, project_id: ProjectId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM project_tombstones WHERE former_project_id=$1::uuid")
        .bind(project_id.to_string())
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn project_count(pool: &DatabasePool, slug: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE slug=$1")
        .bind(slug)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn role_count(pool: &DatabasePool, project_id: ProjectId, user_id: UserId) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM project_user_roles WHERE project_id=$1::uuid AND user_id=$2::uuid",
    )
    .bind(project_id.to_string())
    .bind(user_id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn backend_pid(transaction: &mut Transaction<'_, Postgres>) -> i32 {
    sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut **transaction)
        .await
        .unwrap()
}

async fn wait_for_project_update_block(pool: &DatabasePool, holder_pid: i32) -> bool {
    let deadline = tokio_time::Instant::now() + Duration::from_secs(2);
    let mut observer = pool.acquire().await.unwrap();
    loop {
        let remaining = deadline.saturating_duration_since(tokio_time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let observed = tokio_time::timeout(
            remaining,
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity activity \
                 WHERE activity.pid <> $1 \
                   AND $1 = ANY(pg_blocking_pids(activity.pid)) \
                   AND activity.query LIKE '%FROM projects WHERE id = $1::uuid FOR UPDATE%')",
            )
            .bind(holder_pid)
            .fetch_one(&mut *observer),
        )
        .await;
        let Ok(Ok(blocked)) = observed else {
            return false;
        };
        if blocked {
            return true;
        }
        tokio_time::sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_for_project_share_block(pool: &DatabasePool, holder_pid: i32) -> bool {
    let deadline = tokio_time::Instant::now() + Duration::from_secs(2);
    let mut observer = pool.acquire().await.unwrap();
    loop {
        let remaining = deadline.saturating_duration_since(tokio_time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let observed = tokio_time::timeout(
            remaining,
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity activity \
                 WHERE activity.pid <> $1 \
                   AND $1 = ANY(pg_blocking_pids(activity.pid)) \
                   AND activity.query LIKE '%FROM projects WHERE id = $1::uuid FOR SHARE%')",
            )
            .bind(holder_pid)
            .fetch_one(&mut *observer),
        )
        .await;
        let Ok(Ok(blocked)) = observed else {
            return false;
        };
        if blocked {
            return true;
        }
        tokio_time::sleep(Duration::from_millis(25)).await;
    }
}

async fn audit_count(pool: &DatabasePool, action: &str, result: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action_code=$1 AND result=$2")
        .bind(action)
        .bind(result)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn secret_like_audit_metadata(pool: &DatabasePool) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events \
         WHERE metadata::text ~* '(password|token|secret|credential|authorization|cookie|dsn)'",
    )
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
