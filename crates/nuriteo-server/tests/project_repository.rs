use std::env;
use std::fs;
use std::str::FromStr;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::identity::{Timestamp, UserId};
use nuriteo_server::organization::OrganizationId;
use nuriteo_server::project::{
    NewProject, ProjectConflict, ProjectId, ProjectName, ProjectOwner, ProjectPageLimit,
    ProjectRepository, ProjectRepositoryError, ProjectSlug,
};
use nuriteo_server::workspace::StorageScopeId;
use sqlx::{Acquire, Executor, Postgres, Transaction};
use tokio::sync::oneshot;
use tokio::time;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const USER_ONE: &str = "0199ee6c-c777-7000-8000-000000003001";
const USER_TWO: &str = "0199ee6c-c777-7000-8000-000000003002";
const USER_SCOPE_ONE: &str = "0199ee6c-c777-7000-8000-000000003011";
const USER_SCOPE_TWO: &str = "0199ee6c-c777-7000-8000-000000003012";
const ORGANIZATION_ONE: &str = "0199ee6c-c777-7000-8000-000000003021";
const ORGANIZATION_SCOPE_ONE: &str = "0199ee6c-c777-7000-8000-000000003031";
const USER_PROJECT_ALPHA: &str = "0199ee6c-c777-7000-8000-000000003041";
const USER_PROJECT_ZETA: &str = "0199ee6c-c777-7000-8000-000000003042";
const USER_TWO_PROJECT: &str = "0199ee6c-c777-7000-8000-000000003043";
const ORGANIZATION_PROJECT: &str = "0199ee6c-c777-7000-8000-000000003044";
const ORGANIZATION_PROJECT_ZETA: &str = "0199ee6c-c777-7000-8000-000000003048";
const ROLLED_BACK_PROJECT: &str = "0199ee6c-c777-7000-8000-000000003045";
const TOMBSTONED_PROJECT: &str = "0199ee6c-c777-7000-8000-000000003046";
const REUSED_PROJECT: &str = "0199ee6c-c777-7000-8000-000000003047";
const CONCURRENT_PROJECT_ONE: &str = "0199ee6c-c777-7000-8000-000000003049";
const CONCURRENT_PROJECT_TWO: &str = "0199ee6c-c777-7000-8000-000000003050";

#[tokio::test]
#[ignore = "requires the pinned custom-CA PostgreSQL fixture; run tests/fixtures/postgres-project-repository/run.sh"]
async fn project_repository_is_owner_isolated_transactional_and_fail_closed() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30))
            .expect("migration policy must validate"),
    )
    .await
    .expect("migrations must succeed");
    seed_owners_and_scopes(&pool).await;

    verify_create_get_list_and_owner_isolation(&pool).await;
    verify_caller_transaction_rollback(&pool).await;
    verify_typed_conflicts(&pool).await;
    verify_lock_blocks_until_release(&pool).await;
    verify_concurrent_namespace_create(&pool).await;
    verify_invalid_rows_fail_closed(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2))
        .await
        .expect("pool must close");
}

