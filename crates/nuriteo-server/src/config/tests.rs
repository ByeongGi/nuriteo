use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use super::load::load_secret;
use super::schema::*;
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
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "test file not found"))
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

fn load(entries: &[(&str, &str)], files: &TestFiles) -> Result<LoadReport, ConfigError> {
    Config::load(&environment(entries), files)
}

#[test]
fn loads_safe_defaults_without_future_service_credentials() {
    let report = load(
        &[(EXTERNAL_URL, "http://127.0.0.1:3000")],
        &TestFiles::default(),
    )
    .unwrap();

    assert_eq!(
        report.config.server.listen_addr.to_string(),
        "127.0.0.1:8080"
    );
    assert_eq!(
        report.config.server.management_listen_addr.to_string(),
        "127.0.0.1:9090"
    );
    assert_eq!(
        report.config.server.shutdown_drain_timeout,
        Duration::from_secs(30)
    );
    assert_eq!(report.config.server.log_format, LogFormat::Json);
    assert_eq!(report.config.server.log_level, LogLevel::Info);
    assert_eq!(
        report.config.cleanup.worker_policy,
        CleanupWorkerPolicy::default()
    );
    assert_eq!(
        report.config.cleanup.stale_threshold,
        Duration::from_secs(900)
    );
    assert_eq!(report.config.cleanup.failed_threshold, 1);
    assert_eq!(report.config.cleanup.status_timeout, Duration::from_secs(2));
    assert_eq!(
        report.config.public.external_url.as_str(),
        "http://127.0.0.1:3000/"
    );
    assert_eq!(report.config.public.preview_base_domain, None);
    assert!(report.warnings.is_empty());
}

#[test]
fn toml_is_loaded_before_environment_overlay() {
    let toml = br#"
[config]
strict_environment = true

[server]
listen_address = "127.0.0.1:9090"
shutdown_drain_timeout_ms = 45000

[management]
listen_address = "127.0.0.1:9191"

[logging]
format = "text"
level = "warn"

[public]
external_url = "https://file.example.com"
preview_base_domain = "preview.file.example.com"
"#;
    let files = TestFiles(BTreeMap::from([(
        "/config/nuriteo.toml".into(),
        toml.to_vec(),
    )]));
    let report = load(
        &[
            (CONFIG_FILE, "/config/nuriteo.toml"),
            (LOG_LEVEL, "debug"),
            (EXTERNAL_URL, "https://env.example.com"),
        ],
        &files,
    )
    .unwrap();

    assert_eq!(
        report.config.server.listen_addr.to_string(),
        "127.0.0.1:9090"
    );
    assert_eq!(report.config.server.log_format, LogFormat::Text);
    assert_eq!(report.config.server.log_level, LogLevel::Debug);
    assert_eq!(
        report.config.public.external_url.as_str(),
        "https://env.example.com/"
    );
    assert_eq!(
        report.config.public.preview_base_domain.as_deref(),
        Some("preview.file.example.com")
    );
}

#[test]
fn instance_setting_bootstrap_uses_environment_then_file_then_registry_default() {
    let toml = br#"
[public]
external_url = "https://nuriteo.example.com"

[instance_settings]
"security.mfa_grace_period_days" = 14
"tokens.default_expiry_days" = 120
"audit.retention_days" = "unlimited"
"workspace.personal_default_quota_bytes" = "unlimited"
"#;
    let files = TestFiles(BTreeMap::from([(
        "/config/nuriteo.toml".into(),
        toml.to_vec(),
    )]));
    let report = load(
        &[
            (CONFIG_FILE, "/config/nuriteo.toml"),
            ("NURITEO_MFA_GRACE_PERIOD_DAYS", "3"),
        ],
        &files,
    )
    .unwrap();

    assert_eq!(
        report
            .instance_settings
            .resolve(instance_setting_definition("security.mfa_grace_period_days").unwrap())
            .unwrap(),
        (json!(3), BootstrapSettingOrigin::Environment)
    );
    assert_eq!(
        report
            .instance_settings
            .resolve(instance_setting_definition("tokens.default_expiry_days").unwrap())
            .unwrap(),
        (json!(120), BootstrapSettingOrigin::File)
    );
    assert_eq!(
        report
            .instance_settings
            .resolve(instance_setting_definition("runtime.network.default").unwrap())
            .unwrap(),
        (json!("browser_direct"), BootstrapSettingOrigin::Default)
    );
    assert_eq!(
        report
            .instance_settings
            .resolve(instance_setting_definition("audit.retention_days").unwrap())
            .unwrap(),
        (Value::Null, BootstrapSettingOrigin::File)
    );
    assert_eq!(
        report
            .instance_settings
            .resolve(instance_setting_definition("workspace.personal_default_quota_bytes").unwrap())
            .unwrap(),
        (Value::Null, BootstrapSettingOrigin::File)
    );
}

