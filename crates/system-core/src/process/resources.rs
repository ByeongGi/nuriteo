use std::collections::BTreeSet;

use super::state::Pid;

/// Set of processes that still own kernel resources.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ResourceTable {
    owners: BTreeSet<Pid>,
}

impl Default for ResourceTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ResourceTable {
    /// Creates a table with no resource owners.
    #[must_use]
    pub fn new() -> Self {
        Self {
            owners: BTreeSet::new(),
        }
    }

    /// Records that `pid` owns kernel resources.
    pub fn attach(&mut self, pid: Pid) {
        self.owners.insert(pid);
    }

    /// Drops resource ownership for `pid`.
    pub fn release(&mut self, pid: Pid) {
        self.owners.remove(&pid);
    }

    /// Reports whether `pid` still owns kernel resources.
    #[must_use]
    pub fn contains(&self, pid: Pid) -> bool {
        self.owners.contains(&pid)
    }
}
