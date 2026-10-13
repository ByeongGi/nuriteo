#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Hardlink,
    Symlink,
}
