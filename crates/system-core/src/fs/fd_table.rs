use std::collections::BTreeMap;

use super::{
    error::{FsError, FsResult},
    ids::Fd,
    open_file::OpenFile,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FdTable {
    next_fd: u32,
    entries: BTreeMap<Fd, OpenFile>,
}

impl Default for FdTable {
    fn default() -> Self {
        Self {
            next_fd: 3,
            entries: BTreeMap::new(),
        }
    }
}

impl FdTable {
    pub fn insert(&mut self, open_file: OpenFile) -> Fd {
        let fd = Fd(self.next_fd);
        self.next_fd += 1;
        self.entries.insert(fd, open_file);
        fd
    }

    pub fn get_mut(&mut self, fd: Fd) -> FsResult<&mut OpenFile> {
        self.entries.get_mut(&fd).ok_or(FsError::InvalidFd)
    }

    pub fn remove(&mut self, fd: Fd) -> FsResult<OpenFile> {
        self.entries.remove(&fd).ok_or(FsError::InvalidFd)
    }
}