#[test]
fn instance_setting_bootstrap_defers_unknown_and_invalid_values_without_leaking_them() {
    let files = TestFiles(BTreeMap::from([(
        "/config/nuriteo.toml".into(),
        br#"
[public]
external_url = "https://nuriteo.example.com"
[instance_settings]
"security.unknown" = "must-not-appear"
"#
        .to_vec(),
    )]));
    let report = load(&[(CONFIG_FILE, "/config/nuriteo.toml")], &files).unwrap();
    let error = report.instance_settings.validate().unwrap_err();
    assert_eq!(error.to_string(), "unknown Instance setting key");
    assert!(!error.to_string().contains("must-not-appear"));

    let report = load(
        &[
            (EXTERNAL_URL, "https://nuriteo.example.com"),
            ("NURITEO_MFA_ENFORCEMENT", "must-not-appear"),
        ],
        &TestFiles::default(),
    )
    .unwrap();
    let error = report.instance_settings.validate().unwrap_err();
    assert!(!error.to_string().contains("must-not-appear"));
}

#[test]
fn rejects_invalid_configuration_table() {
    struct Case {
        name: &'static str,
        variable: &'static str,
        value: &'static str,
        expected: &'static str,
    }
    let cases = [
        Case {
            name: "listener requires a port",
            variable: LISTEN_ADDR,
            value: "127.0.0.1",
            expected: "configuration NURITEO_HTTP_LISTEN_ADDR must be an IP address and port",
        },
        Case {
            name: "listener rejects port zero",
            variable: LISTEN_ADDR,
            value: "127.0.0.1:0",
            expected: "configuration NURITEO_HTTP_LISTEN_ADDR must use a non-zero port",
        },
        Case {
            name: "drain timeout has a lower bound",
            variable: SHUTDOWN_DRAIN_TIMEOUT_MS,
            value: "999",
            expected: "configuration NURITEO_SHUTDOWN_DRAIN_TIMEOUT_MS must be between 1000 and 300000 milliseconds",
        },
        Case {
            name: "trace logging is unavailable",
            variable: LOG_LEVEL,
            value: "trace",
            expected: "configuration NURITEO_LOG_LEVEL must be one of: error, warn, info, debug",
        },
        Case {
            name: "public non-loopback URL requires TLS",
            variable: EXTERNAL_URL,
            value: "http://nuriteo.example.com",
            expected: "configuration NURITEO_EXTERNAL_URL must use https except for a loopback development URL",
        },
        Case {
            name: "canonical URL excludes a subpath",
            variable: EXTERNAL_URL,
            value: "https://nuriteo.example.com/subpath",
            expected: "configuration NURITEO_EXTERNAL_URL must be an origin without a path, query, or fragment",
        },
        Case {
            name: "preview domain excludes wildcard",
            variable: PREVIEW_BASE_DOMAIN,
            value: "*.preview.example.com",
            expected: "configuration NURITEO_PREVIEW_BASE_DOMAIN must be a lowercase ASCII DNS domain without a wildcard",
        },
        Case {
            name: "preview domain is canonical lowercase",
            variable: PREVIEW_BASE_DOMAIN,
            value: "Preview.Example.com",
            expected: "configuration NURITEO_PREVIEW_BASE_DOMAIN must be a lowercase ASCII DNS domain without a wildcard",
        },
    ];

    for case in cases {
        let mut entries = vec![(EXTERNAL_URL, "https://nuriteo.example.com")];
        if case.variable == EXTERNAL_URL {
            entries.clear();
        }
        entries.push((case.variable, case.value));
        let error = load(&entries, &TestFiles::default()).unwrap_err();
        assert_eq!(error.to_string(), case.expected, "{}", case.name);
    }
}

#[test]
fn cleanup_policy_configuration_fails_closed_before_startup() {
    let error = load(
        &[
            (EXTERNAL_URL, "https://nuriteo.example.com"),
            (CLEANUP_BATCH_SIZE, "100"),
            (CLEANUP_CONCURRENCY, "1"),
            (CLEANUP_LEASE_DURATION_MS, "100"),
        ],
        &TestFiles::default(),
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "configuration NURITEO_CLEANUP_LEASE_DURATION_MS does not safely cover the configured cleanup batch"
    );

    let error = load(
        &[
            (EXTERNAL_URL, "https://nuriteo.example.com"),
            (CLEANUP_FAILED_THRESHOLD, "0"),
        ],
        &TestFiles::default(),
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "configuration NURITEO_CLEANUP_FAILED_THRESHOLD is outside the supported range"
    );
}

