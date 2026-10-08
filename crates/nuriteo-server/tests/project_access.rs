use std::env;
use std::fs;
use std::str::FromStr;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{Timestamp, UserId};
use nuriteo_server::project::{
    EffectiveProjectRole, ProjectAccessError, ProjectAccessRepository, ProjectId, ProjectRole,
};
use sqlx::{Acquire, Executor, Postgres, Transaction};
use tokio::sync::oneshot;
use tokio::time;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const OWNER: &str = "0199ee6c-c777-7000-8000-000000005001";
const MEMBER: &str = "0199ee6c-c777-7000-8000-000000005002";
const UNGRANTED: &str = "0199ee6c-c777-7000-8000-000000005003";
const OUTSIDER: &str = "0199ee6c-c777-7000-8000-000000005004";
const DISABLED: &str = "0199ee6c-c777-7000-8000-000000005005";
const ORGANIZATION: &str = "0199ee6c-c777-7000-8000-000000005010";
const PERSONAL_SCOPE: &str = "0199ee6c-c777-7000-8000-000000005020";
const ORGANIZATION_SCOPE: &str = "0199ee6c-c777-7000-8000-000000005021";
const PERSONAL_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005030";
const ARCHIVED_PERSONAL_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005031";
const ORGANIZATION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005032";
const ARCHIVED_ORGANIZATION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005033";
const DELETION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005034";
const CONCURRENT_DELETE_PROJECT: &str = "0199ee6c-c777-7000-8000-000000005035";
const READ_TEAM: &str = "0199ee6c-c777-7000-8000-000000005060";
const WRITE_TEAM: &str = "0199ee6c-c777-7000-8000-000000005061";
const ADMIN_TEAM: &str = "0199ee6c-c777-7000-8000-000000005062";

#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-project-access/run.sh"]
async fn direct_project_roles_are_isolated_effective_and_serialized() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(40));
    assert_eq!(report.known_migrations, 40);
    seed_fixture(&pool).await;

    verify_effective_roles_and_archived_access(&pool).await;
    verify_team_roles_compose_and_fail_closed(&pool).await;
    verify_typed_grant_revoke_and_constraints(&pool).await;
    verify_owner_demotion_reactivates_direct_grant(&pool).await;
    verify_membership_role_and_effective_races(&pool).await;
    verify_role_change_and_membership_removal_races(&pool).await;
    verify_concurrent_same_pair_grant(&pool).await;
    verify_membership_delete_blocks_grant(&pool).await;
    verify_concurrent_grant_and_membership_delete(&pool).await;
    verify_effective_role_blocks_membership_delete(&pool).await;
    verify_concurrent_revoke_and_membership_delete(&pool).await;
    verify_concurrent_grant_and_project_delete(&pool).await;
    verify_lifecycle_cascades(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_team_roles_compose_and_fail_closed(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO teams (id,organization_id,slug,display_name) VALUES \
         ('0199ee6c-c777-7000-8000-000000005060'::uuid, \
          '0199ee6c-c777-7000-8000-000000005010'::uuid,'readers','Readers'), \
         ('0199ee6c-c777-7000-8000-000000005061'::uuid, \
          '0199ee6c-c777-7000-8000-000000005010'::uuid,'writers','Writers'), \
         ('0199ee6c-c777-7000-8000-000000005062'::uuid, \
          '0199ee6c-c777-7000-8000-000000005010'::uuid,'admins','Admins')",
    )
    .await;
    for (team, role) in [
        (READ_TEAM, "member"),
        (WRITE_TEAM, "maintainer"),
        (ADMIN_TEAM, "member"),
    ] {
        sqlx::query(
            "INSERT INTO team_memberships (team_id,organization_id,user_id,role) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4)",
        )
        .bind(team)
        .bind(ORGANIZATION)
        .bind(MEMBER)
        .bind(role)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    for (team, role) in [
        (READ_TEAM, "read"),
        (WRITE_TEAM, "write"),
        (ADMIN_TEAM, "admin"),
    ] {
        sqlx::query(
            "INSERT INTO team_project_roles (team_id,organization_id,project_id,role) \
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4)",
        )
        .bind(team)
        .bind(ORGANIZATION)
        .bind(ORGANIZATION_PROJECT)
        .bind(role)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }

    grant(pool, ORGANIZATION_PROJECT, MEMBER, ProjectRole::Write).await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Admin,
        "the maximum direct or Team role must win"
    );
    assert_eq!(
        effective(pool, PERSONAL_PROJECT, MEMBER).await,
        EffectiveProjectRole::None,
        "Organization Team roles must not affect a personal Project"
    );
    assert_eq!(
        effective(pool, PERSONAL_PROJECT, OWNER).await,
        EffectiveProjectRole::Admin,
        "personal ownership semantics must remain unchanged"
    );

    delete_team_membership(pool, ADMIN_TEAM).await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Write,
        "membership removal must fall back to remaining authority"
    );
    delete_team_membership(pool, WRITE_TEAM).await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Write,
        "a direct role must remain after Team membership removal"
    );
    revoke(pool, ORGANIZATION_PROJECT, MEMBER).await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Read,
        "revoking a direct role must reveal the remaining Team role"
    );

    execute(
        pool,
        "UPDATE projects SET state='archived', archived_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 \
         WHERE id='0199ee6c-c777-7000-8000-000000005032'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Read,
        "an archived Project must preserve its existing Team role"
    );
    execute(
        pool,
        "UPDATE projects SET state='active', archived_at=NULL, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 \
         WHERE id='0199ee6c-c777-7000-8000-000000005032'::uuid",
    )
    .await;

    execute(
        pool,
        "UPDATE users SET status='disabled', disabled_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None,
        "a disabled User must never receive a preserved Team role"
    );
    execute(
        pool,
        "UPDATE users SET status='active', disabled_at=NULL, updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;

    execute(
        pool,
        "UPDATE organizations SET status='archived', archived_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 \
         WHERE id='0199ee6c-c777-7000-8000-000000005010'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None,
        "an archived Organization must suppress preserved Team roles"
    );
    execute(
        pool,
        "UPDATE organizations SET status='active', archived_at=NULL, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 \
         WHERE id='0199ee6c-c777-7000-8000-000000005010'::uuid",
    )
    .await;

    delete_team_membership(pool, READ_TEAM).await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None
    );
    execute(
        pool,
        "DELETE FROM teams WHERE organization_id='0199ee6c-c777-7000-8000-000000005010'::uuid",
    )
    .await;
}

