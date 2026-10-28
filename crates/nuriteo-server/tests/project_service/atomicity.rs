#![allow(unused_imports)]
use super::races::*;
use super::*;
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
    ProjectState, ProjectTemplate, ProjectVersion,
};

use sqlx::{Acquire, Executor, Postgres, Transaction};

use super::{
    DATABASE_CA_ENV, DATABASE_URL_ENV, DISABLED, MEMBER, MEMBER_TWO, ORGANIZATION,
    ORGANIZATION_SCOPE, OUTSIDER, OWNER, PERSONAL_SCOPE,
};
use tokio::time as tokio_time;

#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-project-service/run.sh"]
pub(crate) async fn project_service_is_authorized_versioned_audited_and_atomic() {
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
            ProjectTemplate::ViteReact,
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
                ProjectTemplate::ViteReact,
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
            ProjectTemplate::NextApp,
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
                ProjectTemplate::ViteReact,
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
                &ProjectDeleteConfirmation::new(name("Wrong Name")),
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
            &ProjectDeleteConfirmation::new(name("Direct Admin Rename")),
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
                ProjectTemplate::ViteReact,
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

pub(crate) async fn verify_direct_role_pagination(
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
            ProjectTemplate::ViteReact,
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

pub(crate) async fn verify_audit_failure_rolls_back_and_denial_fails_closed(
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
            ProjectTemplate::ViteReact,
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
                ProjectTemplate::ViteReact,
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
            ProjectTemplate::ViteReact,
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

pub(crate) async fn verify_failure_audit_uses_single_deadline(
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
            ProjectTemplate::ViteReact,
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

pub(crate) async fn verify_commit_resolution_is_bounded_and_explicit(
    pool: &DatabasePool,
    owner: UserId,
) {
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
            ProjectTemplate::ViteReact,
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
