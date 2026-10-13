mod error;
mod fd_table;
mod ids;
mod inode;
mod links;
mod open_file;
mod path;
pub mod snapshot;
mod watch;

use std::collections::BTreeMap;

pub use crate::process::Pid;
pub use error::{FsError, FsResult};
use fd_table::FdTable;
pub use ids::{Fd, InodeId};
pub use inode::{FileType, Metadata, Node};
pub use links::LinkKind;
pub use open_file::{OpenFile, OpenOptions};
use path::AbsolutePath;
pub use snapshot::{FsSnapshot, SnapshotEntry, SnapshotEntryKind, SnapshotError};
pub use watch::{WatchEvent, WatchEventKind};

#[derive(Debug, Clone)]
pub struct SystemFs {
    nodes: BTreeMap<InodeId, Node>,
    next_inode: u64,
    fd_tables: BTreeMap<Pid, FdTable>,
    events: Vec<WatchEvent>,
}

impl Default for SystemFs {
    fn default() -> Self {
        let mut fs = Self {
            nodes: BTreeMap::new(),
            next_inode: 1,
            fd_tables: BTreeMap::new(),
            events: Vec::new(),
        };
        fs.nodes.insert(InodeId(0), Node::directory());
        fs.mkdir("/workspace").expect("default workspace directory");
        fs
    }
}

impl SystemFs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mkdir(&mut self, path: &str) -> FsResult<()> {
        let path = AbsolutePath::parse(path)?;
        let (parent_parts, name) = path.parent_and_name()?;
        let parent = self.resolve_parts(parent_parts)?;

