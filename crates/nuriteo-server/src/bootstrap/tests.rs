use std::cell::Cell;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::{Environment, FileReader};

use super::input::{BootstrapAdminInput, BootstrapInputError};

#[derive(Default)]
struct TestEnvironment(Vec<(OsString, OsString)>);

impl Environment for TestEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

#[derive(Default)]
struct TestFiles {
    values: BTreeMap<PathBuf, Vec<u8>>,
    reads: Cell<usize>,
}

impl FileReader for TestFiles {
    fn read(&self, path: &Path, _limit: usize) -> io::Result<Vec<u8>> {
        self.reads.set(self.reads.get() + 1);
        self.values
            .get(path)
            .cloned()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
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
fn accepts_file_first_and_compatibility_direct_sources() {
    let files = TestFiles {
        values: BTreeMap::from([(PathBuf::from("/secret/admin"), b"correct horse\n".to_vec())]),
        reads: Cell::new(0),
    };
    let file_input = BootstrapAdminInput::load(&environment(&[
        ("NURITEO_BOOTSTRAP_ADMIN_EMAIL", "ADMIN@Example.test"),
        ("NURITEO_BOOTSTRAP_ADMIN_NAME", "Instance Admin"),
        ("NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", "/secret/admin"),
    ]))
    .unwrap();
    assert_eq!(files.reads.get(), 0, "loading input must not read a secret");
    assert_eq!(file_input.normalized_email, "admin@example.test");
    assert_eq!(
        file_input.load_password(&files).unwrap().as_bytes(),
        b"correct horse"
    );

    let direct_input = BootstrapAdminInput::load(&environment(&[
        ("NURITEO_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test"),
        ("NURITEO_BOOTSTRAP_ADMIN_NAME", "Instance Admin"),
        ("NURITEO_BOOTSTRAP_ADMIN_PASSWORD", "compatibility-only"),
    ]))
    .unwrap();
    assert_eq!(
        direct_input.load_password(&files).unwrap().as_bytes(),
        b"compatibility-only"
    );
}

#[test]
fn password_sources_and_bootstrap_namespace_fail_closed() {
    let base = [
        ("NURITEO_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test"),
        ("NURITEO_BOOTSTRAP_ADMIN_NAME", "Instance Admin"),
    ];
    let cases = [
        (vec![base[0], base[1]], BootstrapInputError::MissingPassword),
        (
            vec![
                base[0],
                base[1],
                ("NURITEO_BOOTSTRAP_ADMIN_PASSWORD", "direct"),
                ("NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", "/secret/admin"),
            ],
            BootstrapInputError::AmbiguousPasswordSource,
        ),
        (
            vec![
                base[0],
                base[1],
                ("NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", "/secret/admin"),
                ("NURITEO_BOOTSTRAP_ADMIN_EXTRA", "typo"),
            ],
            BootstrapInputError::UnknownField,
        ),
    ];
    for (entries, expected) in cases {
        assert_eq!(
            BootstrapAdminInput::load(&environment(&entries)).unwrap_err(),
            expected
        );
    }
}

#[test]
fn validates_identity_and_bounds_password_material() {
    for (email, name, expected) in [
        (
            " admin@example.test",
            "Admin",
            BootstrapInputError::InvalidEmail,
        ),
        (
            "admin@example.test",
            " ",
            BootstrapInputError::InvalidDisplayName,
        ),
        (
            "admin@example.test",
            "Admin\n",
            BootstrapInputError::InvalidDisplayName,
        ),
    ] {
        let error = BootstrapAdminInput::load(&environment(&[
            ("NURITEO_BOOTSTRAP_ADMIN_EMAIL", email),
            ("NURITEO_BOOTSTRAP_ADMIN_NAME", name),
            ("NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", "/secret/admin"),
        ]))
        .unwrap_err();
        assert_eq!(error, expected);
    }

    let input = BootstrapAdminInput::load(&environment(&[
        ("NURITEO_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test"),
        ("NURITEO_BOOTSTRAP_ADMIN_NAME", "Admin"),
        ("NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", "/secret/admin"),
    ]))
    .unwrap();
    let oversized = TestFiles {
        values: BTreeMap::from([(PathBuf::from("/secret/admin"), vec![b'x'; 1027])]),
        reads: Cell::new(0),
    };
    assert_eq!(
        input.load_password(&oversized).unwrap_err(),
        BootstrapInputError::InvalidPassword
    );
}

#[test]
fn debug_and_errors_never_expose_password_values_or_paths() {
    let input = BootstrapAdminInput::load(&environment(&[
        ("NURITEO_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test"),
        ("NURITEO_BOOTSTRAP_ADMIN_NAME", "Admin"),
        ("NURITEO_BOOTSTRAP_ADMIN_PASSWORD", "never-print-this"),
    ]))
    .unwrap();
    let formatted = format!("{input:?}");
    assert!(!formatted.contains("never-print-this"));

    let error = BootstrapInputError::PasswordFile(io::ErrorKind::PermissionDenied);
    for formatted in [error.to_string(), format!("{error:?}")] {
        assert!(!formatted.contains("/secret/admin"));
        assert!(!formatted.contains("never-print-this"));
    }
}
