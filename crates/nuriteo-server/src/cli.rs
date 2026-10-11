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

impl OperationalCommand {
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Serve => "serve",
            Self::Migrate => "migrate",
            Self::UpgradePreflight => "upgrade-preflight",
            Self::BootstrapAdmin => "bootstrap-admin",
            Self::Healthcheck => "healthcheck",
            Self::StorageCheck => "storage-check",
            Self::StorageConfigureBrowserUploadCors => "storage-configure-browser-upload-cors",
            Self::Backup(_) => "backup",
            Self::RecoveryKit(_) => "recovery-kit",
        }
    }
}

#[must_use]
pub fn root_command() -> Command {
    Command::new(BINARY_NAME)
        .about("NURITEO self-hosted core API server")
        .subcommand_required(true)
        .arg(
            Arg::new("version")
                .short('V')
                .long("version")
                .help("Print version")
                .action(ArgAction::SetTrue)
                .exclusive(true),
        )
        .subcommand(
            Command::new("serve")
                .about("Run the API server")
                .disable_version_flag(true),
        )
        .subcommand(
            Command::new("migrate")
                .about("Apply forward-only database migrations")
                .disable_version_flag(true),
        )
        .subcommand(
            Command::new("upgrade-preflight")
                .about("Validate a supported upgrade without changing the database")
                .disable_version_flag(true),
        )
        .subcommand(
            Command::new("bootstrap-admin")
                .about("Create the first instance administrator when none exists")
                .disable_version_flag(true),
        )
        .subcommand(
            Command::new("healthcheck")
                .about("Check deployment readiness")
                .disable_version_flag(true),
        )
        .subcommand(
            Command::new("storage-check")
                .about("Check configured object storage capabilities")
                .disable_version_flag(true),
        )
        .subcommand(
            Command::new("storage-configure-browser-upload-cors")
                .about("Explicitly replace bucket CORS with the NURITEO browser upload policy")
                .disable_version_flag(true),
        )
        .subcommand(backup_command())
        .subcommand(recovery_kit_command())
}

fn backup_command() -> Command {
    let backup_id = || Arg::new("backup-id").required(true).value_name("BACKUP_ID");
    Command::new("backup")
        .about("Create, verify, transfer, restore, and prune backups")
        .disable_version_flag(true)
        .subcommand_required(true)
        .subcommand(Command::new("create").about("Create and verify an online backup"))
        .subcommand(Command::new("list").about("List complete restore points"))
        .subcommand(
            Command::new("verify")
                .about("Verify a complete restore point")
                .arg(backup_id()),
        )
        .subcommand(
            Command::new("export")
                .about("Write a canonical portable backup stream")
                .arg(backup_id())
                .arg(
                    Arg::new("format")
                        .long("format")
                        .required(true)
                        .value_parser(["portable-v1"]),
                )
                .arg(Arg::new("output").long("output").required(true)),
        )
        .subcommand(
            Command::new("import")
                .about("Stage and verify a portable backup stream")
                .arg(
                    Arg::new("format")
                        .long("format")
                        .required(true)
                        .value_parser(["portable-v1"]),
                )
                .arg(Arg::new("input").long("input").required(true)),
        )
        .subcommand(
            Command::new("restore")
                .about("Restore into an empty staged target")
                .arg(backup_id())
                .arg(
                    Arg::new("recovery-kit")
                        .long("recovery-kit")
                        .requires("recovery-kit-passphrase-file"),
                )
                .arg(
                    Arg::new("recovery-kit-passphrase-file")
                        .long("recovery-kit-passphrase-file")
                        .requires("recovery-kit"),
                ),
        )
        .subcommand(
            Command::new("drill")
                .about("Restore and validate a backup in an empty isolated target")
                .arg(backup_id())
                .arg(
                    Arg::new("recovery-kit")
                        .long("recovery-kit")
                        .requires("recovery-kit-passphrase-file"),
                )
                .arg(
                    Arg::new("recovery-kit-passphrase-file")
                        .long("recovery-kit-passphrase-file")
                        .requires("recovery-kit"),
                ),
        )
        .subcommand(Command::new("prune").about("Prune unretained restore points"))
}

fn recovery_kit_command() -> Command {
    let input = || Arg::new("input").long("input").required(true);
    let passphrase_file = || {
        Arg::new("passphrase-file")
            .long("passphrase-file")
            .required(true)
            .help("Read the exact UTF-8 passphrase bytes from this file")
    };
    Command::new("recovery-kit")
        .about("Export, inspect, verify, and restore an encrypted Secret Recovery Kit")
        .disable_version_flag(true)
        .subcommand_required(true)
        .subcommand(
            Command::new("export")
                .about("Create a new passphrase-encrypted Recovery Kit")
                .arg(
                    Arg::new("output")
                        .long("output")
                        .default_value(RECOVERY_KIT_DEFAULT_FILENAME),
                )
                .arg(passphrase_file()),
        )
        .subcommand(
            Command::new("inspect")
                .about("Decrypt and print non-secret Recovery Kit metadata")
                .arg(input())
                .arg(passphrase_file()),
        )
        .subcommand(
            Command::new("verify")
                .about("Verify a Recovery Kit against this instance master-key ring")
                .arg(input())
                .arg(passphrase_file()),
        )
        .subcommand(
            Command::new("restore")
                .about("Write the verified master-key ring into a new private directory")
                .arg(input())
                .arg(passphrase_file())
                .arg(Arg::new("output-dir").long("output-dir").required(true)),
        )
}

