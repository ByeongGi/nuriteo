#![allow(unused_imports)]
use super::super::*;
use super::challenge_replay::*;
use super::database::*;
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

#[test]
pub(crate) fn rfc_6238_sha1_window_and_redaction_are_stable() {
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
pub(crate) fn challenge_policy_is_bounded() {
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
pub(crate) async fn actual_mfa_003_receipt_replays_for_old_and_rotated_sessions_only() {
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
pub(crate) async fn actual_mfa_003_policy_population_proof_fences_stale_apply() {
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
