use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::Path;

use crate::config::{Environment, FileReader};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use super::preflight::preflight;
use super::*;

#[derive(Default)]
struct TestEnvironment(Vec<(OsString, OsString)>);

impl Environment for TestEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

#[derive(Default)]
struct TestFiles(BTreeMap<String, Vec<u8>>);

impl FileReader for TestFiles {
    fn read(&self, path: &Path, _limit: usize) -> io::Result<Vec<u8>> {
        self.0
            .get(path.to_string_lossy().as_ref())
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "fixture missing"))
    }
}

fn environment(entries: &[(&str, &str)]) -> TestEnvironment {
    TestEnvironment(
        entries
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect(),
    )
}

fn base() -> Vec<(&'static str, &'static str)> {
    vec![
        ("NURITEO_SMTP_HOST", "smtp.internal.example"),
        ("NURITEO_SMTP_PORT", "587"),
        ("NURITEO_SMTP_SECURITY", "starttls"),
    ]
}

#[test]
fn smtp_is_optional_and_never_infers_partial_configuration() {
    assert_eq!(
        SmtpConfig::load(&TestEnvironment::default(), &TestFiles::default()).unwrap(),
        None
    );
    let error = SmtpConfig::load(
        &environment(&[("NURITEO_SMTP_HOST", "smtp.internal.example")]),
        &TestFiles::default(),
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "required configuration NURITEO_SMTP_PORT is missing"
    );

    assert_eq!(
        SmtpConfig::load(
            &environment(&[("NURITEO_INSTANCE_CA_FILE", "/private/instance-ca.pem")]),
            &TestFiles::default(),
        )
        .unwrap(),
        None,
        "the shared Instance CA alone must not activate SMTP"
    );
}

#[test]
fn credentials_load_from_exclusive_files_and_debug_is_redacted() {
    let username = "smtp-user-sensitive";
    let password = "smtp-password-sensitive";
    let mut entries = base();
    entries.extend([
        ("NURITEO_SMTP_USERNAME_FILE", "/private/smtp-user"),
        ("NURITEO_SMTP_PASSWORD_FILE", "/private/smtp-password"),
        ("NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS", "1500"),
    ]);
    let files = TestFiles(BTreeMap::from([
        (
            "/private/smtp-user".to_owned(),
            format!("{username}\n").into_bytes(),
        ),
        (
            "/private/smtp-password".to_owned(),
            format!("{password}\n").into_bytes(),
        ),
    ]));
    let config = SmtpConfig::load(&environment(&entries), &files)
        .unwrap()
        .unwrap();
    let credentials = config.credentials().unwrap();
    assert_eq!(credentials.username().expose_secret(), username);
    assert_eq!(credentials.password().expose_secret(), password);
    assert_eq!(config.preflight_timeout().as_millis(), 1500);
    assert_eq!(config.from_address(), "noreply@localhost");
    assert_eq!(config.from_name(), "NURITEO");

    let debug = format!("{config:?} {credentials:?}");
    for prohibited in [
        username,
        password,
        "smtp.internal.example",
        "/private/smtp-user",
        "/private/smtp-password",
    ] {
        assert!(!debug.contains(prohibited));
    }
}

#[test]
fn credential_and_transport_validation_fail_closed_without_values() {
    struct Case {
        additions: &'static [(&'static str, &'static str)],
        expected: &'static str,
    }
    let cases = [
        Case {
            additions: &[("NURITEO_SMTP_SECURITY", "none")],
            expected: "configuration NURITEO_SMTP_SECURITY must be implicit-tls or starttls",
        },
        Case {
            additions: &[("NURITEO_SMTP_USERNAME", "do-not-log")],
            expected: "SMTP username and password must be configured together",
        },
        Case {
            additions: &[
                ("NURITEO_SMTP_USERNAME", "do-not-log"),
                ("NURITEO_SMTP_USERNAME_FILE", "/private/user"),
                ("NURITEO_SMTP_PASSWORD", "do-not-log"),
            ],
            expected: "credential configuration NURITEO_SMTP_USERNAME is invalid",
        },
        Case {
            additions: &[("NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS", "99")],
            expected: "configuration NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS must be an integer from 100 through 30000",
        },
    ];
    for case in cases {
        let mut entries = base();
        for (key, value) in case.additions {
            if let Some(current) = entries.iter_mut().find(|(existing, _)| existing == key) {
                current.1 = value;
            } else {
                entries.push((key, value));
            }
        }
        let error = SmtpConfig::load(&environment(&entries), &TestFiles::default()).unwrap_err();
        assert_eq!(error.to_string(), case.expected);
        assert!(!error.to_string().contains("do-not-log"));
        assert!(!error.to_string().contains("/private/user"));
    }
}

#[tokio::test]
async fn starttls_downgrade_is_rejected_permanently() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut stream = BufReader::new(stream);
        stream
            .get_mut()
            .write_all(b"220 test ESMTP\r\n")
            .await
            .unwrap();
        let mut request = String::new();
        stream.read_line(&mut request).await.unwrap();
        assert_eq!(request, "EHLO nuriteo.invalid\r\n");
        stream
            .get_mut()
            .write_all(b"250-test\r\n250 AUTH PLAIN\r\n")
            .await
            .unwrap();
    });
    let config = SmtpConfig::load(
        &environment(&[
            ("NURITEO_SMTP_HOST", "localhost"),
            ("NURITEO_SMTP_PORT", &port),
            ("NURITEO_SMTP_SECURITY", "starttls"),
            ("NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS", "5000"),
        ]),
        &TestFiles::default(),
    )
    .unwrap()
    .unwrap();
    let error = preflight(&config).await.unwrap_err();
    assert_eq!(error.class(), SmtpFailureClass::Permanent);
    assert_eq!(error.category(), SmtpFailureCategory::Trust);
    server.await.unwrap();
}

#[tokio::test]
async fn total_preflight_timeout_is_retryable_and_bounded() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let server = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    });
    let config = SmtpConfig::load(
        &environment(&[
            ("NURITEO_SMTP_HOST", "localhost"),
            ("NURITEO_SMTP_PORT", &port),
            ("NURITEO_SMTP_SECURITY", "starttls"),
            ("NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS", "100"),
        ]),
        &TestFiles::default(),
    )
    .unwrap()
    .unwrap();
    let error = preflight(&config).await.unwrap_err();
    assert_eq!(error.class(), SmtpFailureClass::Retryable);
    assert_eq!(error.category(), SmtpFailureCategory::Timeout);
    server.abort();
}
