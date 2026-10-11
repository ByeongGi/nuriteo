use std::collections::BTreeSet;
use std::fmt;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use sqlx::Executor;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::VERSION;
use crate::database::DatabasePool;
use crate::object_storage::{ObjectKey, S3ObjectStore};

use super::{
    BackupDestination, BackupObjectInventory, CommandPgDump, CreatedBy, DatabaseDescriptor,
    ExportedBackupSnapshot, ManifestEntry, ManifestEntryKind, PortableBackupManifest,
    SnapshotCaptureError, VerificationReport,
};

#[derive(Clone)]
pub struct BackupCreateCoordinator {
    pool: DatabasePool,
    primary: S3ObjectStore,
    destination: BackupDestination,
}

impl BackupCreateCoordinator {
    #[must_use]
    pub const fn new(
        pool: DatabasePool,
        primary: S3ObjectStore,
        destination: BackupDestination,
    ) -> Self {
        Self {
            pool,
            primary,
            destination,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        generation_id: Uuid,
        schema_version: i64,
        postgres_major: i32,
        dump: CommandPgDump,
        scratch_directory: &Path,
    ) -> Result<VerificationReport, BackupCreateError> {
        validate_create_input(schema_version, postgres_major, scratch_directory)?;
        self.destination
            .preflight()
            .await
            .map_err(|_| BackupCreateError::DestinationPreflight)?;
        self.insert_generation(generation_id, schema_version, postgres_major)
            .await?;
        let archive_path = dump.output_path().to_path_buf();
        let result = self
            .create_inner(
                generation_id,
                u64::try_from(schema_version).map_err(|_| BackupCreateError::Input)?,
                dump,
                scratch_directory,
            )
            .await;
        let _ = tokio::fs::remove_file(archive_path).await;
        if let Err(error) = result {
            self.fail_generation(generation_id, error.category()).await;
            return Err(error);
        }
        result
    }

    async fn create_inner(
        &self,
        generation_id: Uuid,
        schema_version: u64,
        dump: CommandPgDump,
        scratch_directory: &Path,
    ) -> Result<VerificationReport, BackupCreateError> {
        let captured = ExportedBackupSnapshot::begin(self.pool.clone(), generation_id)
            .await
            .map_err(BackupCreateError::Snapshot)?
            .capture(dump)
            .await
            .map_err(BackupCreateError::Snapshot)?;

        let database = self
            .destination
            .put_verified_file(
                captured.database_archive.sha256,
                captured.database_archive.bytes,
                &captured.database_archive.path,
            )
            .await
            .map_err(|_| BackupCreateError::DestinationWrite)?;
        self.record_entry(generation_id, 1, "database_archive", None, &database)
            .await?;

        let mut manifest_entries = vec![ManifestEntry {
            path: "database.dump".into(),
            kind: ManifestEntryKind::DatabaseArchive,
            bytes: database.bytes,
            sha256: hex_digest(database.sha256),
        }];
        let mut included_payloads = BTreeSet::new();
        for (index, object) in captured.objects.iter().enumerate() {
            let temporary = scratch_path(scratch_directory, object.sha256);
            let copy_result = self.download_primary(object, &temporary).await;
            if let Err(error) = copy_result {
                let _ = tokio::fs::remove_file(&temporary).await;
                return Err(error);
            }
            let stored = self
                .destination
                .put_verified_file(object.sha256, object.physical_bytes, &temporary)
                .await
                .map_err(|_| BackupCreateError::DestinationWrite);
            let _ = tokio::fs::remove_file(&temporary).await;
            let stored = stored?;
            let ordinal = i64::try_from(index)
                .ok()
                .and_then(|value| value.checked_add(2))
                .ok_or(BackupCreateError::Input)?;
            self.record_entry(
                generation_id,
                ordinal,
                "project_bundle",
                Some(&object.object_key),
                &stored,
            )
            .await?;
            if included_payloads.insert(object.sha256) {
                let digest = hex_digest(object.sha256);
                manifest_entries.push(ManifestEntry {
                    path: format!("payloads/sha256/{}/{}", &digest[..2], digest),
                    kind: ManifestEntryKind::Payload,
                    bytes: object.physical_bytes,
                    sha256: digest,
                });
            }
        }
        manifest_entries[1..].sort_by(|left, right| left.sha256.cmp(&right.sha256));
        let manifest = PortableBackupManifest {
            format: "nuriteo-portable".into(),
            format_version: 1,
            backup_id: generation_id.to_string(),
            created_by: CreatedBy {
                version: VERSION.into(),
            },
            database: DatabaseDescriptor {
                schema_version,
                archive_format: "postgres-custom".into(),
            },
            required_features: Vec::new(),
            entries: manifest_entries,
            extensions: Default::default(),
        };
        let manifest_bytes =
            serde_json::to_vec(&manifest).map_err(|_| BackupCreateError::Manifest)?;
        let manifest_object = self
            .destination
            .put_verified_bytes(
                &format!("restore-points/{generation_id}/manifest.json"),
                manifest_bytes,
            )
            .await
            .map_err(|_| BackupCreateError::DestinationWrite)?;
        self.complete_generation(generation_id, manifest_object.sha256)
            .await?;
        let bytes = captured
            .objects
            .iter()
            .try_fold(captured.database_archive.bytes, |total, object| {
                total.checked_add(object.physical_bytes)
            })
            .ok_or(BackupCreateError::Input)?;
        Ok(VerificationReport {
            backup_id: generation_id.to_string(),
            entries: captured.objects.len() + 1,
            bytes,
        })
    }

    async fn download_primary(
        &self,
        object: &BackupObjectInventory,
        target: &Path,
    ) -> Result<(), BackupCreateError> {
        let key =
            ObjectKey::parse(object.object_key.clone()).map_err(|_| BackupCreateError::Source)?;
        let stream = self
            .primary
            .get_stream(&key, object.physical_bytes)
            .await
            .map_err(|_| BackupCreateError::Source)?;
        if stream.metadata.content_length != object.physical_bytes {
            return Err(BackupCreateError::SourceVerification);
        }
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .await
            .map_err(|_| BackupCreateError::Scratch)?;
        let mut reader = stream.reader;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .await
                .map_err(|_| BackupCreateError::Source)?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(read as u64)
                .ok_or(BackupCreateError::SourceVerification)?;
            file.write_all(&buffer[..read])
                .await
                .map_err(|_| BackupCreateError::Scratch)?;
            hasher.update(&buffer[..read]);
        }
        file.sync_all()
            .await
            .map_err(|_| BackupCreateError::Scratch)?;
        if copied != object.physical_bytes || <[u8; 32]>::from(hasher.finalize()) != object.sha256 {
            return Err(BackupCreateError::SourceVerification);
        }
        Ok(())
    }

