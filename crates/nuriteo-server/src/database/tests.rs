use std::net::TcpListener;
use std::thread;

use super::*;

const SECRET_URL: &str = "postgres://nuriteo:do-not-print@localhost/nuriteo";

fn valid_config() -> DatabasePoolConfig {
    DatabasePoolConfig::new(
        SECRET_URL.to_owned(),
        0,
        4,
        Duration::from_millis(250),
        Duration::from_millis(250),
        DatabaseTlsConfig::default(),
    )
    .unwrap_or_else(|error| panic!("test configuration should be valid: {error}"))
}

#[test]
fn configuration_debug_redacts_the_complete_database_url() {
    let debug = format!("{:?}", valid_config());

    assert!(!debug.contains("do-not-print"));
    assert!(!debug.contains("nuriteo:do-not-print"));
    assert!(debug.contains("[REDACTED]"));
}

#[test]
fn rejects_invalid_pool_bounds_and_timeouts() {
    let tls = DatabaseTlsConfig::default();
    assert!(matches!(
        DatabasePoolConfig::new(
            SECRET_URL.to_owned(),
            5,
            4,
            Duration::from_secs(1),
            Duration::from_secs(1),
            tls.clone(),
        ),
        Err(DatabaseConfigError::InvalidConnectionBounds)
    ));
    assert!(matches!(
        DatabasePoolConfig::new(
            SECRET_URL.to_owned(),
            0,
            1,
            Duration::from_millis(99),
            Duration::from_secs(1),
            tls,
        ),
        Err(DatabaseConfigError::InvalidConnectTimeout)
    ));
}

#[test]
fn errors_never_include_connection_credentials() {
    let invalid = DatabasePoolConfig::new(
        "postgres://nuriteo:do-not-print@/missing-host".to_owned(),
        0,
        1,
        Duration::from_secs(1),
        Duration::from_secs(1),
        DatabaseTlsConfig::default(),
    )
    .expect_err("URL without a host must fail");

    let display = invalid.to_string();
    let debug = format!("{invalid:?}");
    assert!(!display.contains("do-not-print"));
    assert!(!debug.contains("do-not-print"));
}

#[test]
fn rejects_undeclared_libpq_secret_and_session_environment() {
    for forbidden in [
        "PGPASSWORD",
        "PGPASSFILE",
        "PGSSLMODE",
        "PGSSLROOTCERT",
        "PGSSLCERT",
        "PGSSLKEY",
        "PGHOST",
        "PGHOSTADDR",
        "PGPORT",
        "PGUSER",
        "PGDATABASE",
        "PGAPPNAME",
        "PGOPTIONS",
        "PGSERVICE",
        "PGSERVICEFILE",
    ] {
        let result = connect_options_with_environment(&valid_config(), |name| {
            (name == forbidden).then(|| "must-not-leak".into())
        });
        assert!(matches!(
            result,
            Err(DatabaseError::InvalidConfiguration(
                DatabaseConfigError::ConflictingDriverEnvironment
            ))
        ));
        assert!(!format!("{result:?}").contains("must-not-leak"));
    }
}

#[test]
fn tls_configuration_rejects_empty_and_private_key_trust_inputs() {
    assert!(matches!(
        DatabaseTlsConfig::verify_full(Some(Vec::new()), None, None),
        Err(TlsConfigError::EmptyTrustBundle)
    ));
    let private_key = b"-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n".to_vec();
    assert!(matches!(
        DatabaseTlsConfig::verify_full(None, Some(private_key), None),
        Err(TlsConfigError::InvalidTrustBundle)
    ));
}

#[tokio::test]
async fn connection_deadline_bounds_a_server_that_never_completes_the_handshake() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("test listener must bind: {error}"));
    let port = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("test listener needs an address: {error}"))
        .port();
    let server = thread::spawn(move || {
        if let Ok((_stream, _address)) = listener.accept() {
            thread::sleep(Duration::from_secs(1));
        }
    });
    let config = DatabasePoolConfig::new(
        format!("postgres://nuriteo:do-not-print@localhost:{port}/nuriteo"),
        0,
        1,
        Duration::from_millis(100),
        Duration::from_secs(1),
        DatabaseTlsConfig::default(),
    )
    .unwrap_or_else(|error| panic!("test configuration should be valid: {error}"));

    let result = DatabasePool::connect(config).await;

    assert!(matches!(result, Err(DatabaseError::ConnectTimeout)));
    assert!(!format!("{result:?}").contains("do-not-print"));
    server.join().expect("test server thread must finish");
}
