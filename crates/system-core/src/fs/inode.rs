use std::collections::BTreeMap;

use super::ids::InodeId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub file_type: FileType,
    pub len: usize,
    pub nlink: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    File { data: Vec<u8>, nlink: u32 },
    Directory { entries: BTreeMap<String, InodeId> },
    Symlink { target: String },
}

impl Node {
    pub fn directory() -> Self {
        Self::Directory {
            entries: BTreeMap::new(),
        }
    }

    pub fn file() -> Self {
        Self::File {
            data: Vec::new(),
            nlink: 1,
        }
    }

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
