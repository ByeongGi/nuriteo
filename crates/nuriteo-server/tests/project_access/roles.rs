#![allow(unused_imports)]
use super::*;
use super::races::*;
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
use super::{DATABASE_URL_ENV, DATABASE_CA_ENV, OWNER, MEMBER, UNGRANTED, OUTSIDER, DISABLED, ORGANIZATION, PERSONAL_SCOPE, ORGANIZATION_SCOPE, PERSONAL_PROJECT, ARCHIVED_PERSONAL_PROJECT, ORGANIZATION_PROJECT, ARCHIVED_ORGANIZATION_PROJECT, DELETION_PROJECT, CONCURRENT_DELETE_PROJECT, READ_TEAM, WRITE_TEAM, ADMIN_TEAM};



#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-project-access/run.sh"]
pub(crate) async fn direct_project_roles_are_isolated_effective_and_serialized() {    let pool = fixture_pool().await;
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


pub(crate) async fn verify_team_roles_compose_and_fail_closed(pool: &DatabasePool) {    execute(
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


pub(crate) async fn delete_team_membership(pool: &DatabasePool, team_id: &str) {    sqlx::query(
        "DELETE FROM team_memberships \
         WHERE team_id=$1::uuid AND user_id=$2::uuid",
    )
    .bind(team_id)
    .bind(MEMBER)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}


pub(crate) async fn verify_effective_roles_and_archived_access(pool: &DatabasePool) {    let mut connection = pool.acquire().await.unwrap();
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


pub(crate) async fn verify_owner_demotion_reactivates_direct_grant(pool: &DatabasePool) {    grant(pool, ORGANIZATION_PROJECT, OWNER, ProjectRole::Read).await;
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


pub(crate) async fn verify_membership_role_and_effective_races(pool: &DatabasePool) {    execute(
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


pub(crate) async fn verify_role_change_and_membership_removal_races(pool: &DatabasePool) {    let mut role_change_connection = pool.acquire().await.unwrap();
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


pub(crate) async fn verify_membership_delete_blocks_grant(pool: &DatabasePool) {    let mut removal_connection = pool.acquire().await.unwrap();
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


pub(crate) async fn verify_concurrent_same_pair_grant(pool: &DatabasePool) {    let mut holder_connection = pool.acquire().await.unwrap();
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
