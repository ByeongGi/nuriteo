use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pid(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Generation(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessStatus {
    Prepared,
    Starting,
    Ready,
    Failed,
    Exited,
    Killed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessState {
    pub pid: Pid,
    pub generation: Generation,
    pub parent: Option<Pid>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub status: ProcessStatus,
    pub exit_code: Option<i32>,
}
