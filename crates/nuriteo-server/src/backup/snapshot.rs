use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use sqlx::pool::PoolConnection;
use sqlx::{Executor, Postgres};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::database::DatabasePool;

const MIN_DUMP_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_DUMP_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, PartialEq, Eq)]
pub struct BackupObjectInventory {
    pub object_key: String,
    pub sha256: [u8; 32],
    pub physical_bytes: u64,
}

impl std::fmt::Debug for BackupObjectInventory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BackupObjectInventory")
            .field("object_key", &self.object_key)
            .field("sha256", &"[SHA-256]")
            .field("physical_bytes", &self.physical_bytes)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgDumpArtifact {
    pub path: PathBuf,
    pub sha256: [u8; 32],
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedBackupSnapshot {
    pub generation_id: Uuid,
    pub synchronized_snapshot_id: String,
    pub database_archive: PgDumpArtifact,
    pub objects: Vec<BackupObjectInventory>,
}

pub struct PgDumpCommandConfig {
    executable: PathBuf,
    host: String,
    port: u16,
    username: String,
    database: String,
    password: String,
    ssl_mode: String,
    ssl_root_cert: Option<PathBuf>,
    output_path: PathBuf,
    timeout: Duration,
}

impl std::fmt::Debug for PgDumpCommandConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgDumpCommandConfig")
            .field("executable", &self.executable)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("database", &self.database)
            .field("password", &"[REDACTED]")
            .field("ssl_mode", &self.ssl_mode)
            .field("ssl_root_cert", &self.ssl_root_cert)
            .field("output_path", &self.output_path)
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl Drop for PgDumpCommandConfig {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

impl PgDumpCommandConfig {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        executable: PathBuf,
        host: String,
        port: u16,
        username: String,
        database: String,
        password: String,
        ssl_mode: String,
        ssl_root_cert: Option<PathBuf>,
        output_path: PathBuf,
        timeout: Duration,
    ) -> Result<Self, PgDumpError> {
        if !executable.is_absolute()
            || host.is_empty()
            || username.is_empty()
            || database.is_empty()
            || password.is_empty()
            || !output_path.is_absolute()
            || !(MIN_DUMP_TIMEOUT..=MAX_DUMP_TIMEOUT).contains(&timeout)
            || !matches!(
                ssl_mode.as_str(),
                "verify-full" | "verify-ca" | "require" | "disable"
            )
            || ssl_root_cert
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
        {
            return Err(PgDumpError::InvalidConfiguration);
        }
        Ok(Self {
            executable,
            host,
            port,
            username,
            database,
            password,
            ssl_mode,
            ssl_root_cert,
            output_path,
            timeout,
        })
    }
}

pub struct CommandPgDump {
    config: PgDumpCommandConfig,
}

impl CommandPgDump {
    #[must_use]
    pub const fn new(config: PgDumpCommandConfig) -> Self {
        Self { config }
    }

    #[must_use]
    pub fn output_path(&self) -> &Path {
        &self.config.output_path
    }

    pub async fn run(self, snapshot_id: String) -> Result<PgDumpArtifact, PgDumpError> {
        tokio::task::spawn_blocking(move || self.run_blocking(&snapshot_id))
            .await
            .map_err(|_| PgDumpError::WorkerFailed)?
    }

    fn run_blocking(self, snapshot_id: &str) -> Result<PgDumpArtifact, PgDumpError> {
        let output = create_output(&self.config.output_path)?;
        let mut command = Command::new(&self.config.executable);
        command
            .arg("--format=custom")
            .arg("--no-password")
            .arg("--snapshot")
            .arg(snapshot_id)
            .arg("--host")
            .arg(&self.config.host)
            .arg("--port")
            .arg(self.config.port.to_string())
            .arg("--username")
            .arg(&self.config.username)
            .arg(&self.config.database)
            .env("PGPASSWORD", OsString::from(&self.config.password))
            .env("PGSSLMODE", &self.config.ssl_mode)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output))
            .stderr(Stdio::null());
        if let Some(root_cert) = &self.config.ssl_root_cert {
            command.env("PGSSLROOTCERT", root_cert);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                let _ = fs::remove_file(&self.config.output_path);
                return Err(PgDumpError::SpawnFailed);
            }
        };
        let deadline = Instant::now() + self.config.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&self.config.output_path);
                    return Err(PgDumpError::WaitFailed);
                }
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&self.config.output_path);
                return Err(PgDumpError::TimedOut);
            }
            thread::sleep(Duration::from_millis(20));
        };
        if !status.success() {
            let _ = fs::remove_file(&self.config.output_path);
            return Err(PgDumpError::CommandFailed);
        }
        inspect_artifact(self.config.output_path.clone())
    }
}

