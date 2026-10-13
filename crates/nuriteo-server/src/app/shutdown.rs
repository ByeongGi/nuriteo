use std::error::Error;
use std::fmt;
use std::future::Future;
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::{Instant, timeout_at};

type WorkerFuture = Pin<Box<dyn Future<Output = Result<(), WorkerError>> + Send + 'static>>;
type WorkerFactory = Box<dyn FnOnce(Shutdown) -> WorkerFuture + Send + 'static>;
type WorkerOutput = (String, Result<(), WorkerError>);
type WorkerCompletion = Option<Result<WorkerOutput, tokio::task::JoinError>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Starting,
    Running,
    Draining,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownReason {
    Sigterm,
    Interrupt,
    Requested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorConfig {
    drain_timeout: Duration,
    max_workers: NonZeroUsize,
}

impl SupervisorConfig {
    #[must_use]
    pub const fn new(drain_timeout: Duration, max_workers: NonZeroUsize) -> Self {
        Self {
            drain_timeout,
            max_workers,
        }
    }

    #[must_use]
    pub const fn drain_timeout(self) -> Duration {
        self.drain_timeout
    }

    #[must_use]
    pub const fn max_workers(self) -> NonZeroUsize {
        self.max_workers
    }
}

#[derive(Debug, Clone)]
pub struct Shutdown {
    requested: watch::Receiver<bool>,
}

impl Shutdown {
    pub async fn requested(&mut self) {
        while !*self.requested.borrow() {
            if self.requested.changed().await.is_err() {
                break;
            }
        }
    }

    #[must_use]
    pub fn is_requested(&self) -> bool {
        *self.requested.borrow()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerError {
    message: String,
}

impl WorkerError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for WorkerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for WorkerError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownReport {
    reason: ShutdownReason,
    drained_workers: usize,
    transitions: Vec<LifecycleState>,
}

impl ShutdownReport {
    #[must_use]
    pub const fn reason(&self) -> ShutdownReason {
        self.reason
    }

    #[must_use]
    pub const fn drained_workers(&self) -> usize {
        self.drained_workers
    }

    #[must_use]
    pub fn transitions(&self) -> &[LifecycleState] {
        &self.transitions
    }
}

#[derive(Debug)]
pub enum SupervisorError {
    NoWorkers,
    WorkerLimitReached {
        limit: usize,
    },
    DuplicateWorkerName {
        name: String,
    },
    InvalidWorkerName,
    Signal(std::io::Error),
    WorkerExitedEarly {
        name: String,
    },
    WorkerFailed {
        name: String,
        source: WorkerError,
    },
    WorkerTaskFailed {
        message: String,
    },
    DrainTimedOut {
        timeout: Duration,
        unfinished: usize,
    },
}

impl fmt::Display for SupervisorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoWorkers => formatter.write_str("supervisor requires at least one worker"),
            Self::WorkerLimitReached { limit } => {
                write!(formatter, "supervisor worker limit reached ({limit})")
            }
            Self::DuplicateWorkerName { name } => {
                write!(formatter, "duplicate worker name: {name}")
            }
            Self::InvalidWorkerName => formatter.write_str("worker name must not be empty"),
            Self::Signal(error) => write!(
                formatter,
                "failed to install or receive shutdown signal: {error}"
            ),
            Self::WorkerExitedEarly { name } => {
                write!(formatter, "worker exited before shutdown: {name}")
            }
            Self::WorkerFailed { name, source } => {
                write!(formatter, "worker failed: {name}: {source}")
            }
            Self::WorkerTaskFailed { message } => {
                write!(formatter, "worker task failed: {message}")
            }
            Self::DrainTimedOut {
                timeout,
                unfinished,
            } => write!(
                formatter,
                "graceful shutdown exceeded {timeout:?} with {unfinished} worker(s) unfinished"
            ),
        }
    }
}

impl Error for SupervisorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Signal(error) => Some(error),
            Self::WorkerFailed { source, .. } => Some(source),
            _ => None,
        }
    }
}

struct RegisteredWorker {
    name: String,
    factory: WorkerFactory,
}

pub struct Supervisor {
    config: SupervisorConfig,
    workers: Vec<RegisteredWorker>,
    state: LifecycleState,
    transitions: Vec<LifecycleState>,
    state_sender: watch::Sender<LifecycleState>,
}

