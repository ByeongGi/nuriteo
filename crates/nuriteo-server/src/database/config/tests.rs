use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;

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

#[test]
fn loads_direct_and_file_database_urls_without_exposing_credentials() {
    let direct = DatabaseRuntimeConfig::load(
        &environment(&[(
            DATABASE_URL,
            "postgres://nuriteo:direct-secret@localhost/nuriteo",
        )]),
        &TestFiles::default(),
    )
    .unwrap_or_else(|error| panic!("direct URL must load: {error}"));
    let direct_debug = format!("{direct:?}");
    assert!(!direct_debug.contains("direct-secret"));
    assert!(!direct_debug.contains("postgres://"));

    let files = TestFiles(BTreeMap::from([(
        "/run/secrets/database-url".into(),
        b"postgres://nuriteo:file-secret@localhost/nuriteo\n".to_vec(),
    )]));
    let from_file = DatabaseRuntimeConfig::load(
        &environment(&[(DATABASE_URL_FILE, "/run/secrets/database-url")]),
        &files,
    )
    .unwrap_or_else(|error| panic!("URL file must load: {error}"));
    let file_debug = format!("{from_file:?}");
    assert!(!file_debug.contains("file-secret"));
    assert!(!file_debug.contains("/run/secrets"));
}

#[test]
fn rejects_conflicting_sources_unsafe_tls_and_invalid_bounds() {
    let conflict = DatabaseRuntimeConfig::load(
        &environment(&[
            (DATABASE_URL, "postgres://user:secret@localhost/database"),
            (DATABASE_URL_FILE, "/secret/url"),
        ]),
        &TestFiles::default(),
    )
    .expect_err("direct and file URL must conflict");
    assert!(!format!("{conflict:?}").contains("secret@"));

    let unsafe_tls = DatabaseRuntimeConfig::load(
        &environment(&[
            (DATABASE_URL, "postgres://user:secret@localhost/database"),
            (TLS_MODE, "disable"),
        ]),
        &TestFiles::default(),
    )
    .expect_err("unsafe TLS mode must fail");
    assert!(matches!(
        unsafe_tls,
        DatabaseRuntimeConfigError::InvalidTlsMode
    ));

    let invalid_bounds = DatabaseRuntimeConfig::load(
        &environment(&[
            (DATABASE_URL, "postgres://user:secret@localhost/database"),
            (MIN_CONNECTIONS, "3"),
            (MAX_CONNECTIONS, "2"),
        ]),
        &TestFiles::default(),
    )
    .expect_err("invalid pool bounds must fail");
    assert!(matches!(
        invalid_bounds,
        DatabaseRuntimeConfigError::Database(DatabaseConfigError::InvalidConnectionBounds)
    ));
}

#[test]
fn tls_files_are_bounded_and_client_identity_is_atomic() {
    let incomplete = DatabaseRuntimeConfig::load(
        &environment(&[
            (DATABASE_URL, "postgres://user:secret@localhost/database"),
            (CLIENT_CERT_FILE, "/secret/client.crt"),
        ]),
        &TestFiles::default(),
    )
    .expect_err("partial client identity must fail before reading files");
    assert!(matches!(
        incomplete,
        DatabaseRuntimeConfigError::IncompleteClientIdentity
    ));

    let files = TestFiles(BTreeMap::from([(
        "/private/database-ca".into(),
        vec![b'x'; MAX_TLS_FILE_BYTES + 1],
    )]));
    let oversized = DatabaseRuntimeConfig::load(
        &environment(&[
            (DATABASE_URL, "postgres://user:secret@localhost/database"),
            (DATABASE_CA_FILE, "/private/database-ca"),
        ]),
        &files,
    )
    .expect_err("oversized CA file must fail");
    assert!(matches!(
        oversized,
        DatabaseRuntimeConfigError::Source(ConfigSourceError::FileTooLarge { .. })
    ));
    assert!(!oversized.to_string().contains("/private/database-ca"));
}
