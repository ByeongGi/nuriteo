#![allow(unused_imports)]
use super::*;
use super::instance_commands::*;
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



pub(crate) async fn backup_restore<O: Write, E: Write>(    command: BackupCommand,
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


pub(crate) async fn close_restore_pools(    source: DatabasePool,
    source_config: &DatabaseRuntimeConfig,
    target: DatabasePool,
    target_runtime: &RestoreRuntime,
) {
    let _ = source.close(source_config.close_timeout()).await;
    let _ = target.close(target_runtime.database.close_timeout()).await;
}


pub(crate) async fn backup_read<O: Write, E: Write>(    command: BackupCommand,
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


pub(crate) async fn backup_create<O: Write, E: Write>(    stdout: &mut O,
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


pub(crate) async fn postgres_major(pool: &DatabasePool) -> Result<i32, ()> {    let mut connection = pool.acquire().await.map_err(|_| ())?;
    let version: String = sqlx::query_scalar("SHOW server_version_num")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| ())?;
    let version: i32 = version.parse().map_err(|_| ())?;
    let major = version / 10_000;
    (14..=99).contains(&major).then_some(major).ok_or(())
}


pub(crate) fn backup_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {    writeln!(stderr, "{BINARY_NAME}: backup failed ({category})")?;
    Ok(CommandStatus::Failure)
}


pub(crate) fn run_recovery_kit_command<O: Write, E: Write>(    command: RecoveryKitCommand,
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


pub(crate) fn read_recovery_kit_passphrase(path: &Path) -> Result<RecoveryKitPassphrase, RecoveryKitError> {    let bytes = fs::read(path).map_err(|_| RecoveryKitError::InvalidPassphrase)?;
    if bytes.len() > 4096 {
        return Err(RecoveryKitError::InvalidPassphrase);
    }
    let value = String::from_utf8(bytes).map_err(|_| RecoveryKitError::InvalidPassphrase)?;
    RecoveryKitPassphrase::new(value)
}


pub(crate) fn read_recovery_kit_artifact(path: &Path) -> Result<Vec<u8>, RecoveryKitCliError> {    let file = File::open(path).map_err(|_| RecoveryKitCliError::Input)?;
    let mut artifact = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut artifact)
        .map_err(|_| RecoveryKitCliError::Input)?;
    if artifact.is_empty() || artifact.len() > 1024 * 1024 {
        return Err(RecoveryKitCliError::Input);
    }
    Ok(artifact)
}


pub(crate) fn write_metadata<O: Write>(    output: &mut O,
    metadata: &crate::integration::recovery_kit::RecoveryKitMetadata,
) -> Result<(), RecoveryKitCliError> {
    serde_json::to_writer(&mut *output, metadata).map_err(|_| RecoveryKitCliError::Output)?;
    writeln!(output).map_err(|_| RecoveryKitCliError::Output)
}


pub(crate) fn write_restored_keyring(    output_dir: &Path,
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


pub(crate) fn create_private_dir(path: &Path) -> Result<(), RecoveryKitCliError> {    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| RecoveryKitCliError::Output)
}


pub(crate) fn write_private_new(path: &Path, value: &[u8]) -> Result<(), RecoveryKitCliError> {    let mut options = OpenOptions::new();
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


pub(crate) fn recovery_kit_error_category(error: RecoveryKitError) -> &'static str {    recovery_kit_cli_error_category(RecoveryKitCliError::Kit(error))
}


pub(crate) fn recovery_kit_cli_error_category(error: RecoveryKitCliError) -> &'static str {    match error {
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


pub(crate) fn recovery_kit_failure<E: Write>(stderr: &mut E, category: &str) -> io::Result<CommandStatus> {    writeln!(stderr, "{BINARY_NAME}: recovery-kit failed ({category})")?;
    Ok(CommandStatus::Failure)
}


pub(crate) fn unavailable<E: Write>(    command: &OperationalCommand,
    stderr: &mut E,
) -> io::Result<CommandStatus> {
    writeln!(
        stderr,
        "{BINARY_NAME}: `{}` is not available in this build",
        command.name()
    )?;
    Ok(CommandStatus::Failure)
}
