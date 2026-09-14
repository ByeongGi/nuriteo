use std::collections::BTreeMap;

use super::{
    resources::ResourceTable,
    state::{Generation, Pid, ProcessState, ProcessStatus},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessError {
    InvalidTransition,
    NotFound,
}

pub type ProcessResult<T> = Result<T, ProcessError>;

#[derive(Debug, Default, Clone)]
pub struct ProcessTable {
    next_pid: u32,
    next_generation: u32,
    processes: BTreeMap<Pid, ProcessState>,
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
        let state = ProcessState {
            pid,
            generation,
            parent,
            cwd: cwd.into(),
            env,
            status: ProcessStatus::Prepared,
            exit_code: None,
        };
        self.resources.attach(pid);
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
        Ok(state.clone())
    }
}
