use std::ffi::OsString;
use std::fmt;
use std::num::NonZeroU16;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use percent_encoding::percent_decode_str;
use sqlx::{Acquire, Row};
use zeroize::Zeroize;

use crate::VERSION;
use crate::config::{Environment, FileReader, load_secret};
use crate::database::{DatabasePool, DatabaseRuntimeConfig, check_schema_readiness};
use crate::object_storage::{
    ListRequest, ObjectKey, ObjectPrefix, ObjectStorageConfig, S3ObjectStore,
};

use super::{ManifestEntryKind, StagedBackup, VerificationReport};

const RESTORE_DATABASE_URL: &str = "NURITEO_RESTORE_DATABASE_URL";
const RESTORE_DATABASE_URL_FILE: &str = "NURITEO_RESTORE_DATABASE_URL_FILE";
const RESTORE_DATABASE_CA_FILE: &str = "NURITEO_RESTORE_DATABASE_CA_FILE";
const RESTORE_DATABASE_CLIENT_CERT_FILE: &str = "NURITEO_RESTORE_DATABASE_CLIENT_CERT_FILE";
const RESTORE_DATABASE_CLIENT_KEY_FILE: &str = "NURITEO_RESTORE_DATABASE_CLIENT_KEY_FILE";
const RESTORE_PG_RESTORE_PATH: &str = "NURITEO_RESTORE_PG_RESTORE_PATH";
const RESTORE_TIMEOUT_MS: &str = "NURITEO_RESTORE_TIMEOUT_MS";

pub struct RestoreRuntime {
    pub database: DatabaseRuntimeConfig,
    pub storage: ObjectStorageConfig,
    command: PgRestoreCommandConfig,
}

impl RestoreRuntime {
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, BackupRestoreError> {
        let entries = environment.entries();
        let database_environment = RenamedEnvironment::new(
            &entries,
            &[
                (RESTORE_DATABASE_URL, "NURITEO_DATABASE_URL"),
                (RESTORE_DATABASE_URL_FILE, "NURITEO_DATABASE_URL_FILE"),
                (RESTORE_DATABASE_CA_FILE, "NURITEO_DATABASE_CA_FILE"),
                (
                    RESTORE_DATABASE_CLIENT_CERT_FILE,
                    "NURITEO_DATABASE_CLIENT_CERT_FILE",
                ),
                (
                    RESTORE_DATABASE_CLIENT_KEY_FILE,
                    "NURITEO_DATABASE_CLIENT_KEY_FILE",
                ),
            ],
        )?;
        let storage_environment = RenamedEnvironment::new(
            &entries,
            &[
                ("NURITEO_RESTORE_S3_ENDPOINT", "NURITEO_S3_ENDPOINT"),
                ("NURITEO_RESTORE_S3_REGION", "NURITEO_S3_REGION"),
                ("NURITEO_RESTORE_S3_BUCKET", "NURITEO_S3_BUCKET"),
                (
                    "NURITEO_RESTORE_S3_ADDRESSING_STYLE",
                    "NURITEO_S3_ADDRESSING_STYLE",
                ),
                (
                    "NURITEO_RESTORE_S3_CREDENTIAL_PROVIDER",
                    "NURITEO_S3_CREDENTIAL_PROVIDER",
                ),
                (
                    "NURITEO_RESTORE_S3_ACCESS_KEY_ID",
                    "NURITEO_S3_ACCESS_KEY_ID",
                ),
                (
                    "NURITEO_RESTORE_S3_ACCESS_KEY_ID_FILE",
                    "NURITEO_S3_ACCESS_KEY_ID_FILE",
                ),
                (
                    "NURITEO_RESTORE_S3_SECRET_ACCESS_KEY",
                    "NURITEO_S3_SECRET_ACCESS_KEY",
                ),
                (
                    "NURITEO_RESTORE_S3_SECRET_ACCESS_KEY_FILE",
                    "NURITEO_S3_SECRET_ACCESS_KEY_FILE",
                ),
                (
                    "NURITEO_RESTORE_S3_SESSION_TOKEN",
                    "NURITEO_S3_SESSION_TOKEN",
                ),
                (
                    "NURITEO_RESTORE_S3_SESSION_TOKEN_FILE",
                    "NURITEO_S3_SESSION_TOKEN_FILE",
                ),
                ("NURITEO_RESTORE_S3_CA_FILE", "NURITEO_S3_CA_FILE"),
            ],
        )?;
        let database = DatabaseRuntimeConfig::load(&database_environment, files)
            .map_err(|_| BackupRestoreError::Configuration)?;
        let storage = ObjectStorageConfig::load(&storage_environment, files)
            .map_err(|_| BackupRestoreError::Configuration)?;
        let command = PgRestoreCommandConfig::load(environment, files)?;
        Ok(Self {
            database,
            storage,
            command,
        })
    }
}

