/// Path change recorded by the filesystem.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WatchEvent {
    /// Absolute path that changed, or an inode tag after an open-file write.
    pub path: String,
    /// Create, modify, remove, or rename.
    pub kind: WatchEventKind,
}

/// Kind of path change recorded for watchers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WatchEventKind {
    /// A directory entry was added.
    Create,
    /// File bytes changed.
    Modify,
    /// A directory entry was removed.
    Remove,
    /// A directory entry moved to a new path.
    Rename,
}
