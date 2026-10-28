use std::ffi::{OsStr, OsString};

use std::fs::{self, File, OpenOptions};

use std::io::{self, Read, Write};

use std::path::{Path, PathBuf};

use clap::error::ErrorKind;

use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::app::run_server;

use crate::backup::{
    BackupCreateCoordinator, BackupDestination, BackupDestinationRuntime, BackupEngine,
    BackupReadCoordinator, BackupRestoreCoordinator, CommandPgDump, DirectoryBackupRepository,
    PgDumpCommandConfig, PortableLimits, PrunePolicy, RestoreRuntime,
};

use crate::bootstrap::{
    BootstrapAdminInput, BootstrapErrorCategory, BootstrapOutcome, bootstrap_administrator,
};

use crate::config::{Config, SystemEnvironment, SystemFileReader};

use crate::database::{
    DatabasePool, DatabaseRuntimeConfig, SchemaReadiness, check_schema_readiness,
    run_embedded_migrations,
};

use crate::health::run_http_healthcheck;

use crate::integration::MasterKeyring;

use crate::integration::recovery_kit::{
    DEFAULT_FILENAME as RECOVERY_KIT_DEFAULT_FILENAME, RecoveryKitError, RecoveryKitPassphrase,
};

use crate::object_storage::{ObjectStorageConfig, OperationLimits, S3ObjectStore};

use crate::storage_check;

use crate::upgrade_preflight;

use crate::{CommandStatus, VERSION};

