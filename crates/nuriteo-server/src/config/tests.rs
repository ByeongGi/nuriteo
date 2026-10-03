use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::Path;

use super::*;

const DATABASE_SECRET: &str = "postgresql://nuriteo:database-password@db/nuriteo";
const ACCESS_KEY: &str = "storage-access-key";
const STORAGE_SECRET: &str = "storage-secret-value";
const MASTER_KEY: &str = "master-key-material-that-is-at-least-32-bytes";
const SESSION_KEY: &str = "session-key-material-that-is-at-least-32-bytes";

#[derive(Default)]
struct TestEnvironment(Vec<(OsString, OsString)>);

impl Environment for TestEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

#[derive(Default)]
struct TestFiles(BTreeMap<String, String>);

impl FileReader for TestFiles {
    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        self.0
            .get(path.to_string_lossy().as_ref())
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "test file not found"))
    }
}

fn valid_sources() -> (TestEnvironment, TestFiles) {
    let environment = TestEnvironment(
        [
            ("NURITEO_EXTERNAL_URL", "https://nuriteo.example.com"),
            ("NURITEO_PREVIEW_BASE_DOMAIN", "preview.nuriteo.example.com"),
            ("NURITEO_DATABASE_URL_FILE", "/secrets/database-url"),
            ("NURITEO_S3_ENDPOINT", "http://rustfs:9000"),
            ("NURITEO_S3_REGION", "us-east-1"),
            ("NURITEO_S3_BUCKET", "nuriteo-projects"),
            ("NURITEO_S3_PATH_STYLE", "true"),
            ("NURITEO_S3_ACCESS_KEY_ID_FILE", "/secrets/s3-access-key"),
            (
                "NURITEO_S3_SECRET_ACCESS_KEY_FILE",
                "/secrets/s3-secret-key",
            ),
            ("NURITEO_MASTER_KEY_FILE", "/secrets/master-key"),
            ("NURITEO_SESSION_KEY_FILE", "/secrets/session-key"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect(),
    );
    let files = TestFiles(BTreeMap::from([
        (
            "/secrets/database-url".into(),
            format!("{DATABASE_SECRET}\n"),
        ),
        ("/secrets/s3-access-key".into(), format!("{ACCESS_KEY}\n")),
        (
            "/secrets/s3-secret-key".into(),
            format!("{STORAGE_SECRET}\n"),
        ),
        ("/secrets/master-key".into(), format!("{MASTER_KEY}\n")),
        ("/secrets/session-key".into(), format!("{SESSION_KEY}\n")),
    ]));
    (environment, files)
}

#[test]
fn loads_typed_configuration_from_injected_sources() {
    let (environment, files) = valid_sources();

    let config = Config::load(&environment, &files).unwrap();

    assert_eq!(config.server.listen_addr.to_string(), "0.0.0.0:8080");
    assert_eq!(config.server.log_format, LogFormat::Json);
    assert_eq!(config.server.log_level, LogLevel::Info);
    assert_eq!(
        config.public.external_url.as_str(),
        "https://nuriteo.example.com/"
    );
    assert_eq!(
        config.public.preview_base_domain,
        "preview.nuriteo.example.com"
    );
    assert_eq!(config.database.url.expose_secret(), DATABASE_SECRET);
    assert!(config.object_storage.path_style);
    assert_eq!(
        config.object_storage.access_key_id.expose_secret(),
        ACCESS_KEY
    );
    assert_eq!(config.crypto.master_key.expose_secret(), MASTER_KEY);
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
            name: "listener has no port",
            variable: "NURITEO_LISTEN_ADDR",
            value: "127.0.0.1",
            expected: "NURITEO_LISTEN_ADDR must be an IP address and port",
        },
        Case {
            name: "trace logging is unavailable",
            variable: "NURITEO_LOG_LEVEL",
            value: "trace",
            expected: "NURITEO_LOG_LEVEL must be one of: error, warn, info, debug",
        },
        Case {
            name: "public non-loopback URL requires TLS",
            variable: "NURITEO_EXTERNAL_URL",
            value: "http://nuriteo.example.com",
            expected: "NURITEO_EXTERNAL_URL must use https except for a loopback development URL",
        },
        Case {
            name: "preview domain excludes wildcard",
            variable: "NURITEO_PREVIEW_BASE_DOMAIN",
            value: "*.preview.example.com",
            expected: "NURITEO_PREVIEW_BASE_DOMAIN must be a valid DNS domain without a wildcard",
        },
        Case {
            name: "bucket excludes uppercase",
            variable: "NURITEO_S3_BUCKET",
            value: "Nuriteo-Projects",
            expected: "NURITEO_S3_BUCKET must be a valid S3 bucket name",
        },
        Case {
            name: "boolean is explicit",
            variable: "NURITEO_S3_PATH_STYLE",
            value: "yes",
            expected: "NURITEO_S3_PATH_STYLE must be true or false",
        },
    ];

    for case in cases {
        let (mut environment, files) = valid_sources();
        environment
            .0
            .retain(|(name, _)| name != &OsString::from(case.variable));
        environment
            .0
            .push((case.variable.into(), case.value.into()));

        let error = Config::load(&environment, &files).unwrap_err();

        assert_eq!(
            error.to_string(),
            format!("configuration {}", case.expected),
            "{}",
            case.name
        );
    }
}