#[test]
fn management_listener_is_separate_from_the_public_application_listener() {
    let error = load(
        &[
            (EXTERNAL_URL, "https://nuriteo.example.com"),
            (LISTEN_ADDR, "127.0.0.1:8080"),
            (MANAGEMENT_LISTEN_ADDR, "127.0.0.1:8080"),
        ],
        &TestFiles::default(),
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "configuration NURITEO_MANAGEMENT_LISTEN_ADDR must differ from the application listener"
    );
}

#[test]
fn requires_the_canonical_external_url() {
    let error = load(&[], &TestFiles::default()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "required configuration NURITEO_EXTERNAL_URL is missing"
    );
}

#[test]
fn strict_unknown_environment_handling_is_deterministic() {
    let strict_error = load(
        &[
            (EXTERNAL_URL, "https://nuriteo.example.com"),
            ("NURITEO_Z_TYPO", "secret-looking-value"),
            ("NURITEO_A_TYPO", "another-value"),
        ],
        &TestFiles::default(),
    )
    .unwrap_err();
    assert_eq!(
        strict_error.to_string(),
        "unknown NURITEO configuration variable(s): NURITEO_A_TYPO, NURITEO_Z_TYPO"
    );
    assert!(!strict_error.to_string().contains("secret-looking-value"));

    let report = load(
        &[
            (EXTERNAL_URL, "https://nuriteo.example.com"),
            (STRICT, "false"),
            ("NURITEO_Z_TYPO", "value"),
            ("NURITEO_A_TYPO", "value"),
        ],
        &TestFiles::default(),
    )
    .unwrap();
    assert_eq!(
        report.warnings,
        vec![
            ConfigWarning::UnknownEnvironmentVariable {
                name: "NURITEO_A_TYPO".into()
            },
            ConfigWarning::UnknownEnvironmentVariable {
                name: "NURITEO_Z_TYPO".into()
            },
        ]
    );
}

#[test]
fn rejects_unknown_or_secret_toml_fields_without_echoing_contents() {
    let secret = "must-not-appear";
    let files = TestFiles(BTreeMap::from([(
        "/config/nuriteo.toml".into(),
        format!("[database]\npassword = \"{secret}\"\n").into_bytes(),
    )]));
    let error = load(
        &[
            (CONFIG_FILE, "/config/nuriteo.toml"),
            (EXTERNAL_URL, "https://nuriteo.example.com"),
        ],
        &files,
    )
    .unwrap_err();

    assert_eq!(error, ConfigError::InvalidToml);
    assert!(!error.to_string().contains(secret));
}

#[test]
fn configuration_file_reads_are_bounded_and_path_safe() {
    let oversized = vec![b'x'; 64 * 1024 + 1];
    let files = TestFiles(BTreeMap::from([("/private/config".into(), oversized)]));
    let error = load(
        &[
            (CONFIG_FILE, "/private/config"),
            (EXTERNAL_URL, "https://nuriteo.example.com"),
        ],
        &files,
    )
    .unwrap_err();

    assert!(matches!(error, ConfigError::FileTooLarge { .. }));
    assert!(!error.to_string().contains("/private/config"));
}

#[test]
fn secret_file_contract_is_bounded_redacted_and_removes_one_line_ending() {
    const DIRECT: &str = "NURITEO_TEST_TOKEN";
    const FILE: &str = "NURITEO_TEST_TOKEN_FILE";
    struct Case {
        name: &'static str,
        bytes: &'static [u8],
        expected: &'static str,
    }
    let cases = [
        Case {
            name: "LF",
            bytes: b"token\n",
            expected: "token",
        },
        Case {
            name: "CRLF",
            bytes: b"token\r\n",
            expected: "token",
        },
        Case {
            name: "exactly one ending",
            bytes: b"token\n\n",
            expected: "token\n",
        },
    ];

    for case in cases {
        let files = TestFiles(BTreeMap::from([(
            "/secret/token".into(),
            case.bytes.to_vec(),
        )]));
        let secret = load_secret(
            &environment(&[(FILE, "/secret/token")]),
            &files,
            DIRECT,
            FILE,
        )
        .unwrap()
        .unwrap();
        assert_eq!(secret.expose_secret(), case.expected, "{}", case.name);
        assert_eq!(format!("{secret:?}"), "SecretString([REDACTED])");
    }
}

