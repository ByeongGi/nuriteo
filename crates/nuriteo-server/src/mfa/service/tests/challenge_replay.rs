#![allow(unused_imports)]
use super::super::*;
use super::database::*;
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

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-mfa-challenge/run.sh"]
pub(crate) async fn actual_mfa_challenge_replay_lockout_recovery_and_reset_are_atomic() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
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
    let begin_key = MfaIdempotencyKey::new("mfa2-begin-receipt-0001".into()).unwrap();
    let enrollment = service
        .begin_enrollment_idempotent(fresh.token(), &begin_key, "mfa2:begin")
        .await
        .unwrap();
    let begin_replay = service
        .begin_enrollment_idempotent(fresh.token(), &begin_key, "mfa2:begin-replay")
        .await
        .unwrap();
    assert_eq!(begin_replay.metadata, enrollment.metadata);
    assert_eq!(begin_replay.secret.expose(), enrollment.secret.expose());
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

    let confirm_key = MfaIdempotencyKey::new("mfa2-confirm-receipt-0001".into()).unwrap();
    let completed = service
        .confirm_enrollment_idempotent(
            fresh.token(),
            enrollment.metadata.id,
            &confirmation_code,
            &confirm_key,
            "mfa2:confirm",
        )
        .await
        .unwrap();
    assert_eq!(completed.recovery_codes.len(), RECOVERY_CODE_COUNT);
    let completed_replay = service
        .confirm_enrollment_idempotent(
            fresh.token(),
            enrollment.metadata.id,
            &confirmation_code,
            &confirm_key,
            "mfa2:confirm-replay",
        )
        .await
        .unwrap();
    assert_eq!(
        completed_replay.session.token().expose(),
        completed.session.token().expose()
    );
    assert!(
        completed_replay
            .recovery_codes
            .iter()
            .zip(&completed.recovery_codes)
            .all(|(left, right)| left.expose() == right.expose())
    );
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
            .admin_reset(
                stale_admin.token(),
                local_user(),
                enrollment.metadata.id,
                "mfa2@example.test",
                "mfa2:reset-stale",
            )
            .await
            .unwrap_err(),
        MfaServiceError::ReauthenticationRequired
    );
    let admin = sessions
        .rotate(stale_admin.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    let admin_enrollment = service
        .begin_enrollment(admin.token(), "mfa3:admin-begin")
        .await
        .unwrap();
    let admin_now = database_time(&pool).await;
    let admin_counter = u64::try_from(admin_now.unix_timestamp() / TOTP_STEP_SECONDS).unwrap();
    let admin_code =
        TotpCode::parse(&hotp(admin_enrollment.secret.expose(), admin_counter).unwrap()).unwrap();
    let admin = service
        .confirm_enrollment(
            admin.token(),
            admin_enrollment.metadata.id,
            &admin_code,
            "mfa3:admin-confirm",
        )
        .await
        .unwrap()
        .session;

    let external_url = url::Url::parse("http://127.0.0.1:3000").unwrap();
    let http = MfaHttpService::production(
        pool.clone(),
        &external_url,
        keyring([71; 32]),
        session_policy,
    )
    .unwrap();
    let csrf = format!("nrt_csrf_{}", URL_SAFE_NO_PAD.encode([1_u8; 32]));
    let cookie = format!(
        "nuriteo_dev_session={}; nuriteo_dev_csrf={csrf}",
        admin.token().expose()
    );
    let origins = ["http://127.0.0.1:3000"];
    let cookie_headers = [cookie.as_str()];
    let csrf_headers = [csrf.as_str()];
    let request = BrowserRequestHeaders {
        method: BrowserMethod::Patch,
        origins: &origins,
        cookie_headers: &cookie_headers,
        csrf_headers: &csrf_headers,
    };

    let preview = http
        .preview_policy(request, "administrators", 0, 1)
        .await
        .unwrap();
    assert_eq!(preview.affected_users, 1);
    assert_eq!(preview.unenrolled_users, 0);
    assert_eq!(preview.immediately_restricted_users, 0);
    let enforced = http
        .update_policy(
            request,
            "administrators",
            0,
            1,
            &preview.population_proof,
            "mfa3:policy-enforce",
        )
        .await
        .unwrap();
    assert_eq!(enforced.mode, "administrators");
    assert_eq!(enforced.grace_period_days, 0);
    assert_eq!(enforced.enrolled_local_administrators, 1);
    assert_eq!(
        http.preview_policy(request, "all_local_users", 0, 1)
            .await
            .unwrap_err(),
        crate::mfa::MfaHttpServiceError::Conflict
    );
    assert_eq!(
        http.update_policy(
            request,
            "administrators",
            31,
            2,
            &preview.population_proof,
            "mfa3:invalid",
        )
        .await
        .unwrap_err(),
        crate::mfa::MfaHttpServiceError::InvalidInput
    );
    let relax_preview = http.preview_policy(request, "off", 7, 2).await.unwrap();
    let relaxed = http
        .update_policy(
            request,
            "off",
            7,
            2,
            &relax_preview.population_proof,
            "mfa3:policy-relax",
        )
        .await
        .unwrap();
    assert_eq!(relaxed.mode, "off");
    assert!(active_mfa_exists(&pool, admin_user()).await);
    let search_request = BrowserRequestHeaders {
        method: BrowserMethod::Get,
        origins: &[],
        cookie_headers: &cookie_headers,
        csrf_headers: &[],
    };
    let targets = http
        .reset_targets(search_request, "mfa2@example.test")
        .await
        .unwrap();
    assert_eq!(targets.items.len(), 1);
    assert_eq!(targets.items[0].user_id, local_user().to_string());
    assert_eq!(
        targets.items[0].credential_generation,
        enrollment.metadata.id.to_string()
    );

    install_rejecting_audit_trigger(&pool).await;
    assert_eq!(
        service
            .admin_reset(
                admin.token(),
                local_user(),
                enrollment.metadata.id,
                "mfa2@example.test",
                "mfa2:reset-rollback",
            )
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
        resetting_service.admin_reset(
            admin.token(),
            local_user(),
            enrollment.metadata.id,
            "mfa2@example.test",
            "mfa2:reset-race",
        )
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
            .admin_reset(
                admin.token(),
                disabled_race_user(),
                Uuid::now_v7(),
                "mfa2-disabled@example.test",
                "mfa2:cross-reset",
            )
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
    assert_eq!(cross_reset.unwrap_err(), MfaServiceError::Conflict);
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

    // Enforcing the policy and removing the last enrolled local
    // administrator serialize through the same advisory lock. Whichever wins,
    // the committed state must retain the safety invariant.
    let race_stale = sessions.issue(admin_user()).await.unwrap();
    let race_admin = sessions
        .rotate(race_stale.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    let race_cookie = format!(
        "nuriteo_dev_session={}; nuriteo_dev_csrf={csrf}",
        race_admin.token().expose()
    );
    let race_cookie_headers = [race_cookie.as_str()];
    let race_request = BrowserRequestHeaders {
        method: BrowserMethod::Patch,
        origins: &origins,
        cookie_headers: &race_cookie_headers,
        csrf_headers: &csrf_headers,
    };
    let race_preview = http
        .preview_policy(race_request, "administrators", 7, 3)
        .await
        .unwrap();
    let disable_service = service.clone();
    let enforce_http = http.clone();
    let (disabled, enforced) = tokio::join!(
        disable_service.disable_self(race_admin.token(), "mfa3:safety-race-disable"),
        enforce_http.update_policy(
            race_request,
            "administrators",
            7,
            3,
            &race_preview.population_proof,
            "mfa3:safety-race-enforce"
        )
    );
    assert!(disabled.is_ok() || enforced.is_ok());
    let invariant_holds: bool = sqlx::query_scalar(
        "SELECT CASE WHEN policy.value #>> '{}'='off' THEN TRUE ELSE EXISTS( \
           SELECT 1 FROM users account \
           JOIN local_password_credentials local ON local.user_id=account.id \
           JOIN mfa_totp_credentials mfa ON mfa.user_id=account.id AND mfa.state='active' \
           WHERE account.status='active' AND account.is_instance_admin) END \
         FROM instance_settings policy WHERE policy.key='security.mfa_enforcement'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(
        invariant_holds,
        "MFA safety race committed an unsafe policy state"
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

pub(crate) fn local_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000008001".parse().unwrap()
}

pub(crate) fn admin_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000008002".parse().unwrap()
}

pub(crate) fn disabled_race_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000008003".parse().unwrap()
}

pub(crate) async fn seed_users(pool: &DatabasePool) {
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

pub(crate) async fn active_mfa_exists(pool: &DatabasePool, user_id: UserId) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM mfa_totp_credentials
         WHERE user_id=$1::uuid AND state='active')",
    )
    .bind(user_id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
}

