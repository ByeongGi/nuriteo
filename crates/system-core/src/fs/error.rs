#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsError {
    AlreadyExists,
    InvalidFd,
    InvalidInput,
    IsDirectory,
    NotFile,
    NotDirectory,
    NotFound,
    PermissionDenied,
}

pub type FsResult<T> = Result<T, FsError>;
