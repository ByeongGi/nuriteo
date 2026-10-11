use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::portable::{
    ManifestEntry, PortableBackupManifest, PortableFormatError, PortableLimits, read_portable_v1,
    write_portable_v1,
};

const COMPLETE_MARKER: &str = ".complete";
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationReport {
    pub backup_id: String,
    pub entries: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrunePolicy {
    /// Restore points selected by daily/weekly/monthly/pinned retention or an
    /// external legal/object hold. They are never eligible for deletion.
    pub protected_backup_ids: BTreeSet<String>,
    /// Upper bound for one invocation. A caller must schedule another bounded
    /// run instead of turning pruning into an unbounded foreground operation.
    pub max_deletions: usize,
}

impl Default for PrunePolicy {
    fn default() -> Self {
        Self {
            protected_backup_ids: BTreeSet::new(),
            max_deletions: 100,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupEngineError {
    InvalidRepository,
    NotFound,
    NotComplete,
    AlreadyExists,
    Io,
    Portable(PortableFormatError),
    TargetNotEmpty,
    RestoreInterrupted,
    RestoreValidation,
    RetentionProtected,
    InvalidPolicy,
}

impl fmt::Display for BackupEngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRepository => "backup repository configuration is invalid",
            Self::NotFound => "backup restore point was not found",
            Self::NotComplete => "backup is not a complete restore point",
            Self::AlreadyExists => "backup restore point already exists",
            Self::Io => "backup repository I/O failed",
            Self::Portable(error) => return error.fmt(formatter),
            Self::TargetNotEmpty => "restore target must be empty",
            Self::RestoreInterrupted => "restore was interrupted before cutover",
            Self::RestoreValidation => "staged restore validation failed",
            Self::RetentionProtected => "backup is protected by retention or hold",
            Self::InvalidPolicy => "backup prune policy is invalid",
        })
    }
}

impl std::error::Error for BackupEngineError {}

impl From<PortableFormatError> for BackupEngineError {
    fn from(error: PortableFormatError) -> Self {
        Self::Portable(error)
    }
}

impl From<io::Error> for BackupEngineError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

pub trait BackupImport: Send {
    fn write_entry(
        &mut self,
        entry: &ManifestEntry,
        source: &mut dyn Read,
    ) -> Result<(), BackupEngineError>;

    fn commit(self: Box<Self>, manifest: &PortableBackupManifest) -> Result<(), BackupEngineError>;
}

pub trait BackupRepository: Send + Sync {
    fn list_complete(&self) -> Result<Vec<String>, BackupEngineError>;
    fn load_complete_manifest(
        &self,
        backup_id: &str,
    ) -> Result<PortableBackupManifest, BackupEngineError>;
    fn open_entry(
        &self,
        backup_id: &str,
        entry: &ManifestEntry,
    ) -> Result<Box<dyn Read>, BackupEngineError>;
    fn begin_import(&self, backup_id: &str) -> Result<Box<dyn BackupImport>, BackupEngineError>;
    fn prune(&self, backup_id: &str, policy: &PrunePolicy) -> Result<(), BackupEngineError>;
}

/// Restore implementations stage into an empty database and bucket. `cutover`
/// is deliberately a separate final call so no error or cancellation before
/// complete validation can expose partially restored data.
pub trait RestoreTarget {
    fn require_empty(&mut self) -> Result<(), BackupEngineError>;
    fn begin_staging(&mut self, manifest: &PortableBackupManifest)
    -> Result<(), BackupEngineError>;
    fn stage_entry(
        &mut self,
        entry: &ManifestEntry,
        source: &mut dyn Read,
    ) -> Result<(), BackupEngineError>;
    fn validate_staging(
        &mut self,
        manifest: &PortableBackupManifest,
    ) -> Result<(), BackupEngineError>;
    fn cutover(&mut self) -> Result<(), BackupEngineError>;
    fn abort_staging(&mut self);
}

pub struct BackupEngine<R> {
    repository: R,
    limits: PortableLimits,
}

impl<R: BackupRepository> BackupEngine<R> {
    #[must_use]
    pub const fn new(repository: R, limits: PortableLimits) -> Self {
        Self { repository, limits }
    }

    pub fn list(&self) -> Result<Vec<String>, BackupEngineError> {
        self.repository.list_complete()
    }

    pub fn verify(&self, backup_id: &str) -> Result<VerificationReport, BackupEngineError> {
        let manifest = self.repository.load_complete_manifest(backup_id)?;
        manifest.validate(self.limits)?;
        let mut bytes = 0_u64;
        for entry in &manifest.entries {
            let mut source = self.repository.open_entry(backup_id, entry)?;
            verify_reader(&mut source, entry)?;
            bytes = bytes
                .checked_add(entry.bytes)
                .ok_or(BackupEngineError::Portable(PortableFormatError::SizeLimit))?;
        }
        Ok(VerificationReport {
            backup_id: manifest.backup_id,
            entries: manifest.entries.len(),
            bytes,
        })
    }