async fn verify_create_get_list_and_owner_isolation(pool: &DatabasePool) {
    let user_one = ProjectOwner::User(user_id(USER_ONE));
    let user_two = ProjectOwner::User(user_id(USER_TWO));
    let organization = ProjectOwner::Organization(organization_id(ORGANIZATION_ONE));
    for (candidate, expected_owner) in [
        (
            candidate(USER_PROJECT_ZETA, user_one, USER_SCOPE_ONE, "zeta"),
            user_one,
        ),
        (
            candidate(USER_PROJECT_ALPHA, user_one, USER_SCOPE_ONE, "alpha"),
            user_one,
        ),
        (
            candidate(USER_TWO_PROJECT, user_two, USER_SCOPE_TWO, "alpha"),
            user_two,
        ),
        (
            candidate(
                ORGANIZATION_PROJECT,
                organization,
                ORGANIZATION_SCOPE_ONE,
                "alpha",
            ),
            organization,
        ),
        (
            candidate(
                ORGANIZATION_PROJECT_ZETA,
                organization,
                ORGANIZATION_SCOPE_ONE,
                "zeta",
            ),
            organization,
        ),
    ] {
        let project = create_and_commit(pool, &candidate)
            .await
            .expect("valid Project must be created");
        assert_eq!(project.owner(), expected_owner);
    }

    let membership_count: i64 = query_scalar(
        pool,
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = \
         '0199ee6c-c777-7000-8000-000000003021'::uuid",
    )
    .await;
    assert_eq!(membership_count, 0, "repository must not infer membership");

    let mut connection = pool.acquire().await.expect("connection must be acquired");
    let mut transaction = connection.begin().await.expect("transaction must begin");
    let first_user_page = ProjectRepository::list_page(
        &mut transaction,
        user_one,
        ProjectPageLimit::new(1).expect("page limit must validate"),
        None,
    )
    .await
    .expect("owner list must load");
    assert_eq!(
        first_user_page
            .projects()
            .iter()
            .map(|project| project.slug().as_str())
            .collect::<Vec<_>>(),
        ["alpha"]
    );
    assert!(first_user_page.has_more());
    let second_user_page = ProjectRepository::list_page(
        &mut transaction,
        user_one,
        ProjectPageLimit::new(1).expect("page limit must validate"),
        first_user_page.next_key(),
    )
    .await
    .expect("second owner page must load");
    assert_eq!(
        second_user_page
            .projects()
            .iter()
            .map(|project| project.slug().as_str())
            .collect::<Vec<_>>(),
        ["zeta"]
    );
    assert!(!second_user_page.has_more());

    let first_organization_page = ProjectRepository::list_page(
        &mut transaction,
        organization,
        ProjectPageLimit::new(1).expect("page limit must validate"),
        None,
    )
    .await
    .expect("Organization page must load");
    assert_eq!(
        first_organization_page
            .projects()
            .iter()
            .map(|project| project.slug().as_str())
            .collect::<Vec<_>>(),
        ["alpha"]
    );
    assert!(first_organization_page.has_more());
    let second_organization_page = ProjectRepository::list_page(
        &mut transaction,
        organization,
        ProjectPageLimit::new(1).expect("page limit must validate"),
        first_organization_page.next_key(),
    )
    .await
    .expect("second Organization page must load");
    assert_eq!(
        second_organization_page
            .projects()
            .iter()
            .map(|project| project.slug().as_str())
            .collect::<Vec<_>>(),
        ["zeta"]
    );
    assert!(!second_organization_page.has_more());
    assert!(
        ProjectRepository::get_by_id(&mut transaction, user_one, project_id(USER_TWO_PROJECT),)
            .await
            .expect("isolated lookup must complete")
            .is_none()
    );
    assert!(
        ProjectRepository::get_by_id(&mut transaction, user_two, project_id(USER_TWO_PROJECT),)
            .await
            .expect("owner lookup must complete")
            .is_some()
    );
    assert!(
        ProjectRepository::get_by_id(&mut transaction, user_one, project_id(ORGANIZATION_PROJECT),)
            .await
            .expect("User-to-Organization isolation lookup must complete")
            .is_none()
    );
    assert!(
        ProjectRepository::get_by_id(
            &mut transaction,
            organization,
            project_id(USER_PROJECT_ALPHA),
        )
        .await
        .expect("Organization-to-User isolation lookup must complete")
        .is_none()
    );
    assert!(
        ProjectRepository::get_by_id(
            &mut transaction,
            organization,
            project_id(ORGANIZATION_PROJECT),
        )
        .await
        .expect("Organization lookup must complete")
        .is_some()
    );
    transaction
        .rollback()
        .await
        .expect("transaction must roll back");
}

async fn verify_caller_transaction_rollback(pool: &DatabasePool) {
    let owner = ProjectOwner::User(user_id(USER_ONE));
    let candidate = candidate(ROLLED_BACK_PROJECT, owner, USER_SCOPE_ONE, "rolled-back");
    let mut connection = pool.acquire().await.expect("connection must be acquired");
    let mut transaction = connection.begin().await.expect("transaction must begin");
    ProjectRepository::create(&mut transaction, &candidate)
        .await
        .expect("create inside caller transaction must succeed");
    assert!(
        ProjectRepository::get_by_id(&mut transaction, owner, project_id(ROLLED_BACK_PROJECT))
            .await
            .expect("same transaction must observe insert")
            .is_some()
    );
    transaction
        .rollback()
        .await
        .expect("transaction must roll back");

    let mut connection = pool.acquire().await.expect("connection must be acquired");
    let mut transaction = connection.begin().await.expect("transaction must begin");
    assert!(
        ProjectRepository::get_by_id(&mut transaction, owner, project_id(ROLLED_BACK_PROJECT))
            .await
            .expect("post-rollback lookup must complete")
            .is_none()
    );
    transaction
        .rollback()
        .await
        .expect("transaction must roll back");
}

