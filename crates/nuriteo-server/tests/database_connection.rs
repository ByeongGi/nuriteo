use std::env;
use std::fs;
use std::time::Duration;

use nuriteo_server::database::{
    DatabaseError, DatabaseErrorCategory, DatabasePool, DatabasePoolConfig, DatabaseTlsConfig,
    TlsConfigError,
};
use url::Url;

const DATABASE_URL_ENV: &str = "NURITEO_TEST_DATABASE_URL";
const DATABASE_CA_ENV: &str = "NURITEO_TEST_DATABASE_CA";
const SERVER_CERT_ENV: &str = "NURITEO_TEST_DATABASE_SERVER_CERT";

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the PostgreSQL fixture"))
}

fn config(url: String, ca: Option<Vec<u8>>, max_connections: u32) -> DatabasePoolConfig {
    let tls = DatabaseTlsConfig::verify_full(None, ca, None)
        .unwrap_or_else(|error| panic!("TLS fixture must be valid: {error}"));
    DatabasePoolConfig::new(
        url,
        1,
        max_connections,
        Duration::from_secs(5),
        Duration::from_millis(200),
        tls,
    )
    .unwrap_or_else(|error| panic!("database fixture configuration must be valid: {error}"))
}

#[tokio::test]
#[ignore = "requires the pinned PostgreSQL TLS fixture; run tests/fixtures/postgres/run.sh"]
async fn real_postgres_covers_tls_success_failure_authentication_and_pool_timeout() {
    let database_url = required_env(DATABASE_URL_ENV);
    let ca = fs::read(required_env(DATABASE_CA_ENV))
        .unwrap_or_else(|error| panic!("fixture CA must be readable: {error}"));
    let server_certificate = fs::read(required_env(SERVER_CERT_ENV))
        .unwrap_or_else(|error| panic!("fixture server certificate must be readable: {error}"));

    assert!(matches!(
        DatabaseTlsConfig::verify_full(None, Some(server_certificate), None),
        Err(TlsConfigError::NonCaCertificate)
    ));

    let untrusted = DatabasePool::connect(config(database_url.clone(), None, 1)).await;
    assert!(
        matches!(
            untrusted,
            Err(DatabaseError::ConnectFailed(DatabaseErrorCategory::Trust))
        ),
        "unexpected trust failure classification: {untrusted:?}"
    );

    let pool = DatabasePool::connect(config(database_url.clone(), Some(ca.clone()), 1))
        .await
        .unwrap_or_else(|error| panic!("TLS PostgreSQL connection must succeed: {error}"));
    pool.ping()
        .await
        .unwrap_or_else(|error| panic!("PostgreSQL ping must succeed: {error}"));

    let held_connection = pool
        .acquire()
        .await
        .unwrap_or_else(|error| panic!("first pool acquisition must succeed: {error}"));
    assert!(matches!(
        pool.acquire().await,
        Err(DatabaseError::AcquireTimeout)
    ));
    drop(held_connection);
    pool.close(Duration::from_secs(2))
        .await
        .unwrap_or_else(|error| panic!("pool must close cleanly: {error}"));

    let mut wrong_password =
        Url::parse(&database_url).unwrap_or_else(|error| panic!("fixture URL must parse: {error}"));
    wrong_password
        .set_password(Some("credential-that-must-not-leak"))
        .unwrap_or_else(|()| panic!("PostgreSQL URL supports a password"));
    let authentication_failure =
        DatabasePool::connect(config(wrong_password.into(), Some(ca), 1)).await;
    assert!(matches!(
        authentication_failure,
        Err(DatabaseError::ConnectFailed(
            DatabaseErrorCategory::Authentication
        ))
    ));
    let safe_error = format!("{authentication_failure:?}");
    assert!(!safe_error.contains("credential-that-must-not-leak"));
    assert!(!safe_error.contains("postgres://"));
}