        match self.nodes.get(&parent) {
            Some(Node::Directory { entries }) if entries.contains_key(name) => {
                Err(FsError::AlreadyExists)
            }
            Some(Node::Directory { .. }) => {
                let inode = self.allocate_inode(Node::directory());
                self.insert_child(parent, name, inode)?;
                self.record(path_string(&path), WatchEventKind::Create);
                Ok(())
            }
            Some(Node::File { .. }) | Some(Node::Symlink { .. }) => Err(FsError::NotDirectory),
            None => Err(FsError::NotFound),
        }
    }

    pub fn stat(&self, path: &str) -> FsResult<Metadata> {
        let path = AbsolutePath::parse(path)?;
        let inode = self.resolve_parts(path.parts())?;
        self.nodes
            .get(&inode)
            .map(Node::metadata)
            .ok_or(FsError::NotFound)
    }

    pub fn lstat(&self, path: &str) -> FsResult<Metadata> {
        let path = AbsolutePath::parse(path)?;
        let inode = self.resolve_parts_no_follow(path.parts())?;
        self.nodes
            .get(&inode)
            .map(Node::metadata)
            .ok_or(FsError::NotFound)
    }

    pub fn readlink(&self, path: &str) -> FsResult<String> {
        let path = AbsolutePath::parse(path)?;
        let inode = self.resolve_parts_no_follow(path.parts())?;
        match self.nodes.get(&inode) {
            Some(Node::Symlink { target }) => Ok(target.clone()),
            Some(_) => Err(FsError::InvalidInput),
            None => Err(FsError::NotFound),
        }
    }

    pub fn symlink(&mut self, target: &str, link_path: &str) -> FsResult<()> {
        if !target.starts_with('/') {
            return Err(FsError::InvalidInput);
        }
        let path = AbsolutePath::parse(link_path)?;
        let (parent_parts, name) = path.parent_and_name()?;
        let parent = self.resolve_parts(parent_parts)?;
        if self.child(parent, name).is_ok() {
            return Err(FsError::AlreadyExists);
        }
        let inode = self.allocate_inode(Node::Symlink {
            target: target.to_owned(),
        });
        self.insert_child(parent, name, inode)?;
        self.record(path_string(&path), WatchEventKind::Create);
        Ok(())
    }

    pub fn hardlink(&mut self, existing: &str, new_path: &str) -> FsResult<()> {
        let existing = AbsolutePath::parse(existing)?;
        let inode = self.resolve_parts(existing.parts())?;
        match self.nodes.get_mut(&inode) {
            Some(Node::File { nlink, .. }) => *nlink += 1,
            Some(_) => return Err(FsError::InvalidInput),
            None => return Err(FsError::NotFound),
        }

        let new_path = AbsolutePath::parse(new_path)?;
        let (parent_parts, name) = new_path.parent_and_name()?;
        let parent = self.resolve_parts(parent_parts)?;
        if self.child(parent, name).is_ok() {
            return Err(FsError::AlreadyExists);
        }
        self.insert_child(parent, name, inode)?;
        self.record(path_string(&new_path), WatchEventKind::Create);
        Ok(())
    }

    pub fn rename(&mut self, from: &str, to: &str) -> FsResult<()> {
        let from = AbsolutePath::parse(from)?;
        let (from_parent_parts, from_name) = from.parent_and_name()?;
        let from_parent = self.resolve_parts(from_parent_parts)?;
        let inode = self.remove_child(from_parent, from_name)?;

        let to = AbsolutePath::parse(to)?;
        let (to_parent_parts, to_name) = to.parent_and_name()?;
        let to_parent = self.resolve_parts(to_parent_parts)?;
        self.insert_child(to_parent, to_name, inode)?;
        self.record(path_string(&to), WatchEventKind::Rename);
        Ok(())
    }

    pub fn truncate(&mut self, path: &str, len: usize) -> FsResult<()> {
        let path = AbsolutePath::parse(path)?;
        let inode = self.resolve_parts(path.parts())?;
        match self.nodes.get_mut(&inode) {
            Some(Node::File { data, .. }) => {
                data.resize(len, 0);
                self.record(path_string(&path), WatchEventKind::Modify);
                Ok(())
            }
            Some(Node::Directory { .. }) => Err(FsError::IsDirectory),
            Some(Node::Symlink { .. }) => Err(FsError::NotFile),
            None => Err(FsError::NotFound),
        }
    }

    pub fn unlink(&mut self, path: &str) -> FsResult<()> {
        let path = AbsolutePath::parse(path)?;
        let (parent_parts, name) = path.parent_and_name()?;
        let parent = self.resolve_parts(parent_parts)?;
        let inode = self.remove_child(parent, name)?;
        if let Some(Node::File { nlink, .. }) = self.nodes.get_mut(&inode) {
            *nlink = nlink.saturating_sub(1);
        } else {
            self.nodes.remove(&inode);
        }
        self.record(path_string(&path), WatchEventKind::Remove);
        Ok(())
    }

    pub fn drain_events(&mut self) -> Vec<WatchEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn open(&mut self, pid: Pid, path: &str, options: OpenOptions) -> FsResult<Fd> {
        if !options.read && !options.write {
            return Err(FsError::InvalidInput);
        }

        let path = AbsolutePath::parse(path)?;
        let inode = match self.resolve_parts(path.parts()) {
            Ok(inode) => inode,
            Err(FsError::NotFound) if options.create => self.create_file_at(&path)?,
            Err(error) => return Err(error),
        };

        match self.nodes.get_mut(&inode) {
            Some(Node::File { data, .. }) => {
                if options.truncate {
                    if !options.write {
                        return Err(FsError::InvalidInput);
                    }
                    data.clear();
                }
            }
            Some(Node::Directory { .. }) => return Err(FsError::IsDirectory),
            Some(Node::Symlink { .. }) => return Err(FsError::NotFile),
            None => return Err(FsError::NotFound),
        }

        let open_file = OpenFile {
            inode,
            offset: 0,
            options,
        };
        Ok(self.fd_table(pid).insert(open_file))
    }

    pub fn read(&mut self, pid: Pid, fd: Fd, len: usize) -> FsResult<Vec<u8>> {
        let table = self.fd_tables.get_mut(&pid).ok_or(FsError::InvalidFd)?;
        let open_file = table.get_mut(fd)?;
        if !open_file.options.read {
            return Err(FsError::PermissionDenied);
        }

        let data = match self.nodes.get(&open_file.inode) {
            Some(Node::File { data, .. }) => data,
            Some(Node::Directory { .. }) => return Err(FsError::IsDirectory),
            Some(Node::Symlink { .. }) => return Err(FsError::NotFile),
            None => return Err(FsError::NotFound),
        };

        let start = open_file.offset.min(data.len());
        let end = (start + len).min(data.len());
        open_file.offset = end;
        Ok(data[start..end].to_vec())
    }

    pub fn write(&mut self, pid: Pid, fd: Fd, bytes: &[u8]) -> FsResult<usize> {
        let inode = {
            let table = self.fd_tables.get_mut(&pid).ok_or(FsError::InvalidFd)?;
            let open_file = table.get_mut(fd)?;
            if !open_file.options.write {
                return Err(FsError::PermissionDenied);
            }

            let data = match self.nodes.get_mut(&open_file.inode) {
                Some(Node::File { data, .. }) => data,
                Some(Node::Directory { .. }) => return Err(FsError::IsDirectory),
                Some(Node::Symlink { .. }) => return Err(FsError::NotFile),
                None => return Err(FsError::NotFound),
            };

            if open_file.offset > data.len() {
                data.resize(open_file.offset, 0);
            }
            let end = open_file.offset + bytes.len();
            if end > data.len() {
                data.resize(end, 0);
            }
            data[open_file.offset..end].copy_from_slice(bytes);
            open_file.offset = end;
            open_file.inode
        };
        self.record(format!("<inode:{}>", inode.0), WatchEventKind::Modify);
        Ok(bytes.len())
    }

    pub fn close(&mut self, pid: Pid, fd: Fd) -> FsResult<()> {
        let table = self.fd_tables.get_mut(&pid).ok_or(FsError::InvalidFd)?;
        table.remove(fd)?;
        Ok(())
    }

    pub fn snapshot(&self) -> FsSnapshot {
        let entries = self
            .nodes
            .iter()
            .map(|(inode, node)| match node {
                Node::File { data, nlink } => SnapshotEntry {
                    inode: inode.0,
                    kind: SnapshotEntryKind::File {
                        data: data.clone(),
                        nlink: *nlink,
                    },
                },
                Node::Directory { entries } => SnapshotEntry {
                    inode: inode.0,
                    kind: SnapshotEntryKind::Directory {
                        entries: entries
                            .iter()
                            .map(|(name, child)| (name.clone(), child.0))
                            .collect(),
                    },
                },
                Node::Symlink { target } => SnapshotEntry {
                    inode: inode.0,
                    kind: SnapshotEntryKind::Symlink {
                        target: target.clone(),
                    },
                },
            })
            .collect();
        FsSnapshot::new(1, self.next_inode, entries)
    }

    pub fn restore(snapshot: &FsSnapshot) -> Result<Self, SnapshotError> {
        snapshot.verify()?;
        let mut nodes = BTreeMap::new();
        for entry in &snapshot.entries {
            let node = match &entry.kind {
                SnapshotEntryKind::File { data, nlink } => Node::File {
                    data: data.clone(),
                    nlink: *nlink,
                },
                SnapshotEntryKind::Directory { entries } => Node::Directory {
                    entries: entries
                        .iter()
                        .map(|(name, inode)| (name.clone(), InodeId(*inode)))
                        .collect(),
                },
                SnapshotEntryKind::Symlink { target } => Node::Symlink {
                    target: target.clone(),
                },
            };
            nodes.insert(InodeId(entry.inode), node);
        }
        if !nodes.contains_key(&InodeId(0)) {
            return Err(SnapshotError::MissingRoot);
        }
        Ok(Self {
            nodes,
            next_inode: snapshot.next_inode,
            fd_tables: BTreeMap::new(),
            events: Vec::new(),
        })
    }

    fn fd_table(&mut self, pid: Pid) -> &mut FdTable {
        self.fd_tables.entry(pid).or_default()
    }

    fn allocate_inode(&mut self, node: Node) -> InodeId {
        let inode = InodeId(self.next_inode);
        self.next_inode += 1;
        self.nodes.insert(inode, node);
        inode
    }

    fn create_file_at(&mut self, path: &AbsolutePath) -> FsResult<InodeId> {
        let (parent_parts, name) = path.parent_and_name()?;
        let parent = self.resolve_parts(parent_parts)?;

        match self.nodes.get(&parent) {
            Some(Node::Directory { entries }) if entries.contains_key(name) => {
                Err(FsError::AlreadyExists)
            }
            Some(Node::Directory { .. }) => {
                let inode = self.allocate_inode(Node::file());
                self.insert_child(parent, name, inode)?;
                Ok(inode)
            }
            Some(Node::File { .. }) | Some(Node::Symlink { .. }) => Err(FsError::NotDirectory),
            None => Err(FsError::NotFound),
        }
    }

    fn insert_child(&mut self, parent: InodeId, name: &str, child: InodeId) -> FsResult<()> {
        match self.nodes.get_mut(&parent) {
            Some(Node::Directory { entries }) => {
                entries.insert(name.to_owned(), child);
                Ok(())
            }
            Some(Node::File { .. }) | Some(Node::Symlink { .. }) => Err(FsError::NotDirectory),
            None => Err(FsError::NotFound),
        }
    }

    fn remove_child(&mut self, parent: InodeId, name: &str) -> FsResult<InodeId> {
        match self.nodes.get_mut(&parent) {
            Some(Node::Directory { entries }) => entries.remove(name).ok_or(FsError::NotFound),
            Some(Node::File { .. }) | Some(Node::Symlink { .. }) => Err(FsError::NotDirectory),
            None => Err(FsError::NotFound),
        }
    }

    fn child(&self, parent: InodeId, name: &str) -> FsResult<InodeId> {
        match self.nodes.get(&parent) {
            Some(Node::Directory { entries }) => {
                entries.get(name).copied().ok_or(FsError::NotFound)
            }
            Some(Node::File { .. }) | Some(Node::Symlink { .. }) => Err(FsError::NotDirectory),
            None => Err(FsError::NotFound),
        }
    }

    fn resolve_parts(&self, parts: &[String]) -> FsResult<InodeId> {
        let mut current = InodeId(0);
        for part in parts {
            let node = self.nodes.get(&current).ok_or(FsError::NotFound)?;
            let entries = match node {
                Node::Directory { entries } => entries,
                Node::File { .. } | Node::Symlink { .. } => return Err(FsError::NotDirectory),
            };
            current = *entries.get(part).ok_or(FsError::NotFound)?;
            if let Some(Node::Symlink { target }) = self.nodes.get(&current) {
                let target = AbsolutePath::parse(target)?;
                current = self.resolve_parts(target.parts())?;
            }
        }
        Ok(current)
    }

    fn resolve_parts_no_follow(&self, parts: &[String]) -> FsResult<InodeId> {
        let mut current = InodeId(0);
        for part in parts {
            current = self.child(current, part)?;
        }
        Ok(current)
    }

    fn record(&mut self, path: String, kind: WatchEventKind) {
        self.events.push(WatchEvent { path, kind });
    }
}

