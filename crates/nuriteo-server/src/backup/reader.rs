use std::fmt;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use sqlx::Row;
use uuid::Uuid;

use crate::database::DatabasePool;

use super::{
    BackupDestination, PortableBackupManifest, PortableFormatError, PortableLimits,
    VerificationReport, write_portable_v1,
};

#[derive(Clone)]
pub struct BackupReadCoordinator {
    pool: DatabasePool,
    destination: BackupDestination,
    limits: PortableLimits,
}

impl BackupReadCoordinator {
    #[must_use]
    pub const fn new(
        pool: DatabasePool,
        destination: BackupDestination,
        limits: PortableLimits,
    ) -> Self {
        Self {
            pool,
            destination,
            limits,
        }
    }

    pub async fn list(&self) -> Result<Vec<String>, BackupReadError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| BackupReadError::Database)?;
        sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM complete_backup_restore_points ORDER BY completed_at DESC,id",
        )
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| BackupReadError::Database)
    }

    pub async fn load_manifest(
        &self,
        backup_id: &str,
    ) -> Result<PortableBackupManifest, BackupReadError> {
        let backup_id = Uuid::parse_str(backup_id).map_err(|_| BackupReadError::NotFound)?;
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| BackupReadError::Database)?;
        let row = sqlx::query(
            "SELECT manifest_sha256,schema_version FROM complete_backup_restore_points
             WHERE id=$1::uuid",
        )
        .bind(backup_id.to_string())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| BackupReadError::Database)?
        .ok_or(BackupReadError::NotFound)?;
        let digest = digest(row.try_get::<Vec<u8>, _>("manifest_sha256").ok())?;
        let schema_version = row
            .try_get::<i64, _>("schema_version")
            .ok()
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(BackupReadError::Metadata)?;
        drop(connection);

        let key = self.destination.manifest_object_key(backup_id);
        let body = self
            .destination
            .read_verified_bounded(&key, digest, self.limits.max_manifest_bytes)
            .await
            .map_err(|_| BackupReadError::Destination)?;
        let manifest: PortableBackupManifest =
            serde_json::from_slice(&body).map_err(|_| BackupReadError::Manifest)?;
        manifest
            .validate(self.limits)
            .map_err(BackupReadError::Portable)?;
        if manifest.backup_id != backup_id.to_string()
            || manifest.database.schema_version != schema_version
        {
            return Err(BackupReadError::Metadata);
        }
        Ok(manifest)
    }

    pub async fn verify(
        &self,
        backup_id: &str,
        scratch_directory: &Path,
    ) -> Result<VerificationReport, BackupReadError> {
        require_scratch_directory(scratch_directory)?;
        let manifest = self.load_manifest(backup_id).await?;
        let run_id = Uuid::now_v7();
        let mut bytes = 0_u64;
        for (index, entry) in manifest.entries.iter().enumerate() {
            let digest = parse_digest(&entry.sha256)?;
            let key = self.destination.payload_object_key(digest);
            let target = scratch_directory.join(format!("verify-{run_id}-{index}"));
            let result = self
                .destination
                .download_verified(&key, entry.bytes, digest, &target)
                .await
                .map_err(|_| BackupReadError::Destination);
            let _ = tokio::fs::remove_file(&target).await;
            result?;
            bytes = bytes
                .checked_add(entry.bytes)
                .ok_or(BackupReadError::Portable(PortableFormatError::SizeLimit))?;
        }
        Ok(VerificationReport {
            backup_id: manifest.backup_id,
            entries: manifest.entries.len(),
            bytes,
        })
    }

    pub async fn export<W: Write>(
        &self,
        backup_id: &str,
        scratch_directory: &Path,
        output: &mut W,
    ) -> Result<VerificationReport, BackupReadError> {
        require_scratch_directory(scratch_directory)?;
        let manifest = self.load_manifest(backup_id).await?;
        let run_id = Uuid::now_v7();
        let mut staged = Vec::with_capacity(manifest.entries.len());
        for (index, entry) in manifest.entries.iter().enumerate() {
            let digest = parse_digest(&entry.sha256)?;
            let key = self.destination.payload_object_key(digest);
            let target = scratch_directory.join(format!("export-{run_id}-{index}"));
            if self
                .destination
                .download_verified(&key, entry.bytes, digest, &target)
                .await
                .is_err()
            {
                remove_staged(&staged).await;
                return Err(BackupReadError::Destination);
            }
            staged.push(target);
        }

        let mut index = 0_usize;
        let export = write_portable_v1(output, &manifest, self.limits, |entry| {
            let target = staged
                .get(index)
                .ok_or_else(|| std::io::Error::other("backup entry is not staged"))?;
            if manifest.entries[index].path != entry.path {
                return Err(std::io::Error::other("backup entry order drifted"));
            }
            index += 1;
            File::open(target).map(|file| Box::new(file) as Box<dyn Read>)
        })
        .map_err(BackupReadError::Portable);
        remove_staged(&staged).await;
        export?;

        let bytes = manifest.entries.iter().try_fold(0_u64, |total, entry| {
            total
                .checked_add(entry.bytes)
                .ok_or(BackupReadError::Portable(PortableFormatError::SizeLimit))
        })?;
        Ok(VerificationReport {
            backup_id: manifest.backup_id,
            entries: manifest.entries.len(),
            bytes,
        })
    }

    pub async fn stage(
        &self,
        backup_id: &str,
        scratch_directory: &Path,
    ) -> Result<StagedBackup, BackupReadError> {
        require_scratch_directory(scratch_directory)?;
        let manifest = self.load_manifest(backup_id).await?;
        let directory = tempfile::Builder::new()
            .prefix("nuriteo-restore-")
            .tempdir_in(scratch_directory)
            .map_err(|_| BackupReadError::Scratch)?;
        let mut paths = Vec::with_capacity(manifest.entries.len());
        for (index, entry) in manifest.entries.iter().enumerate() {
            let digest = parse_digest(&entry.sha256)?;
            let key = self.destination.payload_object_key(digest);
            let target = directory.path().join(format!("entry-{index}"));
            self.destination
                .download_verified(&key, entry.bytes, digest, &target)
                .await
                .map_err(|_| BackupReadError::Destination)?;
            paths.push(target);
        }
        Ok(StagedBackup {
            _directory: directory,
            manifest,
            paths,
        })
    }
}

