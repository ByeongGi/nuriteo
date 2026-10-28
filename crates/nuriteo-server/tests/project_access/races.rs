#![allow(unused_imports)]
use super::roles::*;
use super::*;
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

use super::{
    ADMIN_TEAM, ARCHIVED_ORGANIZATION_PROJECT, ARCHIVED_PERSONAL_PROJECT,
    CONCURRENT_DELETE_PROJECT, DATABASE_CA_ENV, DATABASE_URL_ENV, DELETION_PROJECT, DISABLED,
    MEMBER, ORGANIZATION, ORGANIZATION_PROJECT, ORGANIZATION_SCOPE, OUTSIDER, OWNER,
    PERSONAL_PROJECT, PERSONAL_SCOPE, READ_TEAM, UNGRANTED, WRITE_TEAM,
};
use tokio::time;

pub(crate) async fn verify_typed_grant_revoke_and_constraints(pool: &DatabasePool) {
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

pub(crate) async fn verify_lifecycle_cascades(pool: &DatabasePool) {
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

pub(crate) async fn verify_concurrent_grant_and_membership_delete(pool: &DatabasePool) {
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

pub(crate) async fn verify_effective_role_blocks_membership_delete(pool: &DatabasePool) {
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

pub(crate) async fn verify_concurrent_revoke_and_membership_delete(pool: &DatabasePool) {
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

pub(crate) async fn verify_concurrent_grant_and_project_delete(pool: &DatabasePool) {
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

pub(crate) async fn grant(
    pool: &DatabasePool,
    project: &str,
    user: &str,
    role: ProjectRole,
) -> nuriteo_server::project::DirectProjectRoleGrant {
    grant_result(pool, project, user, role).await.unwrap()
}

pub(crate) async fn grant_result(
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

pub(crate) async fn revoke(pool: &DatabasePool, project: &str, user: &str) {
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    assert!(
        ProjectAccessRepository::revoke(&mut transaction, project_id(project), user_id(user),)
            .await
            .unwrap()
    );
    transaction.commit().await.unwrap();
}

pub(crate) async fn effective(
    pool: &DatabasePool,
    project: &str,
    user: &str,
) -> EffectiveProjectRole {
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

pub(crate) async fn backend_pid(transaction: &mut Transaction<'_, Postgres>) -> i32 {
    sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut **transaction)
        .await
        .unwrap()
}

pub(crate) async fn lock_organization_for_update(transaction: &mut Transaction<'_, Postgres>) {
    sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(ORGANIZATION)
        .fetch_one(&mut **transaction)
        .await
        .unwrap();
}

pub(crate) async fn wait_for_database_block(
    pool: &DatabasePool,
    holder_pid: i32,
    contender_pid: i32,
) -> bool {
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

pub(crate) async fn role_count(pool: &DatabasePool, project: &str, user: &str) -> i64 {
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

pub(crate) async fn seed_fixture(pool: &DatabasePool) {
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

pub(crate) async fn insert_membership(pool: &DatabasePool, user: &str, role: &str) {
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

pub(crate) async fn assert_rejected(pool: &DatabasePool, statement: &'static str, contract: &str) {
    assert!(
        sqlx::query(statement)
            .execute(&mut *pool.acquire().await.unwrap())
            .await
            .is_err(),
        "{contract} must be rejected"
    );
}

pub(crate) async fn execute(pool: &DatabasePool, statement: &'static str) {
    sqlx::query(statement)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

pub(crate) fn project_id(value: &str) -> ProjectId {
    value.parse().unwrap()
}

pub(crate) fn user_id(value: &str) -> UserId {
    value.parse().unwrap()
}

pub(crate) fn now() -> Timestamp {
    Timestamp::from_str("2026-10-04T12:00:00Z").unwrap()
}

pub(crate) async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    connection
        .execute("DROP SCHEMA public CASCADE")
        .await
        .unwrap();
    connection.execute("CREATE SCHEMA public").await.unwrap();
}

pub(crate) async fn fixture_pool() -> DatabasePool {
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
