/// Hard link or symbolic link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LinkKind {
    /// Another directory entry for an existing inode.
    Hardlink,
    /// A path that stores another path.
    Symlink,
}