pub struct ExportedBackupSnapshot {
    pool: DatabasePool,
    connection: PoolConnection<Postgres>,
    generation_id: Uuid,
    snapshot_id: String,
}

impl ExportedBackupSnapshot {
    pub async fn begin(
        pool: DatabasePool,
        generation_id: Uuid,
    ) -> Result<Self, SnapshotCaptureError> {
        let mut connection = pool
            .acquire()
            .await
            .map_err(|_| SnapshotCaptureError::Database)?;
        sqlx::query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *connection)
            .await
            .map_err(|_| SnapshotCaptureError::Database)?;
        let snapshot_id: String = sqlx::query_scalar("SELECT pg_export_snapshot()")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| SnapshotCaptureError::Database)?;

        let result = record_exported_snapshot(&pool, generation_id, &snapshot_id).await;
        if result.is_err() {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            return Err(SnapshotCaptureError::GenerationConflict);
        }
        Ok(Self {
            pool,
            connection,
            generation_id,
            snapshot_id,
        })
    }

    #[must_use]
    pub fn snapshot_id(&self) -> &str {
        &self.snapshot_id
    }

    pub async fn capture(
        mut self,
        dump: CommandPgDump,
    ) -> Result<CapturedBackupSnapshot, SnapshotCaptureError> {
        let snapshot_id = self.snapshot_id.clone();
        let archive_path = dump.output_path().to_path_buf();
        let dump_future = dump.run(snapshot_id.clone());
        let inventory_future = load_object_inventory(&mut self.connection);
        let (dump_result, inventory_result) = tokio::join!(dump_future, inventory_future);
        let result = match (dump_result, inventory_result) {
            (Ok(archive), Ok(objects)) => {
                match install_inventory_holds(&self.pool, self.generation_id, &objects).await {
                    Ok(()) => match record_inventory_expectations(
                        &self.pool,
                        self.generation_id,
                        &archive,
                        &objects,
                    )
                    .await
                    {
                        Ok(()) => Ok(CapturedBackupSnapshot {
                            generation_id: self.generation_id,
                            synchronized_snapshot_id: snapshot_id,
                            database_archive: archive,
                            objects,
                        }),
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error),
                }
            }
            (Err(error), _) => Err(SnapshotCaptureError::PgDump(error)),
            (_, Err(error)) => Err(error),
        };

        let result = if result.is_ok() {
            match sqlx::query("COMMIT").execute(&mut *self.connection).await {
                Ok(_) => result,
                Err(_) => Err(SnapshotCaptureError::Database),
            }
        } else {
            let _ = sqlx::query("ROLLBACK").execute(&mut *self.connection).await;
            result
        };
        if result.is_err() {
            cleanup_failed_capture(&self.pool, self.generation_id, &archive_path).await;
        }
        result
    }
}

async fn record_exported_snapshot(
    pool: &DatabasePool,
    generation_id: Uuid,
    snapshot_id: &str,
) -> Result<(), SnapshotCaptureError> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| SnapshotCaptureError::Database)?;
    let snapshot_update = sqlx::query(
        "UPDATE backup_generations SET synchronized_snapshot_id=$2,updated_at=transaction_timestamp()
         WHERE id=$1::uuid AND state='preparing' AND synchronized_snapshot_id IS NULL",
    )
    .bind(generation_id.to_string())
    .bind(snapshot_id)
    .execute(&mut *connection)
    .await
    .map_err(|_| SnapshotCaptureError::Database)?;
    if snapshot_update.rows_affected() == 1 {
        Ok(())
    } else {
        Err(SnapshotCaptureError::GenerationConflict)
    }
}