impl Supervisor {
    #[must_use]
    pub fn new(config: SupervisorConfig) -> Self {
        let (state_sender, _) = watch::channel(LifecycleState::Starting);
        Self {
            config,
            workers: Vec::new(),
            state: LifecycleState::Starting,
            transitions: vec![LifecycleState::Starting],
            state_sender,
        }
    }

    #[must_use]
    pub fn state(&self) -> LifecycleState {
        self.state
    }

    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<LifecycleState> {
        self.state_sender.subscribe()
    }

    pub fn register<F, Fut>(
        &mut self,
        name: impl Into<String>,
        worker: F,
    ) -> Result<(), SupervisorError>
    where
        F: FnOnce(Shutdown) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), WorkerError>> + Send + 'static,
    {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(SupervisorError::InvalidWorkerName);
        }
        if self.workers.len() >= self.config.max_workers.get() {
            return Err(SupervisorError::WorkerLimitReached {
                limit: self.config.max_workers.get(),
            });
        }
        if self.workers.iter().any(|worker| worker.name == name) {
            return Err(SupervisorError::DuplicateWorkerName { name });
        }

        self.workers.push(RegisteredWorker {
            name,
            factory: Box::new(move |shutdown| Box::pin(worker(shutdown))),
        });
        Ok(())
    }

    pub async fn run_until_os_signal(self) -> Result<ShutdownReport, SupervisorError> {
        self.run_until(shutdown_signal()).await
    }

    pub async fn run_until<S>(mut self, signal: S) -> Result<ShutdownReport, SupervisorError>
    where
        S: Future<Output = Result<ShutdownReason, std::io::Error>> + Send,
    {
        if self.workers.is_empty() {
            return Err(SupervisorError::NoWorkers);
        }

        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let mut tasks = JoinSet::new();
        for worker in self.workers.drain(..) {
            let shutdown = Shutdown {
                requested: shutdown_receiver.clone(),
            };
            tasks.spawn(async move {
                let result = (worker.factory)(shutdown).await;
                (worker.name, result)
            });
        }
        drop(shutdown_receiver);
        self.transition(LifecycleState::Running);

        tokio::pin!(signal);
        let reason = tokio::select! {
            result = &mut signal => result.map_err(SupervisorError::Signal)?,
            completed = tasks.join_next() => {
                let error = early_exit_error(completed);
                shutdown_sender.send_replace(true);
                self.transition(LifecycleState::Draining);
                let drain_result = drain_workers(&mut tasks, self.config.drain_timeout).await;
                self.transition(LifecycleState::Stopped);
                drain_result?;
                return Err(error);
            }
        };

        shutdown_sender.send_replace(true);
        self.transition(LifecycleState::Draining);
        let drained_workers = drain_workers(&mut tasks, self.config.drain_timeout).await;
        self.transition(LifecycleState::Stopped);

        Ok(ShutdownReport {
            reason,
            drained_workers: drained_workers?,
            transitions: self.transitions,
        })
    }

    fn transition(&mut self, next: LifecycleState) {
        self.state = next;
        self.transitions.push(next);
        self.state_sender.send_replace(next);
    }
}

fn early_exit_error(completed: WorkerCompletion) -> SupervisorError {
    match completed {
        Some(Ok((name, Ok(())))) => SupervisorError::WorkerExitedEarly { name },
        Some(Ok((name, Err(source)))) => SupervisorError::WorkerFailed { name, source },
        Some(Err(error)) => SupervisorError::WorkerTaskFailed {
            message: error.to_string(),
        },
        None => SupervisorError::NoWorkers,
    }
}

async fn drain_workers(
    tasks: &mut JoinSet<WorkerOutput>,
    timeout: Duration,
) -> Result<usize, SupervisorError> {
    let deadline = Instant::now() + timeout;
    let mut drained = 0;
    let mut first_error = None;

    while !tasks.is_empty() {
        match timeout_at(deadline, tasks.join_next()).await {
            Ok(Some(Ok((_name, Ok(()))))) => drained += 1,
            Ok(Some(Ok((name, Err(source))))) => {
                drained += 1;
                first_error.get_or_insert(SupervisorError::WorkerFailed { name, source });
            }
            Ok(Some(Err(error))) => {
                first_error.get_or_insert(SupervisorError::WorkerTaskFailed {
                    message: error.to_string(),
                });
            }
            Ok(None) => break,
            Err(_) => {
                let unfinished = tasks.len();
                tasks.abort_all();
                while tasks.join_next().await.is_some() {}
                return Err(SupervisorError::DrainTimedOut {
                    timeout,
                    unfinished,
                });
            }
        }
    }

    match first_error {
        Some(error) => Err(error),
        None => Ok(drained),
    }
}

