use std::collections::BTreeMap;

/// Process identifier assigned by the process table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pid(pub u32);

/// Identifier of a process group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProcessGroupId(pub u32);

/// Identifier of a login session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub u32);

/// Generation that distinguishes recycled process ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Generation(pub u32);

/// Lifecycle stage of a process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProcessStatus {
    /// Allocated, not yet started.
    Prepared,
    /// Start was requested and has not reached ready.
    Starting,
    /// Running and able to take signals.
    Ready,
    /// Stopped by `fail` with an exit code.
    Failed,
    /// Stopped by `exit` with an exit code.
    Exited,
    /// Stopped by `kill`.
    Killed,
}

/// Signal the kernel can deliver to a process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VirtualSignal {
    /// Terminal interrupt, usually Ctrl-C.
    Interrupt,
    /// Request to terminate the process.
    Terminate,
    /// Forced stop.
    Kill,
    /// The controlling terminal changed size.
    WindowChanged,
}

/// Lifecycle record for one prepared process.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProcessState {
    /// Identifier assigned at prepare time.
    pub pid: Pid,
    /// Generation that keeps a recycled pid distinct.
    pub generation: Generation,
    /// Process that prepared this one, when it had a parent.
    pub parent: Option<Pid>,
    /// Group used for job-control signals.
    pub process_group: ProcessGroupId,
    /// Login session this process belongs to.
    pub session: SessionId,
    /// Absolute working directory inherited or supplied at prepare time.
    pub cwd: String,
    /// Environment variables owned by this process.
    pub env: BTreeMap<String, String>,
    /// Lifecycle stage.
    pub status: ProcessStatus,
    /// Code recorded by fail, exit, or kill. Empty until the process stops.
    pub exit_code: Option<i32>,
}