pub struct BackupRestoreCoordinator {
    production_pool: DatabasePool,
    target_pool: DatabasePool,
    target_storage: S3ObjectStore,
    command: Option<PgRestoreCommandConfig>,
}

impl BackupRestoreCoordinator {
    #[must_use]
    pub fn new(
        production_pool: DatabasePool,
        target_pool: DatabasePool,
        target_storage: S3ObjectStore,
        runtime: RestoreRuntime,
    ) -> Self {
        Self {
            production_pool,
            target_pool,
            target_storage,
            command: Some(runtime.command),
        }
    }

    pub async fn restore(
        self,
        staged: &StagedBackup,
    ) -> Result<VerificationReport, BackupRestoreError> {
        self.restore_inner(staged, false).await
    }

    pub async fn restore_with_recovery_kit(
        self,
        staged: &StagedBackup,
    ) -> Result<VerificationReport, BackupRestoreError> {
        self.restore_inner(staged, true).await
    }

    async fn restore_inner(
        mut self,
        staged: &StagedBackup,
        recovery_kit_verified: bool,
    ) -> Result<VerificationReport, BackupRestoreError> {
        self.require_isolated_empty_target().await?;
        if staged.manifest().created_by.version != VERSION {
            return Err(BackupRestoreError::IncompatibleRelease);
        }
        self.command
            .take()
            .ok_or(BackupRestoreError::RestoreCommand)?
            .run(staged.database_archive()?)
            .await?;
        let readiness = check_schema_readiness(&self.target_pool)
            .await
            .map_err(|_| BackupRestoreError::Validation)?;
        let restored_schema = match readiness {
            crate::database::SchemaReadiness::Ready { version } => version,
            _ => return Err(BackupRestoreError::Validation),
        };
        if u64::try_from(restored_schema).ok() != Some(staged.manifest().database.schema_version) {
            return Err(BackupRestoreError::Validation);
        }

        let bundles = self.restored_bundles().await?;
        for bundle in &bundles {
            let source = staged.payload_for_digest(&hex_digest(bundle.digest))?;
            let key = ObjectKey::parse(bundle.object_key.clone())
                .map_err(|_| BackupRestoreError::Validation)?;
            self.target_storage
                .put_verified_restore_file(&key, source, bundle.bytes, bundle.digest)
                .await
                .map_err(|_| BackupRestoreError::StorageWrite)?;
        }
        self.finalize_recovery_state_and_validate(staged, &bundles, recovery_kit_verified)
            .await?;

        let bytes = staged
            .manifest()
            .entries
            .iter()
            .try_fold(0_u64, |total, entry| total.checked_add(entry.bytes))
            .ok_or(BackupRestoreError::Validation)?;
        Ok(VerificationReport {
            backup_id: staged.manifest().backup_id.clone(),
            entries: staged.manifest().entries.len(),
            bytes,
        })
    }

