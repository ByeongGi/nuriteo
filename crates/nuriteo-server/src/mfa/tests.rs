use super::*;

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sqlx::{Acquire, Executor, Row};

use crate::config::{Environment, FileReader};
use crate::database::{
    DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

#[test]
fn secret_wrappers_are_bounded_and_redacted() {
    let secret = TotpSecret::new(vec![7; 20]).unwrap();
    let code = RecoveryCode::new(b"recovery-code-01".to_vec()).unwrap();
    assert_eq!(format!("{secret:?}"), "TotpSecret([REDACTED])");
    assert_eq!(format!("{code:?}"), "RecoveryCode([REDACTED])");
    assert_eq!(
        TotpSecret::new(vec![0; 19]),
        Err(MfaStorageError::InvalidInput)
    );
    assert_eq!(
        RecoveryCode::new(vec![0; 7]),
        Err(MfaStorageError::InvalidInput)
    );
}

#[tokio::test]
#[ignore = "requires tests/fixtures/postgres-mfa-totp/run.sh"]
async fn actual_mfa_secret_recovery_lifecycle_and_rotation_are_atomic() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    let report = run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(report.latest_version, Some(40));
    seed_users(&pool).await;
    let user_id = fixture_user();
    let old = MfaRepository::new(pool.clone(), keyring(1, [11; 32], &[]));

    let mut disabling_connection = pool.acquire().await.unwrap();
    let mut disabling = disabling_connection.begin().await.unwrap();
    sqlx::query(
        "UPDATE users SET status='disabled',disabled_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
    )
    .bind(race_user().to_string())
    .execute(&mut *disabling)
    .await
    .unwrap();
    let race_repository = old.clone();
    let enrollment_race = tokio::spawn(async move {
        race_repository
            .begin_enrollment(
                race_user(),
                race_user(),
                &TotpSecret::new(b"race-totp-secret-0001".to_vec()).unwrap(),
                "mfa:disable-race",
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!enrollment_race.is_finished());
    disabling.commit().await.unwrap();
    drop(disabling_connection);
    assert_eq!(
        enrollment_race.await.unwrap().unwrap_err(),
        MfaStorageError::LocalAccountRequired
    );
    let race_credentials: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM mfa_totp_credentials WHERE user_id=$1::uuid")
            .bind(race_user().to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(race_credentials, 0);

    let first = old
        .begin_enrollment(
            user_id,
            user_id,
            &TotpSecret::new(b"first-totp-secret-0001".to_vec()).unwrap(),
            "mfa:first",
        )
        .await
        .unwrap();
    assert_eq!(old.active_secret(user_id).await.unwrap(), None);
    let second = old
        .begin_enrollment(
            user_id,
            user_id,
            &TotpSecret::new(b"second-totp-secret-002".to_vec()).unwrap(),
            "mfa:second",
        )
        .await
        .unwrap();
    assert_ne!(first.id, second.id);
    let first_state: String =
        sqlx::query_scalar("SELECT state FROM mfa_totp_credentials WHERE id=$1::uuid")
            .bind(first.id.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
    assert_eq!(first_state, "replaced");

    let activation_a = old.clone();
    let activation_b = old.clone();
    let (activated_a, activated_b) = tokio::join!(
        activation_a.activate_confirmed(
            user_id,
            ConfirmedTotpEnrollment::new(second.id, user_id),
            recovery_codes(&[b"recovery-alpha", b"recovery-beta"]),
            "mfa:activate-a",
        ),
        activation_b.activate_confirmed(
            user_id,
            ConfirmedTotpEnrollment::new(second.id, user_id),
            recovery_codes(&[b"recovery-alpha", b"recovery-beta"]),
            "mfa:activate-b",
        )
    );
    assert!(matches!(
        (activated_a, activated_b),
        (Ok(_), Err(MfaStorageError::Conflict)) | (Err(MfaStorageError::Conflict), Ok(_))
    ));
    assert_eq!(
        old.active_secret(user_id).await.unwrap().unwrap().expose(),
        b"second-totp-secret-002"
    );
    assert!(
        sqlx::query(
            "INSERT INTO mfa_totp_credentials
             (id,user_id,state,secret_version,algorithm,key_version,nonce,ciphertext,activated_at)
             SELECT $1::uuid,$2::uuid,'active',secret_version,algorithm,key_version,
                    decode(repeat('42',12),'hex'),ciphertext,CURRENT_TIMESTAMP
             FROM mfa_totp_credentials WHERE id=$3::uuid",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(race_user().to_string())
        .bind(second.id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err(),
        "direct active credential insert must be rejected"
    );
    let wrong_key = MfaRepository::new(pool.clone(), keyring(1, [99; 32], &[]));
    let wrong_key_error = wrong_key.active_secret(user_id).await.unwrap_err();
    assert_eq!(wrong_key_error, MfaStorageError::SecretUnavailable);
    assert!(!format!("{wrong_key_error:?} {wrong_key_error}").contains("second-totp"));
    let missing_previous = MfaRepository::new(pool.clone(), keyring(2, [22; 32], &[]));
    assert_eq!(
        missing_previous.active_secret(user_id).await.unwrap_err(),
        MfaStorageError::SecretUnavailable
    );
    let tampered_rows = [
        sqlx::query(
            "SELECT id::text,secret_version,algorithm,key_version,nonce,
             set_byte(ciphertext,0,get_byte(ciphertext,0)#1) AS ciphertext
             FROM mfa_totp_credentials WHERE id=$1::uuid",
        ),
        sqlx::query(
            "SELECT id::text,secret_version+1 AS secret_version,algorithm,key_version,nonce,ciphertext
             FROM mfa_totp_credentials WHERE id=$1::uuid",
        ),
        sqlx::query(
            "SELECT '0199ee6c-c777-7000-8000-000000006099'::text AS id,
             secret_version,algorithm,key_version,nonce,ciphertext
             FROM mfa_totp_credentials WHERE id=$1::uuid",
        ),
    ];
    for query in tampered_rows {
        let row = query
            .bind(second.id.to_string())
            .fetch_one(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
        assert_eq!(
            old.open_secret(user_id, &row).unwrap_err(),
            MfaStorageError::SecretUnavailable
        );
    }
    let active_row = sqlx::query(
        "SELECT id::text,secret_version,algorithm,key_version,nonce,ciphertext
         FROM mfa_totp_credentials WHERE id=$1::uuid",
    )
    .bind(second.id.to_string())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        old.open_secret(oidc_only_user(), &active_row).unwrap_err(),
        MfaStorageError::SecretUnavailable
    );
    let persisted: Vec<(Vec<u8>, String)> = sqlx::query(
        "SELECT credential.ciphertext,recovery.code_hash FROM mfa_totp_credentials credential
         JOIN mfa_recovery_codes recovery ON recovery.credential_id=credential.id
         WHERE credential.id=$1::uuid ORDER BY recovery.slot",
    )
    .bind(second.id.to_string())
    .fetch_all(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap()
    .into_iter()
    .map(|row| (row.get("ciphertext"), row.get("code_hash")))
    .collect();
    assert_eq!(persisted.len(), 2);
    assert!(persisted.iter().all(|(ciphertext, hash)| {
        !ciphertext
            .windows(b"second-totp-secret-002".len())
            .any(|window| window == b"second-totp-secret-002")
            && hash.starts_with("$argon2id$")
            && !hash.contains("recovery-")
    }));
    let fixture_hash = persisted[0].1.clone();
    assert!(
        sqlx::query(
            "INSERT INTO mfa_recovery_codes(id,credential_id,user_id,slot,code_hash)
             VALUES($1::uuid,$2::uuid,$3::uuid,21,$4)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(second.id.to_string())
        .bind(user_id.to_string())
        .bind(&fixture_hash)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err(),
        "database must enforce the bounded recovery-code slot set"
    );

    let first_consumer = old.clone();
    let second_consumer = old.clone();
    let (consume_a, consume_b) = tokio::join!(
        first_consumer.consume_recovery_code(
            user_id,
            user_id,
            RecoveryCode::new(b"recovery-alpha".to_vec()).unwrap(),
            "mfa:consume-a",
        ),
        second_consumer.consume_recovery_code(
            user_id,
            user_id,
            RecoveryCode::new(b"recovery-alpha".to_vec()).unwrap(),
            "mfa:consume-b",
        )
    );
    let outcomes = [consume_a.unwrap(), consume_b.unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == RecoveryConsumeResult::Consumed)
            .count(),
        1
    );

    old.replace_recovery_codes(
        user_id,
        user_id,
        recovery_codes(&[b"recovery-gamma"]),
        "mfa:replace-codes",
    )
    .await
    .unwrap();
    assert_eq!(
        old.consume_recovery_code(
            user_id,
            user_id,
            RecoveryCode::new(b"recovery-beta".to_vec()).unwrap(),
            "mfa:old-code",
        )
        .await
        .unwrap(),
        RecoveryConsumeResult::Mismatch
    );

    let rotated = MfaRepository::new(pool.clone(), keyring(2, [22; 32], &[(1, [11; 32])]));
    let (rotation_a, rotation_b) = tokio::join!(rotated.rotate_batch(1), rotated.rotate_batch(1));
    assert_eq!(rotation_a.unwrap().rotated + rotation_b.unwrap().rotated, 2);
    assert_eq!(rotated.rotate_batch(100).await.unwrap().rotated, 0);
    assert_eq!(
        rotated
            .active_secret(user_id)
            .await
            .unwrap()
            .unwrap()
            .expose(),
        b"second-totp-secret-002"
    );
    let current_only = MfaRepository::new(pool.clone(), keyring(2, [22; 32], &[]));
    assert_eq!(
        current_only
            .active_secret(user_id)
            .await
            .unwrap()
            .unwrap()
            .expose(),
        b"second-totp-secret-002"
    );

    assert!(
        sqlx::query(
            "UPDATE mfa_totp_credentials SET state='disabled',terminal_at=CURRENT_TIMESTAMP,
             updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid",
        )
        .bind(second.id.to_string())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err(),
        "terminal transition must reject retained recovery codes"
    );
    let insert_pool = pool.clone();
    let insert_hash = fixture_hash.clone();
    let insert_recovery = async move {
        sqlx::query(
            "INSERT INTO mfa_recovery_codes(id,credential_id,user_id,slot,code_hash)
             VALUES($1::uuid,$2::uuid,$3::uuid,2,$4)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(second.id.to_string())
        .bind(user_id.to_string())
        .bind(insert_hash)
        .execute(&mut *insert_pool.acquire().await.unwrap())
        .await
    };
    let disabling_repository = rotated.clone();
    let disable_mfa = async move {
        disabling_repository
            .disable(user_id, user_id, "mfa:disable-race")
            .await
    };
    let (insert_result, disable_result) = tokio::join!(insert_recovery, disable_mfa);
    assert_ne!(insert_result.is_ok(), disable_result.is_ok());
    if insert_result.is_ok() {
        assert_eq!(disable_result.unwrap_err(), MfaStorageError::Unavailable);
        rotated
            .disable(user_id, user_id, "mfa:disable-after-race")
            .await
            .unwrap();
    }
    assert!(
        sqlx::query(
            "INSERT INTO mfa_recovery_codes(id,credential_id,user_id,slot,code_hash)
             VALUES($1::uuid,$2::uuid,$3::uuid,1,$4)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(second.id.to_string())
        .bind(user_id.to_string())
        .bind(&fixture_hash)
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .is_err(),
        "inactive credentials must reject new recovery codes"
    );
    assert_eq!(rotated.active_secret(user_id).await.unwrap(), None);
    assert_eq!(
        rotated
            .replace_recovery_codes(
                user_id,
                user_id,
                recovery_codes(&[b"recovery-delta"]),
                "mfa:inactive-reissue",
            )
            .await
            .unwrap_err(),
        MfaStorageError::NotActive
    );
    assert_eq!(
        rotated
            .consume_recovery_code(
                user_id,
                user_id,
                RecoveryCode::new(b"recovery-gamma".to_vec()).unwrap(),
                "mfa:inactive-consume",
            )
            .await
            .unwrap(),
        RecoveryConsumeResult::Mismatch
    );

    let oidc_only = oidc_only_user();
    assert_eq!(
        rotated
            .begin_enrollment(
                oidc_only,
                oidc_only,
                &TotpSecret::new(b"oidc-only-totp-secret".to_vec()).unwrap(),
                "mfa:oidc-only",
            )
            .await
            .unwrap_err(),
        MfaStorageError::LocalAccountRequired
    );
    let audit: String = sqlx::query_scalar(
        "SELECT string_agg(metadata::text || changed_fields::text, '')
         FROM audit_events WHERE action_code LIKE 'mfa.%'",
    )
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert!(!audit.contains("totp-secret"));
    assert!(!audit.contains("recovery-"));

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

fn recovery_codes(values: &[&[u8]]) -> Vec<RecoveryCode> {
    values
        .iter()
        .map(|value| RecoveryCode::new(value.to_vec()).unwrap())
        .collect()
}

fn fixture_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000006001".parse().unwrap()
}

fn oidc_only_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000006002".parse().unwrap()
}

fn race_user() -> UserId {
    "0199ee6c-c777-7000-8000-000000006003".parse().unwrap()
}

async fn seed_users(pool: &DatabasePool) {
    sqlx::query(
        "INSERT INTO users(id,email,normalized_email,display_name) VALUES
         ('0199ee6c-c777-7000-8000-000000006001','local@example.test','local@example.test','Local'),
         ('0199ee6c-c777-7000-8000-000000006002','oidc@example.test','oidc@example.test','OIDC'),
         ('0199ee6c-c777-7000-8000-000000006003','race@example.test','race@example.test','Race')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO local_password_credentials(user_id,password_verifier)
         VALUES
         ('0199ee6c-c777-7000-8000-000000006001',
          '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM'),
         ('0199ee6c-c777-7000-8000-000000006003',
          '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$5izDQ8GG3kr1hDx0wzfQt5n4kQ2DqVfvMXkZXS8RvlM')",
    )
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
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

fn keyring(current: u32, key: [u8; 32], previous: &[(u32, [u8; 32])]) -> MasterKeyring {
    let previous = serde_json::to_string(
        &previous
            .iter()
            .map(|(version, key)| {
                serde_json::json!({"version":version,"key":URL_SAFE_NO_PAD.encode(key)})
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    MasterKeyring::load(
        &TestEnvironment(vec![
            (
                "NURITEO_MASTER_KEY".into(),
                URL_SAFE_NO_PAD.encode(key).into(),
            ),
            (
                "NURITEO_MASTER_KEY_VERSION".into(),
                current.to_string().into(),
            ),
            ("NURITEO_PREVIOUS_MASTER_KEYS".into(), previous.into()),
        ]),
        &NoFiles,
    )
    .unwrap()
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
            6,
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
    pool.acquire()
        .await
        .unwrap()
        .execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .await
        .unwrap();
}