    async fn insert_generation(
        &self,
        generation_id: Uuid,
        schema_version: i64,
        postgres_major: i32,
    ) -> Result<(), BackupCreateError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| BackupCreateError::Database)?;
        sqlx::query(
            "INSERT INTO backup_generations
             (id,nuriteo_version,schema_version,postgres_major,synchronized_snapshot_id,
              expected_object_count,expected_payload_bytes)
             VALUES($1::uuid,$2,$3,$4,NULL,NULL,NULL)",
        )
        .bind(generation_id.to_string())
        .bind(VERSION)
        .bind(schema_version)
        .bind(postgres_major)
        .execute(&mut *connection)
        .await
        .map_err(|_| BackupCreateError::GenerationConflict)?;
        Ok(())
    }

    async fn record_entry(
        &self,
        generation_id: Uuid,
        ordinal: i64,
        component: &str,
        source_key: Option<&str>,
        stored: &super::BackupStoredObject,
    ) -> Result<(), BackupCreateError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| BackupCreateError::Database)?;
        connection
            .execute("BEGIN")
            .await
            .map_err(|_| BackupCreateError::Database)?;
        let payload_bytes = i64::try_from(stored.bytes).map_err(|_| BackupCreateError::Input)?;
        let inserted = sqlx::query(
            "INSERT INTO backup_payloads
             (sha256,destination_object_key,destination_version_id,payload_bytes)
             VALUES($1,$2,$3,$4) ON CONFLICT(sha256) DO NOTHING",
        )
        .bind(stored.sha256.as_slice())
        .bind(&stored.key)
        .bind(stored.version_id.as_deref())
        .bind(payload_bytes)
        .execute(&mut *connection)
        .await;
        if inserted.is_err() {
            let _ = connection.execute("ROLLBACK").await;
            return Err(BackupCreateError::Database);
        }
        let compatible: bool = sqlx::query_scalar(
            "SELECT destination_object_key=$2 AND payload_bytes=$3
             FROM backup_payloads WHERE sha256=$1",
        )
        .bind(stored.sha256.as_slice())
        .bind(&stored.key)
        .bind(payload_bytes)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| BackupCreateError::Database)?;
        if !compatible {
            let _ = connection.execute("ROLLBACK").await;
            return Err(BackupCreateError::DestinationConflict);
        }
        sqlx::query(
            "INSERT INTO backup_manifest_entries
             (backup_id,ordinal,component,source_object_key,payload_sha256,payload_bytes)
             VALUES($1::uuid,$2,$3,$4,$5,$6)",
        )
        .bind(generation_id.to_string())
        .bind(ordinal)
        .bind(component)
        .bind(source_key)
        .bind(stored.sha256.as_slice())
        .bind(payload_bytes)
        .execute(&mut *connection)
        .await
        .map_err(|_| BackupCreateError::Database)?;
        connection
            .execute("COMMIT")
            .await
            .map_err(|_| BackupCreateError::Database)?;
        Ok(())
    }

    async fn complete_generation(
        &self,
        generation_id: Uuid,
        manifest_digest: [u8; 32],
    ) -> Result<(), BackupCreateError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| BackupCreateError::Database)?;
        connection
            .execute("BEGIN")
            .await
            .map_err(|_| BackupCreateError::Database)?;
        for (from, to) in [("copying", "verifying"), ("verifying", "complete")] {
            let digest = (to == "complete").then_some(manifest_digest.as_slice());
            let result = sqlx::query(
                "UPDATE backup_generations SET state=$3,manifest_sha256=COALESCE($4,manifest_sha256),
                 completed_at=CASE WHEN $3='complete' THEN transaction_timestamp() ELSE completed_at END,
                 updated_at=transaction_timestamp() WHERE id=$1::uuid AND state=$2",
            )
            .bind(generation_id.to_string())
            .bind(from)
            .bind(to)
            .bind(digest)
            .execute(&mut *connection)
            .await
            .map_err(|_| BackupCreateError::Database)?;
            if result.rows_affected() != 1 {
                let _ = connection.execute("ROLLBACK").await;
                return Err(BackupCreateError::GenerationConflict);
            }
        }
        connection
            .execute("COMMIT")
            .await
            .map_err(|_| BackupCreateError::Database)?;
        Ok(())
    }

    async fn fail_generation(&self, generation_id: Uuid, failure_code: &'static str) {
        let Ok(mut connection) = self.pool.acquire().await else {
            return;
        };
        if connection.execute("BEGIN").await.is_err() {
            return;
        }
        let _ = sqlx::query(
            "DELETE FROM object_retention_holds WHERE holder_kind='backup' AND holder_id=$1::uuid",
        )
        .bind(generation_id.to_string())
        .execute(&mut *connection)
        .await;
        let _ = sqlx::query(
            "UPDATE backup_generations SET state='failed',failure_code=$2,
             completed_at=transaction_timestamp(),updated_at=transaction_timestamp()
             WHERE id=$1::uuid AND state IN ('preparing','copying','verifying')",
        )
        .bind(generation_id.to_string())
        .bind(failure_code)
        .execute(&mut *connection)
        .await;
        let _ = connection.execute("COMMIT").await;
    }
}

