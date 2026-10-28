#![allow(unused_imports)]
use super::super::*;
use super::challenge_replay::*;
use super::rfc6238::*;
use super::*;

use std::env;

use std::ffi::OsString;

use std::fs;

use std::io;

use std::path::Path;

use std::time::Instant;

use base64::Engine;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::config::{Environment, FileReader, InstanceSettingBootstrap};

use crate::database::{
    DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use crate::identity::{BrowserMethod, BrowserRequestHeaders, acquire_mfa_population_lock};

use crate::instance_settings::InstanceSettingsRepository;

use super::{NoFiles, TestEnvironment};
use crate::mfa::MfaHttpService;

pub(crate) async fn assert_population_lock_fences_phantoms(
    pool: &DatabasePool,
    http: &MfaHttpService,
    token: &str,
) {
    sqlx::raw_sql(
        "INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES
         ('0199ee6c-c777-7000-8000-000000008102','mfa3-credential@example.test','mfa3-credential@example.test','Credential Phantom',FALSE),
         ('0199ee6c-c777-7000-8000-000000008103','mfa3-enrollment@example.test','mfa3-enrollment@example.test','Enrollment Phantom',FALSE);
         INSERT INTO local_password_credentials(user_id,password_verifier)
         VALUES('0199ee6c-c777-7000-8000-000000008103',
         '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM');",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let csrf = format!("nrt_csrf_{}", URL_SAFE_NO_PAD.encode([1_u8; 32]));
    let cookie = format!("nuriteo_dev_session={token}; nuriteo_dev_csrf={csrf}");
    let origins = ["http://127.0.0.1:3000"];
    let cookie_headers = [cookie.as_str()];
    let csrf_headers = [csrf.as_str()];
    let request = BrowserRequestHeaders {
        method: BrowserMethod::Patch,
        origins: &origins,
        cookie_headers: &cookie_headers,
        csrf_headers: &csrf_headers,
    };

    for (correlation_id, mutation) in [
        ("mfa3:phantom-user", "user"),
        ("mfa3:phantom-credential", "credential"),
        ("mfa3:phantom-enrollment", "enrollment"),
    ] {
        let preview = http
            .preview_policy(request, "all_local_users", 7, 1)
            .await
            .unwrap();
        let mut holder_connection = pool.acquire().await.unwrap();
        let mut holder = holder_connection.begin().await.unwrap();
        acquire_mfa_population_lock(&mut holder).await.unwrap();
        let holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *holder)
            .await
            .unwrap();
        match mutation {
            "user" => {
                sqlx::raw_sql(
                    "INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES
                     ('0199ee6c-c777-7000-8000-000000008101','mfa3-user@example.test','mfa3-user@example.test','User Phantom',FALSE);
                     INSERT INTO local_password_credentials(user_id,password_verifier)
                     VALUES('0199ee6c-c777-7000-8000-000000008101',
                     '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM');",
                )
                .execute(&mut *holder)
                .await
                .unwrap();
            }
            "credential" => {
                sqlx::query(
                    "INSERT INTO local_password_credentials(user_id,password_verifier)
                     VALUES('0199ee6c-c777-7000-8000-000000008102',
                     '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')",
                )
                .execute(&mut *holder)
                .await
                .unwrap();
            }
            "enrollment" => {
                sqlx::raw_sql(
                    "INSERT INTO mfa_totp_credentials
                     (id,user_id,state,secret_version,algorithm,key_version,nonce,ciphertext)
                     VALUES('0199ee6c-c777-7000-8000-000000009103',
                     '0199ee6c-c777-7000-8000-000000008103','pending',1,'aes-256-gcm-v1',1,
                     decode('030303030303030303030303','hex'),
                     decode('0404040404040404040404040404040404','hex'));
                     UPDATE mfa_totp_credentials SET state='active',activated_at=transaction_timestamp(),
                     updated_at=transaction_timestamp()
                     WHERE id='0199ee6c-c777-7000-8000-000000009103'::uuid;",
                )
                .execute(&mut *holder)
                .await
                .unwrap();
            }
            _ => unreachable!(),
        }
        let apply = tokio::spawn(apply_policy_for_test(
            http.clone(),
            token.to_owned(),
            preview.population_proof,
            correlation_id,
        ));
        wait_until_blocked(pool, holder_pid).await;
        holder.commit().await.unwrap();
        drop(holder_connection);
        assert_eq!(
            apply.await.unwrap().unwrap_err(),
            crate::mfa::MfaHttpServiceError::PreconditionFailed
        );
    }
}

pub(crate) async fn apply_policy_for_test(
    http: MfaHttpService,
    token: String,
    population_proof: String,
    correlation_id: &'static str,
) -> Result<crate::mfa::MfaPolicyView, crate::mfa::MfaHttpServiceError> {
    let csrf = format!("nrt_csrf_{}", URL_SAFE_NO_PAD.encode([1_u8; 32]));
    let cookie = format!("nuriteo_dev_session={token}; nuriteo_dev_csrf={csrf}");
    let origins = ["http://127.0.0.1:3000"];
    let cookie_headers = [cookie.as_str()];
    let csrf_headers = [csrf.as_str()];
    http.update_policy(
        BrowserRequestHeaders {
            method: BrowserMethod::Patch,
            origins: &origins,
            cookie_headers: &cookie_headers,
            csrf_headers: &csrf_headers,
        },
        "all_local_users",
        7,
        1,
        &population_proof,
        correlation_id,
    )
    .await
}

pub(crate) async fn wait_until_blocked(pool: &DatabasePool, blocker_pid: i32) {
    wait_until_blocked_count(pool, blocker_pid, 1).await;
}

pub(crate) async fn wait_until_blocked_count(pool: &DatabasePool, blocker_pid: i32, expected: i64) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let blocked: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity activity
                 WHERE activity.datname=current_database()
                   AND activity.pid<>pg_backend_pid()
                   AND $1=ANY(pg_blocking_pids(activity.pid))",
            )
            .bind(blocker_pid)
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
            if blocked >= expected {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("MFA contender must block on the canonical population/User lock");
}

