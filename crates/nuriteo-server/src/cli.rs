use std::ffi::{OsStr, OsString};
use std::io::{self, Write};

use clap::error::ErrorKind;
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::app::run_server;
use crate::config::{Config, SystemEnvironment, SystemFileReader};
use crate::database::{
    DatabasePool, DatabaseRuntimeConfig, SchemaReadiness, check_schema_readiness,
    run_embedded_migrations,
};
use crate::health::run_http_healthcheck;
use crate::{CommandStatus, VERSION};

const BINARY_NAME: &str = "nuriteo-server";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationalCommand {
    Serve,
    Migrate,
    BootstrapAdmin,
    Healthcheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliAction {
    Version,
    Operational(OperationalCommand),
}

impl OperationalCommand {
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Serve => "serve",
            Self::Migrate => "migrate",
            Self::BootstrapAdmin => "bootstrap-admin",
            Self::Healthcheck => "healthcheck",
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
            Command::new("bootstrap-admin")
                .about("Create the first instance administrator when none exists")
                .disable_version_flag(true),
        )
        .subcommand(
            Command::new("healthcheck")
                .about("Check deployment readiness")
                .disable_version_flag(true),
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
        Ok(CliAction::Operational(command)) => unavailable(command, stderr),
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
        Ok(CliAction::Operational(OperationalCommand::Healthcheck)) => {
            healthcheck(stdout, stderr).await
        }
        Ok(CliAction::Operational(command)) => unavailable(command, stderr),
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
        Some("bootstrap-admin") => Ok(CliAction::Operational(OperationalCommand::BootstrapAdmin)),
        Some("healthcheck") => Ok(CliAction::Operational(OperationalCommand::Healthcheck)),
        _ => Err(root_command().error(
            ErrorKind::MissingSubcommand,
            "an operational command is required",
        )),
    }
}

const fn is_successful_display(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::DisplayHelp | ErrorKind::DisplayVersion)
}

fn unavailable<E: Write>(command: OperationalCommand, stderr: &mut E) -> io::Result<CommandStatus> {
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
            ("bootstrap-admin", OperationalCommand::BootstrapAdmin),
            ("healthcheck", OperationalCommand::Healthcheck),
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
    fn operational_commands_fail_closed_until_their_handlers_exist() {
        for argument in ["serve", "migrate", "bootstrap-admin", "healthcheck"] {
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
