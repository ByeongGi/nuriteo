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
use crate::instance_settings::InstanceSettingsRepository;

#[test]
fn rfc_6238_sha1_window_and_redaction_are_stable() {
    let secret = TotpSecret::new(b"12345678901234567890".to_vec()).unwrap();
    let code = TotpCode::parse(b"287082").unwrap();
    let now = OffsetDateTime::from_unix_timestamp(59).unwrap();
    assert_eq!(matching_counter(&secret, &code, now).unwrap(), Some(1));
    assert_eq!(format!("{code:?}"), "TotpCode([REDACTED])");
    assert_eq!(
        TotpCode::parse(b"12a456").unwrap_err(),
        MfaServiceError::InvalidInput
    );
}

#[test]
fn challenge_policy_is_bounded() {
    assert!(MfaChallengePolicy::default().failure_threshold <= MAX_FAILURE_THRESHOLD);
    assert_eq!(
        MfaChallengePolicy::new(
            2,
            Duration::from_secs(60),
            Duration::from_secs(60),
            Duration::from_secs(1),
        )
        .unwrap_err(),
        MfaServiceError::InvalidInput
    );
}

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-mfa-challenge/run.sh"]
async fn actual_mfa_challenge_replay_lockout_recovery_and_reset_are_atomic() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(31));
    InstanceSettingsRepository::new(pool.clone(), Duration::from_secs(5))
        .unwrap()
        .materialize(&InstanceSettingBootstrap::empty())
        .await
        .unwrap();
    seed_users(&pool).await;

    let session_policy = SessionPolicy::default();
    let sessions = SessionService::new(pool.clone(), session_policy);
    let service = MfaService::new(
        pool.clone(),
        keyring([71; 32]),
        session_policy,
        MfaChallengePolicy::default(),
    );

    let stale = sessions.issue(local_user()).await.unwrap();
    assert_eq!(
        service
            .begin_enrollment(stale.token(), "mfa2:stale-reauth")
            .await
            .unwrap_err(),
        MfaServiceError::ReauthenticationRequired
    );
    let fresh = sessions
        .rotate(stale.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    let other_session = sessions.issue(local_user()).await.unwrap();
    let enrollment = service
        .begin_enrollment(fresh.token(), "mfa2:begin")
        .await
        .unwrap();
    let now = database_time(&pool).await;
    let current = u64::try_from(now.unix_timestamp() / TOTP_STEP_SECONDS).unwrap();
    let confirmation_code = TotpCode::parse(
        &hotp(enrollment.secret.expose(), current.checked_sub(1).unwrap()).unwrap(),
    )
    .unwrap();

    let saturated_permits = service.passwords.saturate_for_test().await;
    let saturation_started = Instant::now();
    let (saturated_confirmation, database_progress) = tokio::join!(
        service.confirm_enrollment(
            fresh.token(),
            enrollment.metadata.id,
            &confirmation_code,
            "mfa2:argon-saturated",
        ),
        tokio::time::timeout(Duration::from_secs(1), async {
            let mut connection = pool.acquire().await.unwrap();
            sqlx::query_scalar::<_, i32>("SELECT 1")
                .fetch_one(&mut *connection)
                .await
                .unwrap()
        })
    );
    assert_eq!(
        saturated_confirmation.unwrap_err(),
        MfaServiceError::Unavailable
    );
    assert_eq!(database_progress.unwrap(), 1);
    assert!(
        saturation_started.elapsed() < Duration::from_secs(1),
        "Argon2 admission saturation must fail before the operation deadline"
    );
    drop(saturated_permits);

    let completed = service
        .confirm_enrollment(
            fresh.token(),
            enrollment.metadata.id,
            &confirmation_code,
            "mfa2:confirm",
        )
        .await
        .unwrap();
    assert_eq!(completed.recovery_codes.len(), RECOVERY_CODE_COUNT);
    assert_eq!(
        sessions
            .authenticate(other_session.token())
            .await
            .unwrap_err(),
        SessionServiceError::InvalidToken
    );

    let disable_race_session = sessions.issue(local_user()).await.unwrap();
    let mut disable_holder_connection = pool.acquire().await.unwrap();
    let mut disable_holder = disable_holder_connection.begin().await.unwrap();
    let disable_holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *disable_holder)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1::uuid FOR UPDATE")
        .bind(local_user().to_string())
        .fetch_one(&mut *disable_holder)
        .await
        .unwrap();
    let disable_race_service = service.clone();
    let disable_race_code =
        TotpCode::parse(&hotp(enrollment.secret.expose(), current).unwrap()).unwrap();
    let disable_race = tokio::spawn(async move {
        disable_race_service
            .verify_totp(
                disable_race_session.token(),
                &disable_race_code,
                "mfa2:disable-race",
            )
            .await
    });
    wait_until_blocked(&pool, disable_holder_pid).await;
    sqlx::query(
        "UPDATE users SET status='disabled',disabled_at=transaction_timestamp(),
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(local_user().to_string())
    .execute(&mut *disable_holder)
    .await
    .unwrap();
    sqlx::query("DELETE FROM local_password_credentials WHERE user_id=$1::uuid")
        .bind(local_user().to_string())
        .execute(&mut *disable_holder)
        .await
        .unwrap();
    disable_holder.commit().await.unwrap();
    drop(disable_holder_connection);
    assert_eq!(
        disable_race.await.unwrap().unwrap_err(),
        MfaServiceError::NotActive
    );
    restore_local_user(&pool, local_user()).await;

    let replay_peer = sessions.issue(local_user()).await.unwrap();
    let current_code =
        TotpCode::parse(&hotp(enrollment.secret.expose(), current).unwrap()).unwrap();
    let first = service.clone();
    let second = service.clone();
    let first_token = completed.session.token();
    let second_token = replay_peer.token();
    let (replay_a, replay_b) = tokio::join!(
        first.verify_totp(first_token, &current_code, "mfa2:replay-a"),
        second.verify_totp(second_token, &current_code, "mfa2:replay-b")
    );
    let (verified, replay_error) = match (replay_a, replay_b) {
        (Ok(session), Err(error)) | (Err(error), Ok(session)) => (session, error),
        observed => panic!("concurrent replay was not fenced: {observed:?}"),
    };
    assert_eq!(replay_error, MfaServiceError::ChallengeFailed);

    let invalid = TotpCode::parse(b"000000").unwrap();
    for attempt in 0..DEFAULT_FAILURE_THRESHOLD {
        assert_eq!(
            service
                .verify_totp(
                    verified.token(),
                    &invalid,
                    &format!("mfa2:lockout-{attempt}"),
                )
                .await
                .unwrap_err(),
            MfaServiceError::ChallengeFailed
        );
    }
    let locked_until: Option<OffsetDateTime> =
        sqlx::query_scalar("SELECT locked_until FROM mfa_challenge_states WHERE user_id=$1::uuid")
            .bind(local_user().to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    let observed_now = database_time(&pool).await;
    assert!(locked_until.is_some_and(|until| until > observed_now));
    assert_eq!(
        service
            .verify_totp(verified.token(), &current_code, "mfa2:locked-valid")
            .await
            .unwrap_err(),
        MfaServiceError::ChallengeFailed
    );
    sqlx::query(
        "UPDATE mfa_challenge_states SET failure_count=0,failure_window_started_at=NULL,
         locked_until=NULL,updated_at=transaction_timestamp() WHERE user_id=$1::uuid",
    )
    .bind(local_user().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();

    let recovery_peer = sessions.issue(local_user()).await.unwrap();
    let recovery_bytes = completed.recovery_codes[0].expose().to_vec();
    let recover_a = service.clone();
    let recover_b = service.clone();
    let (recovered_a, recovered_b) = tokio::join!(
        recover_a.recover(
            verified.token(),
            RecoveryCode::new(recovery_bytes.clone()).unwrap(),
            "mfa2:recover-a"
        ),
        recover_b.recover(
            recovery_peer.token(),
            RecoveryCode::new(recovery_bytes).unwrap(),
            "mfa2:recover-b"
        )
    );
    let recovered = match (recovered_a, recovered_b) {
        (
            Ok(session),
            Err(MfaServiceError::AuthenticationFailed | MfaServiceError::ChallengeFailed),
        )
        | (
            Err(MfaServiceError::AuthenticationFailed | MfaServiceError::ChallengeFailed),
            Ok(session),
        ) => session,
        observed => panic!("recovery code was not one-time: {observed:?}"),
    };

    let stale_admin = sessions.issue(admin_user()).await.unwrap();
    assert_eq!(
        service
            .admin_reset(stale_admin.token(), local_user(), "mfa2:reset-stale")
            .await
            .unwrap_err(),
        MfaServiceError::ReauthenticationRequired
    );
    let admin = sessions
        .rotate(stale_admin.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    install_rejecting_audit_trigger(&pool).await;
    assert_eq!(
        service
            .admin_reset(admin.token(), local_user(), "mfa2:reset-rollback")
            .await
            .unwrap_err(),
        MfaServiceError::Unavailable
    );
    assert!(active_mfa_exists(&pool, local_user()).await);
    sessions.authenticate(recovered.token()).await.unwrap();
    remove_rejecting_audit_trigger(&pool).await;
    let replacement_session = sessions
        .rotate(recovered.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    let replacement = service
        .begin_enrollment(replacement_session.token(), "mfa2:replacement-begin")
        .await
        .unwrap();
    let replacement_now = database_time(&pool).await;
    let replacement_counter =
        u64::try_from(replacement_now.unix_timestamp() / TOTP_STEP_SECONDS).unwrap();
    let replacement_code =
        TotpCode::parse(&hotp(replacement.secret.expose(), replacement_counter).unwrap()).unwrap();
    let confirming_service = service.clone();
    let resetting_service = service.clone();
    let (confirming, resetting) = tokio::join!(
        confirming_service.confirm_enrollment(
            replacement_session.token(),
            replacement.metadata.id,
            &replacement_code,
            "mfa2:confirm-reset-race"
        ),
        resetting_service.admin_reset(admin.token(), local_user(), "mfa2:reset-race")
    );
    resetting.unwrap();
    match confirming {
        Ok(completed) => assert_eq!(
            sessions
                .authenticate(completed.session.token())
                .await
                .unwrap_err(),
            SessionServiceError::InvalidToken
        ),
        Err(
            MfaServiceError::AuthenticationFailed
            | MfaServiceError::Conflict
            | MfaServiceError::NotActive,
        ) => {}
        observed => panic!("confirm/reset race had an invalid result: {observed:?}"),
    }
    assert!(!active_mfa_exists(&pool, local_user()).await);
    assert_eq!(
        sessions
            .authenticate(replacement_session.token())
            .await
            .unwrap_err(),
        SessionServiceError::InvalidToken
    );

    let disabled_stale = sessions.issue(disabled_race_user()).await.unwrap();
    let disabled_session = sessions
        .rotate(
            disabled_stale.token(),
            SessionRotationKind::Reauthentication,
        )
        .await
        .unwrap();
    let mut cross_holder_connection = pool.acquire().await.unwrap();
    let mut cross_holder = cross_holder_connection.begin().await.unwrap();
    let cross_holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *cross_holder)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1::uuid FOR UPDATE")
        .bind(disabled_race_user().to_string())
        .fetch_one(&mut *cross_holder)
        .await
        .unwrap();
    let cross_begin_service = service.clone();
    let cross_reset_service = service.clone();
    let cross_begin = tokio::spawn(async move {
        cross_begin_service
            .begin_enrollment(disabled_session.token(), "mfa2:cross-begin")
            .await
    });
    let cross_reset = tokio::spawn(async move {
        cross_reset_service
            .admin_reset(admin.token(), disabled_race_user(), "mfa2:cross-reset")
            .await
    });
    // At least one contender must reach the shared target-User lock before
    // release; the second remains concurrently runnable and then serializes
    // through the same canonical order.
    wait_until_blocked(&pool, cross_holder_pid).await;
    cross_holder.commit().await.unwrap();
    drop(cross_holder_connection);
    let (cross_begin, cross_reset) = (cross_begin.await.unwrap(), cross_reset.await.unwrap());
    assert!(cross_begin.is_ok());
    assert_eq!(cross_reset.unwrap_err(), MfaServiceError::NotActive);
    let disabled_session = sessions.issue(disabled_race_user()).await.unwrap();
    sqlx::query(
        "UPDATE users SET status='disabled',disabled_at=transaction_timestamp(),
         updated_at=transaction_timestamp() WHERE id=$1::uuid",
    )
    .bind(disabled_race_user().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .begin_enrollment(disabled_session.token(), "mfa2:disabled")
            .await
            .unwrap_err(),
        MfaServiceError::AuthenticationFailed
    );

    let audit_dump: String = sqlx::query_scalar(
        "SELECT COALESCE(string_agg(action_code || metadata::text || changed_fields::text,' '),'')
         FROM audit_events WHERE action_code LIKE 'mfa.%'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        !audit_dump
            .as_bytes()
            .windows(enrollment.secret.expose().len())
            .any(|window| window == enrollment.secret.expose())
    );
    for recovery in &completed.recovery_codes {
        assert!(
            !audit_dump
                .as_bytes()
                .windows(recovery.expose().len())
                .any(|window| window == recovery.expose())
        );
    }

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

fn local_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000008001".parse().unwrap()
}

fn admin_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000008002".parse().unwrap()
}

fn disabled_race_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000008003".parse().unwrap()
}

async fn seed_users(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name,is_instance_admin) VALUES
         ('0199ee6c-c777-7000-8000-000000008001','mfa2@example.test','mfa2@example.test','MFA User',FALSE),
         ('0199ee6c-c777-7000-8000-000000008002','mfa2-admin@example.test','mfa2-admin@example.test','MFA Admin',TRUE),
         ('0199ee6c-c777-7000-8000-000000008003','mfa2-disabled@example.test','mfa2-disabled@example.test','Disabled Race',FALSE)",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO local_password_credentials(user_id,password_verifier)
         SELECT id,'$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM'
         FROM users",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn active_mfa_exists(pool: &DatabasePool, user_id: UserId) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM mfa_totp_credentials
         WHERE user_id=$1::uuid AND state='active')",
    )
    .bind(user_id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

async fn wait_until_blocked(pool: &DatabasePool, blocker_pid: i32) {
    wait_until_blocked_count(pool, blocker_pid, 1).await;
}

async fn wait_until_blocked_count(pool: &DatabasePool, blocker_pid: i32, expected: i64) {
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
    .expect("MFA contender must block on the User row");
}

async fn restore_local_user(pool: &DatabasePool, user_id: UserId) {
    let mut connection = pool.acquire().await.unwrap();
    let mut tx = connection.begin().await.unwrap();
    sqlx::query(
        "UPDATE users SET status='active',disabled_at=NULL,updated_at=transaction_timestamp()
         WHERE id=$1::uuid",
    )
    .bind(user_id.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO local_password_credentials(user_id,password_verifier)
         VALUES($1::uuid,'$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')",
    )
    .bind(user_id.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn install_rejecting_audit_trigger(pool: &DatabasePool) {
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

async fn remove_rejecting_audit_trigger(pool: &DatabasePool) {
    sqlx::raw_sql(
        "DROP TRIGGER reject_mfa_reset_audit ON audit_events;
         DROP FUNCTION reject_mfa_reset_audit();",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn database_time(pool: &DatabasePool) -> OffsetDateTime {
    sqlx::query_scalar("SELECT CURRENT_TIMESTAMP")
        .fetch_one(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}

fn keyring(key: [u8; 32]) -> MasterKeyring {
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

#[derive(Clone)]
struct TestEnvironment(Vec<(OsString, OsString)>);

impl Environment for TestEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

struct NoFiles;

impl FileReader for NoFiles {
    fn read(&self, _: &Path, _: usize) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::NotFound.into())
    }
}

async fn fixture_pool() -> DatabasePool {
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

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&mut *connection)
        .await
        .unwrap();
}