async fn verify_typed_conflicts(pool: &DatabasePool) {
    let owner = ProjectOwner::User(user_id(USER_ONE));
    assert_eq!(
        create_and_rollback(
            pool,
            &candidate(USER_PROJECT_ALPHA, owner, USER_SCOPE_ONE, "different"),
        )
        .await,
        Err(ProjectRepositoryError::Conflict(
            ProjectConflict::IdentifierExists
        ))
    );
    assert_eq!(
        create_and_rollback(
            pool,
            &candidate(
                REUSED_PROJECT,
                ProjectOwner::Organization(organization_id(ORGANIZATION_ONE)),
                USER_SCOPE_ONE,
                "organization-wrong-scope",
            ),
        )
        .await,
        Err(ProjectRepositoryError::Conflict(
            ProjectConflict::OwnerScopeMismatch
        ))
    );
    assert_eq!(
        create_and_rollback(
            pool,
            &candidate(REUSED_PROJECT, owner, USER_SCOPE_ONE, "alpha"),
        )
        .await,
        Err(ProjectRepositoryError::Conflict(
            ProjectConflict::NamespaceUnavailable
        ))
    );
    assert_eq!(
        create_and_rollback(
            pool,
            &candidate(REUSED_PROJECT, owner, USER_SCOPE_TWO, "wrong-scope"),
        )
        .await,
        Err(ProjectRepositoryError::Conflict(
            ProjectConflict::OwnerScopeMismatch
        ))
    );

    let tombstoned = candidate(
        TOMBSTONED_PROJECT,
        owner,
        USER_SCOPE_ONE,
        "reserved-forever",
    );
    create_and_commit(pool, &tombstoned)
        .await
        .expect("tombstone fixture must be created");
    execute(
        pool,
        "DELETE FROM projects WHERE id = \
         '0199ee6c-c777-7000-8000-000000003046'::uuid",
    )
    .await;
    assert_eq!(
        create_and_rollback(
            pool,
            &candidate(REUSED_PROJECT, owner, USER_SCOPE_ONE, "reserved-forever",),
        )
        .await,
        Err(ProjectRepositoryError::Conflict(
            ProjectConflict::NamespaceUnavailable
        ))
    );
}

async fn verify_lock_blocks_until_release(pool: &DatabasePool) {
    let mut first_connection = pool.acquire().await.expect("connection must be acquired");
    let mut first_transaction = first_connection
        .begin()
        .await
        .expect("transaction must begin");
    let holder_pid = backend_pid(&mut first_transaction).await;
    ProjectRepository::lock_by_id(&mut first_transaction, project_id(USER_PROJECT_ALPHA))
        .await
        .expect("first lock must succeed")
        .expect("locked Project must exist");

    let second_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let second = tokio::spawn(async move {
        let mut connection = second_pool
            .acquire()
            .await
            .expect("second connection must be acquired");
        let mut transaction = connection
            .begin()
            .await
            .expect("second transaction must begin");
        let contender_pid = backend_pid(&mut transaction).await;
        pid_tx
            .send(contender_pid)
            .expect("lock PID observer must remain available");
        let project =
            ProjectRepository::lock_by_id(&mut transaction, project_id(USER_PROJECT_ALPHA)).await;
        transaction
            .rollback()
            .await
            .expect("second transaction must roll back");
        project
    });
    let contender_pid = pid_rx
        .await
        .expect("second transaction must report its backend PID");
    if !wait_for_database_block(pool, holder_pid, contender_pid).await {
        first_transaction
            .rollback()
            .await
            .expect("first transaction must release lock after observation timeout");
        second.abort();
        let _ = second.await;
        panic!("PostgreSQL must report the second lock as blocked by the first transaction");
    }
    first_transaction
        .rollback()
        .await
        .expect("first transaction must release lock");
    assert!(
        time::timeout(Duration::from_secs(2), second)
            .await
            .expect("second lock must proceed after release")
            .expect("second lock task must join")
            .expect("second lock query must succeed")
            .is_some()
    );
}