pub(crate) async fn restore_local_user(pool: &DatabasePool, user_id: UserId) {
    let mut connection = pool.acquire().await.unwrap();
    let mut tx = connection.begin().await.unwrap();
    restore_local_user_status_in(&mut tx, user_id).await;
    insert_local_credential_in(&mut tx, user_id).await;
    tx.commit().await.unwrap();
}

pub(crate) async fn restore_local_user_status(pool: &DatabasePool, user_id: UserId) {
    let mut connection = pool.acquire().await.unwrap();
    let mut tx = connection.begin().await.unwrap();
    restore_local_user_status_in(&mut tx, user_id).await;
    tx.commit().await.unwrap();
}

pub(crate) async fn restore_local_credential(pool: &DatabasePool, user_id: UserId) {
    let mut connection = pool.acquire().await.unwrap();
    let mut tx = connection.begin().await.unwrap();
    insert_local_credential_in(&mut tx, user_id).await;
    tx.commit().await.unwrap();
}

pub(crate) async fn restore_local_user_status_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: UserId,
) {
    sqlx::query(
        "UPDATE users SET status='active',disabled_at=NULL,updated_at=transaction_timestamp()
         WHERE id=$1::uuid",
    )
    .bind(user_id.to_string())
    .execute(&mut **tx)
    .await
    .unwrap();
}

pub(crate) async fn insert_local_credential_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: UserId,
) {
    sqlx::query(
        "INSERT INTO local_password_credentials(user_id,password_verifier)
         VALUES($1::uuid,'$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')",
    )
    .bind(user_id.to_string())
    .execute(&mut **tx)
    .await
    .unwrap();
}

pub(crate) async fn install_rejecting_audit_trigger(pool: &DatabasePool) {
    sqlx::raw_sql(
        "CREATE FUNCTION reject_mfa_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.action_code='mfa.admin_reset' THEN RAISE EXCEPTION 'fixture audit failure';
         END IF; RETURN NEW; END $$;
         CREATE TRIGGER reject_mfa_reset_audit BEFORE INSERT ON audit_events
         FOR EACH ROW EXECUTE FUNCTION reject_mfa_reset_audit();",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

pub(crate) async fn remove_rejecting_audit_trigger(pool: &DatabasePool) {
    sqlx::raw_sql(
        "DROP TRIGGER reject_mfa_reset_audit ON audit_events;
         DROP FUNCTION reject_mfa_reset_audit();",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

pub(crate) async fn database_time(pool: &DatabasePool) -> OffsetDateTime {
    sqlx::query_scalar("SELECT CURRENT_TIMESTAMP")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

pub(crate) fn keyring(key: [u8; 32]) -> MasterKeyring {
    MasterKeyring::load(
        &TestEnvironment(vec![
            (
                "NURITEO_MASTER_KEY".into(),
                URL_SAFE_NO_PAD.encode(key).into(),
            ),
            ("NURITEO_MASTER_KEY_VERSION".into(), "1".into()),
        ]),
        &NoFiles,
    )
    .unwrap()
}

impl Environment for TestEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

impl FileReader for NoFiles {
    fn read(&self, _: &Path, _: usize) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::NotFound.into())
    }
}

pub(crate) async fn fixture_pool() -> DatabasePool {
    let tls = DatabaseTlsConfig::verify_full(
        None,
        Some(fs::read(env::var("NURITEO_TEST_DATABASE_CA").unwrap()).unwrap()),
        None,
    )
    .unwrap();
    DatabasePool::connect(
        DatabasePoolConfig::new(
            env::var("NURITEO_TEST_DATABASE_URL").unwrap(),
            1,
            8,
            Duration::from_secs(5),
            Duration::from_secs(5),
            tls,
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

pub(crate) async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&mut *connection)
        .await
        .unwrap();
}

pub(crate) async fn prepare_fixture(pool: &DatabasePool) {
    reset_fixture(pool).await;
    let report = run_embedded_migrations(
        pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(40));
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    seed_users(pool).await;
}