async fn delete_team_membership(pool: &DatabasePool, team_id: &str) {
    sqlx::query(
        "DELETE FROM team_memberships \
         WHERE team_id=$1::uuid AND user_id=$2::uuid",
    )
    .bind(team_id)
    .bind(MEMBER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn verify_effective_roles_and_archived_access(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    for (project, user, expected) in [
        (PERSONAL_PROJECT, OWNER, EffectiveProjectRole::Admin),
        (
            ARCHIVED_PERSONAL_PROJECT,
            OWNER,
            EffectiveProjectRole::Admin,
        ),
        (PERSONAL_PROJECT, OUTSIDER, EffectiveProjectRole::None),
        (ORGANIZATION_PROJECT, OWNER, EffectiveProjectRole::Admin),
        (
            ARCHIVED_ORGANIZATION_PROJECT,
            OWNER,
            EffectiveProjectRole::Admin,
        ),
        (ORGANIZATION_PROJECT, MEMBER, EffectiveProjectRole::None),
        (ORGANIZATION_PROJECT, UNGRANTED, EffectiveProjectRole::None),
        (ORGANIZATION_PROJECT, OUTSIDER, EffectiveProjectRole::None),
        (ORGANIZATION_PROJECT, DISABLED, EffectiveProjectRole::None),
    ] {
        assert_eq!(
            ProjectAccessRepository::resolve_effective_role(
                &mut transaction,
                project_id(project),
                user_id(user),
            )
            .await
            .unwrap(),
            expected
        );
    }
    transaction.rollback().await.unwrap();

    grant(
        pool,
        ARCHIVED_ORGANIZATION_PROJECT,
        MEMBER,
        ProjectRole::Read,
    )
    .await;
    execute(
        pool,
        "UPDATE projects SET state='archived', archived_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 \
         WHERE id='0199ee6c-c777-7000-8000-000000005033'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ARCHIVED_ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Read
    );
    execute(
        pool,
        "UPDATE organizations SET status='archived', archived_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 \
         WHERE id='0199ee6c-c777-7000-8000-000000005010'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ARCHIVED_ORGANIZATION_PROJECT, OWNER).await,
        EffectiveProjectRole::None
    );
    assert_eq!(
        effective(pool, ARCHIVED_ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None
    );
    execute(
        pool,
        "UPDATE organizations SET status='active', archived_at=NULL, \
         updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 \
         WHERE id='0199ee6c-c777-7000-8000-000000005010'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ARCHIVED_ORGANIZATION_PROJECT, OWNER).await,
        EffectiveProjectRole::Admin
    );
    assert_eq!(
        effective(pool, ARCHIVED_ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Read
    );
    assert_eq!(
        grant_result(
            pool,
            ARCHIVED_ORGANIZATION_PROJECT,
            UNGRANTED,
            ProjectRole::Read,
        )
        .await,
        Err(ProjectAccessError::ProjectUnavailable)
    );

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert!(
        ProjectAccessRepository::revoke(
            &mut transaction,
            project_id(ARCHIVED_ORGANIZATION_PROJECT),
            user_id(MEMBER),
        )
        .await
        .unwrap()
    );
    transaction.commit().await.unwrap();
}

async fn verify_owner_demotion_reactivates_direct_grant(pool: &DatabasePool) {
    grant(pool, ORGANIZATION_PROJECT, OWNER, ProjectRole::Read).await;
    execute(
        pool,
        "UPDATE organization_memberships SET role='owner', updated_at=CURRENT_TIMESTAMP \
         WHERE organization_id='0199ee6c-c777-7000-8000-000000005010'::uuid \
           AND user_id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;
    execute(
        pool,
        "UPDATE organization_memberships SET role='member', updated_at=CURRENT_TIMESTAMP \
         WHERE organization_id='0199ee6c-c777-7000-8000-000000005010'::uuid \
           AND user_id='0199ee6c-c777-7000-8000-000000005001'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, OWNER).await,
        EffectiveProjectRole::Read
    );
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Admin
    );
    execute(
        pool,
        "UPDATE organization_memberships SET role='owner', updated_at=CURRENT_TIMESTAMP \
         WHERE organization_id='0199ee6c-c777-7000-8000-000000005010'::uuid \
           AND user_id='0199ee6c-c777-7000-8000-000000005001'::uuid",
    )
    .await;
    execute(
        pool,
        "UPDATE organization_memberships SET role='member', updated_at=CURRENT_TIMESTAMP \
         WHERE organization_id='0199ee6c-c777-7000-8000-000000005010'::uuid \
           AND user_id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;
}

async fn verify_membership_role_and_effective_races(pool: &DatabasePool) {
    execute(
        pool,
        "UPDATE organization_memberships SET role='owner', updated_at=CURRENT_TIMESTAMP \
         WHERE organization_id='0199ee6c-c777-7000-8000-000000005010'::uuid \
           AND user_id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;

    let mut resolver_connection = pool.acquire().await.unwrap();
    let mut resolver_transaction = resolver_connection.begin().await.unwrap();
    let resolver_pid = backend_pid(&mut resolver_transaction).await;
    assert_eq!(
        ProjectAccessRepository::resolve_effective_role(
            &mut resolver_transaction,
            project_id(ORGANIZATION_PROJECT),
            user_id(OWNER),
        )
        .await
        .unwrap(),
        EffectiveProjectRole::Admin
    );
    let demotion_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let demotion = tokio::spawn(async move {
        let mut connection = demotion_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        lock_organization_for_update(&mut transaction).await;
        sqlx::query(
            "UPDATE organization_memberships SET role='member', updated_at=CURRENT_TIMESTAMP \
             WHERE organization_id=$1::uuid AND user_id=$2::uuid",
        )
        .bind(ORGANIZATION)
        .bind(OWNER)
        .execute(&mut *transaction)
        .await
        .unwrap();
        transaction.commit().await.unwrap();
    });
    let demotion_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, resolver_pid, demotion_pid).await {
        resolver_transaction.rollback().await.unwrap();
        demotion.abort();
        let _ = demotion.await;
        panic!("membership demotion must wait for the effective-role transaction");
    }
    resolver_transaction.rollback().await.unwrap();
    time::timeout(Duration::from_secs(2), demotion)
        .await
        .expect("membership demotion must proceed after resolver release")
        .expect("membership demotion task must join");
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, OWNER).await,
        EffectiveProjectRole::Read
    );

    let mut promotion_connection = pool.acquire().await.unwrap();
    let mut promotion = promotion_connection.begin().await.unwrap();
    let promotion_pid = backend_pid(&mut promotion).await;
    lock_organization_for_update(&mut promotion).await;
    sqlx::query(
        "UPDATE organization_memberships SET role='owner', updated_at=CURRENT_TIMESTAMP \
         WHERE organization_id=$1::uuid AND user_id=$2::uuid",
    )
    .bind(ORGANIZATION)
    .bind(OWNER)
    .execute(&mut *promotion)
    .await
    .unwrap();
    let resolver_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let resolver = tokio::spawn(async move {
        let mut connection = resolver_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        let role = ProjectAccessRepository::resolve_effective_role(
            &mut transaction,
            project_id(ORGANIZATION_PROJECT),
            user_id(OWNER),
        )
        .await;
        transaction.rollback().await.unwrap();
        role
    });
    let contender_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, promotion_pid, contender_pid).await {
        promotion.rollback().await.unwrap();
        resolver.abort();
        let _ = resolver.await;
        panic!("effective-role resolution must wait for membership promotion");
    }
    promotion.commit().await.unwrap();
    assert_eq!(
        time::timeout(Duration::from_secs(2), resolver)
            .await
            .expect("resolver must proceed after membership promotion")
            .expect("resolver task must join")
            .unwrap(),
        EffectiveProjectRole::Admin
    );
    execute(
        pool,
        "UPDATE organization_memberships SET role='member', updated_at=CURRENT_TIMESTAMP \
         WHERE organization_id='0199ee6c-c777-7000-8000-000000005010'::uuid \
           AND user_id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;
}

async fn verify_role_change_and_membership_removal_races(pool: &DatabasePool) {
    let mut role_change_connection = pool.acquire().await.unwrap();
    let mut role_change = role_change_connection.begin().await.unwrap();
    let role_change_pid = backend_pid(&mut role_change).await;
    assert!(
        ProjectAccessRepository::revoke(
            &mut role_change,
            project_id(ORGANIZATION_PROJECT),
            user_id(MEMBER),
        )
        .await
        .unwrap()
    );
    ProjectAccessRepository::grant(
        &mut role_change,
        project_id(ORGANIZATION_PROJECT),
        user_id(MEMBER),
        ProjectRole::Admin,
        now(),
    )
    .await
    .unwrap();

    let removal_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let removal = tokio::spawn(async move {
        let mut connection = removal_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        lock_organization_for_update(&mut transaction).await;
        sqlx::query(
            "DELETE FROM organization_memberships \
             WHERE organization_id=$1::uuid AND user_id=$2::uuid",
        )
        .bind(ORGANIZATION)
        .bind(MEMBER)
        .execute(&mut *transaction)
        .await
        .unwrap();
        transaction.commit().await.unwrap();
    });
    let removal_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, role_change_pid, removal_pid).await {
        role_change.rollback().await.unwrap();
        removal.abort();
        let _ = removal.await;
        panic!("membership removal must wait for the role-change transaction");
    }
    role_change.commit().await.unwrap();
    time::timeout(Duration::from_secs(2), removal)
        .await
        .expect("membership removal must proceed after role-change commit")
        .expect("membership removal task must join");
    assert_eq!(role_count(pool, ORGANIZATION_PROJECT, MEMBER).await, 0);
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None
    );
    insert_membership(pool, MEMBER, "member").await;
    grant(pool, ORGANIZATION_PROJECT, MEMBER, ProjectRole::Read).await;

    let mut removal_connection = pool.acquire().await.unwrap();
    let mut removal = removal_connection.begin().await.unwrap();
    let removal_pid = backend_pid(&mut removal).await;
    lock_organization_for_update(&mut removal).await;
    sqlx::query(
        "DELETE FROM organization_memberships \
         WHERE organization_id=$1::uuid AND user_id=$2::uuid",
    )
    .bind(ORGANIZATION)
    .bind(MEMBER)
    .execute(&mut *removal)
    .await
    .unwrap();

    let role_change_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let role_change = tokio::spawn(async move {
        let mut connection = role_change_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        let revoked = ProjectAccessRepository::revoke(
            &mut transaction,
            project_id(ORGANIZATION_PROJECT),
            user_id(MEMBER),
        )
        .await;
        let granted = ProjectAccessRepository::grant(
            &mut transaction,
            project_id(ORGANIZATION_PROJECT),
            user_id(MEMBER),
            ProjectRole::Write,
            now(),
        )
        .await;
        transaction.rollback().await.unwrap();
        (revoked, granted)
    });
    let role_change_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, removal_pid, role_change_pid).await {
        removal.rollback().await.unwrap();
        role_change.abort();
        let _ = role_change.await;
        panic!("role change must wait for membership removal");
    }
    removal.commit().await.unwrap();
    let (revoked, granted) = time::timeout(Duration::from_secs(2), role_change)
        .await
        .expect("role change must resolve after membership removal")
        .expect("role-change task must join");
    assert_eq!(revoked, Ok(false));
    assert_eq!(granted, Err(ProjectAccessError::MemberUnavailable));
    assert_eq!(role_count(pool, ORGANIZATION_PROJECT, MEMBER).await, 0);
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None
    );
    insert_membership(pool, MEMBER, "member").await;
    grant(pool, ORGANIZATION_PROJECT, MEMBER, ProjectRole::Write).await;
}