const BINARY_NAME: &str = "nuriteo-server";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupCommand {
    Create,
    List,
    Verify {
        backup_id: String,
    },
    Export {
        backup_id: String,
        output: String,
    },
    Import {
        input: String,
    },
    Restore {
        backup_id: String,
        recovery_kit: Option<String>,
        recovery_kit_passphrase_file: Option<String>,
    },
    Drill {
        backup_id: String,
        recovery_kit: Option<String>,
        recovery_kit_passphrase_file: Option<String>,
    },
    Prune,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryKitCommand {
    Export {
        output: String,
        passphrase_file: String,
    },
    Inspect {
        input: String,
        passphrase_file: String,
    },
    Verify {
        input: String,
        passphrase_file: String,
    },
    Restore {
        input: String,
        passphrase_file: String,
        output_dir: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperationalCommand {
    Serve,
    Migrate,
    UpgradePreflight,
    BootstrapAdmin,
    Healthcheck,
    StorageCheck,
    StorageConfigureBrowserUploadCors,
    Backup(BackupCommand),
    RecoveryKit(RecoveryKitCommand),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliAction {
    Version,
    Operational(OperationalCommand),
}

const fn bootstrap_category(category: BootstrapErrorCategory) -> &'static str {
    match category {
        BootstrapErrorCategory::Input => "input",
        BootstrapErrorCategory::SchemaNotReady => "schema-not-ready",
        BootstrapErrorCategory::DatabaseOperation => "database-operation",
        BootstrapErrorCategory::PasswordHashing => "password-hashing",
        BootstrapErrorCategory::Audit => "audit",
    }
}

pub(crate) enum MigrationCommandError {
    Readiness(SchemaReadiness),
    ReadinessQuery,
    Migration,
}

const fn backup_error_category(error: crate::backup::BackupEngineError) -> &'static str {
    use crate::backup::BackupEngineError;
    match error {
        BackupEngineError::NotFound => "not-found",
        BackupEngineError::NotComplete => "not-complete",
        BackupEngineError::AlreadyExists => "already-exists",
        BackupEngineError::Portable(_) => "invalid-portable-backup",
        BackupEngineError::TargetNotEmpty => "target-not-empty",
        BackupEngineError::RestoreInterrupted => "restore-interrupted",
        BackupEngineError::RestoreValidation => "restore-validation",
        BackupEngineError::RetentionProtected => "retention-protected",
        BackupEngineError::InvalidPolicy => "invalid-policy",
        BackupEngineError::InvalidRepository | BackupEngineError::Io => "repository",
    }
}

#[derive(Debug)]
pub(crate) enum RecoveryKitCliError {
    Input,
    Output,
    KeyConfiguration,
    Kit(RecoveryKitError),
}

const fn is_successful_display(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::DisplayHelp | ErrorKind::DisplayVersion)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_operational_command() {
        let cases = [
            ("serve", OperationalCommand::Serve),
            ("migrate", OperationalCommand::Migrate),
            ("upgrade-preflight", OperationalCommand::UpgradePreflight),
            ("bootstrap-admin", OperationalCommand::BootstrapAdmin),
            ("healthcheck", OperationalCommand::Healthcheck),
            ("storage-check", OperationalCommand::StorageCheck),
            (
                "storage-configure-browser-upload-cors",
                OperationalCommand::StorageConfigureBrowserUploadCors,
            ),
        ];

        for (argument, expected) in cases {
            assert_eq!(parse([argument]).unwrap(), CliAction::Operational(expected));
        }
    }

    #[test]
    fn maps_display_and_usage_results_to_stable_statuses() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let status = run(["--version"], &mut stdout, &mut stderr).unwrap();
        assert_eq!(status, CommandStatus::Success);
        assert_eq!(stdout, b"nuriteo-server 0.1.0\n");
        assert!(stderr.is_empty());

        stdout.clear();
        let status = run(["unknown"], &mut stdout, &mut stderr).unwrap();
        assert_eq!(status, CommandStatus::UsageError);
        assert!(stdout.is_empty());
        assert!(!stderr.is_empty());
    }

    #[test]
    fn parses_the_complete_backup_command_surface() {
        let cases = [
            (vec!["backup", "create"], BackupCommand::Create),
            (vec!["backup", "list"], BackupCommand::List),
            (
                vec!["backup", "verify", "backup-1"],
                BackupCommand::Verify {
                    backup_id: "backup-1".into(),
                },
            ),
            (
                vec![
                    "backup",
                    "export",
                    "backup-1",
                    "--format",
                    "portable-v1",
                    "--output",
                    "-",
                ],
                BackupCommand::Export {
                    backup_id: "backup-1".into(),
                    output: "-".into(),
                },
            ),
            (
                vec![
                    "backup",
                    "import",
                    "--format",
                    "portable-v1",
                    "--input",
                    "-",
                ],
                BackupCommand::Import { input: "-".into() },
            ),
            (
                vec!["backup", "restore", "backup-1"],
                BackupCommand::Restore {
                    backup_id: "backup-1".into(),
                    recovery_kit: None,
                    recovery_kit_passphrase_file: None,
                },
            ),
            (
                vec!["backup", "drill", "backup-1"],
                BackupCommand::Drill {
                    backup_id: "backup-1".into(),
                    recovery_kit: None,
                    recovery_kit_passphrase_file: None,
                },
            ),
            (vec!["backup", "prune"], BackupCommand::Prune),
        ];
        for (arguments, expected) in cases {
            assert_eq!(
                parse(arguments).unwrap(),
                CliAction::Operational(OperationalCommand::Backup(expected))
            );
        }
        assert!(
            parse([
                "backup",
                "export",
                "id",
                "--format",
                "portable-v2",
                "--output",
                "-"
            ])
            .is_err()
        );
        assert!(parse(["backup", "restore", "id", "--recovery-kit", "kit.age"]).is_err());
        assert_eq!(
            parse([
                "backup",
                "restore",
                "id",
                "--recovery-kit",
                "kit.age",
                "--recovery-kit-passphrase-file",
                "passphrase"
            ])
            .unwrap(),
            CliAction::Operational(OperationalCommand::Backup(BackupCommand::Restore {
                backup_id: "id".into(),
                recovery_kit: Some("kit.age".into()),
                recovery_kit_passphrase_file: Some("passphrase".into()),
            }))
        );
    }

    #[test]
    fn parses_the_complete_recovery_kit_command_surface() {
        let cases = [
            (
                vec!["recovery-kit", "export", "--passphrase-file", "passphrase"],
                RecoveryKitCommand::Export {
                    output: RECOVERY_KIT_DEFAULT_FILENAME.into(),
                    passphrase_file: "passphrase".into(),
                },
            ),
            (
                vec![
                    "recovery-kit",
                    "inspect",
                    "--input",
                    "kit.age",
                    "--passphrase-file",
                    "passphrase",
                ],
                RecoveryKitCommand::Inspect {
                    input: "kit.age".into(),
                    passphrase_file: "passphrase".into(),
                },
            ),
            (
                vec![
                    "recovery-kit",
                    "verify",
                    "--input",
                    "kit.age",
                    "--passphrase-file",
                    "passphrase",
                ],
                RecoveryKitCommand::Verify {
                    input: "kit.age".into(),
                    passphrase_file: "passphrase".into(),
                },
            ),
            (
                vec![
                    "recovery-kit",
                    "restore",
                    "--input",
                    "kit.age",
                    "--passphrase-file",
                    "passphrase",
                    "--output-dir",
                    "restored",
                ],
                RecoveryKitCommand::Restore {
                    input: "kit.age".into(),
                    passphrase_file: "passphrase".into(),
                    output_dir: "restored".into(),
                },
            ),
        ];
        for (arguments, expected) in cases {
            assert_eq!(
                parse(arguments).unwrap(),
                CliAction::Operational(OperationalCommand::RecoveryKit(expected))
            );
        }
    }

    #[test]
    fn operational_commands_fail_closed_until_their_handlers_exist() {
        for argument in [
            "serve",
            "migrate",
            "upgrade-preflight",
            "bootstrap-admin",
            "healthcheck",
            "storage-check",
            "storage-configure-browser-upload-cors",
        ] {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let status = run([argument], &mut stdout, &mut stderr).unwrap();

            assert_eq!(status, CommandStatus::Failure);
            assert_eq!(status.exit_code(), 1);
            assert!(stdout.is_empty());
            assert_eq!(
                String::from_utf8(stderr).unwrap(),
                format!("nuriteo-server: `{argument}` is not available in this build\n")
            );
        }
    }
}

mod instance_commands;
pub use instance_commands::*;
mod backup;
pub(crate) use backup::*;
