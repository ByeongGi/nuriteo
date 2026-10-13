use std::collections::BTreeSet;

use super::state::Pid;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ResourceTable {
    owners: BTreeSet<Pid>,
}

impl ResourceTable {
    pub fn attach(&mut self, pid: Pid) {
        self.owners.insert(pid);
    }

    pub fn release(&mut self, pid: Pid) {
        self.owners.remove(&pid);
    }

    pub fn contains(&self, pid: Pid) -> bool {
        self.owners.contains(&pid)
    }
}