pub(crate) async fn assert_population_proof_stale(
    pool: &DatabasePool,
    http: &MfaHttpService,
    request: BrowserRequestHeaders<'_>,
) {
    let active_preview = http
        .preview_policy(request, "all_local_users", 7, 1)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE users SET status='disabled',disabled_at=transaction_timestamp(),updated_at=transaction_timestamp()
         WHERE id=$1::uuid",
    )
    .bind(disabled_race_user().to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        http.update_policy(
            request,
            "all_local_users",
            7,
            1,
            &active_preview.population_proof,
            "mfa3:stale-active-population",
        )
        .await
        .unwrap_err(),
        crate::mfa::MfaHttpServiceError::PreconditionFailed
    );
    restore_local_user_status(pool, disabled_race_user()).await;

    let local_preview = http
        .preview_policy(request, "all_local_users", 7, 1)
        .await
        .unwrap();
    sqlx::query("DELETE FROM local_password_credentials WHERE user_id=$1::uuid")
        .bind(disabled_race_user().to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        http.update_policy(
            request,
            "all_local_users",
            7,
            1,
            &local_preview.population_proof,
            "mfa3:stale-local-population",
        )
        .await
        .unwrap_err(),
        crate::mfa::MfaHttpServiceError::PreconditionFailed
    );
    restore_local_credential(pool, disabled_race_user()).await;

    let enrollment_preview = http
        .preview_policy(request, "all_local_users", 7, 1)
        .await
        .unwrap();
    sqlx::raw_sql(
        "INSERT INTO mfa_totp_credentials
         (id,user_id,state,secret_version,algorithm,key_version,nonce,ciphertext)
         VALUES('0199ee6c-c777-7000-8000-000000009001',
                '0199ee6c-c777-7000-8000-000000008003','pending',1,'aes-256-gcm-v1',1,
                decode('010101010101010101010101','hex'),
                decode('0202020202020202020202020202020202','hex'));
         UPDATE mfa_totp_credentials SET state='active',activated_at=transaction_timestamp(),
         updated_at=transaction_timestamp()
         WHERE id='0199ee6c-c777-7000-8000-000000009001'::uuid;",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        http.update_policy(
            request,
            "all_local_users",
            7,
            1,
            &enrollment_preview.population_proof,
            "mfa3:stale-enrollment-population",
        )
        .await
        .unwrap_err(),
        crate::mfa::MfaHttpServiceError::PreconditionFailed
    );
}