async fn verify_membership_delete_blocks_grant(pool: &DatabasePool) {
    let mut removal_connection = pool.acquire().await.unwrap();
    let mut removal = removal_connection.begin().await.unwrap();
    let removal_pid = backend_pid(&mut removal).await;
    lock_organization_for_update(&mut removal).await;
    sqlx::query(
        "DELETE FROM organization_memberships \
         WHERE organization_id=$1::uuid AND user_id=$2::uuid",
    )
    .bind(ORGANIZATION)
    .bind(UNGRANTED)
    .execute(&mut *removal)
    .await
    .unwrap();

    let grant_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let grant = tokio::spawn(async move {
        let mut connection = grant_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        let result = ProjectAccessRepository::grant(
            &mut transaction,
            project_id(ORGANIZATION_PROJECT),
            user_id(UNGRANTED),
            ProjectRole::Read,
            now(),
        )
        .await;
        transaction.rollback().await.unwrap();
        result
    });
    let contender_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, removal_pid, contender_pid).await {
        removal.rollback().await.unwrap();
        grant.abort();
        let _ = grant.await;
        panic!("grant must wait for membership removal");
    }
    removal.commit().await.unwrap();
    assert_eq!(
        time::timeout(Duration::from_secs(2), grant)
            .await
            .expect("grant must resolve after membership removal")
            .expect("grant task must join"),
        Err(ProjectAccessError::MemberUnavailable)
    );
    insert_membership(pool, UNGRANTED, "member").await;
}

