use super::ids::InodeId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenOptions {
    pub read: bool,
    pub write: bool,
    pub create: bool,
    pub truncate: bool,
}

impl OpenOptions {
    pub fn read_only() -> Self {
        Self {
            read: true,
            write: false,
            create: false,
            truncate: false,
        }
    }

    pub fn write_create_truncate() -> Self {
        Self {
            read: false,
            write: true,
            create: true,
            truncate: true,
        }
    }

    pub fn read_write_create() -> Self {
        Self {
            read: true,
            write: true,
            create: true,
            truncate: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFile {
    pub inode: InodeId,
    pub offset: usize,
    pub options: OpenOptions,
}
