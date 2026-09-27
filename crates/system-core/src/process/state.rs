use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pid(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProcessGroupId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub u32);

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VirtualSignal {
    Interrupt,
    Terminate,
    Kill,
    WindowChanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessState {
    pub pid: Pid,
    pub generation: Generation,
    pub parent: Option<Pid>,
    pub process_group: ProcessGroupId,
    pub session: SessionId,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub status: ProcessStatus,
    pub exit_code: Option<i32>,
}