async fn verify_concurrent_same_pair_grant(pool: &DatabasePool) {
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    let holder_pid = backend_pid(&mut holder).await;
    ProjectAccessRepository::grant(
        &mut holder,
        project_id(ORGANIZATION_PROJECT),
        user_id(UNGRANTED),
        ProjectRole::Read,
        now(),
    )
    .await
    .unwrap();

    let contender_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let contender = tokio::spawn(async move {
        let mut connection = contender_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        let result = ProjectAccessRepository::grant(
            &mut transaction,
            project_id(ORGANIZATION_PROJECT),
            user_id(UNGRANTED),
            ProjectRole::Admin,
            now(),
        )
        .await;
        transaction.rollback().await.unwrap();
        result
    });
    let contender_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, holder_pid, contender_pid).await {
        holder.rollback().await.unwrap();
        contender.abort();
        let _ = contender.await;
        panic!("same-pair grant must be blocked by the holder transaction");
    }
    holder.commit().await.unwrap();
    assert_eq!(
        time::timeout(Duration::from_secs(2), contender)
            .await
            .expect("same-pair grant must resolve after holder commit")
            .expect("same-pair grant task must join"),
        Err(ProjectAccessError::AlreadyGranted)
    );
    revoke(pool, ORGANIZATION_PROJECT, UNGRANTED).await;
}

