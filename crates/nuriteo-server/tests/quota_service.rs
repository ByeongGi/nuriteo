use std::env;
use std::fs;
use std::str::FromStr;
use std::time::Duration;

use nuriteo_server::database::{
    DatabasePool, DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};
use nuriteo_server::project::ProjectId;
use nuriteo_server::quota::{
    EffectiveQuota, QuotaService, QuotaServiceError, QuotaServicePolicy, ReservationRequest,
    SaveSessionId, TerminalSaveState,
};
use nuriteo_server::workspace::StorageScopeId;
use sqlx::{Acquire, AssertSqlSafe, Executor};
use tokio::sync::Barrier;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const USER_SCOPE: &str = "0199ee6c-c777-7000-8000-000000007020";
const ORG_SCOPE: &str = "0199ee6c-c777-7000-8000-000000007021";
const USER_PROJECT_A: &str = "0199ee6c-c777-7000-8000-000000007030";
const USER_PROJECT_B: &str = "0199ee6c-c777-7000-8000-000000007031";
const ORG_PROJECT: &str = "0199ee6c-c777-7000-8000-000000007032";

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-quota/run.sh"]
async fn quota_service_is_scope_serialized_deduplicated_and_fail_closed() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    seed_fixture(&pool).await;

    let service = service(&pool, Duration::from_secs(3));
    let user_usage = service
        .projection(scope(USER_SCOPE), EffectiveQuota::limited(1_000).unwrap())
        .await
        .unwrap();
    assert_eq!(user_usage.used_bytes(), 100);
    assert_eq!(user_usage.reserved_bytes(), 0);
    assert_eq!(user_usage.available_bytes(), Some(900));
    let org_usage = service
        .projection(scope(ORG_SCOPE), EffectiveQuota::unlimited())
        .await
        .unwrap();
    assert_eq!(org_usage.used_bytes(), 100);
    assert_eq!(org_usage.available_bytes(), None);

    verify_retry_conflict_and_terminal_release(&pool, &service).await;
    verify_concurrent_oversubscription(&pool).await;
    verify_scope_isolation_and_timeout(&pool).await;
    verify_expiry_and_wrong_scope(&pool, &service).await;
    verify_terminal_transition_project_delete_lock_order(&pool).await;
    verify_commit_release_consumer_contract(&pool).await;
    verify_expiry_sweep_is_bounded_and_drainable(&pool).await;

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn verify_expiry_sweep_is_bounded_and_drainable(pool: &DatabasePool) {
    execute(
        pool,
        "INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) \
         SELECT ('0199ee6c-c777-7000-8000-' || lpad((9000+n)::text,12,'0'))::uuid, \
                '0199ee6c-c777-7000-8000-000000007001'::uuid, \
                '0199ee6c-c777-7000-8000-000000007020'::uuid, \
                'sweep-' || n, 'Sweep ' || n \
         FROM generate_series(1,101) n",
    )
    .await;
    execute(
        pool,
        "INSERT INTO save_sessions \
         (id,project_id,storage_scope_id,actor_user_id,expected_project_version, \
          expected_bundle_sha256,expected_physical_bytes,expected_logical_bytes, \
          expected_file_count,staging_object_key,upload_mode,expires_at) \
         SELECT ('0199ee6c-c777-7000-8000-' || lpad((8000+n)::text,12,'0'))::uuid, \
                ('0199ee6c-c777-7000-8000-' || lpad((9000+n)::text,12,'0'))::uuid, \
                '0199ee6c-c777-7000-8000-000000007020'::uuid, \
                '0199ee6c-c777-7000-8000-000000007001'::uuid,1, \
                decode(repeat('81',32),'hex'),1,1,1,'staging/quota/sweep-' || n, \
                'single',CURRENT_TIMESTAMP + INTERVAL '2 seconds' \
         FROM generate_series(1,101) n",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_reservations \
         (save_session_id,storage_scope_id,reserved_bytes,created_at,expires_at) \
         SELECT id,storage_scope_id,expected_physical_bytes,created_at,expires_at \
         FROM save_sessions WHERE staging_object_key LIKE 'staging/quota/sweep-%'",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(2_100)).await;
    let service = service(pool, Duration::from_secs(3));
    assert_eq!(
        service.release_expired(scope(USER_SCOPE)).await.unwrap(),
        100
    );
    assert_eq!(service.release_expired(scope(USER_SCOPE)).await.unwrap(), 1);
    assert_eq!(service.release_expired(scope(USER_SCOPE)).await.unwrap(), 0);
    assert_eq!(
        query_scalar(
            pool,
            "SELECT COUNT(*) FROM storage_reservations WHERE storage_scope_id=\
             '0199ee6c-c777-7000-8000-000000007020'::uuid",
        )
        .await,
        0
    );
}

async fn verify_commit_release_consumer_contract(pool: &DatabasePool) {
    let session = "0199ee6c-c777-7000-8000-000000007108";
    create_session(
        pool,
        session,
        USER_PROJECT_B,
        USER_SCOPE,
        "b-7108",
        100,
        false,
    )
    .await;
    service(pool, Duration::from_secs(3))
        .reserve(request(session, USER_PROJECT_B, USER_SCOPE, 100, 250))
        .await
        .unwrap();
    let mut connection = pool.acquire().await.unwrap();
    let mut transaction = connection.begin().await.unwrap();
    transaction
        .execute(
            "SELECT id FROM storage_scopes WHERE id=\
             '0199ee6c-c777-7000-8000-000000007020'::uuid FOR UPDATE",
        )
        .await
        .unwrap();
    transaction
        .execute(
            "SELECT id FROM projects WHERE id=\
             '0199ee6c-c777-7000-8000-000000007031'::uuid FOR UPDATE",
        )
        .await
        .unwrap();
    for state in ["uploading", "verifying"] {
        sqlx::query(
            "UPDATE save_sessions SET state=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(session)
        .bind(state)
        .execute(&mut *transaction)
        .await
        .unwrap();
    }
    sqlx::query(
        "UPDATE save_sessions SET state='committed', \
         committed_bundle_id='0199ee6c-c777-7000-8000-000000007050'::uuid, \
         terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
    )
    .bind(session)
    .execute(&mut *transaction)
    .await
    .unwrap();
    let reservations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=$1::uuid",
    )
    .bind(session)
    .fetch_one(&mut *transaction)
    .await
    .unwrap();
    assert_eq!(reservations, 0);
    transaction.commit().await.unwrap();
}

async fn verify_terminal_transition_project_delete_lock_order(pool: &DatabasePool) {
    let session = "0199ee6c-c777-7000-8000-000000007107";
    create_session(
        pool,
        session,
        USER_PROJECT_A,
        USER_SCOPE,
        "a-7107",
        10,
        false,
    )
    .await;
    service(pool, Duration::from_secs(3))
        .reserve(request(session, USER_PROJECT_A, USER_SCOPE, 10, 200))
        .await
        .unwrap();

    let mut holder = pool.acquire().await.unwrap();
    let mut transaction = holder.begin().await.unwrap();
    transaction
        .execute(
            "SELECT id FROM projects WHERE id=\
             '0199ee6c-c777-7000-8000-000000007030'::uuid FOR UPDATE",
        )
        .await
        .unwrap();
    let transition = {
        let service = service(pool, Duration::from_secs(3));
        tokio::spawn(async move {
            service
                .transition_terminal(
                    scope(USER_SCOPE),
                    project(USER_PROJECT_A),
                    session_id(session),
                    TerminalSaveState::Aborted,
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        transaction
            .execute(
                "DELETE FROM projects WHERE id=\
                 '0199ee6c-c777-7000-8000-000000007030'::uuid",
            )
            .await
            .is_err(),
        "Project deletion must fail closed while an active Save session exists"
    );
    transaction.rollback().await.unwrap();
    transition
        .await
        .unwrap()
        .expect("scope -> Project -> Save locking must complete without a deadlock");
    assert_eq!(
        query_scalar(
            pool,
            "SELECT COUNT(*) FROM storage_reservations WHERE save_session_id=\
             '0199ee6c-c777-7000-8000-000000007107'::uuid",
        )
        .await,
        0
    );
}

async fn verify_retry_conflict_and_terminal_release(pool: &DatabasePool, service: &QuotaService) {
    let session = "0199ee6c-c777-7000-8000-000000007100";
    create_session(
        pool,
        session,
        USER_PROJECT_A,
        USER_SCOPE,
        "a-7100",
        60,
        false,
    )
    .await;
    let request = request(session, USER_PROJECT_A, USER_SCOPE, 60, 200);
    let first = service.reserve(request).await.unwrap();
    assert!(!first.is_idempotent_retry());
    assert_eq!(first.projection().reserved_bytes(), 60);
    let retry = service.reserve(request).await.unwrap();
    assert!(retry.is_idempotent_retry());
    assert_eq!(retry.reserved_bytes(), 60);
    let conflicting = ReservationRequest {
        requested_bytes: 61,
        ..request
    };
    assert_eq!(
        service.reserve(conflicting).await,
        Err(QuotaServiceError::ReservationConflict)
    );
    service
        .transition_terminal(
            scope(USER_SCOPE),
            project(USER_PROJECT_A),
            session_id(session),
            TerminalSaveState::Failed,
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .projection(scope(USER_SCOPE), EffectiveQuota::unlimited())
            .await
            .unwrap()
            .reserved_bytes(),
        0
    );
}

async fn verify_concurrent_oversubscription(pool: &DatabasePool) {
    let first = "0199ee6c-c777-7000-8000-000000007101";
    let second = "0199ee6c-c777-7000-8000-000000007102";
    create_session(pool, first, USER_PROJECT_A, USER_SCOPE, "a-7101", 40, false).await;
    create_session(
        pool,
        second,
        USER_PROJECT_B,
        USER_SCOPE,
        "b-7102",
        40,
        false,
    )
    .await;
    let barrier = std::sync::Arc::new(Barrier::new(3));
    let first_task = {
        let barrier = barrier.clone();
        let service = service(pool, Duration::from_secs(3));
        tokio::spawn(async move {
            barrier.wait().await;
            service
                .reserve(request(first, USER_PROJECT_A, USER_SCOPE, 40, 150))
                .await
        })
    };
    let second_task = {
        let barrier = barrier.clone();
        let service = service(pool, Duration::from_secs(3));
        tokio::spawn(async move {
            barrier.wait().await;
            service
                .reserve(request(second, USER_PROJECT_B, USER_SCOPE, 40, 150))
                .await
        })
    };
    barrier.wait().await;
    let results = [first_task.await.unwrap(), second_task.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(QuotaServiceError::QuotaExceeded)))
            .count(),
        1
    );
    let reserved: i64 = query_scalar(
        pool,
        "SELECT COALESCE(SUM(reserved_bytes),0)::bigint FROM storage_reservations \
         WHERE storage_scope_id='0199ee6c-c777-7000-8000-000000007020'",
    )
    .await;
    assert_eq!(reserved, 40);
    for session in [first, second] {
        let state: String = query_scalar_owned(
            pool,
            format!("SELECT state FROM save_sessions WHERE id='{session}'::uuid"),
        )
        .await;
        if state == "created" {
            service(pool, Duration::from_secs(3))
                .transition_terminal(
                    scope(USER_SCOPE),
                    if session == first {
                        project(USER_PROJECT_A)
                    } else {
                        project(USER_PROJECT_B)
                    },
                    session_id(session),
                    TerminalSaveState::Aborted,
                )
                .await
                .unwrap();
        }
    }
}

async fn verify_scope_isolation_and_timeout(pool: &DatabasePool) {
    let user_session = "0199ee6c-c777-7000-8000-000000007103";
    let org_session = "0199ee6c-c777-7000-8000-000000007104";
    create_session(
        pool,
        user_session,
        USER_PROJECT_A,
        USER_SCOPE,
        "a-7103",
        10,
        false,
    )
    .await;
    create_session(
        pool,
        org_session,
        ORG_PROJECT,
        ORG_SCOPE,
        "o-7104",
        10,
        false,
    )
    .await;

    let mut holder = pool.acquire().await.unwrap();
    let mut transaction = holder.begin().await.unwrap();
    transaction
        .execute(
            "SELECT id FROM storage_scopes WHERE id=\
             '0199ee6c-c777-7000-8000-000000007020'::uuid FOR UPDATE",
        )
        .await
        .unwrap();
    service(pool, Duration::from_secs(1))
        .reserve(request(org_session, ORG_PROJECT, ORG_SCOPE, 10, 200))
        .await
        .expect("different scope must not wait behind the locked scope");
    assert_eq!(
        service(pool, Duration::from_millis(150))
            .reserve(request(user_session, USER_PROJECT_A, USER_SCOPE, 10, 200))
            .await,
        Err(QuotaServiceError::OperationTimeout)
    );
    transaction.rollback().await.unwrap();
    service(pool, Duration::from_secs(3))
        .transition_terminal(
            scope(ORG_SCOPE),
            project(ORG_PROJECT),
            session_id(org_session),
            TerminalSaveState::Aborted,
        )
        .await
        .unwrap();
    service(pool, Duration::from_secs(3))
        .transition_terminal(
            scope(USER_SCOPE),
            project(USER_PROJECT_A),
            session_id(user_session),
            TerminalSaveState::Aborted,
        )
        .await
        .unwrap();
}

async fn verify_expiry_and_wrong_scope(pool: &DatabasePool, service: &QuotaService) {
    let expired = "0199ee6c-c777-7000-8000-000000007105";
    create_session(
        pool,
        expired,
        USER_PROJECT_A,
        USER_SCOPE,
        "a-7105",
        10,
        true,
    )
    .await;
    execute_owned(
        pool,
        format!(
            "INSERT INTO storage_reservations \
             (save_session_id,storage_scope_id,reserved_bytes,created_at,expires_at) \
             SELECT id,storage_scope_id,expected_physical_bytes,created_at,expires_at \
             FROM save_sessions WHERE id='{expired}'::uuid"
        ),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        service
            .reserve(request(expired, USER_PROJECT_A, USER_SCOPE, 10, 200))
            .await,
        Err(QuotaServiceError::SessionExpired)
    );
    let state: String = query_scalar_owned(
        pool,
        format!("SELECT state FROM save_sessions WHERE id='{expired}'::uuid"),
    )
    .await;
    assert_eq!(state, "expired");
    let reservations: i64 = query_scalar(pool, "SELECT COUNT(*) FROM storage_reservations").await;
    assert_eq!(reservations, 0);

    let swept = "0199ee6c-c777-7000-8000-000000007109";
    create_session(pool, swept, USER_PROJECT_A, USER_SCOPE, "a-7109", 10, true).await;
    execute_owned(
        pool,
        format!(
            "INSERT INTO storage_reservations \
             (save_session_id,storage_scope_id,reserved_bytes,created_at,expires_at) \
             SELECT id,storage_scope_id,expected_physical_bytes,created_at,expires_at \
             FROM save_sessions WHERE id='{swept}'::uuid"
        ),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(service.release_expired(scope(USER_SCOPE)).await.unwrap(), 1);
    let swept_state: String = query_scalar_owned(
        pool,
        format!("SELECT state FROM save_sessions WHERE id='{swept}'::uuid"),
    )
    .await;
    assert_eq!(swept_state, "expired");
    assert_eq!(
        query_scalar(pool, "SELECT COUNT(*) FROM storage_reservations").await,
        0
    );

    let wrong = "0199ee6c-c777-7000-8000-000000007106";
    create_session(pool, wrong, USER_PROJECT_A, USER_SCOPE, "a-7106", 10, false).await;
    assert_eq!(
        service
            .reserve(request(wrong, ORG_PROJECT, ORG_SCOPE, 10, 200))
            .await,
        Err(QuotaServiceError::WrongScope)
    );
    service
        .transition_terminal(
            scope(USER_SCOPE),
            project(USER_PROJECT_A),
            session_id(wrong),
            TerminalSaveState::Aborted,
        )
        .await
        .unwrap();
}

fn request(
    session: &str,
    project_value: &str,
    scope_value: &str,
    bytes: u64,
    limit: u64,
) -> ReservationRequest {
    ReservationRequest {
        storage_scope_id: scope(scope_value),
        project_id: project(project_value),
        save_session_id: session_id(session),
        requested_bytes: bytes,
        effective_quota: EffectiveQuota::limited(limit).unwrap(),
    }
}

async fn create_session(
    pool: &DatabasePool,
    id: &str,
    project: &str,
    scope: &str,
    key: &str,
    bytes: i64,
    expired: bool,
) {
    let timing = if expired {
        "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, \
         CURRENT_TIMESTAMP + INTERVAL '250 milliseconds'"
    } else {
        "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 hour'"
    };
    execute_owned(pool, format!(
        "INSERT INTO save_sessions \
         (id,project_id,storage_scope_id,actor_user_id,expected_project_version,expected_bundle_sha256,\
          expected_physical_bytes,expected_logical_bytes,expected_file_count,staging_object_key,\
          upload_mode,created_at,updated_at,expires_at) VALUES \
         ('{id}'::uuid,'{project}'::uuid,'{scope}'::uuid,\
          '0199ee6c-c777-7000-8000-000000007001'::uuid,\
          (SELECT lock_version FROM projects WHERE id='{project}'::uuid),decode(repeat('7a',32),'hex'),\
          {bytes},1,1,'staging/quota/{key}','single',{timing})"
    )).await;
}

async fn seed_fixture(pool: &DatabasePool) {
    execute(pool, "INSERT INTO users (id,email,normalized_email,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000007001','quota@example.test','quota@example.test','Quota Owner')").await;
    execute(
        pool,
        "INSERT INTO organizations (id,slug,display_name) VALUES \
        ('0199ee6c-c777-7000-8000-000000007010','quota-org','Quota Org')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_scopes (id,owner_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000007020','0199ee6c-c777-7000-8000-000000007001')",
    )
    .await;
    execute(
        pool,
        "INSERT INTO storage_scopes (id,owner_organization_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000007021','0199ee6c-c777-7000-8000-000000007010')",
    )
    .await;
    execute(pool, "INSERT INTO projects (id,owner_user_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000007030','0199ee6c-c777-7000-8000-000000007001','0199ee6c-c777-7000-8000-000000007020','quota-a','Quota A'),\
        ('0199ee6c-c777-7000-8000-000000007031','0199ee6c-c777-7000-8000-000000007001','0199ee6c-c777-7000-8000-000000007020','quota-b','Quota B')").await;
    execute(pool, "INSERT INTO projects (id,owner_organization_id,storage_scope_id,slug,name) VALUES \
        ('0199ee6c-c777-7000-8000-000000007032','0199ee6c-c777-7000-8000-000000007010','0199ee6c-c777-7000-8000-000000007021','quota-org','Quota Org')").await;
    for (session, project, scope, key) in [
        (
            "0199ee6c-c777-7000-8000-000000007060",
            USER_PROJECT_A,
            USER_SCOPE,
            "seed-a",
        ),
        (
            "0199ee6c-c777-7000-8000-000000007061",
            USER_PROJECT_B,
            USER_SCOPE,
            "seed-b",
        ),
        (
            "0199ee6c-c777-7000-8000-000000007062",
            ORG_PROJECT,
            ORG_SCOPE,
            "seed-o",
        ),
    ] {
        create_session(pool, session, project, scope, key, 100, false).await;
        execute_owned(pool, format!("UPDATE save_sessions SET state='uploading',updated_at=CURRENT_TIMESTAMP WHERE id='{session}'::uuid")).await;
        execute_owned(pool, format!("UPDATE save_sessions SET state='verifying',updated_at=CURRENT_TIMESTAMP WHERE id='{session}'::uuid")).await;
        if session == "0199ee6c-c777-7000-8000-000000007060" {
            execute(pool, "INSERT INTO bundles \
                (id,sha256,object_key,physical_bytes,logical_bytes,file_count,format,verified_at) VALUES \
                ('0199ee6c-c777-7000-8000-000000007050',decode(repeat('7a',32),'hex'),\
                 'staging/quota/seed-a',100,1,1,'project-bundle-v1',CURRENT_TIMESTAMP)").await;
        }
        execute_owned(pool, format!("UPDATE save_sessions SET state='committed',committed_bundle_id='0199ee6c-c777-7000-8000-000000007050',terminal_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id='{session}'::uuid")).await;
        execute_owned(pool, format!("INSERT INTO project_bundle_admissions \
            (project_id,storage_scope_id,bundle_id,source_save_session_id,save_session_id) VALUES \
            ('{project}'::uuid,'{scope}'::uuid,'0199ee6c-c777-7000-8000-000000007050'::uuid,'{session}'::uuid,'{session}'::uuid)")).await;
    }
    execute(pool, "UPDATE projects SET working_head_bundle_id='0199ee6c-c777-7000-8000-000000007050',updated_at=CURRENT_TIMESTAMP,lock_version=lock_version+1 WHERE id IN \
        ('0199ee6c-c777-7000-8000-000000007030','0199ee6c-c777-7000-8000-000000007031','0199ee6c-c777-7000-8000-000000007032')").await;
    execute(pool, "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,recovery_position,actor_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000007070','0199ee6c-c777-7000-8000-000000007030','0199ee6c-c777-7000-8000-000000007020','0199ee6c-c777-7000-8000-000000007050','recovery',1,'0199ee6c-c777-7000-8000-000000007001')").await;
    execute(pool, "INSERT INTO project_bundle_refs \
        (id,project_id,storage_scope_id,bundle_id,kind,version_name,actor_user_id) VALUES \
        ('0199ee6c-c777-7000-8000-000000007071','0199ee6c-c777-7000-8000-000000007031','0199ee6c-c777-7000-8000-000000007020','0199ee6c-c777-7000-8000-000000007050','version','Shared','0199ee6c-c777-7000-8000-000000007001')").await;
}

fn service(pool: &DatabasePool, timeout: Duration) -> QuotaService {
    QuotaService::new(pool.clone(), QuotaServicePolicy::new(timeout).unwrap())
}

fn scope(value: &str) -> StorageScopeId {
    StorageScopeId::from_str(value).unwrap()
}
fn project(value: &str) -> ProjectId {
    ProjectId::from_str(value).unwrap()
}
fn session_id(value: &str) -> SaveSessionId {
    SaveSessionId::from_uuid(uuid::Uuid::parse_str(value).unwrap()).unwrap()
}

async fn query_scalar(pool: &DatabasePool, statement: &'static str) -> i64 {
    sqlx::query_scalar(statement)
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn query_scalar_owned<T>(pool: &DatabasePool, statement: String) -> T
where
    for<'r> T: sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
{
    sqlx::query_scalar(AssertSqlSafe(statement))
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

async fn execute(pool: &DatabasePool, statement: &'static str) {
    sqlx::query(statement)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

async fn execute_owned(pool: &DatabasePool, statement: String) {
    sqlx::query(AssertSqlSafe(statement))
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
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
