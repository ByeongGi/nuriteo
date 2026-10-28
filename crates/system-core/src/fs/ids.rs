/// Identifier of one filesystem node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InodeId(pub u64);

/// File descriptor local to one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Fd(pub u32);

impl Fd {
    /// First descriptor issued to a process.
    ///
    /// `0`, `1`, and `2` stay reserved for standard input, output, and error.
    /// Changing this value shifts every descriptor the kernel issues.
    pub const FIRST_ISSUED: u32 = 3;
}
