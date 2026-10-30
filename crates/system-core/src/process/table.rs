use std::{
    collections::{BTreeMap, VecDeque},
    error::Error,
    fmt::{self, Display, Formatter},
};

use super::{
    resources::ResourceTable,
    state::{
        Generation, Pid, ProcessGroupId, ProcessState, ProcessStatus, SessionId, VirtualSignal,
    },
};

/// Why a process-table operation failed.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProcessError {
    /// No process identifier or generation remains.
    Exhausted,
    /// The process group does not belong to the session.
    InvalidProcessGroup,
    /// The process cannot become a session leader.
    InvalidSession,
    /// The current status does not allow this transition.
    InvalidTransition,
    /// No process is registered for the pid.
    NotFound,
}

impl ProcessError {
    /// Static sentence returned to a guest for this process failure.
    #[must_use]
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Exhausted => "process identifier space exhausted",
            Self::InvalidProcessGroup => "invalid process group",
            Self::InvalidSession => "invalid session",
            Self::InvalidTransition => "invalid process state transition",
            Self::NotFound => "process was not found",
        }
    }
}

impl Display for ProcessError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.reason())
    }
}

impl Error for ProcessError {}

/// Process and signal queued for delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SignalDelivery {
    /// Process that will observe the signal.
    pub pid: Pid,
    /// Generation of that process at queue time.
    pub generation: Generation,
    /// Signal waiting to be taken.
    pub signal: VirtualSignal,
}

/// Process-table operation result alias.
pub type ProcessResult<T> = Result<T, ProcessError>;

/// Processes, sessions, and pending virtual signals.
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash)]
pub struct ProcessTable {
    next_pid: u32,
    next_generation: u32,
    processes: BTreeMap<Pid, ProcessState>,
    pending_signals: BTreeMap<Pid, VecDeque<VirtualSignal>>,
    resources: ResourceTable,
}

impl ProcessTable {
    /// Creates a table with no processes.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocates a process in the prepared state.
    ///
    /// # Errors
    /// Returns [`ProcessError::Exhausted`] when the process identifier or the
    /// generation has no remaining value. The table is left unchanged.
    pub fn prepare(
        &mut self,
        parent: Option<Pid>,
        cwd: impl Into<String>,
        env: BTreeMap<String, String>,
    ) -> ProcessResult<ProcessState> {
        let pid = Pid(self.next_pid.max(1));
        let next_pid = pid.0.checked_add(1).ok_or(ProcessError::Exhausted)?;
        let generation = Generation(self.next_generation.max(1));
        let next_generation = generation.0.checked_add(1).ok_or(ProcessError::Exhausted)?;
        self.next_pid = next_pid;
        self.next_generation = next_generation;
        let (process_group, session) = parent
            .and_then(|pid| self.processes.get(&pid))
            .map_or((ProcessGroupId(pid.0), SessionId(pid.0)), |parent| {
                (parent.process_group, parent.session)
            });
        let state = ProcessState {
            pid,
            generation,
            parent,
            process_group,
            session,
            cwd: cwd.into(),
            env,
            status: ProcessStatus::Prepared,
            exit_code: None,
        };
        self.resources.attach(pid);
        self.pending_signals.insert(pid, VecDeque::new());
        self.processes.insert(pid, state.clone());
        Ok(state)
    }

    /// Moves a prepared process to starting.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent and
    /// [`ProcessError::InvalidTransition`] when it is not prepared.
    pub fn start(&mut self, pid: Pid) -> ProcessResult<ProcessState> {
        self.transition(pid, ProcessStatus::Prepared, ProcessStatus::Starting, None)
    }

    /// Moves a starting process to ready.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent and
    /// [`ProcessError::InvalidTransition`] when it is not starting.
    pub fn ready(&mut self, pid: Pid) -> ProcessResult<ProcessState> {
        self.transition(pid, ProcessStatus::Starting, ProcessStatus::Ready, None)
    }

    /// Marks a process failed and stores `exit_code`.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent and
    /// [`ProcessError::InvalidTransition`] when it has already stopped.
    pub fn fail(&mut self, pid: Pid, exit_code: i32) -> ProcessResult<ProcessState> {
        self.finish(pid, ProcessStatus::Failed, exit_code)
    }