async fn verify_typed_grant_revoke_and_constraints(pool: &DatabasePool) {
    let granted = grant(pool, ORGANIZATION_PROJECT, MEMBER, ProjectRole::Read).await;
    assert_eq!(granted.role(), ProjectRole::Read);
    assert_eq!(granted.lock_version().get(), 1);
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Read
    );
    assert_eq!(
        grant_result(pool, ORGANIZATION_PROJECT, MEMBER, ProjectRole::Write).await,
        Err(ProjectAccessError::AlreadyGranted)
    );
    assert_eq!(
        grant_result(pool, PERSONAL_PROJECT, MEMBER, ProjectRole::Read).await,
        Err(ProjectAccessError::ProjectNotOrganizationOwned)
    );
    assert_eq!(
        grant_result(pool, ORGANIZATION_PROJECT, OUTSIDER, ProjectRole::Read).await,
        Err(ProjectAccessError::MemberUnavailable)
    );
    assert_eq!(
        grant_result(pool, ORGANIZATION_PROJECT, DISABLED, ProjectRole::Read).await,
        Err(ProjectAccessError::MemberUnavailable)
    );

    let mut rollback_connection = pool.acquire().await.unwrap();
    let mut rollback_transaction = rollback_connection.begin().await.unwrap();
    ProjectAccessRepository::grant(
        &mut rollback_transaction,
        project_id(ORGANIZATION_PROJECT),
        user_id(UNGRANTED),
        ProjectRole::Read,
        now(),
    )
    .await
    .unwrap();
    rollback_transaction.rollback().await.unwrap();
    assert_eq!(role_count(pool, ORGANIZATION_PROJECT, UNGRANTED).await, 0);

    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert!(
        ProjectAccessRepository::revoke(
            &mut transaction,
            project_id(ORGANIZATION_PROJECT),
            user_id(MEMBER),
        )
        .await
        .unwrap()
    );
    let replacement = ProjectAccessRepository::grant(
        &mut transaction,
        project_id(ORGANIZATION_PROJECT),
        user_id(MEMBER),
        ProjectRole::Write,
        now(),
    )
    .await
    .unwrap();
    assert_eq!(replacement.role(), ProjectRole::Write);
    transaction.commit().await.unwrap();
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Write
    );
    execute(
        pool,
        "UPDATE users SET status='disabled', disabled_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None
    );
    execute(
        pool,
        "UPDATE users SET status='active', disabled_at=NULL, updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::Write
    );

    grant(pool, ORGANIZATION_PROJECT, UNGRANTED, ProjectRole::Read).await;
    execute(
        pool,
        "UPDATE users SET status='disabled', disabled_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000005003'::uuid",
    )
    .await;
    revoke(pool, ORGANIZATION_PROJECT, UNGRANTED).await;
    execute(
        pool,
        "UPDATE users SET status='active', disabled_at=NULL, updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000005003'::uuid",
    )
    .await;

    assert_rejected(
        pool,
        "INSERT INTO project_user_roles (project_id, organization_id, user_id, role) VALUES \
         ('0199ee6c-c777-7000-8000-000000005030'::uuid, \
          '0199ee6c-c777-7000-8000-000000005010'::uuid, \
          '0199ee6c-c777-7000-8000-000000005002'::uuid, 'read')",
        "Personal Project grant",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO project_user_roles (project_id, organization_id, user_id, role) VALUES \
         ('0199ee6c-c777-7000-8000-000000005032'::uuid, \
          '0199ee6c-c777-7000-8000-000000005010'::uuid, \
          '0199ee6c-c777-7000-8000-000000005003'::uuid, 'owner')",
        "invalid direct role",
    )
    .await;
    assert_rejected(
        pool,
        "INSERT INTO project_user_roles (project_id, organization_id, user_id, role) VALUES \
         ('0199ee6c-c777-7000-8000-000000005032'::uuid, \
          '0199ee6c-c777-7000-8000-000000005010'::uuid, \
          '0199ee6c-c777-7000-8000-000000005004'::uuid, 'read')",
        "non-member direct role",
    )
    .await;
    assert_rejected(
        pool,
        "UPDATE project_user_roles SET lock_version=lock_version \
         WHERE project_id='0199ee6c-c777-7000-8000-000000005032'::uuid \
           AND user_id='0199ee6c-c777-7000-8000-000000005002'::uuid",
        "non-advancing role version",
    )
    .await;
}