pub fn parse<I, S>(args: I) -> Result<CliAction, clap::Error>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<OsString> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect();
    let is_version = |argument: &OsString| argument == "--version" || argument == "-V";
    if args.len() == 1 && is_version(&args[0]) {
        return Ok(CliAction::Version);
    }
    if args.iter().any(is_version) {
        return Err(root_command().error(
            ErrorKind::ArgumentConflict,
            "the version flag cannot be combined with another argument",
        ));
    }

    let matches = root_command()
        .try_get_matches_from(std::iter::once(OsString::from(BINARY_NAME)).chain(args))?;
    command_from_matches(&matches)
}

pub fn run<I, S, O, E>(args: I, stdout: &mut O, stderr: &mut E) -> io::Result<CommandStatus>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
    O: Write,
    E: Write,
{
    match parse(args) {
        Ok(CliAction::Version) => {
            writeln!(stdout, "{BINARY_NAME} {VERSION}")?;
            Ok(CommandStatus::Success)
        }
        Ok(CliAction::Operational(command)) => unavailable(&command, stderr),
        Err(error) if is_successful_display(error.kind()) => {
            write!(stdout, "{error}")?;
            Ok(CommandStatus::Success)
        }
        Err(error) => {
            write!(stderr, "{error}")?;
            Ok(CommandStatus::UsageError)
        }
    }
}

