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
use crate::mfa::MfaHttpService;

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
async fn actual_mfa_003_receipt_replays_for_old_and_rotated_sessions_only() {
    let pool = fixture_pool().await;
    prepare_fixture(&pool).await;
    let session_policy = SessionPolicy::default();
    let sessions = SessionService::new(pool.clone(), session_policy);
    let service = MfaService::new(
        pool.clone(),
        keyring([71; 32]),
        session_policy,
        MfaChallengePolicy::default(),
    );
    let stale = sessions.issue(local_user()).await.unwrap();
    let fresh = sessions
        .rotate(stale.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    let begin_key = MfaIdempotencyKey::new("mfa3-receipt-begin-0001".into()).unwrap();
    let enrollment = service
        .begin_enrollment_idempotent(fresh.token(), &begin_key, "mfa3:receipt-begin")
        .await
        .unwrap();
    let now = database_time(&pool).await;
    let counter = u64::try_from(now.unix_timestamp() / TOTP_STEP_SECONDS).unwrap();
    let code = TotpCode::parse(&hotp(enrollment.secret.expose(), counter).unwrap()).unwrap();
    let confirm_key = MfaIdempotencyKey::new("mfa3-receipt-confirm-0001".into()).unwrap();
    let completed = service
        .confirm_enrollment_idempotent(
            fresh.token(),
            enrollment.metadata.id,
            &code,
            &confirm_key,
            "mfa3:receipt-confirm",
        )
        .await
        .unwrap();
    for (token, correlation) in [
        (fresh.token(), "mfa3:receipt-old-cookie"),
        (completed.session.token(), "mfa3:receipt-rotated-cookie"),
    ] {
        let replay = service
            .confirm_enrollment_idempotent(
                token,
                enrollment.metadata.id,
                &code,
                &confirm_key,
                correlation,
            )
            .await
            .unwrap();
        assert_eq!(
            replay.session.token().expose(),
            completed.session.token().expose()
        );
        assert!(
            replay
                .recovery_codes
                .iter()
                .zip(&completed.recovery_codes)
                .all(|(left, right)| left.expose() == right.expose())
        );
    }
    let unrelated_stale = sessions.issue(local_user()).await.unwrap();
    let unrelated_browser = sessions
        .rotate(
            unrelated_stale.token(),
            SessionRotationKind::Reauthentication,
        )
        .await
        .unwrap();
    assert!(matches!(
        service
            .confirm_enrollment_idempotent(
                unrelated_browser.token(),
                enrollment.metadata.id,
                &code,
                &confirm_key,
                "mfa3:receipt-unrelated-browser",
            )
            .await,
        Err(MfaServiceError::Conflict | MfaServiceError::NotActive)
    ));
    let begin_alias_error = sqlx::query(
        "UPDATE mfa_operation_receipts SET rotated_session_binding=$1
         WHERE operation='begin' AND idempotency_key=$2",
    )
    .bind(unrelated_browser.token().binding_digest().as_slice())
    .bind(begin_key.expose())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap_err();
    assert_eq!(
        begin_alias_error
            .as_database_error()
            .and_then(|error| error.constraint()),
        Some("mfa_operation_receipts_rotation_check")
    );
    sqlx::query(
        "UPDATE mfa_operation_receipts SET rotated_session_binding=$1
         WHERE operation='confirm' AND idempotency_key=$2",
    )
    .bind(unrelated_browser.token().binding_digest().as_slice())
    .bind(confirm_key.expose())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service
            .confirm_enrollment_idempotent(
                unrelated_browser.token(),
                enrollment.metadata.id,
                &code,
                &confirm_key,
                "mfa3:receipt-tampered-alias",
            )
            .await
            .unwrap_err(),
        MfaServiceError::Conflict
    );
    assert_eq!(
        service
            .confirm_enrollment_idempotent(
                fresh.token(),
                enrollment.metadata.id,
                &code,
                &confirm_key,
                "mfa3:receipt-tampered-original",
            )
            .await
            .unwrap_err(),
        MfaServiceError::Conflict
    );
    sqlx::query(
        "UPDATE mfa_operation_receipts
         SET created_at=transaction_timestamp()-interval '20 minutes',
             expires_at=transaction_timestamp()-interval '1 second'
         WHERE operation='confirm' AND idempotency_key=$1",
    )
    .bind(confirm_key.expose())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(matches!(
        service
            .confirm_enrollment_idempotent(
                completed.session.token(),
                enrollment.metadata.id,
                &code,
                &confirm_key,
                "mfa3:receipt-expired",
            )
            .await,
        Err(MfaServiceError::Conflict | MfaServiceError::NotActive)
    ));
    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-mfa-challenge/run.sh"]
async fn actual_mfa_003_policy_population_proof_fences_stale_apply() {
    let pool = fixture_pool().await;
    prepare_fixture(&pool).await;
    let session_policy = SessionPolicy::default();
    let sessions = SessionService::new(pool.clone(), session_policy);
    let service = MfaService::new(
        pool.clone(),
        keyring([71; 32]),
        session_policy,
        MfaChallengePolicy::default(),
    );
    let stale = sessions.issue(admin_user()).await.unwrap();
    let admin = sessions
        .rotate(stale.token(), SessionRotationKind::Reauthentication)
        .await
        .unwrap();
    let enrollment = service
        .begin_enrollment(admin.token(), "mfa3:proof-admin-begin")
        .await
        .unwrap();
    let now = database_time(&pool).await;
    let counter = u64::try_from(now.unix_timestamp() / TOTP_STEP_SECONDS).unwrap();
    let code = TotpCode::parse(&hotp(enrollment.secret.expose(), counter).unwrap()).unwrap();
    let admin = service
        .confirm_enrollment(
            admin.token(),
            enrollment.metadata.id,
            &code,
            "mfa3:proof-admin-confirm",
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
    Box::pin(assert_population_proof_stale(&pool, &http, request)).await;
    assert_population_lock_fences_phantoms(&pool, &http, admin.token().expose()).await;
    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
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

async fn assert_population_proof_stale(
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

async fn assert_population_lock_fences_phantoms(
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

async fn apply_policy_for_test(
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
    .expect("MFA contender must block on the canonical population/User lock");
}

async fn restore_local_user(pool: &DatabasePool, user_id: UserId) {
    let mut connection = pool.acquire().await.unwrap();
    let mut tx = connection.begin().await.unwrap();
    restore_local_user_status_in(&mut tx, user_id).await;
    insert_local_credential_in(&mut tx, user_id).await;
    tx.commit().await.unwrap();
}

async fn restore_local_user_status(pool: &DatabasePool, user_id: UserId) {
    let mut connection = pool.acquire().await.unwrap();
    let mut tx = connection.begin().await.unwrap();
    restore_local_user_status_in(&mut tx, user_id).await;
    tx.commit().await.unwrap();
}

async fn restore_local_credential(pool: &DatabasePool, user_id: UserId) {
    let mut connection = pool.acquire().await.unwrap();
    let mut tx = connection.begin().await.unwrap();
    insert_local_credential_in(&mut tx, user_id).await;
    tx.commit().await.unwrap();
}

async fn restore_local_user_status_in(
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

async fn insert_local_credential_in(
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

async fn prepare_fixture(pool: &DatabasePool) {
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