fn validate_create_input(
    schema_version: i64,
    postgres_major: i32,
    scratch_directory: &Path,
) -> Result<(), BackupCreateError> {
    let metadata =
        std::fs::symlink_metadata(scratch_directory).map_err(|_| BackupCreateError::Input)?;
    if schema_version <= 0
        || !(14..=99).contains(&postgres_major)
        || !scratch_directory.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
    {
        return Err(BackupCreateError::Input);
    }
    Ok(())
}

fn scratch_path(directory: &Path, digest: [u8; 32]) -> PathBuf {
    directory.join(format!("backup-payload-{}", hex_digest(digest)))
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

#[derive(Debug)]
pub enum BackupCreateError {
    Input,
    DestinationPreflight,
    GenerationConflict,
    Snapshot(SnapshotCaptureError),
    Source,
    SourceVerification,
    Scratch,
    DestinationWrite,
    DestinationConflict,
    Manifest,
    Database,
}

impl BackupCreateError {
    #[must_use]
    pub const fn category(&self) -> &'static str {
        match self {
            Self::Input => "invalid_input",
            Self::DestinationPreflight => "destination_preflight",
            Self::GenerationConflict => "generation_conflict",
            Self::Snapshot(_) => "snapshot_capture",
            Self::Source => "source_read",
            Self::SourceVerification => "source_verification",
            Self::Scratch => "scratch_io",
            Self::DestinationWrite => "destination_write",
            Self::DestinationConflict => "destination_conflict",
            Self::Manifest => "manifest_encoding",
            Self::Database => "database_operation",
        }
    }
}

impl fmt::Display for BackupCreateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "backup create failed ({})", self.category())
    }
}

impl std::error::Error for BackupCreateError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scratch_contract_requires_an_absolute_real_directory() {
        let directory = tempfile::tempdir().unwrap();
        assert!(validate_create_input(48, 17, directory.path()).is_ok());
        assert!(matches!(
            validate_create_input(0, 17, directory.path()),
            Err(BackupCreateError::Input)
        ));
        assert!(matches!(
            validate_create_input(48, 13, directory.path()),
            Err(BackupCreateError::Input)
        ));
        assert!(matches!(
            validate_create_input(48, 17, Path::new("relative")),
            Err(BackupCreateError::Input)
        ));
    }

    #[test]
    fn scratch_names_are_content_addressed_and_error_text_is_redacted() {
        let path = scratch_path(Path::new("/tmp/backup"), [0xcd; 32]);
        assert_eq!(
            path,
            Path::new("/tmp/backup").join(
                "backup-payload-cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
            )
        );
        assert_eq!(
            BackupCreateError::SourceVerification.to_string(),
            "backup create failed (source_verification)"
        );
    }
}