async fn verify_concurrent_namespace_create(pool: &DatabasePool) {
    let owner = ProjectOwner::User(user_id(USER_ONE));
    let mut first_connection = pool.acquire().await.expect("connection must be acquired");
    let mut first_transaction = first_connection
        .begin()
        .await
        .expect("transaction must begin");
    let holder_pid = backend_pid(&mut first_transaction).await;
    ProjectRepository::create(
        &mut first_transaction,
        &candidate(CONCURRENT_PROJECT_ONE, owner, USER_SCOPE_ONE, "concurrent"),
    )
    .await
    .expect("first namespace create must succeed before commit");

    let second_pool = pool.clone();
    let (pid_tx, pid_rx) = oneshot::channel();
    let second = tokio::spawn(async move {
        let mut connection = second_pool
            .acquire()
            .await
            .expect("concurrent connection must be acquired");
        let mut transaction = connection
            .begin()
            .await
            .expect("concurrent transaction must begin");
        let contender_pid = backend_pid(&mut transaction).await;
        let candidate = candidate(CONCURRENT_PROJECT_TWO, owner, USER_SCOPE_ONE, "concurrent");
        pid_tx
            .send(contender_pid)
            .expect("create PID observer must remain available");
        let result = ProjectRepository::create(&mut transaction, &candidate).await;
        transaction
            .rollback()
            .await
            .expect("losing transaction must roll back");
        result
    });
    let contender_pid = pid_rx
        .await
        .expect("second transaction must report its backend PID");
    if !wait_for_database_block(pool, holder_pid, contender_pid).await {
        first_transaction
            .rollback()
            .await
            .expect("first namespace transaction must roll back after observation timeout");
        second.abort();
        let _ = second.await;
        panic!("PostgreSQL must report the concurrent namespace create as blocked");
    }
    first_transaction
        .commit()
        .await
        .expect("first namespace create must commit");
    assert_eq!(
        time::timeout(Duration::from_secs(2), second)
            .await
            .expect("second create must resolve after commit")
            .expect("second create task must join"),
        Err(ProjectRepositoryError::Conflict(
            ProjectConflict::NamespaceUnavailable
        ))
    );
}

async fn backend_pid(transaction: &mut Transaction<'_, Postgres>) -> i32 {
    sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut **transaction)
        .await
        .expect("transaction backend PID must be available")
}

