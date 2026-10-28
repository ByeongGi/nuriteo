#![allow(unused_imports)]
use super::*;
use super::backup::*;
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
use super::{BINARY_NAME, BackupCommand, RecoveryKitCommand, OperationalCommand, CliAction, bootstrap_category, MigrationCommandError, backup_error_category, RecoveryKitCliError, is_successful_display};



impl super::OperationalCommand {
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


pub(crate) fn backup_command() -> Command {    let backup_id = || Arg::new("backup-id").required(true).value_name("BACKUP_ID");
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


pub(crate) fn recovery_kit_command() -> Command {    let input = || Arg::new("input").long("input").required(true);
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


pub(crate) async fn storage_configure_browser_upload_cors<O: Write, E: Write>(    stdout: &mut O,
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


pub(crate) async fn bootstrap_admin<O: Write, E: Write>(    stdout: &mut O,
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


pub(crate) fn bootstrap_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {    writeln!(stderr, "{BINARY_NAME}: bootstrap-admin failed ({category})")?;
    Ok(CommandStatus::Failure)
}


pub(crate) async fn serve<E: Write>(stderr: &mut E) -> io::Result<CommandStatus> {    match run_server(&SystemEnvironment, &SystemFileReader).await {
        Ok(()) => Ok(CommandStatus::Success),
        Err(error) => {
            writeln!(stderr, "{BINARY_NAME}: serve failed ({})", error.category())?;
            Ok(CommandStatus::Failure)
        }
    }
}


pub(crate) async fn healthcheck<O: Write, E: Write>(    stdout: &mut O,
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


pub(crate) async fn storage_check<O: Write, E: Write>(    stdout: &mut O,
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


pub(crate) fn storage_check_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {    writeln!(stderr, "{BINARY_NAME}: storage-check failed ({category})")?;
    Ok(CommandStatus::Failure)
}


pub(crate) async fn migrate<O: Write, E: Write>(stdout: &mut O, stderr: &mut E) -> io::Result<CommandStatus> {    let environment = SystemEnvironment;
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


pub(crate) async fn upgrade_preflight<O: Write, E: Write>(    stdout: &mut O,
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


pub(crate) fn upgrade_preflight_failure<E: Write>(    stderr: &mut E,
    category: &str,
) -> io::Result<CommandStatus> {
    writeln!(
        stderr,
        "{BINARY_NAME}: upgrade-preflight stopped ({category})"
    )?;
    Ok(CommandStatus::Failure)
}


pub(crate) async fn execute_migration(    pool: &DatabasePool,
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


pub(crate) fn migration_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {    writeln!(stderr, "{BINARY_NAME}: migrate failed ({category})")?;
    Ok(CommandStatus::Failure)
}


pub(crate) fn command_from_matches(matches: &ArgMatches) -> Result<CliAction, clap::Error> {    match matches.subcommand_name() {
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


pub(crate) fn recovery_kit_from_matches(matches: &ArgMatches) -> Result<CliAction, clap::Error> {    let (_, recovery_kit) = matches.subcommand().ok_or_else(|| {
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


pub(crate) fn backup_from_matches(matches: &ArgMatches) -> Result<CliAction, clap::Error> {    let (_, backup) = matches.subcommand().ok_or_else(|| {
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


pub(crate) fn required_string(matches: &ArgMatches, name: &str) -> Result<String, clap::Error> {    matches.get_one::<String>(name).cloned().ok_or_else(|| {
        root_command().error(
            ErrorKind::MissingRequiredArgument,
            "required backup argument missing",
        )
    })
}


pub(crate) async fn run_backup_command<O: Write, E: Write>(    command: BackupCommand,
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