#[test]
fn secret_sources_fail_closed_table() {
    const DIRECT: &str = "NURITEO_TEST_TOKEN";
    const FILE: &str = "NURITEO_TEST_TOKEN_FILE";
    struct Case {
        name: &'static str,
        entries: &'static [(&'static str, &'static str)],
        bytes: Option<Vec<u8>>,
        expected: &'static str,
    }
    let cases = [
        Case {
            name: "conflict",
            entries: &[(DIRECT, "direct"), (FILE, "/secret/token")],
            bytes: Some(b"file".to_vec()),
            expected: "configuration NURITEO_TEST_TOKEN and NURITEO_TEST_TOKEN_FILE cannot both be set",
        },
        Case {
            name: "empty file",
            entries: &[(FILE, "/secret/token")],
            bytes: Some(Vec::new()),
            expected: "secret file referenced by NURITEO_TEST_TOKEN_FILE must not be empty",
        },
        Case {
            name: "NUL",
            entries: &[(FILE, "/secret/token")],
            bytes: Some(b"bad\0secret".to_vec()),
            expected: "secret file referenced by NURITEO_TEST_TOKEN_FILE contains an invalid value",
        },
        Case {
            name: "non UTF-8",
            entries: &[(FILE, "/secret/token")],
            bytes: Some(vec![0xff]),
            expected: "file referenced by NURITEO_TEST_TOKEN_FILE is not valid UTF-8",
        },
        Case {
            name: "oversized",
            entries: &[(FILE, "/secret/token")],
            bytes: Some(vec![b'x'; 64 * 1024 + 1]),
            expected: "file referenced by NURITEO_TEST_TOKEN_FILE exceeds 65536 bytes",
        },
    ];

    for case in cases {
        let files = TestFiles(case.bytes.map_or_else(BTreeMap::new, |bytes| {
            BTreeMap::from([("/secret/token".into(), bytes)])
        }));
        let error = load_secret(&environment(case.entries), &files, DIRECT, FILE).unwrap_err();
        assert_eq!(error.to_string(), case.expected, "{}", case.name);
        assert!(!error.to_string().contains("/secret/token"));
    }

    let error = load_secret(
        &environment(&[(FILE, "/secret/private-token")]),
        &TestFiles::default(),
        DIRECT,
        FILE,
    )
    .unwrap_err();
    assert!(matches!(error, ConfigError::ReadFile { .. }));
    assert!(!error.to_string().contains("/secret/private-token"));
}

#[test]
fn configuration_registry_is_complete_unique_and_never_defaults_secrets() {
    let mut environment_names = std::collections::BTreeSet::new();
    let mut file_keys = std::collections::BTreeSet::new();

    for field in CONFIG_FIELDS {
        assert!(environment_names.insert(field.environment));
        if let Some(file_key) = field.file_key {
            assert!(file_keys.insert(file_key));
        }
        assert!(field.environment.starts_with("NURITEO_"));
        if field.secret {
            assert_eq!(field.default_value, None);
        }
        assert!(!field.reloadable);
        assert!(!field.validation.is_empty());
        assert!(!field.compose_mapping.is_empty());
        assert!(!field.helm_mapping.is_empty());
    }
}

#[test]
fn strict_registry_accepts_bootstrap_command_inputs_without_loading_secrets() {
    let report = load(
        &[
            (EXTERNAL_URL, "http://127.0.0.1:3000"),
            ("NURITEO_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test"),
            ("NURITEO_BOOTSTRAP_ADMIN_NAME", "Instance Admin"),
            (
                "NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE",
                "/run/secrets/bootstrap-password",
            ),
        ],
        &TestFiles::default(),
    )
    .unwrap();

    assert!(report.warnings.is_empty());
    let password_fields: Vec<_> = CONFIG_FIELDS
        .iter()
        .filter(|field| field.environment.contains("BOOTSTRAP_ADMIN_PASSWORD"))
        .collect();
    assert_eq!(password_fields.len(), 2);
    assert!(password_fields.iter().all(|field| field.secret));
}

#[test]
fn strict_registry_accepts_backup_and_isolated_restore_inputs() {
    let report = load(
        &[
            (EXTERNAL_URL, "http://127.0.0.1:3000"),
            ("NURITEO_PG_DUMP_PATH", "/usr/bin/pg_dump"),
            ("NURITEO_BACKUP_SCRATCH_DIR", "/tmp/nuriteo-backup"),
            ("NURITEO_BACKUP_S3_ENDPOINT", "https://backup.example.test"),
            ("NURITEO_BACKUP_S3_BUCKET", "backups"),
            (
                "NURITEO_BACKUP_S3_SECRET_ACCESS_KEY_FILE",
                "/run/secrets/backup-key",
            ),
            (
                "NURITEO_RESTORE_DATABASE_URL_FILE",
                "/run/secrets/restore-database-url",
            ),
            (
                "NURITEO_RESTORE_S3_ENDPOINT",
                "https://restore.example.test",
            ),
            ("NURITEO_RESTORE_S3_BUCKET", "restore-target"),
            (
                "NURITEO_RESTORE_S3_SECRET_ACCESS_KEY_FILE",
                "/run/secrets/restore-key",
            ),
        ],
        &TestFiles::default(),
    )
    .unwrap();

    assert!(report.warnings.is_empty());
}
