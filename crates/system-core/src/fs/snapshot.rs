#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsSnapshot {
    pub version: u32,
    pub next_inode: u64,
    pub entries: Vec<SnapshotEntry>,
    pub integrity: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotEntry {
    pub inode: u64,
    pub kind: SnapshotEntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotEntryKind {
    File { data: Vec<u8>, nlink: u32 },
    Directory { entries: Vec<(String, u64)> },
    Symlink { target: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    UnsupportedVersion,
    IntegrityMismatch,
    MissingRoot,
}

impl FsSnapshot {
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
    mix_u64(&mut hash, version as u64);
    mix_u64(&mut hash, next_inode);
    for entry in entries {
        mix_u64(&mut hash, entry.inode);
        match &entry.kind {
            SnapshotEntryKind::File { data, nlink } => {
                mix_u64(&mut hash, 1);
                mix_u64(&mut hash, *nlink as u64);
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
    mix_u64_len(hash, bytes.len() as u64);
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