    async fn require_isolated_empty_target(&self) -> Result<(), BackupRestoreError> {
        let production_identity = database_identity(&self.production_pool).await?;
        let target_identity = database_identity(&self.target_pool).await?;
        if production_identity == target_identity {
            return Err(BackupRestoreError::ProductionTarget);
        }
        let mut connection = self
            .target_pool
            .acquire()
            .await
            .map_err(|_| BackupRestoreError::Database)?;
        let empty: bool = sqlx::query_scalar(
            "SELECT NOT EXISTS(
               SELECT 1 FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog','information_schema'))",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| BackupRestoreError::Database)?;
        if !empty {
            return Err(BackupRestoreError::TargetNotEmpty);
        }
        let page = self
            .target_storage
            .list(ListRequest {
                prefix: ObjectPrefix::parse("").map_err(|_| BackupRestoreError::Configuration)?,
                continuation: None,
                page_size: NonZeroU16::new(1).expect("one is non-zero"),
            })
            .await
            .map_err(|_| BackupRestoreError::StorageRead)?;
        if !page.objects.is_empty() {
            return Err(BackupRestoreError::TargetNotEmpty);
        }
        Ok(())
    }

    async fn restored_bundles(&self) -> Result<Vec<RestoredBundle>, BackupRestoreError> {
        let mut connection = self
            .target_pool
            .acquire()
            .await
            .map_err(|_| BackupRestoreError::Database)?;
        let rows = sqlx::query(
            "SELECT bundle.object_key,bundle.sha256,bundle.physical_bytes FROM bundles bundle
             WHERE bundle.verification_state='verified' AND (
               EXISTS (SELECT 1 FROM projects project
                       WHERE project.working_head_bundle_id=bundle.id)
               OR EXISTS (SELECT 1 FROM project_bundle_refs reference
                          WHERE reference.bundle_id=bundle.id))
             ORDER BY bundle.object_key",
        )
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| BackupRestoreError::Database)?;
        rows.into_iter()
            .map(|row| {
                let digest: Vec<u8> = row
                    .try_get("sha256")
                    .map_err(|_| BackupRestoreError::Validation)?;
                Ok(RestoredBundle {
                    object_key: row
                        .try_get("object_key")
                        .map_err(|_| BackupRestoreError::Validation)?,
                    digest: digest
                        .try_into()
                        .map_err(|_| BackupRestoreError::Validation)?,
                    bytes: row
                        .try_get::<i64, _>("physical_bytes")
                        .ok()
                        .and_then(|value| u64::try_from(value).ok())
                        .ok_or(BackupRestoreError::Validation)?,
                })
            })
            .collect()
    }

    async fn finalize_recovery_state_and_validate(
        &self,
        staged: &StagedBackup,
        bundles: &[RestoredBundle],
        recovery_kit_verified: bool,
    ) -> Result<(), BackupRestoreError> {
        let manifest_payloads = staged
            .manifest()
            .entries
            .iter()
            .filter(|entry| entry.kind == ManifestEntryKind::Payload)
            .map(|entry| parse_hex_digest(&entry.sha256))
            .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
        let restored_payloads = bundles
            .iter()
            .map(|bundle| bundle.digest)
            .collect::<std::collections::BTreeSet<_>>();
        if manifest_payloads != restored_payloads {
            return Err(BackupRestoreError::Validation);
        }
        let mut connection = self
            .target_pool
            .acquire()
            .await
            .map_err(|_| BackupRestoreError::Database)?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| BackupRestoreError::Database)?;
        sqlx::query(
            "UPDATE sessions SET revoked_at=COALESCE(revoked_at,transaction_timestamp()),
             revocation_reason=COALESCE(revocation_reason,'backup_restore')
             WHERE revoked_at IS NULL",
        )
        .execute(&mut *transaction)
        .await
        .map_err(|_| BackupRestoreError::Database)?;
        if !recovery_kit_verified {
            sqlx::query(
                "UPDATE oidc_providers SET status='disabled',
                disabled_at=COALESCE(disabled_at,transaction_timestamp()),
                config_version=config_version+1,updated_at=transaction_timestamp()
             WHERE status<>'disabled'",
            )
            .execute(&mut *transaction)
            .await
            .map_err(|_| BackupRestoreError::Database)?;
            sqlx::query(
                "UPDATE git_providers SET status='disabled',
                disabled_at=COALESCE(disabled_at,transaction_timestamp()),
                config_version=config_version+1,updated_at=transaction_timestamp()
             WHERE status<>'disabled'",
            )
            .execute(&mut *transaction)
            .await
            .map_err(|_| BackupRestoreError::Database)?;
            sqlx::query(
                "UPDATE registry_connections SET status='disabled',is_default=FALSE,
                disabled_at=COALESCE(disabled_at,transaction_timestamp()),
                config_version=config_version+1,updated_at=transaction_timestamp()
             WHERE status<>'disabled' OR is_default",
            )
            .execute(&mut *transaction)
            .await
            .map_err(|_| BackupRestoreError::Database)?;
            sqlx::query(
                "UPDATE instance_settings SET value='false'::jsonb,lock_version=lock_version+1,
                updated_at=transaction_timestamp()
             WHERE key='smtp.enabled' AND value='true'::jsonb",
            )
            .execute(&mut *transaction)
            .await
            .map_err(|_| BackupRestoreError::Database)?;
            sqlx::query(
                "UPDATE instance_recovery_state
             SET state='needs_reconfiguration',reason='missing_recovery_kit',
                 entered_at=transaction_timestamp(),updated_at=transaction_timestamp()
             WHERE singleton",
            )
            .execute(&mut *transaction)
            .await
            .map_err(|_| BackupRestoreError::Database)?;
        }
        transaction
            .commit()
            .await
            .map_err(|_| BackupRestoreError::Database)?;
        Ok(())
    }
}

