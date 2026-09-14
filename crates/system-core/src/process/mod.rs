pub mod resources;
pub mod state;
pub mod table;

pub use state::{Generation, Pid, ProcessState, ProcessStatus};
pub use table::{ProcessError, ProcessResult, ProcessTable};

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn tracks_prepare_start_ready_exit_and_resources() {
        let mut table = ProcessTable::default();
        let process = table.prepare(
            None,
            "/workspace",
            BTreeMap::from([("A".into(), "1".into())]),
        );

        assert_eq!(process.pid, Pid(1));
        assert_eq!(process.generation, Generation(1));
        assert_eq!(process.status, ProcessStatus::Prepared);
        assert!(table.has_resources(process.pid));

        assert_eq!(
            table.start(process.pid).unwrap().status,
            ProcessStatus::Starting
        );
        assert_eq!(
            table.ready(process.pid).unwrap().status,
            ProcessStatus::Ready
        );
        let exited = table.exit(process.pid, 0).unwrap();

        assert_eq!(exited.status, ProcessStatus::Exited);
        assert_eq!(exited.exit_code, Some(0));
        assert!(!table.has_resources(process.pid));
    }

    #[test]
    fn rejects_duplicate_stop_and_invalid_startup() {
        let mut table = ProcessTable::default();
        let process = table.prepare(None, "/workspace", BTreeMap::new());

        assert_eq!(
            table.ready(process.pid).unwrap_err(),
            ProcessError::InvalidTransition
        );
        table.fail(process.pid, 1).unwrap();
        assert_eq!(
            table.kill(process.pid).unwrap_err(),
            ProcessError::InvalidTransition
        );
    }

    #[test]
    fn advances_pid_generation_for_replacement() {
        let mut table = ProcessTable::default();
        let first = table.prepare(None, "/workspace", BTreeMap::new());
        table.kill(first.pid).unwrap();
        let second = table.prepare(None, "/workspace", BTreeMap::new());

        assert_ne!(first.pid, second.pid);
        assert_ne!(first.generation, second.generation);
    }
}