/// Parses synchronously, then dispatches operational work across an explicit
/// async boundary. Help, version and usage rendering remain deterministic and
/// do not initialize a Tokio runtime or any external dependency.
pub async fn run_async<I, S, O, E>(
    args: I,
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
    O: Write,
    E: Write,
{
    match parse(args) {
        Ok(CliAction::Version) => {
            writeln!(stdout, "{BINARY_NAME} {VERSION}")?;
            Ok(CommandStatus::Success)
        }
        Ok(CliAction::Operational(OperationalCommand::Serve)) => serve(stderr).await,
        Ok(CliAction::Operational(OperationalCommand::Migrate)) => migrate(stdout, stderr).await,
        Ok(CliAction::Operational(OperationalCommand::UpgradePreflight)) => {
            upgrade_preflight(stdout, stderr).await
        }
        Ok(CliAction::Operational(OperationalCommand::BootstrapAdmin)) => {
            bootstrap_admin(stdout, stderr).await
        }
        Ok(CliAction::Operational(OperationalCommand::Healthcheck)) => {
            healthcheck(stdout, stderr).await
        }
        Ok(CliAction::Operational(OperationalCommand::StorageCheck)) => {
            storage_check(stdout, stderr).await
        }
        Ok(CliAction::Operational(OperationalCommand::StorageConfigureBrowserUploadCors)) => {
            storage_configure_browser_upload_cors(stdout, stderr).await
        }
        Ok(CliAction::Operational(OperationalCommand::Backup(command))) => {
            run_backup_command(command, stdout, stderr).await
        }
        Ok(CliAction::Operational(OperationalCommand::RecoveryKit(command))) => {
            run_recovery_kit_command(command, stdout, stderr)
        }
        Err(error) if is_successful_display(error.kind()) => {
            write!(stdout, "{error}")?;
            Ok(CommandStatus::Success)
        }
        Err(error) => {
            write!(stderr, "{error}")?;
            Ok(CommandStatus::UsageError)
        }
    }
}

async fn storage_configure_browser_upload_cors<O: Write, E: Write>(
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    match storage_check::configure_browser_upload_cors(&SystemEnvironment, &SystemFileReader).await
    {
        Ok(()) => {
            writeln!(stdout, "browser upload CORS configured and verified")?;
            Ok(CommandStatus::Success)
        }
        Err(error) => {
            writeln!(
                stderr,
                "{BINARY_NAME}: storage-configure-browser-upload-cors failed ({})",
                error.category()
            )?;
            Ok(CommandStatus::Failure)
        }
    }
}

async fn bootstrap_admin<O: Write, E: Write>(
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    let environment = SystemEnvironment;
    let files = SystemFileReader;
    if Config::load(&environment, &files).is_err() {
        return bootstrap_failure(stderr, "configuration");
    }
    let input = match BootstrapAdminInput::load(&environment) {
        Ok(input) => input,
        Err(_) => return bootstrap_failure(stderr, "input"),
    };
    let config = match DatabaseRuntimeConfig::load(&environment, &files) {
        Ok(config) => config,
        Err(_) => return bootstrap_failure(stderr, "database-configuration"),
    };
    let pool = match DatabasePool::connect(config.pool_config()).await {
        Ok(pool) => pool,
        Err(_) => return bootstrap_failure(stderr, "database-connectivity"),
    };

    let result = bootstrap_administrator(&pool, input, &files).await;
    let close_result = pool.close(config.close_timeout()).await;
    match (result, close_result) {
        (Ok(BootstrapOutcome::Created), Ok(())) => {
            writeln!(stdout, "bootstrap-admin created")?;
            Ok(CommandStatus::Success)
        }
        (Ok(BootstrapOutcome::AlreadyInitialized), Ok(())) => {
            writeln!(stdout, "bootstrap-admin already-initialized")?;
            Ok(CommandStatus::Success)
        }
        (Err(error), _) => bootstrap_failure(stderr, bootstrap_category(error.category())),
        (Ok(_), Err(_)) => bootstrap_failure(stderr, "database-operation"),
    }
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

fn bootstrap_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {
    writeln!(stderr, "{BINARY_NAME}: bootstrap-admin failed ({category})")?;
    Ok(CommandStatus::Failure)
}

async fn serve<E: Write>(stderr: &mut E) -> io::Result<CommandStatus> {
    match run_server(&SystemEnvironment, &SystemFileReader).await {
        Ok(()) => Ok(CommandStatus::Success),
        Err(error) => {
            writeln!(stderr, "{BINARY_NAME}: serve failed ({})", error.category())?;
            Ok(CommandStatus::Failure)
        }
    }
}

async fn healthcheck<O: Write, E: Write>(
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    if run_http_healthcheck(&SystemEnvironment).await {
        writeln!(stdout, "healthcheck ready")?;
        Ok(CommandStatus::Success)
    } else {
        writeln!(stderr, "{BINARY_NAME}: healthcheck unavailable")?;
        Ok(CommandStatus::Failure)
    }
}

async fn storage_check<O: Write, E: Write>(
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    match storage_check::execute(&SystemEnvironment, &SystemFileReader).await {
        Ok(report) => {
            serde_json::to_writer(&mut *stdout, &report).map_err(io::Error::other)?;
            writeln!(stdout)?;
            if report.is_compatible() {
                Ok(CommandStatus::Success)
            } else {
                storage_check_failure(stderr, "incompatible")
            }
        }
        Err(error) => storage_check_failure(stderr, error.category()),
    }
}

fn storage_check_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {
    writeln!(stderr, "{BINARY_NAME}: storage-check failed ({category})")?;
    Ok(CommandStatus::Failure)
}

async fn migrate<O: Write, E: Write>(stdout: &mut O, stderr: &mut E) -> io::Result<CommandStatus> {
    let environment = SystemEnvironment;
    let files = SystemFileReader;
    if Config::load(&environment, &files).is_err() {
        return migration_failure(stderr, "configuration");
    }
    let config = match DatabaseRuntimeConfig::load(&environment, &files) {
        Ok(config) => config,
        Err(_) => return migration_failure(stderr, "database-configuration"),
    };
    let pool = match DatabasePool::connect(config.pool_config()).await {
        Ok(pool) => pool,
        Err(_) => return migration_failure(stderr, "database-connectivity"),
    };

    let result = execute_migration(&pool, &config).await;
    let close_result = pool.close(config.close_timeout()).await;
    match (result, close_result) {
        (Ok(readiness), Ok(())) => {
            writeln!(
                stdout,
                "database migration complete: {}",
                readiness.summary()
            )?;
            Ok(CommandStatus::Success)
        }
        (Err(MigrationCommandError::Readiness(readiness)), _) => {
            writeln!(
                stderr,
                "{BINARY_NAME}: migrate refused: {}",
                readiness.summary()
            )?;
            Ok(CommandStatus::Failure)
        }
        (Err(MigrationCommandError::ReadinessQuery), _)
        | (Err(MigrationCommandError::Migration), _)
        | (Ok(_), Err(_)) => migration_failure(stderr, "database-operation"),
    }
}

async fn upgrade_preflight<O: Write, E: Write>(
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    let environment = SystemEnvironment;
    let files = SystemFileReader;
    if Config::load(&environment, &files).is_err() {
        return upgrade_preflight_failure(stderr, "configuration");
    }
    let config = match DatabaseRuntimeConfig::load(&environment, &files) {
        Ok(config) => config,
        Err(_) => return upgrade_preflight_failure(stderr, "database-configuration"),
    };
    let pool = match DatabasePool::connect(config.pool_config()).await {
        Ok(pool) => pool,
        Err(_) => return upgrade_preflight_failure(stderr, "database-connectivity"),
    };

    let result = upgrade_preflight::execute(&pool).await;
    let close_result = pool.close(config.close_timeout()).await;
    match (result, close_result) {
        (Ok(report), Ok(())) => {
            serde_json::to_writer(&mut *stdout, &report).map_err(io::Error::other)?;
            writeln!(stdout)?;
            Ok(CommandStatus::Success)
        }
        (Err(error), _) => upgrade_preflight_failure(stderr, error.category()),
        (Ok(_), Err(_)) => upgrade_preflight_failure(stderr, "database-operation"),
    }
}

fn upgrade_preflight_failure<E: Write>(
    stderr: &mut E,
    category: &str,
) -> io::Result<CommandStatus> {
    writeln!(
        stderr,
        "{BINARY_NAME}: upgrade-preflight stopped ({category})"
    )?;
    Ok(CommandStatus::Failure)
}

async fn execute_migration(
    pool: &DatabasePool,
    config: &DatabaseRuntimeConfig,
) -> Result<SchemaReadiness, MigrationCommandError> {
    let before = check_schema_readiness(pool)
        .await
        .map_err(|_| MigrationCommandError::ReadinessQuery)?;
    if !before.allows_migration() {
        return Err(MigrationCommandError::Readiness(before));
    }
    run_embedded_migrations(pool, config.migration_options())
        .await
        .map_err(|_| MigrationCommandError::Migration)?;
    let after = check_schema_readiness(pool)
        .await
        .map_err(|_| MigrationCommandError::ReadinessQuery)?;
    if matches!(after, SchemaReadiness::Ready { .. }) {
        Ok(after)
    } else {
        Err(MigrationCommandError::Readiness(after))
    }
}

enum MigrationCommandError {
    Readiness(SchemaReadiness),
    ReadinessQuery,
    Migration,
}

fn migration_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {
    writeln!(stderr, "{BINARY_NAME}: migrate failed ({category})")?;
    Ok(CommandStatus::Failure)
}

fn command_from_matches(matches: &ArgMatches) -> Result<CliAction, clap::Error> {
    match matches.subcommand_name() {
        Some("serve") => Ok(CliAction::Operational(OperationalCommand::Serve)),
        Some("migrate") => Ok(CliAction::Operational(OperationalCommand::Migrate)),
        Some("upgrade-preflight") => {
            Ok(CliAction::Operational(OperationalCommand::UpgradePreflight))
        }
        Some("bootstrap-admin") => Ok(CliAction::Operational(OperationalCommand::BootstrapAdmin)),
        Some("healthcheck") => Ok(CliAction::Operational(OperationalCommand::Healthcheck)),
        Some("storage-check") => Ok(CliAction::Operational(OperationalCommand::StorageCheck)),
        Some("storage-configure-browser-upload-cors") => Ok(CliAction::Operational(
            OperationalCommand::StorageConfigureBrowserUploadCors,
        )),
        Some("backup") => backup_from_matches(matches),
        Some("recovery-kit") => recovery_kit_from_matches(matches),
        _ => Err(root_command().error(
            ErrorKind::MissingSubcommand,
            "an operational command is required",
        )),
    }
}

fn recovery_kit_from_matches(matches: &ArgMatches) -> Result<CliAction, clap::Error> {
    let (_, recovery_kit) = matches.subcommand().ok_or_else(|| {
        root_command().error(
            ErrorKind::MissingSubcommand,
            "recovery-kit command required",
        )
    })?;
    let command = match recovery_kit.subcommand() {
        Some(("export", args)) => RecoveryKitCommand::Export {
            output: required_string(args, "output")?,
            passphrase_file: required_string(args, "passphrase-file")?,
        },
        Some(("inspect", args)) => RecoveryKitCommand::Inspect {
            input: required_string(args, "input")?,
            passphrase_file: required_string(args, "passphrase-file")?,
        },
        Some(("verify", args)) => RecoveryKitCommand::Verify {
            input: required_string(args, "input")?,
            passphrase_file: required_string(args, "passphrase-file")?,
        },
        Some(("restore", args)) => RecoveryKitCommand::Restore {
            input: required_string(args, "input")?,
            passphrase_file: required_string(args, "passphrase-file")?,
            output_dir: required_string(args, "output-dir")?,
        },
        _ => {
            return Err(root_command().error(
                ErrorKind::MissingSubcommand,
                "a recovery-kit subcommand is required",
            ));
        }
    };
    Ok(CliAction::Operational(OperationalCommand::RecoveryKit(
        command,
    )))
}

fn backup_from_matches(matches: &ArgMatches) -> Result<CliAction, clap::Error> {
    let (_, backup) = matches.subcommand().ok_or_else(|| {
        root_command().error(ErrorKind::MissingSubcommand, "backup command required")
    })?;
    let command = match backup.subcommand() {
        Some(("create", _)) => BackupCommand::Create,
        Some(("list", _)) => BackupCommand::List,
        Some(("verify", args)) => BackupCommand::Verify {
            backup_id: required_string(args, "backup-id")?,
        },
        Some(("export", args)) => BackupCommand::Export {
            backup_id: required_string(args, "backup-id")?,
            output: required_string(args, "output")?,
        },
        Some(("import", args)) => BackupCommand::Import {
            input: required_string(args, "input")?,
        },
        Some(("restore", args)) => BackupCommand::Restore {
            backup_id: required_string(args, "backup-id")?,
            recovery_kit: args.get_one::<String>("recovery-kit").cloned(),
            recovery_kit_passphrase_file: args
                .get_one::<String>("recovery-kit-passphrase-file")
                .cloned(),
        },
        Some(("drill", args)) => BackupCommand::Drill {
            backup_id: required_string(args, "backup-id")?,
            recovery_kit: args.get_one::<String>("recovery-kit").cloned(),
            recovery_kit_passphrase_file: args
                .get_one::<String>("recovery-kit-passphrase-file")
                .cloned(),
        },
        Some(("prune", _)) => BackupCommand::Prune,
        _ => {
            return Err(root_command().error(
                ErrorKind::MissingSubcommand,
                "a backup subcommand is required",
            ));
        }
    };
    Ok(CliAction::Operational(OperationalCommand::Backup(command)))
}

fn required_string(matches: &ArgMatches, name: &str) -> Result<String, clap::Error> {
    matches.get_one::<String>(name).cloned().ok_or_else(|| {
        root_command().error(
            ErrorKind::MissingRequiredArgument,
            "required backup argument missing",
        )
    })
}

async fn run_backup_command<O: Write, E: Write>(
    command: BackupCommand,
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    if matches!(command, BackupCommand::Create) {
        return backup_create(stdout, stderr).await;
    }
    if matches!(
        command,
        BackupCommand::Restore { .. } | BackupCommand::Drill { .. }
    ) {
        return backup_restore(command, stdout, stderr).await;
    }
    if matches!(
        command,
        BackupCommand::List | BackupCommand::Verify { .. } | BackupCommand::Export { .. }
    ) && std::env::var_os("NURITEO_BACKUP_REPOSITORY_DIR").is_none()
    {
        return backup_read(command, stdout, stderr).await;
    }
    let repository_root = match std::env::var_os("NURITEO_BACKUP_REPOSITORY_DIR") {
        Some(root) => root,
        None => return backup_failure(stderr, "configuration"),
    };
    let repository = match DirectoryBackupRepository::open(Path::new(&repository_root)) {
        Ok(repository) => repository,
        Err(_) => return backup_failure(stderr, "repository"),
    };
    let engine = BackupEngine::new(repository, PortableLimits::default());
    let result = match command {
        BackupCommand::List => engine.list().and_then(|backups| {
            serde_json::to_writer(&mut *stdout, &backups)
                .map_err(|_| crate::backup::BackupEngineError::Io)?;
            writeln!(stdout).map_err(|_| crate::backup::BackupEngineError::Io)
        }),
        BackupCommand::Verify { backup_id } => engine.verify(&backup_id).and_then(|report| {
            writeln!(
                stdout,
                "backup verified: {} entries={} bytes={}",
                report.backup_id, report.entries, report.bytes
            )
            .map_err(|_| crate::backup::BackupEngineError::Io)
        }),
        BackupCommand::Export { backup_id, output } => {
            if output == "-" {
                engine.export(&backup_id, stdout)
            } else {
                match OpenOptions::new().write(true).create_new(true).open(output) {
                    Ok(mut file) => engine.export(&backup_id, &mut file),
                    Err(_) => Err(crate::backup::BackupEngineError::Io),
                }
            }
        }
        BackupCommand::Import { input } => {
            let imported = if input == "-" {
                let mut stdin = io::stdin().lock();
                engine.import(&mut stdin)
            } else {
                File::open(input)
                    .map_err(|_| crate::backup::BackupEngineError::Io)
                    .and_then(|mut file| engine.import(&mut file))
            };
            imported.and_then(|report| {
                writeln!(
                    stdout,
                    "backup imported: {} entries={} bytes={}",
                    report.backup_id, report.entries, report.bytes
                )
                .map_err(|_| crate::backup::BackupEngineError::Io)
            })
        }
        BackupCommand::Prune => {
            let protected_backup_ids = std::env::var("NURITEO_BACKUP_PROTECTED_IDS")
                .unwrap_or_default()
                .split(',')
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect();
            engine
                .prune(&PrunePolicy {
                    protected_backup_ids,
                    max_deletions: 100,
                })
                .and_then(|deleted| {
                    writeln!(stdout, "backup prune complete: deleted={}", deleted.len())
                        .map_err(|_| crate::backup::BackupEngineError::Io)
                })
        }
        BackupCommand::Create => unreachable!("create is dispatched before portable commands"),
        // Restore is connected after the Maintenance Mode target adapter is
        // available; it must not mutate production through the portable
        // repository boundary.
        BackupCommand::Restore { .. } | BackupCommand::Drill { .. } => {
            return backup_failure(stderr, "coordinator-unavailable");
        }
    };
    match result {
        Ok(()) => Ok(CommandStatus::Success),
        Err(error) => backup_failure(stderr, backup_error_category(error)),
    }
}

async fn backup_restore<O: Write, E: Write>(
    command: BackupCommand,
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    let (backup_id, recovery_kit, recovery_kit_passphrase_file, operation) = match command {
        BackupCommand::Restore {
            backup_id,
            recovery_kit,
            recovery_kit_passphrase_file,
        } => (
            backup_id,
            recovery_kit,
            recovery_kit_passphrase_file,
            "restored",
        ),
        BackupCommand::Drill {
            backup_id,
            recovery_kit,
            recovery_kit_passphrase_file,
        } => (
            backup_id,
            recovery_kit,
            recovery_kit_passphrase_file,
            "drill complete",
        ),
        _ => unreachable!("restore dispatcher only receives restore or drill commands"),
    };
    let environment = SystemEnvironment;
    let files = SystemFileReader;
    let verified_recovery_kit = match (recovery_kit, recovery_kit_passphrase_file) {
        (None, None) => false,
        (Some(kit), Some(passphrase_file)) => {
            let passphrase = match read_recovery_kit_passphrase(Path::new(&passphrase_file)) {
                Ok(value) => value,
                Err(_) => return backup_failure(stderr, "recovery-kit-passphrase"),
            };
            let artifact = match read_recovery_kit_artifact(Path::new(&kit)) {
                Ok(value) => value,
                Err(_) => return backup_failure(stderr, "recovery-kit-input"),
            };
            let keyring = match MasterKeyring::load(&environment, &files) {
                Ok(value) => value,
                Err(_) => return backup_failure(stderr, "recovery-kit-key-configuration"),
            };
            if crate::integration::recovery_kit::verify(
                &artifact,
                &passphrase,
                "instance",
                Some(&keyring),
            )
            .is_err()
            {
                return backup_failure(stderr, "recovery-kit-verification");
            }
            true
        }
        _ => return backup_failure(stderr, "recovery-kit-arguments"),
    };
    let source_database = match DatabaseRuntimeConfig::load(&environment, &files) {
        Ok(config) => config,
        Err(_) => return backup_failure(stderr, "database-configuration"),
    };
    let primary_storage = match ObjectStorageConfig::load(&environment, &files) {
        Ok(config) => config,
        Err(_) => return backup_failure(stderr, "source-storage-configuration"),
    };
    let backup_runtime = match BackupDestinationRuntime::load(&environment, &files) {
        Ok(runtime) => runtime,
        Err(_) => return backup_failure(stderr, "destination-configuration"),
    };
    let restore_runtime = match RestoreRuntime::load(&environment, &files) {
        Ok(runtime) => runtime,
        Err(error) => return backup_failure(stderr, error.category()),
    };
    if primary_storage.same_target(&restore_runtime.storage) {
        return backup_failure(stderr, "production-target");
    }
    let scratch = match std::env::var_os("NURITEO_BACKUP_SCRATCH_DIR") {
        Some(path) => PathBuf::from(path),
        None => return backup_failure(stderr, "restore-scratch"),
    };
    let source_pool = match DatabasePool::connect(source_database.pool_config()).await {
        Ok(pool) => pool,
        Err(_) => return backup_failure(stderr, "database-connectivity"),
    };
    let target_pool = match DatabasePool::connect(restore_runtime.database.pool_config()).await {
        Ok(pool) => pool,
        Err(_) => {
            let _ = source_pool.close(source_database.close_timeout()).await;
            return backup_failure(stderr, "restore-database-connectivity");
        }
    };
    let backup_destination =
        match BackupDestination::new(backup_runtime.config, &backup_runtime.credential) {
            Ok(destination) => destination,
            Err(_) => {
                close_restore_pools(source_pool, &source_database, target_pool, &restore_runtime)
                    .await;
                return backup_failure(stderr, "destination-initialization");
            }
        };
    let target_storage =
        match S3ObjectStore::new(&restore_runtime.storage, OperationLimits::default()).await {
            Ok(storage) => storage,
            Err(_) => {
                close_restore_pools(source_pool, &source_database, target_pool, &restore_runtime)
                    .await;
                return backup_failure(stderr, "restore-storage-initialization");
            }
        };
    let reader = BackupReadCoordinator::new(
        source_pool.clone(),
        backup_destination,
        PortableLimits::default(),
    );
    let staged = match reader.stage(&backup_id, &scratch).await {
        Ok(staged) => staged,
        Err(error) => {
            close_restore_pools(source_pool, &source_database, target_pool, &restore_runtime).await;
            return backup_failure(stderr, error.category());
        }
    };
    let target_close_timeout = restore_runtime.database.close_timeout();
    let coordinator = BackupRestoreCoordinator::new(
        source_pool.clone(),
        target_pool.clone(),
        target_storage,
        restore_runtime,
    );
    let result = if verified_recovery_kit {
        coordinator.restore_with_recovery_kit(&staged).await
    } else {
        coordinator.restore(&staged).await
    };
    let source_close = source_pool.close(source_database.close_timeout()).await;
    let target_close = target_pool.close(target_close_timeout).await;
    match (result, source_close, target_close) {
        (Ok(report), Ok(()), Ok(())) => {
            writeln!(
                stdout,
                "backup {operation}: {} entries={} bytes={}",
                report.backup_id, report.entries, report.bytes,
            )?;
            Ok(CommandStatus::Success)
        }
        (Err(error), _, _) => backup_failure(stderr, error.category()),
        (Ok(_), Err(_), _) | (Ok(_), _, Err(_)) => backup_failure(stderr, "database-close"),
    }
}

async fn close_restore_pools(
    source: DatabasePool,
    source_config: &DatabaseRuntimeConfig,
    target: DatabasePool,
    target_runtime: &RestoreRuntime,
) {
    let _ = source.close(source_config.close_timeout()).await;
    let _ = target.close(target_runtime.database.close_timeout()).await;
}

async fn backup_read<O: Write, E: Write>(
    command: BackupCommand,
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    let environment = SystemEnvironment;
    let files = SystemFileReader;
    let database_config = match DatabaseRuntimeConfig::load(&environment, &files) {
        Ok(config) => config,
        Err(_) => return backup_failure(stderr, "database-configuration"),
    };
    let destination_runtime = match BackupDestinationRuntime::load(&environment, &files) {
        Ok(runtime) => runtime,
        Err(_) => return backup_failure(stderr, "destination-configuration"),
    };
    let destination =
        match BackupDestination::new(destination_runtime.config, &destination_runtime.credential) {
            Ok(destination) => destination,
            Err(_) => return backup_failure(stderr, "destination-initialization"),
        };
    let pool = match DatabasePool::connect(database_config.pool_config()).await {
        Ok(pool) => pool,
        Err(_) => return backup_failure(stderr, "database-connectivity"),
    };
    let coordinator =
        BackupReadCoordinator::new(pool.clone(), destination, PortableLimits::default());
    let result = match command {
        BackupCommand::List => coordinator.list().await.and_then(|backups| {
            serde_json::to_writer(&mut *stdout, &backups)
                .map_err(|_| crate::backup::BackupReadError::Database)?;
            writeln!(stdout).map_err(|_| crate::backup::BackupReadError::Database)
        }),
        BackupCommand::Verify { backup_id } => {
            let scratch = std::env::var_os("NURITEO_BACKUP_SCRATCH_DIR")
                .map(PathBuf::from)
                .ok_or(crate::backup::BackupReadError::Scratch);
            match scratch {
                Ok(scratch) => coordinator
                    .verify(&backup_id, &scratch)
                    .await
                    .and_then(|report| {
                        writeln!(
                            stdout,
                            "backup verified: {} entries={} bytes={}",
                            report.backup_id, report.entries, report.bytes
                        )
                        .map_err(|_| crate::backup::BackupReadError::Database)
                    }),
                Err(error) => Err(error),
            }
        }
        BackupCommand::Export { backup_id, output } => {
            let scratch = std::env::var_os("NURITEO_BACKUP_SCRATCH_DIR")
                .map(PathBuf::from)
                .ok_or(crate::backup::BackupReadError::Scratch);
            match scratch {
                Ok(scratch) if output == "-" => coordinator
                    .export(&backup_id, &scratch, stdout)
                    .await
                    .map(|_| ()),
                Ok(scratch) => match OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&output)
                {
                    Ok(mut file) => {
                        let result = coordinator
                            .export(&backup_id, &scratch, &mut file)
                            .await
                            .map(|_| ());
                        if result.is_err() {
                            drop(file);
                            let _ = std::fs::remove_file(output);
                        }
                        result
                    }
                    Err(_) => Err(crate::backup::BackupReadError::Scratch),
                },
                Err(error) => Err(error),
            }
        }
        _ => unreachable!("read coordinator only handles list, verify, and export"),
    };
    let close_result = pool.close(database_config.close_timeout()).await;
    match (result, close_result) {
        (Ok(()), Ok(())) => Ok(CommandStatus::Success),
        (Err(error), _) => backup_failure(stderr, error.category()),
        (Ok(()), Err(_)) => backup_failure(stderr, "database-close"),
    }
}

async fn backup_create<O: Write, E: Write>(
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    let environment = SystemEnvironment;
    let files = SystemFileReader;
    if Config::load(&environment, &files).is_err() {
        return backup_failure(stderr, "configuration");
    }
    let database_config = match DatabaseRuntimeConfig::load(&environment, &files) {
        Ok(config) => config,
        Err(_) => return backup_failure(stderr, "database-configuration"),
    };
    let primary_config = match ObjectStorageConfig::load(&environment, &files) {
        Ok(config) => config,
        Err(_) => return backup_failure(stderr, "source-storage-configuration"),
    };
    let destination_runtime = match BackupDestinationRuntime::load(&environment, &files) {
        Ok(runtime) => runtime,
        Err(_) => return backup_failure(stderr, "destination-configuration"),
    };
    let scratch = match std::env::var_os("NURITEO_BACKUP_SCRATCH_DIR") {
        Some(path) => Path::new(&path).to_path_buf(),
        None => return backup_failure(stderr, "scratch-configuration"),
    };
    let generation_id = uuid::Uuid::now_v7();
    let dump_config = match PgDumpCommandConfig::load(
        &environment,
        &files,
        scratch.join(format!("database-{generation_id}.dump")),
    ) {
        Ok(config) => config,
        Err(_) => return backup_failure(stderr, "pg-dump-configuration"),
    };
    let pool = match DatabasePool::connect(database_config.pool_config()).await {
        Ok(pool) => pool,
        Err(_) => return backup_failure(stderr, "database-connectivity"),
    };
    let readiness = check_schema_readiness(&pool).await;
    let schema_version = match readiness {
        Ok(SchemaReadiness::Ready { version }) => version,
        _ => {
            let _ = pool.close(database_config.close_timeout()).await;
            return backup_failure(stderr, "schema-not-ready");
        }
    };
    let postgres_major = match postgres_major(&pool).await {
        Ok(version) => version,
        Err(()) => {
            let _ = pool.close(database_config.close_timeout()).await;
            return backup_failure(stderr, "database-operation");
        }
    };
    let primary = match S3ObjectStore::new(&primary_config, OperationLimits::default()).await {
        Ok(store) => store,
        Err(_) => {
            let _ = pool.close(database_config.close_timeout()).await;
            return backup_failure(stderr, "source-storage-initialization");
        }
    };
    let destination =
        match BackupDestination::new(destination_runtime.config, &destination_runtime.credential) {
            Ok(destination) => destination,
            Err(_) => {
                let _ = pool.close(database_config.close_timeout()).await;
                return backup_failure(stderr, "destination-initialization");
            }
        };
    let coordinator = BackupCreateCoordinator::new(pool.clone(), primary, destination);
    let result = coordinator
        .create(
            generation_id,
            schema_version,
            postgres_major,
            CommandPgDump::new(dump_config),
            &scratch,
        )
        .await;
    let close_result = pool.close(database_config.close_timeout()).await;
    match (result, close_result) {
        (Ok(report), Ok(())) => {
            writeln!(
                stdout,
                "backup created: {} entries={} bytes={}",
                report.backup_id, report.entries, report.bytes
            )?;
            Ok(CommandStatus::Success)
        }
        (Err(error), _) => backup_failure(stderr, error.category()),
        (Ok(_), Err(_)) => backup_failure(stderr, "database-close"),
    }
}

async fn postgres_major(pool: &DatabasePool) -> Result<i32, ()> {
    let mut connection = pool.acquire().await.map_err(|_| ())?;
    let version: String = sqlx::query_scalar("SHOW server_version_num")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| ())?;
    let version: i32 = version.parse().map_err(|_| ())?;
    let major = version / 10_000;
    (14..=99).contains(&major).then_some(major).ok_or(())
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

fn backup_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {
    writeln!(stderr, "{BINARY_NAME}: backup failed ({category})")?;
    Ok(CommandStatus::Failure)
}

fn run_recovery_kit_command<O: Write, E: Write>(
    command: RecoveryKitCommand,
    stdout: &mut O,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    let passphrase_path = match &command {
        RecoveryKitCommand::Export {
            passphrase_file, ..
        }
        | RecoveryKitCommand::Inspect {
            passphrase_file, ..
        }
        | RecoveryKitCommand::Verify {
            passphrase_file, ..
        }
        | RecoveryKitCommand::Restore {
            passphrase_file, ..
        } => passphrase_file,
    };
    let passphrase = match read_recovery_kit_passphrase(Path::new(passphrase_path)) {
        Ok(passphrase) => passphrase,
        Err(error) => return recovery_kit_failure(stderr, recovery_kit_error_category(error)),
    };
    let result = (|| -> Result<(), RecoveryKitCliError> {
        match command {
            RecoveryKitCommand::Export { output, .. } => {
                let keyring = MasterKeyring::load(&SystemEnvironment, &SystemFileReader)
                    .map_err(|_| RecoveryKitCliError::KeyConfiguration)?;
                let (artifact, metadata) = crate::integration::recovery_kit::export(
                    &keyring,
                    "instance",
                    time::OffsetDateTime::now_utc(),
                    &passphrase,
                )
                .map_err(RecoveryKitCliError::Kit)?;
                write_private_new(Path::new(&output), &artifact)?;
                write_metadata(stdout, &metadata)?;
                Ok(())
            }
            RecoveryKitCommand::Inspect { input, .. } => {
                let artifact = read_recovery_kit_artifact(Path::new(&input))?;
                let metadata = crate::integration::recovery_kit::inspect(&artifact, &passphrase)
                    .map_err(RecoveryKitCliError::Kit)?;
                write_metadata(stdout, &metadata)
            }
            RecoveryKitCommand::Verify { input, .. } => {
                let artifact = read_recovery_kit_artifact(Path::new(&input))?;
                let keyring = MasterKeyring::load(&SystemEnvironment, &SystemFileReader)
                    .map_err(|_| RecoveryKitCliError::KeyConfiguration)?;
                let metadata = crate::integration::recovery_kit::verify(
                    &artifact,
                    &passphrase,
                    "instance",
                    Some(&keyring),
                )
                .map_err(RecoveryKitCliError::Kit)?;
                write_metadata(stdout, &metadata)
            }
            RecoveryKitCommand::Restore {
                input, output_dir, ..
            } => {
                let artifact = read_recovery_kit_artifact(Path::new(&input))?;
                let verified =
                    crate::integration::recovery_kit::restore(&artifact, &passphrase, "instance")
                        .map_err(RecoveryKitCliError::Kit)?;
                write_restored_keyring(Path::new(&output_dir), &verified)?;
                write_metadata(stdout, &verified.metadata)
            }
        }
    })();
    match result {
        Ok(()) => Ok(CommandStatus::Success),
        Err(error) => recovery_kit_failure(stderr, recovery_kit_cli_error_category(error)),
    }
}

#[derive(Debug)]
enum RecoveryKitCliError {
    Input,
    Output,
    KeyConfiguration,
    Kit(RecoveryKitError),
}

fn read_recovery_kit_passphrase(path: &Path) -> Result<RecoveryKitPassphrase, RecoveryKitError> {
    let bytes = fs::read(path).map_err(|_| RecoveryKitError::InvalidPassphrase)?;
    if bytes.len() > 4096 {
        return Err(RecoveryKitError::InvalidPassphrase);
    }
    let value = String::from_utf8(bytes).map_err(|_| RecoveryKitError::InvalidPassphrase)?;
    RecoveryKitPassphrase::new(value)
}

fn read_recovery_kit_artifact(path: &Path) -> Result<Vec<u8>, RecoveryKitCliError> {
    let file = File::open(path).map_err(|_| RecoveryKitCliError::Input)?;
    let mut artifact = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut artifact)
        .map_err(|_| RecoveryKitCliError::Input)?;
    if artifact.is_empty() || artifact.len() > 1024 * 1024 {
        return Err(RecoveryKitCliError::Input);
    }
    Ok(artifact)
}