#[test]
fn rejects_missing_conflicting_and_unknown_inputs_table() {
    enum Mutation {
        Remove(&'static str),
        Add(&'static str, &'static str),
    }
    struct Case {
        name: &'static str,
        mutations: &'static [Mutation],
        expected: &'static str,
    }

    let cases = [
        Case {
            name: "required value",
            mutations: &[Mutation::Remove("NURITEO_S3_BUCKET")],
            expected: "required configuration NURITEO_S3_BUCKET is missing",
        },
        Case {
            name: "direct and file conflict",
            mutations: &[Mutation::Add("NURITEO_DATABASE_URL", DATABASE_SECRET)],
            expected: "configuration NURITEO_DATABASE_URL and NURITEO_DATABASE_URL_FILE cannot both be set",
        },
        Case {
            name: "unknown strict key",
            mutations: &[Mutation::Add("NURITEO_S3_BUKET", "typo")],
            expected: "unknown NURITEO configuration variable(s): NURITEO_S3_BUKET",
        },
    ];

    for case in cases {
        let (mut environment, files) = valid_sources();
        for mutation in case.mutations {
            match mutation {
                Mutation::Remove(name) => environment
                    .0
                    .retain(|(key, _)| key != &OsString::from(name)),
                Mutation::Add(name, value) => environment.0.push((name.into(), value.into())),
            }
        }

        assert_eq!(
            Config::load(&environment, &files).unwrap_err().to_string(),
            case.expected,
            "{}",
            case.name
        );
    }
}

#[test]
fn non_strict_mode_ignores_unknown_nuriteo_variables() {
    let (mut environment, files) = valid_sources();
    environment.0.extend([
        ("NURITEO_CONFIG_STRICT".into(), "false".into()),
        ("NURITEO_FUTURE_SETTING".into(), "value".into()),
    ]);

    assert!(Config::load(&environment, &files).is_ok());
}

#[test]
fn secret_values_are_redacted_from_debug_display_and_errors() {
    let (environment, files) = valid_sources();
    let config = Config::load(&environment, &files).unwrap();
    let debug = format!("{config:?}");

    for secret in [
        DATABASE_SECRET,
        ACCESS_KEY,
        STORAGE_SECRET,
        MASTER_KEY,
        SESSION_KEY,
    ] {
        assert!(!debug.contains(secret));
    }
    assert_eq!(
        format!("{:?}", config.database.url),
        "SecretString([REDACTED])"
    );
    assert_eq!(config.database.url.to_string(), "[REDACTED]");

    let (mut environment, files) = valid_sources();
    environment
        .0
        .retain(|(name, _)| name != "NURITEO_DATABASE_URL_FILE");
    let malformed_secret = "postgresql://admin:do-not-leak@";
    environment
        .0
        .push(("NURITEO_DATABASE_URL".into(), malformed_secret.into()));
    let error = Config::load(&environment, &files).unwrap_err();

    assert!(!format!("{error:?}").contains(malformed_secret));
    assert!(!error.to_string().contains(malformed_secret));
}

#[test]
fn secret_file_errors_do_not_reveal_the_path_or_contents() {
    let (environment, mut files) = valid_sources();
    files.0.remove("/secrets/session-key");

    let error = Config::load(&environment, &files).unwrap_err();
    let message = error.to_string();

    assert!(message.contains("NURITEO_SESSION_KEY_FILE"));
    assert!(!message.contains("/secrets/session-key"));
}

#[test]
fn rejects_key_range_and_reuse_combinations() {
    struct Case {
        name: &'static str,
        session_key: &'static str,
        expected: &'static str,
    }
    let cases = [
        Case {
            name: "short session key",
            session_key: "too-short",
            expected: "configuration NURITEO_SESSION_KEY_FILE must contain at least 32 bytes",
        },
        Case {
            name: "key reuse",
            session_key: MASTER_KEY,
            expected: "configuration NURITEO_SESSION_KEY_FILE must not reuse the master key",
        },
    ];

    for case in cases {
        let (environment, mut files) = valid_sources();
        files
            .0
            .insert("/secrets/session-key".into(), case.session_key.into());

        assert_eq!(
            Config::load(&environment, &files).unwrap_err().to_string(),
            case.expected,
            "{}",
            case.name
        );
    }
}

#[test]
fn configuration_registry_is_unique_and_never_defaults_secrets() {
    let mut names = std::collections::BTreeSet::new();

    for field in CONFIG_FIELDS {
        assert!(names.insert(field.name), "duplicate field {}", field.name);
        assert!(field.name.starts_with("NURITEO_"));
        assert!(!field.reloadable);
        if field.secret {
            assert_eq!(
                field.default_value, None,
                "secret {} has a default",
                field.name
            );
        }
    }
}