async fn load_object_inventory(
    connection: &mut PoolConnection<Postgres>,
) -> Result<Vec<BackupObjectInventory>, SnapshotCaptureError> {
    let rows: Vec<(String, Vec<u8>, i64)> = sqlx::query_as(
        "SELECT bundle.object_key,bundle.sha256,bundle.physical_bytes
           FROM bundles bundle
          WHERE EXISTS (SELECT 1 FROM projects project
                        WHERE project.working_head_bundle_id=bundle.id)
             OR EXISTS (SELECT 1 FROM project_bundle_refs reference
                        WHERE reference.bundle_id=bundle.id)
          ORDER BY bundle.object_key",
    )
    .fetch_all(&mut **connection)
    .await
    .map_err(|_| SnapshotCaptureError::Database)?;
    rows.into_iter()
        .map(|(object_key, sha256, physical_bytes)| {
            Ok(BackupObjectInventory {
                object_key,
                sha256: sha256
                    .try_into()
                    .map_err(|_| SnapshotCaptureError::InvalidInventory)?,
                physical_bytes: u64::try_from(physical_bytes)
                    .map_err(|_| SnapshotCaptureError::InvalidInventory)?,
            })
        })
        .collect()
}

async fn install_inventory_holds(
    pool: &DatabasePool,
    generation_id: Uuid,
    inventory: &[BackupObjectInventory],
) -> Result<(), SnapshotCaptureError> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| SnapshotCaptureError::Database)?;
    connection
        .execute("BEGIN")
        .await
        .map_err(|_| SnapshotCaptureError::Database)?;
    for object in inventory {
        if sqlx::query(
            "INSERT INTO object_retention_holds(object_key,holder_kind,holder_id)
             VALUES($1,'backup',$2::uuid) ON CONFLICT DO NOTHING",
        )
        .bind(&object.object_key)
        .bind(generation_id.to_string())
        .execute(&mut *connection)
        .await
        .is_err()
        {
            let _ = connection.execute("ROLLBACK").await;
            return Err(SnapshotCaptureError::Database);
        }
    }
    connection
        .execute("COMMIT")
        .await
        .map(|_| ())
        .map_err(|_| SnapshotCaptureError::Database)
}

async fn record_inventory_expectations(
    pool: &DatabasePool,
    generation_id: Uuid,
    archive: &PgDumpArtifact,
    inventory: &[BackupObjectInventory],
) -> Result<(), SnapshotCaptureError> {
    let object_count = i64::try_from(inventory.len())
        .ok()
        .and_then(|count| count.checked_add(1))
        .ok_or(SnapshotCaptureError::InvalidInventory)?;
    let payload_bytes = inventory.iter().try_fold(archive.bytes, |total, object| {
        total.checked_add(object.physical_bytes)
    });
    let payload_bytes = i64::try_from(payload_bytes.ok_or(SnapshotCaptureError::InvalidInventory)?)
        .map_err(|_| SnapshotCaptureError::InvalidInventory)?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| SnapshotCaptureError::Database)?;
    connection
        .execute("BEGIN")
        .await
        .map_err(|_| SnapshotCaptureError::Database)?;
    let result = sqlx::query(
        "UPDATE backup_generations SET expected_object_count=$2,expected_payload_bytes=$3,
         updated_at=transaction_timestamp() WHERE id=$1::uuid AND state='preparing'
         AND expected_object_count IS NULL AND expected_payload_bytes IS NULL",
    )
    .bind(generation_id.to_string())
    .bind(object_count)
    .bind(payload_bytes)
    .execute(&mut *connection)
    .await;
    let result = match result {
        Ok(result) => result,
        Err(_) => {
            let _ = connection.execute("ROLLBACK").await;
            return Err(SnapshotCaptureError::Database);
        }
    };
    if result.rows_affected() != 1 {
        let _ = connection.execute("ROLLBACK").await;
        return Err(SnapshotCaptureError::GenerationConflict);
    }
    let result = sqlx::query(
        "UPDATE backup_generations SET state='copying',updated_at=transaction_timestamp()
         WHERE id=$1::uuid AND state='preparing'",
    )
    .bind(generation_id.to_string())
    .execute(&mut *connection)
    .await;
    let result = match result {
        Ok(result) => result,
        Err(_) => {
            let _ = connection.execute("ROLLBACK").await;
            return Err(SnapshotCaptureError::Database);
        }
    };
    if result.rows_affected() == 1 {
        connection
            .execute("COMMIT")
            .await
            .map(|_| ())
            .map_err(|_| SnapshotCaptureError::Database)
    } else {
        let _ = connection.execute("ROLLBACK").await;
        Err(SnapshotCaptureError::GenerationConflict)
    }
}