#[cfg(unix)]
async fn shutdown_signal() -> Result<ShutdownReason, std::io::Error> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        _ = terminate.recv() => Ok(ShutdownReason::Sigterm),
        result = tokio::signal::ctrl_c() => result.map(|()| ShutdownReason::Interrupt),
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() -> Result<ShutdownReason, std::io::Error> {
    tokio::signal::ctrl_c()
        .await
        .map(|()| ShutdownReason::Interrupt)
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::oneshot;

    use super::*;

    fn test_config(timeout: Duration, max_workers: usize) -> SupervisorConfig {
        SupervisorConfig::new(timeout, NonZeroUsize::new(max_workers).unwrap())
    }

    #[tokio::test]
    async fn drains_workers_in_a_bounded_lifecycle() {
        let mut supervisor = Supervisor::new(test_config(Duration::from_secs(1), 1));
        let drained = Arc::new(AtomicBool::new(false));
        let worker_drained = Arc::clone(&drained);
        supervisor
            .register("worker", move |mut shutdown| async move {
                shutdown.requested().await;
                worker_drained.store(true, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();

        let report = supervisor
            .run_until(async { Ok(ShutdownReason::Requested) })
            .await
            .unwrap();

        assert!(drained.load(Ordering::SeqCst));
        assert_eq!(report.reason(), ShutdownReason::Requested);
        assert_eq!(report.drained_workers(), 1);
        assert_eq!(
            report.transitions(),
            &[
                LifecycleState::Starting,
                LifecycleState::Running,
                LifecycleState::Draining,
                LifecycleState::Stopped,
            ]
        );
    }

    #[tokio::test]
    async fn aborts_and_joins_a_worker_after_the_drain_deadline() {
        let mut supervisor = Supervisor::new(test_config(Duration::from_millis(20), 1));
        supervisor
            .register("stuck", |_shutdown| async move {
                std::future::pending::<()>().await;
                Ok(())
            })
            .unwrap();

        let started = Instant::now();
        let error = supervisor
            .run_until(async { Ok(ShutdownReason::Requested) })
            .await
            .unwrap_err();

        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(matches!(
            error,
            SupervisorError::DrainTimedOut { unfinished: 1, .. }
        ));
    }

    #[tokio::test]
    async fn fails_closed_when_a_worker_exits_before_shutdown() {
        let mut supervisor = Supervisor::new(test_config(Duration::from_secs(1), 1));
        let (_signal_sender, signal_receiver) = oneshot::channel::<()>();
        supervisor
            .register("early", |_shutdown| async move { Ok(()) })
            .unwrap();

        let error = supervisor
            .run_until(async move {
                signal_receiver.await.map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::BrokenPipe, "signal source closed")
                })?;
                Ok(ShutdownReason::Requested)
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            SupervisorError::WorkerExitedEarly { ref name } if name == "early"
        ));
    }

    #[test]
    fn enforces_worker_registration_invariants() {
        let mut supervisor = Supervisor::new(test_config(Duration::from_secs(1), 2));
        assert!(matches!(
            supervisor.register(" ", |_shutdown| async { Ok(()) }),
            Err(SupervisorError::InvalidWorkerName)
        ));
        supervisor
            .register("one", |_shutdown| async { Ok(()) })
            .unwrap();
        assert!(matches!(
            supervisor.register("one", |_shutdown| async { Ok(()) }),
            Err(SupervisorError::DuplicateWorkerName { ref name }) if name == "one"
        ));
        supervisor
            .register("two", |_shutdown| async { Ok(()) })
            .unwrap();
        assert!(matches!(
            supervisor.register("three", |_shutdown| async { Ok(()) }),
            Err(SupervisorError::WorkerLimitReached { limit: 2 })
        ));
    }
}
