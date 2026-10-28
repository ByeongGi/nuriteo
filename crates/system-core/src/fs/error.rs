use std::{
    error::Error,
    fmt::{self, Display, Formatter},
};

/// Filesystem failure returned to a caller.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FsError {
    /// The path already has a directory entry.
    AlreadyExists,
    /// The descriptor is not open for this process.
    InvalidFd,
    /// The path or open options are not usable.
    InvalidInput,
    /// The path names a directory.
    IsDirectory,
    /// The path does not name a regular file.
    NotFile,
    /// A parent path does not name a directory.
    NotDirectory,
    /// The path or inode does not exist.
    NotFound,
    /// The descriptor is not open for the requested access.
    PermissionDenied,
}

impl FsError {
    /// Static sentence returned to a guest for this filesystem failure.
    #[must_use]
    pub const fn reason(self) -> &'static str {
        match self {
            Self::AlreadyExists => "path already exists",
            Self::InvalidFd => "invalid file descriptor",
            Self::InvalidInput => "invalid filesystem input",
            Self::IsDirectory => "path is a directory",
            Self::NotFile => "path is not a file",
            Self::NotDirectory => "path is not a directory",
            Self::NotFound => "path was not found",
            Self::PermissionDenied => "permission denied",
        }
    }
}

impl Display for FsError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.reason())
    }
}

impl Error for FsError {}

/// Filesystem result alias.
pub type FsResult<T> = Result<T, FsError>;