    /// Marks a process exited and stores `exit_code`.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent and
    /// [`ProcessError::InvalidTransition`] when it has already stopped.
    pub fn exit(&mut self, pid: Pid, exit_code: i32) -> ProcessResult<ProcessState> {
        self.finish(pid, ProcessStatus::Exited, exit_code)
    }

    /// Marks a process killed.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent and
    /// [`ProcessError::InvalidTransition`] when it has already stopped.
    pub fn kill(&mut self, pid: Pid) -> ProcessResult<ProcessState> {
        self.finish(pid, ProcessStatus::Killed, 137)
    }

    /// Returns the state of `pid`.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent.
    pub fn get(&self, pid: Pid) -> ProcessResult<&ProcessState> {
        self.processes.get(&pid).ok_or(ProcessError::NotFound)
    }

    /// Reports whether `pid` still owns kernel resources.
    #[must_use]
    pub fn has_resources(&self, pid: Pid) -> bool {
        self.resources.contains(pid)
    }

    /// Makes `pid` the leader of a new session.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent and
    /// [`ProcessError::InvalidSession`] when it already leads its group.
    pub fn create_session(&mut self, pid: Pid) -> ProcessResult<ProcessState> {
        let state = self.processes.get_mut(&pid).ok_or(ProcessError::NotFound)?;
        if state.process_group == ProcessGroupId(pid.0) {
            return Err(ProcessError::InvalidSession);
        }
        state.session = SessionId(pid.0);
        state.process_group = ProcessGroupId(pid.0);
        Ok(state.clone())
    }

    /// Moves `pid` into an existing group in its session.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent and
    /// [`ProcessError::InvalidProcessGroup`] when the group is empty, outside
    /// the session, or the process is already a session leader.
    pub fn set_process_group(
        &mut self,
        pid: Pid,
        process_group: ProcessGroupId,
    ) -> ProcessResult<ProcessState> {
        let state = self.processes.get(&pid).ok_or(ProcessError::NotFound)?;
        if process_group.0 == 0 || state.session == SessionId(pid.0) {
            return Err(ProcessError::InvalidProcessGroup);
        }
        if process_group != ProcessGroupId(pid.0)
            && !self.processes.values().any(|candidate| {
                candidate.process_group == process_group && candidate.session == state.session
            })
        {
            return Err(ProcessError::InvalidProcessGroup);
        }
        let state = self
            .processes
            .get_mut(&pid)
            .expect("pid remained in the table after the membership check");
        state.process_group = process_group;
        Ok(state.clone())
    }

    /// Returns live processes in `process_group`.
    #[must_use]
    pub fn process_group_members(&self, process_group: ProcessGroupId) -> Vec<Pid> {
        self.processes
            .values()
            .filter(|state| {
                state.process_group == process_group && !is_terminal_status(state.status)
            })
            .map(|state| state.pid)
            .collect()
    }

    /// Queues a virtual signal for `pid`.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent and
    /// [`ProcessError::InvalidTransition`] when the process has already stopped.
    pub fn signal(&mut self, pid: Pid, signal: VirtualSignal) -> ProcessResult<SignalDelivery> {
        let state = self.processes.get(&pid).ok_or(ProcessError::NotFound)?;
        if is_terminal_status(state.status) {
            return Err(ProcessError::InvalidTransition);
        }
        let delivery = SignalDelivery {
            pid,
            generation: state.generation,
            signal,
        };
        self.pending_signals
            .get_mut(&pid)
            .ok_or(ProcessError::NotFound)?
            .push_back(signal);
        Ok(delivery)
    }

    /// Queues a virtual signal for every live member of a group.
    ///
    /// # Errors
    /// Returns [`ProcessError::InvalidProcessGroup`] when the group has no live
    /// member, and [`ProcessError::NotFound`] or [`ProcessError::InvalidTransition`]
    /// when a member cannot take the signal.
    pub fn signal_process_group(
        &mut self,
        process_group: ProcessGroupId,
        signal: VirtualSignal,
    ) -> ProcessResult<Vec<SignalDelivery>> {
        let members = self.process_group_members(process_group);
        if members.is_empty() {
            return Err(ProcessError::InvalidProcessGroup);
        }
        members
            .into_iter()
            .map(|pid| self.signal(pid, signal))
            .collect()
    }