async fn verify_lifecycle_cascades(pool: &DatabasePool) {
    grant(pool, DELETION_PROJECT, UNGRANTED, ProjectRole::Admin).await;
    execute(
        pool,
        "DELETE FROM projects \
         WHERE id='0199ee6c-c777-7000-8000-000000005034'::uuid",
    )
    .await;
    assert_eq!(role_count(pool, DELETION_PROJECT, UNGRANTED).await, 0);

    grant(pool, ORGANIZATION_PROJECT, MEMBER, ProjectRole::Read).await;
    execute(
        pool,
        "DELETE FROM organization_memberships \
         WHERE organization_id='0199ee6c-c777-7000-8000-000000005010'::uuid \
           AND user_id='0199ee6c-c777-7000-8000-000000005002'::uuid",
    )
    .await;
    assert_eq!(role_count(pool, ORGANIZATION_PROJECT, MEMBER).await, 0);
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None
    );
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert!(
        !ProjectAccessRepository::revoke(
            &mut transaction,
            project_id(ORGANIZATION_PROJECT),
            user_id(MEMBER),
        )
        .await
        .unwrap()
    );
    transaction.commit().await.unwrap();
    insert_membership(pool, MEMBER, "member").await;
    assert_eq!(role_count(pool, ORGANIZATION_PROJECT, MEMBER).await, 0);
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None
    );
}

async fn verify_concurrent_grant_and_membership_delete(pool: &DatabasePool) {
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    let holder_pid = backend_pid(&mut holder).await;
    ProjectAccessRepository::grant(
        &mut holder,
        project_id(ORGANIZATION_PROJECT),
        user_id(UNGRANTED),
        ProjectRole::Read,
        now(),
    )
    .await
    .unwrap();

    let contender_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let contender = tokio::spawn(async move {
        let mut connection = contender_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        sqlx::query(
            "DELETE FROM organization_memberships \
             WHERE organization_id=$1::uuid AND user_id=$2::uuid",
        )
        .bind(ORGANIZATION)
        .bind(UNGRANTED)
        .execute(&mut *transaction)
        .await
        .unwrap();
        transaction.commit().await.unwrap();
    });
    let contender_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, holder_pid, contender_pid).await {
        holder.rollback().await.unwrap();
        contender.abort();
        let _ = contender.await;
        panic!("membership delete must wait for the grant transaction");
    }
    holder.commit().await.unwrap();
    time::timeout(Duration::from_secs(2), contender)
        .await
        .expect("membership delete must proceed after grant commit")
        .expect("membership delete task must join");
    assert_eq!(role_count(pool, ORGANIZATION_PROJECT, UNGRANTED).await, 0);
    insert_membership(pool, UNGRANTED, "member").await;
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, UNGRANTED).await,
        EffectiveProjectRole::None
    );
}

async fn verify_effective_role_blocks_membership_delete(pool: &DatabasePool) {
    grant(pool, ORGANIZATION_PROJECT, UNGRANTED, ProjectRole::Write).await;
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    let holder_pid = backend_pid(&mut holder).await;
    assert_eq!(
        ProjectAccessRepository::resolve_effective_role(
            &mut holder,
            project_id(ORGANIZATION_PROJECT),
            user_id(UNGRANTED),
        )
        .await
        .unwrap(),
        EffectiveProjectRole::Write
    );

    let contender_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let contender = tokio::spawn(async move {
        let mut connection = contender_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        sqlx::query(
            "DELETE FROM organization_memberships \
             WHERE organization_id=$1::uuid AND user_id=$2::uuid",
        )
        .bind(ORGANIZATION)
        .bind(UNGRANTED)
        .execute(&mut *transaction)
        .await
        .unwrap();
        transaction.commit().await.unwrap();
    });
    let contender_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, holder_pid, contender_pid).await {
        holder.rollback().await.unwrap();
        contender.abort();
        let _ = contender.await;
        panic!("membership delete must wait for the effective-role transaction");
    }
    holder.rollback().await.unwrap();
    time::timeout(Duration::from_secs(2), contender)
        .await
        .expect("membership delete must proceed after effective-role transaction")
        .expect("membership delete task must join");
    assert_eq!(role_count(pool, ORGANIZATION_PROJECT, UNGRANTED).await, 0);
    insert_membership(pool, UNGRANTED, "member").await;
}