#[derive(PartialEq, Eq)]
struct DatabaseIdentity {
    database: String,
    address: Option<String>,
    port: i32,
}

async fn database_identity(pool: &DatabasePool) -> Result<DatabaseIdentity, BackupRestoreError> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| BackupRestoreError::Database)?;
    let row = sqlx::query(
        "SELECT current_database() AS database,inet_server_addr()::text AS address,
         inet_server_port() AS port",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| BackupRestoreError::Database)?;
    Ok(DatabaseIdentity {
        database: row
            .try_get("database")
            .map_err(|_| BackupRestoreError::Database)?,
        address: row
            .try_get("address")
            .map_err(|_| BackupRestoreError::Database)?,
        port: row
            .try_get("port")
            .map_err(|_| BackupRestoreError::Database)?,
    })
}

struct RestoredBundle {
    object_key: String,
    digest: [u8; 32],
    bytes: u64,
}

struct PgRestoreCommandConfig {
    executable: PathBuf,
    host: String,
    port: u16,
    username: String,
    database: String,
    password: String,
    ssl_root_cert: Option<PathBuf>,
    ssl_client_cert: Option<PathBuf>,
    ssl_client_key: Option<PathBuf>,
    timeout: Duration,
}

impl Drop for PgRestoreCommandConfig {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

impl PgRestoreCommandConfig {
    fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, BackupRestoreError> {
        let database_url = load_secret(
            environment,
            files,
            RESTORE_DATABASE_URL,
            RESTORE_DATABASE_URL_FILE,
        )
        .map_err(|_| BackupRestoreError::Configuration)?
        .ok_or(BackupRestoreError::Configuration)?;
        let url = url::Url::parse(database_url.expose_secret())
            .map_err(|_| BackupRestoreError::Configuration)?;
        if !matches!(url.scheme(), "postgres" | "postgresql")
            || url.host_str().is_none()
            || url.username().is_empty()
            || url.password().is_none()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(BackupRestoreError::Configuration);
        }
        let decode = |value: &str| {
            percent_decode_str(value)
                .decode_utf8()
                .map(|value| value.into_owned())
                .map_err(|_| BackupRestoreError::Configuration)
        };
        let database = url.path().strip_prefix('/').unwrap_or_default();
        if database.is_empty() || database.contains('/') {
            return Err(BackupRestoreError::Configuration);
        }
        let executable = environment_value(environment, RESTORE_PG_RESTORE_PATH)?
            .unwrap_or_else(|| "/usr/bin/pg_restore".into());
        let timeout = environment_value(environment, RESTORE_TIMEOUT_MS)?
            .map_or(Ok(14_400_000_u64), |value| {
                value.parse().map_err(|_| BackupRestoreError::Configuration)
            })?;
        let ca = environment_value(environment, RESTORE_DATABASE_CA_FILE)?.map(PathBuf::from);
        let client_cert =
            environment_value(environment, RESTORE_DATABASE_CLIENT_CERT_FILE)?.map(PathBuf::from);
        let client_key =
            environment_value(environment, RESTORE_DATABASE_CLIENT_KEY_FILE)?.map(PathBuf::from);
        if !Path::new(&executable).is_absolute()
            || ca.as_ref().is_some_and(|path| !path.is_absolute())
            || client_cert.as_ref().is_some_and(|path| !path.is_absolute())
            || client_key.as_ref().is_some_and(|path| !path.is_absolute())
            || client_cert.is_some() != client_key.is_some()
            || !(1_000..=86_400_000).contains(&timeout)
        {
            return Err(BackupRestoreError::Configuration);
        }
        Ok(Self {
            executable: executable.into(),
            host: url
                .host_str()
                .ok_or(BackupRestoreError::Configuration)?
                .to_owned(),
            port: url.port().unwrap_or(5432),
            username: decode(url.username())?,
            database: decode(database)?,
            password: decode(url.password().ok_or(BackupRestoreError::Configuration)?)?,
            ssl_root_cert: ca,
            ssl_client_cert: client_cert,
            ssl_client_key: client_key,
            timeout: Duration::from_millis(timeout),
        })
    }