async fn cleanup_failed_capture(pool: &DatabasePool, generation_id: Uuid, archive_path: &Path) {
    let _ = fs::remove_file(archive_path);
    if let Ok(mut connection) = pool.acquire().await {
        if connection.execute("BEGIN").await.is_err() {
            return;
        }
        if sqlx::query(
            "DELETE FROM object_retention_holds WHERE holder_kind='backup' AND holder_id=$1::uuid",
        )
        .bind(generation_id.to_string())
        .execute(&mut *connection)
        .await
        .is_err()
        {
            let _ = connection.execute("ROLLBACK").await;
            return;
        }
        let _ = sqlx::query(
            "UPDATE backup_generations SET state='failed',failure_code='snapshot_capture_failed',
             completed_at=transaction_timestamp(),updated_at=transaction_timestamp()
             WHERE id=$1::uuid AND state IN ('preparing','copying')",
        )
        .bind(generation_id.to_string())
        .execute(&mut *connection)
        .await;
        let _ = connection.execute("COMMIT").await;
    }
}

fn create_output(path: &Path) -> Result<File, PgDumpError> {
    if path.parent().is_none_or(|parent| !parent.is_dir()) {
        return Err(PgDumpError::InvalidConfiguration);
    }
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| match error.kind() {
            io::ErrorKind::AlreadyExists => PgDumpError::OutputExists,
            _ => PgDumpError::OutputFailed,
        })
}

fn inspect_artifact(path: PathBuf) -> Result<PgDumpArtifact, PgDumpError> {
    let mut file = File::open(&path).map_err(|_| PgDumpError::OutputFailed)?;
    let bytes = file
        .metadata()
        .map_err(|_| PgDumpError::OutputFailed)?
        .len();
    if bytes == 0 {
        let _ = fs::remove_file(&path);
        return Err(PgDumpError::EmptyArchive);
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| PgDumpError::OutputFailed)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(PgDumpArtifact {
        path,
        sha256: hasher.finalize().into(),
        bytes,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PgDumpError {
    InvalidConfiguration,
    OutputExists,
    OutputFailed,
    SpawnFailed,
    WaitFailed,
    TimedOut,
    CommandFailed,
    EmptyArchive,
    WorkerFailed,
}

impl std::fmt::Display for PgDumpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidConfiguration => "pg_dump configuration is invalid",
            Self::OutputExists => "pg_dump output already exists",
            Self::OutputFailed => "pg_dump output could not be written",
            Self::SpawnFailed => "pg_dump could not start",
            Self::WaitFailed => "pg_dump process could not be observed",
            Self::TimedOut => "pg_dump timed out",
            Self::CommandFailed => "pg_dump failed",
            Self::EmptyArchive => "pg_dump produced an empty archive",
            Self::WorkerFailed => "pg_dump worker failed",
        })
    }
}

impl std::error::Error for PgDumpError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotCaptureError {
    Database,
    GenerationConflict,
    InvalidInventory,
    PgDump(PgDumpError),
}

impl std::fmt::Display for SnapshotCaptureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database => formatter.write_str("backup snapshot database operation failed"),
            Self::GenerationConflict => formatter.write_str("backup generation state changed"),
            Self::InvalidInventory => formatter.write_str("backup object inventory is invalid"),
            Self::PgDump(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for SnapshotCaptureError {}