fn write_metadata<O: Write>(
    output: &mut O,
    metadata: &crate::integration::recovery_kit::RecoveryKitMetadata,
) -> Result<(), RecoveryKitCliError> {
    serde_json::to_writer(&mut *output, metadata).map_err(|_| RecoveryKitCliError::Output)?;
    writeln!(output).map_err(|_| RecoveryKitCliError::Output)
}

fn write_restored_keyring(
    output_dir: &Path,
    verified: &crate::integration::recovery_kit::VerifiedRecoveryKit,
) -> Result<(), RecoveryKitCliError> {
    create_private_dir(output_dir)?;
    write_private_new(
        &output_dir.join("master-key"),
        verified
            .current_key_base64()
            .map_err(RecoveryKitCliError::Kit)?
            .as_bytes(),
    )?;
    write_private_new(
        &output_dir.join("master-key-version"),
        verified.current_version().to_string().as_bytes(),
    )?;
    write_private_new(
        &output_dir.join("previous-master-keys.json"),
        &verified
            .previous_keys_json()
            .map_err(RecoveryKitCliError::Kit)?,
    )
}

fn create_private_dir(path: &Path) -> Result<(), RecoveryKitCliError> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| RecoveryKitCliError::Output)
}

fn write_private_new(path: &Path, value: &[u8]) -> Result<(), RecoveryKitCliError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| RecoveryKitCliError::Output)?;
    file.write_all(value)
        .and_then(|()| file.sync_all())
        .map_err(|_| RecoveryKitCliError::Output)
}