    /// Pops the next queued signal for `pid`.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` has no signal queue.
    /// `Ok(None)` means the queue exists and is empty.
    pub fn take_signal(&mut self, pid: Pid) -> ProcessResult<Option<VirtualSignal>> {
        self.pending_signals
            .get_mut(&pid)
            .ok_or(ProcessError::NotFound)
            .map(VecDeque::pop_front)
    }

    /// Reports whether `process_group` belongs to the session of `pid`.
    ///
    /// # Errors
    /// Returns [`ProcessError::NotFound`] when `pid` is absent.
    pub fn same_session(&self, pid: Pid, process_group: ProcessGroupId) -> ProcessResult<bool> {
        let session = self.get(pid)?.session;
        Ok(self.processes.values().any(|candidate| {
            candidate.process_group == process_group
                && candidate.session == session
                && !is_terminal_status(candidate.status)
        }))
    }

    fn transition(
        &mut self,
        pid: Pid,
        from: ProcessStatus,
        to: ProcessStatus,
        exit_code: Option<i32>,
    ) -> ProcessResult<ProcessState> {
        let state = self.processes.get_mut(&pid).ok_or(ProcessError::NotFound)?;
        if state.status != from {
            return Err(ProcessError::InvalidTransition);
        }
        state.status = to;
        state.exit_code = exit_code;
        Ok(state.clone())
    }

    fn finish(
        &mut self,
        pid: Pid,
        status: ProcessStatus,
        exit_code: i32,
    ) -> ProcessResult<ProcessState> {
        let state = self.processes.get_mut(&pid).ok_or(ProcessError::NotFound)?;
        if matches!(
            state.status,
            ProcessStatus::Failed | ProcessStatus::Exited | ProcessStatus::Killed
        ) {
            return Err(ProcessError::InvalidTransition);
        }
        state.status = status;
        state.exit_code = Some(exit_code);
        self.resources.release(pid);
        self.pending_signals.remove(&pid);
        Ok(state.clone())
    }
}

fn is_terminal_status(status: ProcessStatus) -> bool {
    matches!(
        status,
        ProcessStatus::Failed | ProcessStatus::Exited | ProcessStatus::Killed
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn rejects_prepare_when_either_counter_is_exhausted() {
        let mut table = ProcessTable {
            next_pid: u32::MAX,
            ..ProcessTable::default()
        };
        assert_eq!(
            table
                .prepare(None, "/workspace", BTreeMap::new())
                .unwrap_err(),
            ProcessError::Exhausted
        );
        assert!(table.processes.is_empty());
        assert_eq!(table.next_pid, u32::MAX);
        assert_eq!(table.next_generation, 0);

        let mut table = ProcessTable {
            next_generation: u32::MAX,
            ..ProcessTable::default()
        };
        assert_eq!(
            table
                .prepare(None, "/workspace", BTreeMap::new())
                .unwrap_err(),
            ProcessError::Exhausted
        );
        assert!(table.processes.is_empty());
        assert_eq!(table.next_pid, 0);
        assert_eq!(table.next_generation, u32::MAX);
    }

    #[test]
    fn keeps_the_last_process_when_the_following_identifier_is_exhausted() {
        let mut table = ProcessTable {
            next_pid: u32::MAX - 1,
            next_generation: u32::MAX - 1,
            ..ProcessTable::default()
        };
        let process = table.prepare(None, "/workspace", BTreeMap::new()).unwrap();
        assert_eq!(process.pid, Pid(u32::MAX - 1));
        assert_eq!(process.generation, Generation(u32::MAX - 1));
        assert_eq!(
            table
                .prepare(None, "/workspace", BTreeMap::new())
                .unwrap_err(),
            ProcessError::Exhausted
        );
        assert_eq!(table.get(process.pid).unwrap().pid, process.pid);
    }
}
