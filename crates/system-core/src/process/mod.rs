pub mod resources;
pub mod state;
pub mod table;

pub use state::{
    Generation, Pid, ProcessGroupId, ProcessState, ProcessStatus, SessionId, VirtualSignal,
};
pub use table::{ProcessError, ProcessResult, ProcessTable, SignalDelivery};

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

    #[test]
    fn inherits_and_changes_process_groups_within_one_session() {
        let mut table = ProcessTable::default();
        let parent = table.prepare(None, "/workspace", BTreeMap::new());
        let child = table.prepare(Some(parent.pid), "/workspace", BTreeMap::new());
        let sibling = table.prepare(Some(parent.pid), "/workspace", BTreeMap::new());

        assert_eq!(child.session, parent.session);
        assert_eq!(child.process_group, parent.process_group);

        let child = table
            .set_process_group(child.pid, ProcessGroupId(child.pid.0))
            .unwrap();
        table
            .set_process_group(sibling.pid, child.process_group)
            .unwrap();
        assert_eq!(
            table.process_group_members(child.process_group),
            vec![child.pid, sibling.pid]
        );
        assert!(table.same_session(parent.pid, child.process_group).unwrap());
    }

    #[test]
    fn creates_a_new_session_only_for_a_non_group_leader() {
        let mut table = ProcessTable::default();
        let parent = table.prepare(None, "/workspace", BTreeMap::new());
        let child = table.prepare(Some(parent.pid), "/workspace", BTreeMap::new());

        assert_eq!(
            table.create_session(parent.pid).unwrap_err(),
            ProcessError::InvalidSession
        );
        let child = table.create_session(child.pid).unwrap();
        assert_eq!(child.session, SessionId(child.pid.0));
        assert_eq!(child.process_group, ProcessGroupId(child.pid.0));
    }

    #[test]
    fn queues_virtual_signals_for_each_live_group_member() {
        let mut table = ProcessTable::default();
        let parent = table.prepare(None, "/workspace", BTreeMap::new());
        let child = table.prepare(Some(parent.pid), "/workspace", BTreeMap::new());

        let deliveries = table
            .signal_process_group(parent.process_group, VirtualSignal::Interrupt)
            .unwrap();
        assert_eq!(deliveries.len(), 2);
        assert_eq!(
            table.take_signal(parent.pid).unwrap(),
            Some(VirtualSignal::Interrupt)
        );
        assert_eq!(
            table.take_signal(child.pid).unwrap(),
            Some(VirtualSignal::Interrupt)
        );
        assert_eq!(table.take_signal(child.pid).unwrap(), None);

        table.exit(child.pid, 0).unwrap();
        assert_eq!(
            table
                .signal(child.pid, VirtualSignal::Terminate)
                .unwrap_err(),
            ProcessError::InvalidTransition
        );
    }
}