    async fn run(self, archive: &Path) -> Result<(), BackupRestoreError> {
        if !archive.is_absolute() || !archive.is_file() {
            return Err(BackupRestoreError::Scratch);
        }
        let archive = archive.to_path_buf();
        tokio::task::spawn_blocking(move || self.run_blocking(&archive))
            .await
            .map_err(|_| BackupRestoreError::RestoreCommand)?
    }

    fn run_blocking(self, archive: &Path) -> Result<(), BackupRestoreError> {
        self.invoke(archive, true)?;
        self.invoke(archive, false)
    }

    fn invoke(&self, archive: &Path, list_only: bool) -> Result<(), BackupRestoreError> {
        let mut command = Command::new(&self.executable);
        if list_only {
            command.arg("--list");
        } else {
            let port = self.port.to_string();
            command.args([
                "--exit-on-error",
                "--no-owner",
                "--no-privileges",
                "--no-password",
                "--host",
                &self.host,
                "--port",
                &port,
                "--username",
                &self.username,
                "--dbname",
                &self.database,
            ]);
        }
        command
            .arg(archive)
            .env_clear()
            .env("PGPASSWORD", &self.password)
            .env("PGSSLMODE", "verify-full")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(ca) = &self.ssl_root_cert {
            command.env("PGSSLROOTCERT", ca);
        }
        if let (Some(certificate), Some(key)) = (&self.ssl_client_cert, &self.ssl_client_key) {
            command.env("PGSSLCERT", certificate).env("PGSSLKEY", key);
        }
        let mut child = command
            .spawn()
            .map_err(|_| BackupRestoreError::RestoreCommand)?;
        let started = std::time::Instant::now();
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|_| BackupRestoreError::RestoreCommand)?
            {
                return status
                    .success()
                    .then_some(())
                    .ok_or(BackupRestoreError::RestoreCommand);
            }
            if started.elapsed() >= self.timeout {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BackupRestoreError::RestoreTimeout);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl fmt::Debug for PgRestoreCommandConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PgRestoreCommandConfig")
            .field("executable", &self.executable)
            .field("host", &"[REDACTED]")
            .field("port", &self.port)
            .field("username", &"[REDACTED]")
            .field("database", &"[REDACTED]")
            .field("password", &"[REDACTED]")
            .field("ssl_root_cert_configured", &self.ssl_root_cert.is_some())
            .field(
                "ssl_client_identity_configured",
                &self.ssl_client_cert.is_some(),
            )
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Clone)]
struct RenamedEnvironment(Vec<(OsString, OsString)>);

impl RenamedEnvironment {
    fn new(
        entries: &[(OsString, OsString)],
        names: &[(&str, &str)],
    ) -> Result<Self, BackupRestoreError> {
        let mut selected = Vec::new();
        for (source, target) in names {
            let matching = entries
                .iter()
                .filter(|(name, _)| name == source)
                .collect::<Vec<_>>();
            if matching.len() > 1 {
                return Err(BackupRestoreError::Configuration);
            }
            if let Some((_, value)) = matching.first() {
                selected.push((OsString::from(target), value.clone()));
            }
        }
        Ok(Self(selected))
    }
}

