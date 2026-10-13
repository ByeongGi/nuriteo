use std::env;
use std::fs;
use std::sync::Arc;

use crate::database::{
    DatabasePoolConfig, DatabaseTlsConfig, MigrationOptions, run_embedded_migrations,
};

use super::*;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";

#[test]
fn token_wire_contract_is_bounded_and_redacted() {
    let token = SessionToken::generate().unwrap();
    assert_eq!(token.expose().len(), TOKEN_WIRE_BYTES);
    assert!(token.expose().starts_with(TOKEN_PREFIX));
    assert_eq!(format!("{token:?}"), "SessionToken([REDACTED])");
    assert_eq!(token.to_string(), "[REDACTED]");
    assert!(!format!("{token:?}").contains(token.expose()));

    for invalid in [
        String::new(),
        "nrt_sess_short".to_owned(),
        format!("bad_sess_{}", "A".repeat(TOKEN_ENCODED_BYTES)),
        format!("{TOKEN_PREFIX}{}*", "A".repeat(TOKEN_ENCODED_BYTES - 1)),
        format!("{TOKEN_PREFIX}{}", "A".repeat(TOKEN_ENCODED_BYTES + 1)),
    ] {
        assert_eq!(
            SessionToken::parse(invalid),
            Err(SessionServiceError::InvalidToken)
        );
    }
}

#[test]
fn generated_tokens_have_independent_256_bit_entropy_inputs() {
    let first = SessionToken::generate().unwrap();
    let second = SessionToken::generate().unwrap();
    assert_ne!(first.expose(), second.expose());
    assert_ne!(first.digest(), second.digest());
    assert_eq!(first.digest().len(), TOKEN_DIGEST_BYTES);
}

#[test]
fn policy_defaults_and_bounds_are_explicit() {
    let policy = SessionPolicy::default();
    assert_eq!(policy.idle_timeout(), Duration::from_secs(7 * 86_400));
    assert_eq!(policy.absolute_timeout(), Duration::from_secs(30 * 86_400));
    assert_eq!(policy.operation_timeout(), Duration::from_secs(5));

    assert_eq!(
        SessionPolicy::new(
            MIN_IDLE - Duration::from_secs(1),
            DEFAULT_ABSOLUTE,
            DEFAULT_OPERATION_TIMEOUT
        ),
        Err(SessionPolicyError::InvalidIdleTimeout)
    );
    assert_eq!(
        SessionPolicy::new(DEFAULT_IDLE, DEFAULT_IDLE, DEFAULT_OPERATION_TIMEOUT),
        Err(SessionPolicyError::InvalidAbsoluteTimeout)
    );
    assert_eq!(
        SessionPolicy::new(
            DEFAULT_IDLE,
            MAX_ABSOLUTE + Duration::from_secs(1),
            DEFAULT_OPERATION_TIMEOUT
        ),
        Err(SessionPolicyError::InvalidAbsoluteTimeout)
    );
    assert_eq!(
        SessionPolicy::new(DEFAULT_IDLE, DEFAULT_ABSOLUTE, Duration::from_millis(99)),
        Err(SessionPolicyError::InvalidOperationTimeout)
    );
}

#[test]
fn errors_never_include_token_or_database_context() {
    let token = SessionToken::generate().unwrap();
    for error in [
        SessionServiceError::InvalidToken,
        SessionServiceError::DatabaseUnavailable,
        SessionServiceError::OperationTimeout,
        SessionServiceError::InvariantViolation,
    ] {
        let rendered = format!("{error:?}: {error}");
        assert!(!rendered.contains(token.expose()));
        assert!(!rendered.contains("postgres://"));
    }
}

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres-session/run.sh"]
async fn real_postgres_enforces_session_lifecycle_and_concurrent_rotation() {
    let pool = fixture_pool().await;
    reset_fixture(&pool).await;
    run_embedded_migrations(
        &pool,
        MigrationOptions::new(Duration::from_secs(5), Duration::from_secs(30)).unwrap(),
    )
    .await
    .unwrap();
    let first_user = UserId::new();
    let second_user = UserId::new();
    insert_user(&pool, first_user, "first@example.test").await;
    insert_user(&pool, second_user, "second@example.test").await;
    let service = SessionService::new(pool.clone(), SessionPolicy::default());

    let issued = service.issue(first_user).await.unwrap();
    assert_eq!(issued.session().user_id(), first_user);
    assert_eq!(
        service
            .authenticate(issued.token())
            .await
            .unwrap()
            .user_id(),
        first_user
    );
    assert_hash_only_persistence(&pool, issued.token()).await;

    let mut wrong_wire = issued.token().expose().as_bytes().to_vec();
    let last = wrong_wire.last_mut().unwrap();
    *last = if *last == b'A' { b'B' } else { b'A' };
    let wrong = SessionToken::parse(String::from_utf8(wrong_wire).unwrap()).unwrap();
    assert_eq!(
        service.authenticate(&wrong).await,
        Err(SessionServiceError::InvalidToken)
    );

    let idle_expired = service.issue(first_user).await.unwrap();
    expire_session(&pool, idle_expired.token(), false).await;
    assert_eq!(
        service.authenticate(idle_expired.token()).await,
        Err(SessionServiceError::InvalidToken)
    );
    let absolute_expired = service.issue(first_user).await.unwrap();
    expire_session(&pool, absolute_expired.token(), true).await;
    assert_eq!(
        service.authenticate(absolute_expired.token()).await,
        Err(SessionServiceError::InvalidToken)
    );

    let concurrent = service.issue(first_user).await.unwrap();
    let shared = Arc::new(concurrent.into_parts().0);
    let first = tokio::spawn({
        let service = service.clone();
        let token = Arc::clone(&shared);
        async move { service.rotate(&token, SessionRotationKind::Login).await }
    });
    let second = tokio::spawn({
        let service = service.clone();
        let token = Arc::clone(&shared);
        async move {
            service
                .rotate(&token, SessionRotationKind::Reauthentication)
                .await
        }
    });
    let outcomes = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Err(SessionServiceError::InvalidToken)))
            .count(),
        1
    );
    assert_eq!(
        service.authenticate(&shared).await,
        Err(SessionServiceError::InvalidToken)
    );
    let replacement = outcomes.into_iter().find_map(Result::ok).unwrap();
    assert_hash_only_persistence(&pool, replacement.token()).await;

    assert_eq!(
        service.revoke(replacement.token()).await.unwrap(),
        SessionRevokeResult::Revoked
    );
    assert_eq!(
        service.revoke(replacement.token()).await.unwrap(),
        SessionRevokeResult::AlreadyInactive
    );

    let all_first = service.issue(second_user).await.unwrap();
    let all_second = service.issue(second_user).await.unwrap();
    assert_eq!(service.revoke_all_for_user(second_user).await.unwrap(), 2);
    assert_eq!(service.revoke_all_for_user(second_user).await.unwrap(), 0);
    assert_eq!(
        service.authenticate(all_first.token()).await,
        Err(SessionServiceError::InvalidToken)
    );
    assert_eq!(
        service.authenticate(all_second.token()).await,
        Err(SessionServiceError::InvalidToken)
    );

    let disabled = service.issue(first_user).await.unwrap();
    sqlx::query(
        "UPDATE users SET status = 'disabled', disabled_at = transaction_timestamp(), \
         updated_at = transaction_timestamp() WHERE id = $1::uuid",
    )
    .bind(first_user.to_string())
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(
        service.authenticate(disabled.token()).await,
        Err(SessionServiceError::InvalidToken)
    );

    reset_fixture(&pool).await;
    pool.close(Duration::from_secs(2)).await.unwrap();
}

