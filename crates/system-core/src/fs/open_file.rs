use super::ids::InodeId;

/// Read and write flags for opening a file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct OpenOptions {
    /// The descriptor may read file bytes.
    pub read: bool,
    /// The descriptor may write file bytes.
    pub write: bool,
    /// Create the file when the path is missing.
    pub create: bool,
    /// Discard existing bytes when the open succeeds.
    pub truncate: bool,
}

impl OpenOptions {
    /// Opens a file for reading.
    #[must_use]
    pub fn read_only() -> Self {
        Self {
            read: true,
            write: false,
            create: false,
            truncate: false,
        }
    }

    /// Creates or truncates a file for writing.
    #[must_use]
    pub fn write_create_truncate() -> Self {
        Self {
            read: false,
            write: true,
            create: true,
            truncate: true,
        }
    }

    /// Creates a file and opens it for reading and writing.
    #[must_use]
    pub fn read_write_create() -> Self {
        Self {
            read: true,
            write: true,
            create: true,
            truncate: false,
        }
    }
}

/// Open file cursor owned by one descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OpenFile {
    /// Inode this descriptor reads and writes.
    pub inode: InodeId,
    /// Next byte index for read and write.
    pub offset: usize,
    /// Access flags captured at open time.
    pub options: OpenOptions,
}