pub struct StagedBackup {
    _directory: tempfile::TempDir,
    manifest: PortableBackupManifest,
    paths: Vec<std::path::PathBuf>,
}

impl StagedBackup {
    #[must_use]
    pub const fn manifest(&self) -> &PortableBackupManifest {
        &self.manifest
    }

    pub fn database_archive(&self) -> Result<&Path, BackupReadError> {
        self.paths
            .first()
            .map(std::path::PathBuf::as_path)
            .ok_or(BackupReadError::Manifest)
    }

    pub fn payload_for_digest(&self, digest: &str) -> Result<&Path, BackupReadError> {
        let index = self
            .manifest
            .entries
            .iter()
            .position(|entry| entry.sha256 == digest)
            .ok_or(BackupReadError::Manifest)?;
        self.paths
            .get(index)
            .map(std::path::PathBuf::as_path)
            .ok_or(BackupReadError::Manifest)
    }
}

async fn remove_staged(paths: &[std::path::PathBuf]) {
    for path in paths {
        let _ = tokio::fs::remove_file(path).await;
    }
}

fn require_scratch_directory(path: &Path) -> Result<(), BackupReadError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| BackupReadError::Scratch)?;
    if !path.is_absolute() || !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(BackupReadError::Scratch);
    }
    Ok(())
}

fn digest(value: Option<Vec<u8>>) -> Result<[u8; 32], BackupReadError> {
    value
        .and_then(|value| value.try_into().ok())
        .ok_or(BackupReadError::Metadata)
}

fn parse_digest(value: &str) -> Result<[u8; 32], BackupReadError> {
    if value.len() != 64 {
        return Err(BackupReadError::Manifest);
    }
    let mut digest = [0_u8; 32];
    for (index, output) in digest.iter_mut().enumerate() {
        let offset = index * 2;
        *output = u8::from_str_radix(&value[offset..offset + 2], 16)
            .map_err(|_| BackupReadError::Manifest)?;
    }
    Ok(digest)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupReadError {
    NotFound,
    Database,
    Destination,
    Manifest,
    Metadata,
    Scratch,
    Portable(PortableFormatError),
}

impl fmt::Display for BackupReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.category())
    }
}

impl std::error::Error for BackupReadError {}

impl BackupReadError {
    #[must_use]
    pub const fn category(self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::Database => "database",
            Self::Destination => "destination",
            Self::Manifest => "manifest",
            Self::Metadata => "metadata",
            Self::Scratch => "scratch",
            Self::Portable(_) => "invalid-portable-backup",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_canonical_sha256_digests() {
        let valid = "00ff".repeat(16);
        assert_eq!(parse_digest(&valid).unwrap()[..4], [0, 255, 0, 255]);
        assert_eq!(parse_digest("0").unwrap_err(), BackupReadError::Manifest);
        assert_eq!(
            parse_digest(&"GG".repeat(32)).unwrap_err(),
            BackupReadError::Manifest
        );
    }

    #[test]
    fn scratch_must_be_an_absolute_real_directory() {
        let temporary = tempfile::tempdir().unwrap();
        assert_eq!(require_scratch_directory(temporary.path()), Ok(()));
        assert_eq!(
            require_scratch_directory(Path::new("relative")),
            Err(BackupReadError::Scratch)
        );
    }
}