impl Environment for RenamedEnvironment {
    fn entries(&self) -> Vec<(OsString, OsString)> {
        self.0.clone()
    }
}

fn environment_value(
    environment: &impl Environment,
    requested: &str,
) -> Result<Option<String>, BackupRestoreError> {
    let mut found = None;
    for (name, value) in environment.entries() {
        if name != requested {
            continue;
        }
        if found.is_some() {
            return Err(BackupRestoreError::Configuration);
        }
        let value = value
            .into_string()
            .map_err(|_| BackupRestoreError::Configuration)?;
        if value.is_empty() {
            return Err(BackupRestoreError::Configuration);
        }
        found = Some(value);
    }
    Ok(found)
}

fn hex_digest(value: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in value {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

fn parse_hex_digest(value: &str) -> Result<[u8; 32], BackupRestoreError> {
    if value.len() != 64 {
        return Err(BackupRestoreError::Validation);
    }
    let mut digest = [0_u8; 32];
    for (index, output) in digest.iter_mut().enumerate() {
        let offset = index * 2;
        *output = u8::from_str_radix(&value[offset..offset + 2], 16)
            .map_err(|_| BackupRestoreError::Validation)?;
    }
    Ok(digest)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupRestoreError {
    Configuration,
    ProductionTarget,
    TargetNotEmpty,
    IncompatibleRelease,
    Database,
    StorageRead,
    StorageWrite,
    Scratch,
    RestoreCommand,
    RestoreTimeout,
    Validation,
    Read(super::BackupReadError),
}

impl From<super::BackupReadError> for BackupRestoreError {
    fn from(value: super::BackupReadError) -> Self {
        Self::Read(value)
    }
}

impl BackupRestoreError {
    #[must_use]
    pub const fn category(self) -> &'static str {
        match self {
            Self::Configuration => "restore-configuration",
            Self::ProductionTarget => "production-target",
            Self::TargetNotEmpty => "target-not-empty",
            Self::IncompatibleRelease => "incompatible-release",
            Self::Database => "restore-database",
            Self::StorageRead => "restore-storage-read",
            Self::StorageWrite => "restore-storage-write",
            Self::Scratch => "restore-scratch",
            Self::RestoreCommand => "pg-restore",
            Self::RestoreTimeout => "pg-restore-timeout",
            Self::Validation => "restore-validation",
            Self::Read(error) => error.category(),
        }
    }
}

impl fmt::Display for BackupRestoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.category())
    }
}

impl std::error::Error for BackupRestoreError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_environment_never_falls_back_to_production_names() {
        let entries = vec![
            (
                OsString::from("NURITEO_DATABASE_URL"),
                OsString::from("production"),
            ),
            (
                OsString::from(RESTORE_DATABASE_URL),
                OsString::from("isolated"),
            ),
        ];
        let mapped =
            RenamedEnvironment::new(&entries, &[(RESTORE_DATABASE_URL, "NURITEO_DATABASE_URL")])
                .unwrap();
        assert_eq!(
            mapped.entries(),
            vec![(
                OsString::from("NURITEO_DATABASE_URL"),
                OsString::from("isolated")
            )]
        );
    }

    #[test]
    fn restore_errors_are_secret_free_categories() {
        assert_eq!(
            BackupRestoreError::ProductionTarget.to_string(),
            "production-target"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pg_restore_validates_archive_before_applying_it() {
        use std::os::unix::fs::PermissionsExt as _;

        let temporary = tempfile::tempdir().unwrap();
        let executable = temporary.path().join("pg-restore-fixture");
        std::fs::write(
            &executable,
            b"#!/bin/sh\ncase \"$1\" in --list|--exit-on-error) exit 0;; *) exit 9;; esac\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let archive = temporary.path().join("database.dump");
        std::fs::write(&archive, b"fixture").unwrap();
        let command = PgRestoreCommandConfig {
            executable,
            host: "restore.invalid".into(),
            port: 5432,
            username: "restore-user".into(),
            database: "restore-db".into(),
            password: "must-never-render".into(),
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            timeout: Duration::from_secs(1),
        };
        assert!(!format!("{command:?}").contains("must-never-render"));
        command.run(&archive).await.unwrap();
    }
}