fn path_string(path: &AbsolutePath) -> String {
    if path.parts().is_empty() {
        "/".to_owned()
    } else {
        format!("/{}", path.parts().join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PID_A: Pid = Pid(10);
    const PID_B: Pid = Pid(20);

    #[test]
    fn writes_reads_and_stats_file_bytes() {
        let mut fs = SystemFs::new();
        let fd = fs
            .open(
                PID_A,
                "/workspace/result.txt",
                OpenOptions::read_write_create(),
            )
            .unwrap();

        assert_eq!(fs.write(PID_A, fd, b"hello").unwrap(), 5);
        fs.close(PID_A, fd).unwrap();

        let meta = fs.stat("/workspace/result.txt").unwrap();
        assert_eq!(meta.file_type, FileType::File);
        assert_eq!(meta.len, 5);
        assert_eq!(meta.nlink, 1);

        let fd = fs
            .open(PID_A, "/workspace/result.txt", OpenOptions::read_only())
            .unwrap();
        assert_eq!(fs.read(PID_A, fd, 16).unwrap(), b"hello");
        assert_eq!(fs.read(PID_A, fd, 16).unwrap(), b"");
    }

    #[test]
    fn separates_fd_tables_by_process() {
        let mut fs = SystemFs::new();
        let fd = fs
            .open(
                PID_A,
                "/workspace/shared.txt",
                OpenOptions::read_write_create(),
            )
            .unwrap();

        assert_eq!(fs.write(PID_A, fd, b"a").unwrap(), 1);
        assert_eq!(fs.write(PID_B, fd, b"b").unwrap_err(), FsError::InvalidFd);
    }

    #[test]
    fn rejects_missing_file_without_create() {
        let mut fs = SystemFs::new();
        let error = fs
            .open(PID_A, "/workspace/missing.txt", OpenOptions::read_only())
            .unwrap_err();

        assert_eq!(error, FsError::NotFound);
    }

    #[test]
    fn rejects_invalid_fd_after_close() {
        let mut fs = SystemFs::new();
        let fd = fs
            .open(
                PID_A,
                "/workspace/closed.txt",
                OpenOptions::read_write_create(),
            )
            .unwrap();
        fs.close(PID_A, fd).unwrap();

        assert_eq!(fs.read(PID_A, fd, 1).unwrap_err(), FsError::InvalidFd);
    }

    #[test]
    fn reports_file_and_directory_type_errors() {
        let mut fs = SystemFs::new();
        fs.mkdir("/workspace/src").unwrap();

        assert_eq!(
            fs.open(PID_A, "/workspace/src", OpenOptions::read_only())
                .unwrap_err(),
            FsError::IsDirectory
        );

        fs.open(
            PID_A,
            "/workspace/src-file",
            OpenOptions::write_create_truncate(),
        )
        .unwrap();
        assert_eq!(
            fs.mkdir("/workspace/src-file/nested").unwrap_err(),
            FsError::NotDirectory
        );
    }

    #[test]
    fn supports_symlink_realpath_lstat_and_readlink() {
        let mut fs = SystemFs::new();
        let fd = fs
            .open(
                PID_A,
                "/workspace/target.txt",
                OpenOptions::read_write_create(),
            )
            .unwrap();
        fs.write(PID_A, fd, b"target").unwrap();
        fs.symlink("/workspace/target.txt", "/workspace/link.txt")
            .unwrap();

        assert_eq!(
            fs.lstat("/workspace/link.txt").unwrap().file_type,
            FileType::Symlink
        );
        assert_eq!(
            fs.stat("/workspace/link.txt").unwrap().file_type,
            FileType::File
        );
        assert_eq!(
            fs.readlink("/workspace/link.txt").unwrap(),
            "/workspace/target.txt"
        );
        let fd = fs
            .open(PID_A, "/workspace/link.txt", OpenOptions::read_only())
            .unwrap();
        assert_eq!(fs.read(PID_A, fd, 16).unwrap(), b"target");
    }

    #[test]
    fn preserves_hardlink_nlink_and_open_unlink_lifetime() {
        let mut fs = SystemFs::new();
        let fd = fs
            .open(PID_A, "/workspace/a.txt", OpenOptions::read_write_create())
            .unwrap();
        fs.write(PID_A, fd, b"abc").unwrap();
        fs.hardlink("/workspace/a.txt", "/workspace/b.txt").unwrap();

        assert_eq!(fs.stat("/workspace/a.txt").unwrap().nlink, 2);
        assert_eq!(fs.stat("/workspace/b.txt").unwrap().nlink, 2);
        fs.unlink("/workspace/a.txt").unwrap();
        assert_eq!(fs.stat("/workspace/a.txt").unwrap_err(), FsError::NotFound);
        assert_eq!(fs.stat("/workspace/b.txt").unwrap().nlink, 1);
        assert_eq!(fs.read(PID_A, fd, 8).unwrap(), b"");
    }

    #[test]
    fn supports_rename_truncate_and_watch_events() {
        let mut fs = SystemFs::new();
        let fd = fs
            .open(
                PID_A,
                "/workspace/tmp.txt",
                OpenOptions::read_write_create(),
            )
            .unwrap();
        fs.write(PID_A, fd, b"abcdef").unwrap();
        fs.rename("/workspace/tmp.txt", "/workspace/final.txt")
            .unwrap();
        fs.truncate("/workspace/final.txt", 3).unwrap();

        assert_eq!(
            fs.stat("/workspace/tmp.txt").unwrap_err(),
            FsError::NotFound
        );
        assert_eq!(fs.stat("/workspace/final.txt").unwrap().len, 3);
        let events = fs.drain_events();
        assert!(
            events
                .iter()
                .any(|event| event.kind == WatchEventKind::Rename)
        );
        assert!(
            events
                .iter()
                .any(|event| event.kind == WatchEventKind::Modify)
        );
    }

    #[test]
    fn snapshots_files_links_and_integrity_roundtrip() {
        let mut fs = SystemFs::new();
        fs.mkdir("/workspace/src").unwrap();
        let fd = fs
            .open(
                PID_A,
                "/workspace/src/app.txt",
                OpenOptions::read_write_create(),
            )
            .unwrap();
        fs.write(PID_A, fd, b"snapshot").unwrap();
        fs.hardlink("/workspace/src/app.txt", "/workspace/src/hard.txt")
            .unwrap();
        fs.symlink("/workspace/src/app.txt", "/workspace/src/link.txt")
            .unwrap();

        let snapshot = fs.snapshot();
        snapshot.verify().unwrap();
        let mut restored = SystemFs::restore(&snapshot).unwrap();

        assert_eq!(restored.stat("/workspace/src/hard.txt").unwrap().nlink, 2);
        assert_eq!(
            restored.readlink("/workspace/src/link.txt").unwrap(),
            "/workspace/src/app.txt"
        );
        let fd = restored
            .open(PID_A, "/workspace/src/app.txt", OpenOptions::read_only())
            .unwrap();
        assert_eq!(restored.read(PID_A, fd, 32).unwrap(), b"snapshot");

        let mut corrupted = snapshot.clone();
        corrupted.entries[0].inode = 999;
        assert_eq!(
            corrupted.verify().unwrap_err(),
            SnapshotError::IntegrityMismatch
        );
    }
}
