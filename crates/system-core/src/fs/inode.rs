use std::collections::BTreeMap;

use super::ids::InodeId;

/// Kind of node stored in the filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileType {
    /// Regular file.
    File,
    /// Directory of named children.
    Directory,
    /// Symbolic link.
    Symlink,
}

/// Type, length, and link count of a filesystem node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Metadata {
    /// Whether the node is a file, directory, or symlink.
    pub file_type: FileType,
    /// Byte length of a file or symlink, or child count of a directory.
    pub len: usize,
    /// Directory entries that point at this node.
    pub nlink: u32,
}

/// File, directory, or symlink bytes owned by an inode.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Node {
    /// Regular file bytes and hard-link count.
    File {
        /// File contents.
        data: Vec<u8>,
        /// Directory entries that point at this file.
        nlink: u32,
    },
    /// Directory entries keyed by name.
    Directory {
        /// Child names and their inode ids.
        entries: BTreeMap<String, InodeId>,
    },
    /// Symbolic link target path.
    Symlink {
        /// Path stored in the symlink.
        target: String,
    },
}

impl Node {
    /// Creates an empty directory node.
    #[must_use]
    pub fn directory() -> Self {
        Self::Directory {
            entries: BTreeMap::new(),
        }
    }

    /// Creates an empty regular file node.
    #[must_use]
    pub fn file() -> Self {
        Self::File {
            data: Vec::new(),
            nlink: 1,
        }
    }

    /// Returns the type, length, and link count of this node.
    #[must_use]
    pub fn metadata(&self) -> Metadata {
        match self {
            Node::File { data, nlink } => Metadata {
                file_type: FileType::File,
                len: data.len(),
                nlink: *nlink,
            },
            Node::Directory { entries } => Metadata {
                file_type: FileType::Directory,
                len: entries.len(),
                nlink: 1,
            },
            Node::Symlink { target } => Metadata {
                file_type: FileType::Symlink,
                len: target.len(),
                nlink: 1,
            },
        }
    }
}
