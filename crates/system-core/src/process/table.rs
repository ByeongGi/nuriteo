use std::collections::{BTreeMap, VecDeque};

use super::{
    resources::ResourceTable,
    state::{
        Generation, Pid, ProcessGroupId, ProcessState, ProcessStatus, SessionId, VirtualSignal,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessError {
    InvalidProcessGroup,
    InvalidSession,
    InvalidTransition,
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalDelivery {
    pub pid: Pid,
    pub generation: Generation,
    pub signal: VirtualSignal,
}

pub type ProcessResult<T> = Result<T, ProcessError>;

#[derive(Debug, Default, Clone)]
pub struct ProcessTable {
    next_pid: u32,
    next_generation: u32,
    processes: BTreeMap<Pid, ProcessState>,
    pending_signals: BTreeMap<Pid, VecDeque<VirtualSignal>>,
    resources: ResourceTable,
}

impl ProcessTable {
    pub fn prepare(
        &mut self,
        parent: Option<Pid>,
        cwd: impl Into<String>,
        env: BTreeMap<String, String>,
    ) -> ProcessState {
        let pid = Pid(self.next_pid.max(1));
        self.next_pid = pid.0 + 1;
        let generation = Generation(self.next_generation.max(1));
        self.next_generation = generation.0 + 1;
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
        state
    }

    pub fn start(&mut self, pid: Pid) -> ProcessResult<ProcessState> {
        self.transition(pid, ProcessStatus::Prepared, ProcessStatus::Starting, None)
    }

    pub fn ready(&mut self, pid: Pid) -> ProcessResult<ProcessState> {
        self.transition(pid, ProcessStatus::Starting, ProcessStatus::Ready, None)
    }

    pub fn fail(&mut self, pid: Pid, exit_code: i32) -> ProcessResult<ProcessState> {
        self.finish(pid, ProcessStatus::Failed, exit_code)
    }

    pub fn exit(&mut self, pid: Pid, exit_code: i32) -> ProcessResult<ProcessState> {
        self.finish(pid, ProcessStatus::Exited, exit_code)
    }

    pub fn kill(&mut self, pid: Pid) -> ProcessResult<ProcessState> {
        self.finish(pid, ProcessStatus::Killed, 137)
    }

    pub fn get(&self, pid: Pid) -> ProcessResult<&ProcessState> {
        self.processes.get(&pid).ok_or(ProcessError::NotFound)
    }

    pub fn has_resources(&self, pid: Pid) -> bool {
        self.resources.contains(pid)
    }

    pub fn create_session(&mut self, pid: Pid) -> ProcessResult<ProcessState> {
        let state = self.processes.get_mut(&pid).ok_or(ProcessError::NotFound)?;
        if state.process_group == ProcessGroupId(pid.0) {
            return Err(ProcessError::InvalidSession);
        }
        state.session = SessionId(pid.0);
        state.process_group = ProcessGroupId(pid.0);
        Ok(state.clone())
    }

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
        let state = self.processes.get_mut(&pid).expect("process was checked");
        state.process_group = process_group;
        Ok(state.clone())
    }

    pub fn process_group_members(&self, process_group: ProcessGroupId) -> Vec<Pid> {
        self.processes
            .values()
            .filter(|state| {
                state.process_group == process_group && !is_terminal_status(state.status)
            })
            .map(|state| state.pid)
            .collect()
    }

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

    pub fn take_signal(&mut self, pid: Pid) -> ProcessResult<Option<VirtualSignal>> {
        self.pending_signals
            .get_mut(&pid)
            .ok_or(ProcessError::NotFound)
            .map(VecDeque::pop_front)
    }

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