async fn verify_concurrent_revoke_and_membership_delete(pool: &DatabasePool) {
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    let holder_pid = backend_pid(&mut holder).await;
    assert!(
        ProjectAccessRepository::revoke(
            &mut holder,
            project_id(ORGANIZATION_PROJECT),
            user_id(MEMBER),
        )
        .await
        .unwrap()
    );

    let contender_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let contender = tokio::spawn(async move {
        let mut connection = contender_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        sqlx::query(
            "DELETE FROM organization_memberships \
             WHERE organization_id=$1::uuid AND user_id=$2::uuid",
        )
        .bind(ORGANIZATION)
        .bind(MEMBER)
        .execute(&mut *transaction)
        .await
        .unwrap();
        transaction.commit().await.unwrap();
    });
    let contender_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, holder_pid, contender_pid).await {
        holder.rollback().await.unwrap();
        contender.abort();
        let _ = contender.await;
        panic!("membership delete must wait for the revoke transaction");
    }
    holder.commit().await.unwrap();
    time::timeout(Duration::from_secs(2), contender)
        .await
        .expect("membership delete must proceed after revoke commit")
        .expect("membership delete task must join");
    assert_eq!(role_count(pool, ORGANIZATION_PROJECT, MEMBER).await, 0);
    assert_eq!(
        effective(pool, ORGANIZATION_PROJECT, MEMBER).await,
        EffectiveProjectRole::None
    );
    insert_membership(pool, MEMBER, "member").await;
}

async fn verify_concurrent_grant_and_project_delete(pool: &DatabasePool) {
    let mut holder_connection = pool.acquire().await.unwrap();
    let mut holder = holder_connection.begin().await.unwrap();
    let holder_pid = backend_pid(&mut holder).await;
    ProjectAccessRepository::grant(
        &mut holder,
        project_id(CONCURRENT_DELETE_PROJECT),
        user_id(UNGRANTED),
        ProjectRole::Read,
        now(),
    )
    .await
    .unwrap();

    let contender_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let contender = tokio::spawn(async move {
        let mut connection = contender_pool.acquire().await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        pid_tx.send(backend_pid(&mut transaction).await).unwrap();
        sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
            .bind(CONCURRENT_DELETE_PROJECT)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
    });
    let contender_pid = pid_rx.await.unwrap();
    if !wait_for_database_block(pool, holder_pid, contender_pid).await {
        holder.rollback().await.unwrap();
        contender.abort();
        let _ = contender.await;
        panic!("Project delete must wait for the grant transaction");
    }
    holder.commit().await.unwrap();
    time::timeout(Duration::from_secs(2), contender)
        .await
        .expect("Project delete must proceed after grant commit")
        .expect("Project delete task must join");
    assert_eq!(
        role_count(pool, CONCURRENT_DELETE_PROJECT, UNGRANTED).await,
        0
    );
    let tombstones: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM project_tombstones WHERE former_project_id=$1::uuid",
    )
    .bind(CONCURRENT_DELETE_PROJECT)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(tombstones, 1);
}

async fn grant(
    pool: &DatabasePool,
    project: &str,
    user: &str,
    role: ProjectRole,
) -> nuriteo_server::project::DirectProjectRoleGrant {
    grant_result(pool, project, user, role).await.unwrap()
}

async fn grant_result(
    pool: &DatabasePool,
    project: &str,
    user: &str,
    role: ProjectRole,
) -> Result<nuriteo_server::project::DirectProjectRoleGrant, ProjectAccessError> {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    let result = ProjectAccessRepository::grant(
        &mut transaction,
        project_id(project),
        user_id(user),
        role,
        now(),
    )
    .await;
    match result {
        Ok(grant) => {
            transaction.commit().await.unwrap();
            Ok(grant)
        }
        Err(error) => {
            transaction.rollback().await.unwrap();
            Err(error)
        }
    }
}

async fn revoke(pool: &DatabasePool, project: &str, user: &str) {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert!(
        ProjectAccessRepository::revoke(&mut transaction, project_id(project), user_id(user),)
            .await
            .unwrap()
    );
    transaction.commit().await.unwrap();
}

async fn effective(pool: &DatabasePool, project: &str, user: &str) -> EffectiveProjectRole {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    let role = ProjectAccessRepository::resolve_effective_role(
        &mut transaction,
        project_id(project),
        user_id(user),
    )
    .await
    .unwrap();
    transaction.rollback().await.unwrap();
    role
}

async fn backend_pid(transaction: &mut Transaction<'_, Postgres>) -> i32 {
    sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut **transaction)
        .await
        .unwrap()
}

async fn lock_organization_for_update(transaction: &mut Transaction<'_, Postgres>) {
    sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(ORGANIZATION)
        .fetch_one(&mut **transaction)
        .await
        .unwrap();
}