    pub fn export<W: Write>(
        &self,
        backup_id: &str,
        output: &mut W,
    ) -> Result<(), BackupEngineError> {
        // Verify before emitting the first byte. This keeps corrupt local or
        // remote objects from producing a stream that resembles a valid export.
        self.verify(backup_id)?;
        let manifest = self.repository.load_complete_manifest(backup_id)?;
        write_portable_v1(output, &manifest, self.limits, |entry| {
            self.repository
                .open_entry(backup_id, entry)
                .map_err(|_| io::Error::other("backup entry unavailable"))
        })?;
        Ok(())
    }

    pub fn import<Rd: Read>(
        &self,
        input: &mut Rd,
    ) -> Result<VerificationReport, BackupEngineError> {
        let mut session: Option<Box<dyn BackupImport>> = None;
        let manifest = read_portable_v1(input, self.limits, |entry, source| {
            if session.is_none() {
                // The manifest is validated before this closure is called, but
                // is returned only after the stream is consumed. Use a random,
                // non-observable staging id; commit uses the declared id.
                session = Some(
                    self.repository
                        .begin_import(&format!("incoming-{}", Uuid::now_v7()))
                        .map_err(|_| io::Error::other("cannot create import staging"))?,
                );
            }
            session
                .as_mut()
                .ok_or_else(|| io::Error::other("import staging unavailable"))?
                .write_entry(entry, source)
                .map_err(|_| io::Error::other("cannot stage import entry"))
        })?;
        let session = session.ok_or(BackupEngineError::Portable(
            PortableFormatError::MissingEntry,
        ))?;
        let report = VerificationReport {
            backup_id: manifest.backup_id.clone(),
            entries: manifest.entries.len(),
            bytes: manifest.entries.iter().map(|entry| entry.bytes).sum(),
        };
        session.commit(&manifest)?;
        Ok(report)
    }

    pub fn restore<T: RestoreTarget>(
        &self,
        backup_id: &str,
        target: &mut T,
    ) -> Result<VerificationReport, BackupEngineError> {
        let report = self.verify(backup_id)?;
        let manifest = self.repository.load_complete_manifest(backup_id)?;
        target.require_empty()?;
        if let Err(error) = target.begin_staging(&manifest) {
            target.abort_staging();
            return Err(error);
        }
        for entry in &manifest.entries {
            let result = self
                .repository
                .open_entry(backup_id, entry)
                .and_then(|mut source| target.stage_entry(entry, &mut source));
            if let Err(error) = result {
                target.abort_staging();
                return Err(error);
            }
        }
        if target.validate_staging(&manifest).is_err() {
            target.abort_staging();
            return Err(BackupEngineError::RestoreValidation);
        }
        target.cutover()?;
        Ok(report)
    }

    pub fn prune(&self, policy: &PrunePolicy) -> Result<Vec<String>, BackupEngineError> {
        if policy.max_deletions == 0 || policy.max_deletions > 10_000 {
            return Err(BackupEngineError::InvalidPolicy);
        }
        let mut deleted = Vec::new();
        for backup_id in self.repository.list_complete()? {
            if deleted.len() == policy.max_deletions {
                break;
            }
            if policy.protected_backup_ids.contains(&backup_id) {
                continue;
            }
            match self.repository.prune(&backup_id, policy) {
                Ok(()) => deleted.push(backup_id),
                Err(BackupEngineError::RetentionProtected) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(deleted)
    }
}

fn verify_reader(source: &mut dyn Read, entry: &ManifestEntry) -> Result<(), BackupEngineError> {
    let mut limited = source.take(entry.bytes);
    let mut digest = Sha256::new();
    let copied = io::copy(&mut limited, &mut DigestWriter(&mut digest))?;
    if copied != entry.bytes {
        return Err(BackupEngineError::Portable(
            PortableFormatError::SizeMismatch,
        ));
    }
    let mut extra = [0_u8; 1];
    if source.read(&mut extra)? != 0 {
        return Err(BackupEngineError::Portable(
            PortableFormatError::SizeMismatch,
        ));
    }
    let digest = digest.finalize();
    let mut actual = String::with_capacity(64);
    for byte in digest.as_slice() {
        use std::fmt::Write as _;
        let _ = write!(actual, "{byte:02x}");
    }
    if actual != entry.sha256 {
        return Err(BackupEngineError::Portable(
            PortableFormatError::ChecksumMismatch,
        ));
    }
    Ok(())
}

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct DirectoryBackupRepository {
    root: PathBuf,
}

impl DirectoryBackupRepository {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, BackupEngineError> {
        let root = root.as_ref();
        if !root.is_absolute() || !root.is_dir() {
            return Err(BackupEngineError::InvalidRepository);
        }
        let metadata = fs::symlink_metadata(root)?;
        if metadata.file_type().is_symlink() {
            return Err(BackupEngineError::InvalidRepository);
        }
        Ok(Self {
            root: root.to_owned(),
        })
    }

    fn backup_path(&self, backup_id: &str) -> Result<PathBuf, BackupEngineError> {
        if backup_id.is_empty()
            || backup_id.len() > 128
            || !backup_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(BackupEngineError::NotFound);
        }
        Ok(self.root.join(backup_id))
    }
}

impl BackupRepository for DirectoryBackupRepository {
    fn list_complete(&self) -> Result<Vec<String>, BackupEngineError> {
        let mut backups = Vec::new();
        for item in fs::read_dir(&self.root)? {
            let item = item?;
            let metadata = item.file_type()?;
            if !metadata.is_dir() {
                continue;
            }
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with(".incoming-") || name.starts_with("incoming-") {
                continue;
            }
            if item.path().join(COMPLETE_MARKER).is_file() {
                backups.push(name);
            }
        }
        backups.sort();
        Ok(backups)
    }