fn recovery_kit_error_category(error: RecoveryKitError) -> &'static str {
    recovery_kit_cli_error_category(RecoveryKitCliError::Kit(error))
}

fn recovery_kit_cli_error_category(error: RecoveryKitCliError) -> &'static str {
    match error {
        RecoveryKitCliError::Input => "input",
        RecoveryKitCliError::Output => "output",
        RecoveryKitCliError::KeyConfiguration => "key-configuration",
        RecoveryKitCliError::Kit(RecoveryKitError::InvalidPassphrase) => "passphrase",
        RecoveryKitCliError::Kit(RecoveryKitError::Decryption) => "decryption",
        RecoveryKitCliError::Kit(RecoveryKitError::UnsupportedFormat) => "unsupported-format",
        RecoveryKitCliError::Kit(RecoveryKitError::IncompatibleInstance) => "incompatible-instance",
        RecoveryKitCliError::Kit(RecoveryKitError::IncompatibleKeyring) => "incompatible-keyring",
        RecoveryKitCliError::Kit(
            RecoveryKitError::InvalidInstance | RecoveryKitError::InvalidPayload,
        ) => "invalid-payload",
        RecoveryKitCliError::Kit(RecoveryKitError::Encryption) => "encryption",
    }
}

fn recovery_kit_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {
    writeln!(stderr, "{BINARY_NAME}: recovery-kit failed ({category})")?;
    Ok(CommandStatus::Failure)
}

const fn is_successful_display(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::DisplayHelp | ErrorKind::DisplayVersion)
}

fn unavailable<E: Write>(
    command: &OperationalCommand,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    writeln!(
        stderr,
        "{BINARY_NAME}: `{}` is not available in this build",
        command.name()
    )?;
    Ok(CommandStatus::Failure)
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
