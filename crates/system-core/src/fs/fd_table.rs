use std::collections::BTreeMap;

use super::{
    error::{FsError, FsResult},
    ids::Fd,
    open_file::OpenFile,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FdTable {
    next_fd: u32,
    entries: BTreeMap<Fd, OpenFile>,
}

impl Default for FdTable {
    fn default() -> Self {
        Self::new()
    }
}

impl FdTable {
    /// Creates a table whose first descriptor is [`Fd::FIRST_ISSUED`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_fd: Fd::FIRST_ISSUED,
            entries: BTreeMap::new(),
        }
    }

    /// Reports whether another descriptor number can be issued.
    ///
    /// # Errors
    /// Returns [`FsError::DescriptorExhausted`] when the next number would not fit in `u32`.
    pub fn ensure_available(&self) -> FsResult<()> {
        self.next_fd
            .checked_add(1)
            .map(|_| ())
            .ok_or(FsError::DescriptorExhausted)
    }

    /// Inserts an open file and returns its descriptor.
    ///
    /// # Errors
    /// Returns [`FsError::DescriptorExhausted`] when the next number would not fit in `u32`.
    /// The table is left unchanged.
    pub fn insert(&mut self, open_file: OpenFile) -> FsResult<Fd> {
        let next_fd = self
            .next_fd
            .checked_add(1)
            .ok_or(FsError::DescriptorExhausted)?;
        let fd = Fd(self.next_fd);
        self.next_fd = next_fd;
        self.entries.insert(fd, open_file);
        Ok(fd)
    }

    /// Points the next descriptor at the end of the `u32` range.
    #[cfg(test)]
    pub(super) fn saturate(&mut self) {
        self.next_fd = u32::MAX;
    }

    pub fn get_mut(&mut self, fd: Fd) -> FsResult<&mut OpenFile> {
        self.entries.get_mut(&fd).ok_or(FsError::InvalidFd)
    }

    pub fn remove(&mut self, fd: Fd) -> FsResult<OpenFile> {
        self.entries.remove(&fd).ok_or(FsError::InvalidFd)
    }
}

#[cfg(test)]
mod tests {
    use super::super::ids::InodeId;
    use super::super::open_file::OpenOptions;
    use super::*;

    #[test]
    fn rejects_insert_when_the_descriptor_counter_is_exhausted() {
        let mut table = FdTable::new();
        table.saturate();
        let error = table
            .insert(OpenFile {
                inode: InodeId(1),
                offset: 0,
                options: OpenOptions::read_only(),
            })
            .unwrap_err();

        assert_eq!(error, FsError::DescriptorExhausted);
        assert!(table.entries.is_empty());
        assert_eq!(table.next_fd, u32::MAX);
    }
}