    fn load_complete_manifest(
        &self,
        backup_id: &str,
    ) -> Result<PortableBackupManifest, BackupEngineError> {
        let path = self.backup_path(backup_id)?;
        if !path.exists() {
            return Err(BackupEngineError::NotFound);
        }
        if !path.join(COMPLETE_MARKER).is_file() {
            return Err(BackupEngineError::NotComplete);
        }
        let file = File::open(path.join(MANIFEST_FILE))?;
        serde_json::from_reader(file)
            .map_err(|_| BackupEngineError::Portable(PortableFormatError::InvalidManifest))
    }

    fn open_entry(
        &self,
        backup_id: &str,
        entry: &ManifestEntry,
    ) -> Result<Box<dyn Read>, BackupEngineError> {
        let path = self.backup_path(backup_id)?.join(&entry.path);
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                BackupEngineError::Portable(PortableFormatError::MissingEntry)
            } else {
                BackupEngineError::Io
            }
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(BackupEngineError::Portable(
                PortableFormatError::InvalidEntryType,
            ));
        }
        Ok(Box::new(File::open(path)?))
    }

    fn begin_import(&self, staging_id: &str) -> Result<Box<dyn BackupImport>, BackupEngineError> {
        let path = self.root.join(format!(".{staging_id}"));
        fs::create_dir(&path).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                BackupEngineError::AlreadyExists
            } else {
                BackupEngineError::Io
            }
        })?;
        Ok(Box::new(DirectoryImport {
            root: self.root.clone(),
            staging: path,
            committed: false,
        }))
    }

    fn prune(&self, backup_id: &str, policy: &PrunePolicy) -> Result<(), BackupEngineError> {
        if policy.protected_backup_ids.contains(backup_id) {
            return Err(BackupEngineError::RetentionProtected);
        }
        let path = self.backup_path(backup_id)?;
        // The hold marker models an external/provider hold in the file adapter;
        // DB-backed production pruning additionally relies on BKP-001 triggers.
        if path.join(".hold").exists() {
            return Err(BackupEngineError::RetentionProtected);
        }
        fs::remove_dir_all(path)?;
        Ok(())
    }
}

struct DirectoryImport {
    root: PathBuf,
    staging: PathBuf,
    committed: bool,
}

impl BackupImport for DirectoryImport {
    fn write_entry(
        &mut self,
        entry: &ManifestEntry,
        source: &mut dyn Read,
    ) -> Result<(), BackupEngineError> {
        let target = self.staging.join(&entry.path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        let copied = io::copy(source, &mut file)?;
        if copied != entry.bytes {
            return Err(BackupEngineError::Portable(
                PortableFormatError::SizeMismatch,
            ));
        }
        file.sync_all()?;
        Ok(())
    }

    fn commit(
        mut self: Box<Self>,
        manifest: &PortableBackupManifest,
    ) -> Result<(), BackupEngineError> {
        let destination = self.root.join(&manifest.backup_id);
        if destination.exists() {
            return Err(BackupEngineError::AlreadyExists);
        }
        let mut manifest_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.staging.join(MANIFEST_FILE))?;
        serde_json::to_writer(&mut manifest_file, manifest).map_err(|_| BackupEngineError::Io)?;
        manifest_file.sync_all()?;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.staging.join(COMPLETE_MARKER))?
            .sync_all()?;
        fs::rename(&self.staging, destination)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for DirectoryImport {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.staging);
        }
    }
}