async fn wait_for_database_block(pool: &DatabasePool, holder_pid: i32, contender_pid: i32) -> bool {
    let deadline = time::Instant::now() + Duration::from_secs(2);
    let mut observer = pool.acquire().await.unwrap();
    loop {
        let remaining = deadline.saturating_duration_since(time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let observation = time::timeout(
            remaining,
            sqlx::query_scalar::<_, bool>(
                "SELECT $1::integer = ANY(pg_blocking_pids($2::integer))",
            )
            .bind(holder_pid)
            .bind(contender_pid)
            .fetch_one(&mut *observer),
        )
        .await;
        let Ok(Ok(blocked)) = observation else {
            return false;
        };
        if blocked {
            return true;
        }
        time::sleep(Duration::from_millis(25)).await;
    }
}

async fn role_count(pool: &DatabasePool, project: &str, user: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM project_user_roles \
         WHERE project_id=$1::uuid AND user_id=$2::uuid",
    )
    .bind(project)
    .bind(user)
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn seed_fixture(pool: &DatabasePool) {
    for (id, label, status) in [
        (OWNER, "owner", "active"),
        (MEMBER, "member", "active"),
        (UNGRANTED, "ungranted", "active"),
        (OUTSIDER, "outsider", "active"),
        (DISABLED, "disabled", "active"),
    ] {
        let email = format!("{label}@example.test");
        sqlx::query(
            "INSERT INTO users \
             (id,email,normalized_email,display_name,status,disabled_at,updated_at) VALUES \
             ($1::uuid,$2,$2,$3,$4,CASE WHEN $4='disabled' THEN CURRENT_TIMESTAMP END,\
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
    execute(
        pool,
        "INSERT INTO organizations (id,slug,display_name) VALUES \
         ('0199ee6c-c777-7000-8000-000000005010'::uuid,'roles-org','Roles Org')",
    )
    .await;
    for (user, role) in [
        (OWNER, "owner"),
        (MEMBER, "member"),
        (UNGRANTED, "member"),
        (DISABLED, "member"),
    ] {
        insert_membership(pool, user, role).await;
    }
    execute(
        pool,
        "UPDATE users SET status='disabled', disabled_at=CURRENT_TIMESTAMP, \
         updated_at=CURRENT_TIMESTAMP \
         WHERE id='0199ee6c-c777-7000-8000-000000005005'::uuid",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_scopes (id,owner_user_id) VALUES \
         ('0199ee6c-c777-7000-8000-000000005020'::uuid, \
          '0199ee6c-c777-7000-8000-000000005001'::uuid)",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_scopes (id,owner_user_id,owner_organization_id) VALUES \
         ('0199ee6c-c777-7000-8000-000000005021'::uuid,NULL, \
          '0199ee6c-c777-7000-8000-000000005010'::uuid)",
    )
    .await;
    for (id, owner, scope, slug) in [
        (PERSONAL_PROJECT, OWNER, PERSONAL_SCOPE, "personal-active"),
        (
            ARCHIVED_PERSONAL_PROJECT,
            OWNER,
            PERSONAL_SCOPE,
            "personal-archived",
        ),
    ] {
        sqlx::query(
            "INSERT INTO projects \
             (id,owner_user_id,storage_scope_id,slug,name) VALUES \
             ($1::uuid,$2::uuid,$3::uuid,$4,$4)",
        )
        .bind(id)
        .bind(owner)
        .bind(scope)
        .bind(slug)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    for (id, owner, scope, slug) in [
        (
            ORGANIZATION_PROJECT,
            ORGANIZATION,
            ORGANIZATION_SCOPE,
            "org-active",
        ),
        (
            ARCHIVED_ORGANIZATION_PROJECT,
            ORGANIZATION,
            ORGANIZATION_SCOPE,
            "org-archived",
        ),
        (
            DELETION_PROJECT,
            ORGANIZATION,
            ORGANIZATION_SCOPE,
            "org-delete",
        ),
        (
            CONCURRENT_DELETE_PROJECT,
            ORGANIZATION,
            ORGANIZATION_SCOPE,
            "org-concurrent-delete",
        ),
    ] {
        sqlx::query(
            "INSERT INTO projects \
             (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
             ($1::uuid,$2::uuid,$3::uuid,$4,$4)",
        )
        .bind(id)
        .bind(owner)
        .bind(scope)
        .bind(slug)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
    for id in [ARCHIVED_PERSONAL_PROJECT] {
        sqlx::query(
            "UPDATE projects SET state='archived', archived_at=CURRENT_TIMESTAMP, \
             updated_at=CURRENT_TIMESTAMP, lock_version=lock_version+1 WHERE id=$1::uuid",
        )
        .bind(id)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    }
}

async fn insert_membership(pool: &DatabasePool, user: &str, role: &str) {
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

async fn assert_rejected(pool: &DatabasePool, statement: &'static str, contract: &str) {
    assert!(
        sqlx::query(statement)
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
        "{contract} must be rejected"
    );
}

async fn execute(pool: &DatabasePool, statement: &'static str) {
    sqlx::query(statement)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

fn project_id(value: &str) -> ProjectId {
    value.parse().unwrap()
}

fn user_id(value: &str) -> UserId {
    value.parse().unwrap()
}

fn now() -> Timestamp {
    Timestamp::from_str("2026-10-04T12:00:00Z").unwrap()
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
            8,
            Duration::from_secs(5),
            Duration::from_secs(2),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}