async fn wait_for_database_block(pool: &DatabasePool, holder_pid: i32, contender_pid: i32) -> bool {
    let deadline = time::Instant::now() + Duration::from_secs(2);
    let mut observer = pool
        .acquire()
        .await
        .expect("blocking observer connection must be acquired");

    loop {
        let remaining = deadline.saturating_duration_since(time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let observation = time::timeout(
            remaining,
            sqlx::query_scalar("SELECT $1::integer = ANY(pg_blocking_pids($2::integer))")
                .bind(holder_pid)
                .bind(contender_pid)
                .fetch_one(&mut *observer),
        )
        .await;
        let Ok(observation) = observation else {
            return false;
        };
        let holder_blocks_contender: bool =
            observation.expect("blocking relationship query must succeed before the deadline");

        if holder_blocks_contender {
            return true;
        }
        if time::Instant::now() >= deadline {
            return false;
        }
        time::sleep(Duration::from_millis(25)).await;
    }
}

async fn verify_invalid_rows_fail_closed(pool: &DatabasePool) {
    assert_corrupt_locked_row(
        pool,
        &["ALTER TABLE projects DROP CONSTRAINT projects_exactly_one_owner_check"],
        "UPDATE projects SET owner_user_id = NULL WHERE id = \
         '0199ee6c-c777-7000-8000-000000003041'::uuid",
    )
    .await;
    assert_corrupt_locked_row(
        pool,
        &[
            "ALTER TABLE projects DROP CONSTRAINT projects_exactly_one_owner_check",
            "ALTER TABLE projects DROP CONSTRAINT projects_organization_scope_fk",
            "ALTER TABLE projects DROP CONSTRAINT projects_organization_slug_unique",
        ],
        "UPDATE projects SET owner_organization_id = \
         '0199ee6c-c777-7000-8000-000000003021'::uuid WHERE id = \
         '0199ee6c-c777-7000-8000-000000003041'::uuid",
    )
    .await;
    assert_corrupt_locked_row(
        pool,
        &["ALTER TABLE projects DROP CONSTRAINT projects_slug_check"],
        "UPDATE projects SET slug = 'Invalid' WHERE id = \
         '0199ee6c-c777-7000-8000-000000003041'::uuid",
    )
    .await;
    assert_corrupt_locked_row(
        pool,
        &["ALTER TABLE projects DROP CONSTRAINT projects_name_check"],
        "UPDATE projects SET name = ' Padded' WHERE id = \
         '0199ee6c-c777-7000-8000-000000003041'::uuid",
    )
    .await;
    assert_corrupt_locked_row(
        pool,
        &["ALTER TABLE projects DROP CONSTRAINT projects_lifecycle_check"],
        "UPDATE projects SET state = 'archived', archived_at = NULL WHERE id = \
         '0199ee6c-c777-7000-8000-000000003041'::uuid",
    )
    .await;
    assert_corrupt_locked_row(
        pool,
        &[
            "ALTER TABLE projects DROP CONSTRAINT projects_state_check",
            "ALTER TABLE projects DROP CONSTRAINT projects_lifecycle_check",
        ],
        "UPDATE projects SET state = 'unknown' WHERE id = \
         '0199ee6c-c777-7000-8000-000000003041'::uuid",
    )
    .await;
    assert_corrupt_locked_row(
        pool,
        &["ALTER TABLE projects DROP CONSTRAINT projects_timestamps_check"],
        "UPDATE projects SET updated_at = created_at - INTERVAL '1 second' WHERE id = \
         '0199ee6c-c777-7000-8000-000000003041'::uuid",
    )
    .await;
    assert_corrupt_locked_row(
        pool,
        &["ALTER TABLE projects DROP CONSTRAINT projects_lock_version_check"],
        "UPDATE projects SET lock_version = 0 WHERE id = \
         '0199ee6c-c777-7000-8000-000000003041'::uuid",
    )
    .await;

    let mut connection = pool.acquire().await.expect("connection must be acquired");
    let mut transaction = connection.begin().await.expect("transaction must begin");
    transaction
        .execute("ALTER TABLE projects DROP CONSTRAINT projects_id_v7_check")
        .await
        .expect("fixture must relax ID check");
    transaction
        .execute(
            "INSERT INTO projects \
             (id, owner_user_id, storage_scope_id, slug, name) VALUES \
             ('0199ee6c-c777-7000-0000-000000003099', \
              '0199ee6c-c777-7000-8000-000000003001', \
              '0199ee6c-c777-7000-8000-000000003011', 'aaa-corrupt', 'Corrupt')",
        )
        .await
        .expect("fixture must insert non-RFC UUIDv7");
    assert_eq!(
        ProjectRepository::list_page(
            &mut transaction,
            ProjectOwner::User(user_id(USER_ONE)),
            ProjectPageLimit::default(),
            None,
        )
        .await,
        Err(ProjectRepositoryError::InvalidPersistedState)
    );
    transaction
        .rollback()
        .await
        .expect("transaction must roll back");
}

async fn assert_corrupt_locked_row(
    pool: &DatabasePool,
    relaxations: &[&'static str],
    mutation: &'static str,
) {
    let mut connection = pool.acquire().await.expect("connection must be acquired");
    let mut transaction = connection.begin().await.expect("transaction must begin");
    transaction
        .execute("ALTER TABLE projects DISABLE TRIGGER USER")
        .await
        .expect("fixture must disable mutation triggers");
    for relaxation in relaxations {
        transaction
            .execute(*relaxation)
            .await
            .expect("fixture must relax one constraint");
    }
    transaction
        .execute(mutation)
        .await
        .expect("fixture must create invalid persisted state");
    assert_eq!(
        ProjectRepository::lock_by_id(&mut transaction, project_id(USER_PROJECT_ALPHA)).await,
        Err(ProjectRepositoryError::InvalidPersistedState)
    );
    transaction
        .rollback()
        .await
        .expect("transaction must roll back");
}

async fn create_and_commit(
    pool: &DatabasePool,
    candidate: &NewProject,
) -> Result<nuriteo_server::project::Project, ProjectRepositoryError> {
    let mut connection = pool.acquire().await.expect("connection must be acquired");
    let mut transaction = connection.begin().await.expect("transaction must begin");
    let result = ProjectRepository::create(&mut transaction, candidate).await;
    match result {
        Ok(project) => {
            transaction.commit().await.expect("transaction must commit");
            Ok(project)
        }
        Err(error) => {
            transaction
                .rollback()
                .await
                .expect("transaction must roll back");
            Err(error)
        }
    }
}

async fn create_and_rollback(
    pool: &DatabasePool,
    candidate: &NewProject,
) -> Result<nuriteo_server::project::Project, ProjectRepositoryError> {
    let mut connection = pool.acquire().await.expect("connection must be acquired");
    let mut transaction = connection.begin().await.expect("transaction must begin");
    let result = ProjectRepository::create(&mut transaction, candidate).await;
    transaction
        .rollback()
        .await
        .expect("transaction must roll back");
    result
}

fn candidate(id: &str, owner: ProjectOwner, scope_id: &str, slug: &str) -> NewProject {
    NewProject::new(
        project_id(id),
        owner,
        StorageScopeId::from_str(scope_id).expect("scope fixture must parse"),
        ProjectSlug::new(slug.to_owned()).expect("slug fixture must validate"),
        ProjectName::new(format!("Project {slug}")).expect("name fixture must validate"),
        Timestamp::from_unix_timestamp(1_780_000_000).expect("timestamp fixture must validate"),
    )
}

fn project_id(value: &str) -> ProjectId {
    ProjectId::from_str(value).expect("Project ID fixture must parse")
}

fn user_id(value: &str) -> UserId {
    UserId::from_str(value).expect("User ID fixture must parse")
}

fn organization_id(value: &str) -> OrganizationId {
    OrganizationId::from_str(value).expect("Organization ID fixture must parse")
}

async fn seed_owners_and_scopes(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO users (id, email, normalized_email, display_name, status) VALUES \
         ('0199ee6c-c777-7000-8000-000000003001', 'one@example.test', 'one@example.test', 'One', 'active'), \
         ('0199ee6c-c777-7000-8000-000000003002', 'two@example.test', 'two@example.test', 'Two', 'active'); \
         INSERT INTO organizations (id, slug, display_name, status) VALUES \
         ('0199ee6c-c777-7000-8000-000000003021', 'repository-org', 'Repository Org', 'active'); \
         INSERT INTO storage_scopes \
         (id, owner_user_id, owner_organization_id) VALUES \
         ('0199ee6c-c777-7000-8000-000000003011', '0199ee6c-c777-7000-8000-000000003001', NULL), \
         ('0199ee6c-c777-7000-8000-000000003012', '0199ee6c-c777-7000-8000-000000003002', NULL), \
         ('0199ee6c-c777-7000-8000-000000003031', NULL, '0199ee6c-c777-7000-8000-000000003021')",
    )
    .await;
}

async fn execute(pool: &DatabasePool, statement: &'static str) {
    let mut connection = pool.acquire().await.expect("connection must be acquired");
    connection
        .execute(statement)
        .await
        .expect("fixture SQL must succeed");
}

async fn query_scalar(pool: &DatabasePool, statement: &'static str) -> i64 {
    let mut connection = pool.acquire().await.expect("connection must be acquired");
    sqlx::query_scalar(statement)
        .fetch_one(&mut *connection)
        .await
        .expect("fixture scalar query must succeed")
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.expect("connection must be acquired");
    connection
        .execute(
            "DROP SCHEMA public CASCADE; CREATE SCHEMA public; \
             GRANT ALL ON SCHEMA public TO public",
        )
        .await
        .expect("fixture schema must reset");
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).expect("fixture database URL must be set");
    let ca_path = env::var(DATABASE_CA_ENV).expect("fixture CA path must be set");
    let ca_pem = fs::read(ca_path).expect("fixture CA must be readable");
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca_pem), None)
        .expect("fixture TLS must validate");
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        4,
        Duration::from_secs(5),
        Duration::from_secs(2),
        tls,
    )
    .expect("fixture database config must validate");
    DatabasePool::connect(config)
        .await
        .expect("fixture database must connect")
}