async fn fixture_pool() -> DatabasePool {
    let database_url = env::var(DATABASE_URL_ENV).unwrap();
    let ca_path = env::var(DATABASE_CA_ENV).unwrap();
    let ca = fs::read(ca_path).unwrap();
    let tls = DatabaseTlsConfig::verify_full(None, Some(ca), None).unwrap();
    let config = DatabasePoolConfig::new(
        database_url,
        0,
        8,
        Duration::from_secs(5),
        Duration::from_secs(5),
        tls,
    )
    .unwrap();
    DatabasePool::connect(config).await.unwrap()
}

async fn insert_user(pool: &DatabasePool, id: UserId, email: &str) {
    sqlx::query(
        "INSERT INTO users (id, email, normalized_email, display_name) \
         VALUES ($1::uuid, $2, $2, 'Session fixture')",
    )
    .bind(id.to_string())
    .bind(email)
    .execute(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
}

async fn expire_session(pool: &DatabasePool, token: &SessionToken, absolute: bool) {
    let digest = token.digest();
    let statement = if absolute {
        "UPDATE sessions SET created_at = transaction_timestamp() - INTERVAL '2 days', \
         last_seen_at = transaction_timestamp() - INTERVAL '3 hours', \
         idle_expires_at = transaction_timestamp() - INTERVAL '2 hours', \
         absolute_expires_at = transaction_timestamp() - INTERVAL '1 hour' \
         WHERE token_hash = $1"
    } else {
        "UPDATE sessions SET created_at = transaction_timestamp() - INTERVAL '1 day', \
         last_seen_at = transaction_timestamp() - INTERVAL '2 hours', \
         idle_expires_at = transaction_timestamp() - INTERVAL '1 hour', \
         absolute_expires_at = transaction_timestamp() + INTERVAL '1 day' \
         WHERE token_hash = $1"
    };
    sqlx::query(statement)
        .bind(digest.as_slice())
        .execute(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

async fn assert_hash_only_persistence(pool: &DatabasePool, token: &SessionToken) {
    let digest = token.digest();
    let row: (Vec<u8>, String) = sqlx::query_as(
        "SELECT token_hash, row_to_json(sessions)::text FROM sessions WHERE token_hash = $1",
    )
    .bind(digest.as_slice())
    .fetch_one(&mut *pool.acquire().await.unwrap())
    .await
    .unwrap();
    assert_eq!(row.0, digest);
    assert!(!row.1.contains(token.expose()));
    assert_eq!(row.0.len(), TOKEN_DIGEST_BYTES);
}

async fn reset_fixture(pool: &DatabasePool) {
    let mut connection = pool.acquire().await.unwrap();
    for statement in [
        "DROP TABLE IF EXISTS organization_memberships CASCADE",
        "DROP TABLE IF EXISTS organizations CASCADE",
        "DROP TABLE IF EXISTS storage_scopes CASCADE",
        "DROP TABLE IF EXISTS local_auth_failures CASCADE",
        "DROP TABLE IF EXISTS audit_events CASCADE",
        "DROP TABLE IF EXISTS sessions CASCADE",
        "DROP TABLE IF EXISTS oidc_identities CASCADE",
        "DROP TABLE IF EXISTS oidc_providers CASCADE",
        "DROP TABLE IF EXISTS local_password_credentials CASCADE",
        "DROP TABLE IF EXISTS users CASCADE",
        "DROP TABLE IF EXISTS _sqlx_migrations CASCADE",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap();
    }
}
