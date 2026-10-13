#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::num::NonZeroUsize;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use nuriteo_server::app::{ShutdownReason, Supervisor, SupervisorConfig};

const CHILD_ENV: &str = "NURITEO_LIFECYCLE_SIGNAL_CHILD";

struct ChildGuard {
    child: Child,
    reaped: bool,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self {
            child,
            reaped: false,
        }
    }

    fn id(&self) -> u32 {
        self.child.id()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.reaped = true;
        }
        Ok(status)
    }

    fn kill_and_wait(&mut self) {
        if self.reaped {
            return;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.reaped = true;
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.kill_and_wait();
    }
}

#[test]
#[ignore = "process fixture launched by sigterm_drains_the_supervised_process"]
fn signal_child_process() {
    if std::env::var_os(CHILD_ENV).is_none() {
        return;
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let config = SupervisorConfig::new(Duration::from_secs(2), NonZeroUsize::new(1).unwrap());
        let mut supervisor = Supervisor::new(config);
        supervisor
            .register("signal-fixture", |mut shutdown| async move {
                println!("READY");
                shutdown.requested().await;
                tokio::time::sleep(Duration::from_millis(30)).await;
                println!("DRAINED");
                Ok(())
            })
            .unwrap();

        let report = supervisor.run_until_os_signal().await.unwrap();
        assert_eq!(report.reason(), ShutdownReason::Sigterm);
        assert_eq!(report.drained_workers(), 1);
        println!("STOPPED");
    });
}

#[test]
fn sigterm_drains_the_supervised_process() {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "signal_child_process",
            "--nocapture",
        ])
        .env(CHILD_ENV, "1")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    let stdout = child.stdout.take().unwrap();
    let (line_sender, line_receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_sender.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut child = ChildGuard::new(child);

    let ready_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = ready_deadline.saturating_duration_since(Instant::now());
        let line = line_receiver.recv_timeout(remaining).unwrap();
        if line == "READY" {
            break;
        }
    }

    let signal_status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(signal_status.success());

    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill_and_wait();
            panic!("signal fixture did not exit before the test deadline");
        }
        thread::sleep(Duration::from_millis(10));
    };

    reader.join().unwrap();
    let remaining: Vec<_> = line_receiver.try_iter().collect();
    assert!(status.success());
    assert!(remaining.iter().any(|line| line == "DRAINED"));
    assert!(remaining.iter().any(|line| line == "STOPPED"));
}
