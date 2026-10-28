use std::{
    error::Error,
    fmt::{self, Display, Formatter},
};

/// Versioned copy of every filesystem node.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FsSnapshot {
    /// Schema version. This kernel restores version 1.
    pub version: u32,
    /// Next inode id the restored filesystem will allocate.
    pub next_inode: u64,
    /// Nodes sorted by inode id.
    pub entries: Vec<SnapshotEntry>,
    /// Hash of the version, next inode, and entries.
    pub integrity: u64,
}

/// One node stored in a filesystem snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SnapshotEntry {
    /// Inode id in the source filesystem.
    pub inode: u64,
    /// File bytes, directory children, or symlink target.
    pub kind: SnapshotEntryKind,
}

/// Payload stored for one snapshot inode.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SnapshotEntryKind {
    /// Regular file bytes and hard-link count.
    File {
        /// File contents.
        data: Vec<u8>,
        /// Directory entries that point at this file.
        nlink: u32,
    },
    /// Directory entries stored as name and inode pairs.
    Directory {
        /// Child names and their inode ids.
        entries: Vec<(String, u64)>,
    },
    /// Symbolic link target path.
    Symlink {
        /// Path stored in the symlink.
        target: String,
    },
}

/// Why a filesystem snapshot was rejected.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SnapshotError {
    /// The snapshot version is not the one this kernel restores.
    UnsupportedVersion,
    /// The stored hash does not match the entries.
    IntegrityMismatch,
    /// The snapshot has no root directory.
    MissingRoot,
}

impl Display for SnapshotError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedVersion => "unsupported snapshot version",
            Self::IntegrityMismatch => "snapshot integrity mismatch",
            Self::MissingRoot => "snapshot is missing its root",
        })
    }
}

impl Error for SnapshotError {}

impl FsSnapshot {
    /// Builds a snapshot and stores its integrity hash.
    #[must_use]
    pub fn new(version: u32, next_inode: u64, mut entries: Vec<SnapshotEntry>) -> Self {
        entries.sort_by_key(|entry| entry.inode);
        let integrity = compute_integrity(version, next_inode, &entries);
        Self {
            version,
            next_inode,
            entries,
            integrity,
        }
    }

    /// Checks that the version is 1 and the integrity hash matches the entries.
    ///
    /// # Errors
    /// Returns [`SnapshotError::UnsupportedVersion`] for any version other than 1
    /// and [`SnapshotError::IntegrityMismatch`] when the hash differs.
    /// A missing root is reported by [`crate::fs::SystemFs::restore`], not here.
    pub fn verify(&self) -> Result<(), SnapshotError> {
        if self.version != 1 {
            return Err(SnapshotError::UnsupportedVersion);
        }
        if self.integrity != compute_integrity(self.version, self.next_inode, &self.entries) {
            return Err(SnapshotError::IntegrityMismatch);
        }
        Ok(())
    }
}

fn compute_integrity(version: u32, next_inode: u64, entries: &[SnapshotEntry]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    mix_u64(&mut hash, u64::from(version));
    mix_u64(&mut hash, next_inode);
    for entry in entries {
        mix_u64(&mut hash, entry.inode);
        match &entry.kind {
            SnapshotEntryKind::File { data, nlink } => {
                mix_u64(&mut hash, 1);
                mix_u64(&mut hash, u64::from(*nlink));
                mix_bytes(&mut hash, data);
            }
            SnapshotEntryKind::Directory { entries } => {
                mix_u64(&mut hash, 2);
                let mut sorted = entries.clone();
                sorted.sort();
                for (name, inode) in &sorted {
                    mix_bytes(&mut hash, name.as_bytes());
                    mix_u64(&mut hash, *inode);
                }
            }
            SnapshotEntryKind::Symlink { target } => {
                mix_u64(&mut hash, 3);
                mix_bytes(&mut hash, target.as_bytes());
            }
        }
    }
    hash
}

fn mix_u64(hash: &mut u64, value: u64) {
    mix_bytes(hash, &value.to_le_bytes());
}

fn mix_bytes(hash: &mut u64, bytes: &[u8]) {
    mix_u64_len(
        hash,
        u64::try_from(bytes.len()).expect("snapshot byte length fits in u64"),
    );
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn mix_u64_len(hash: &mut u64, value: u64) {
    for byte in value.to_le_bytes() {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}
