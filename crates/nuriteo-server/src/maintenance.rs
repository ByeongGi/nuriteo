use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::time::Duration;

use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tokio::sync::Notify;
use tokio::time;
use utoipa::ToSchema;

const ACTIVE: u8 = 0;
const DRAINING: u8 = 1;
const MAINTENANCE: u8 = 2;

/// Process-local admission fence for all HTTP mutations.
///
/// A maintenance controller first closes admission, then waits for every
/// permit issued before the fence to be released. New writes cannot race into
/// the drain because `try_enter_write` rechecks the phase after incrementing
/// the active counter.
#[derive(Clone, Default)]
pub struct MaintenanceGate {
    inner: Arc<GateInner>,
}

#[derive(Default)]
struct GateInner {
    phase: AtomicU8,
    active_writes: AtomicUsize,
    changed: Notify,
}

impl fmt::Debug for MaintenanceGate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MaintenanceGate")
            .field("phase", &self.phase())
            .field("active_writes", &self.active_writes())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaintenancePhase {
    Active,
    Draining,
    Maintenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaintenanceError {
    WriteAdmissionClosed,
    DrainTimedOut,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicMaintenanceView {
    pub phase: &'static str,
    pub read_only: bool,
}

impl fmt::Display for MaintenanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::WriteAdmissionClosed => "write admission is closed for maintenance",
            Self::DrainTimedOut => "active writes did not drain before the deadline",
        })
    }
}

impl std::error::Error for MaintenanceError {}

pub struct WritePermit {
    inner: Arc<GateInner>,
}

impl fmt::Debug for WritePermit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WritePermit")
    }
}

impl MaintenanceGate {
    #[must_use]
    pub fn phase(&self) -> MaintenancePhase {
        match self.inner.phase.load(Ordering::Acquire) {
            ACTIVE => MaintenancePhase::Active,
            DRAINING => MaintenancePhase::Draining,
            MAINTENANCE => MaintenancePhase::Maintenance,
            _ => unreachable!("maintenance phase is written only by this module"),
        }
    }

    #[must_use]
    pub fn active_writes(&self) -> usize {
        self.inner.active_writes.load(Ordering::Acquire)
    }

    pub fn try_enter_write(&self) -> Result<WritePermit, MaintenanceError> {
        if self.inner.phase.load(Ordering::Acquire) != ACTIVE {
            return Err(MaintenanceError::WriteAdmissionClosed);
        }
        self.inner.active_writes.fetch_add(1, Ordering::AcqRel);
        if self.inner.phase.load(Ordering::Acquire) == ACTIVE {
            return Ok(WritePermit {
                inner: Arc::clone(&self.inner),
            });
        }
        release_write(&self.inner);
        Err(MaintenanceError::WriteAdmissionClosed)
    }

    /// Closes write admission and waits for already-admitted writes.
    ///
    /// A timeout deliberately leaves the gate in `Draining`: reopening after
    /// a failed drain would silently admit writes while an operator believes a
    /// backup or upgrade fence is active. The caller may retry or explicitly
    /// call `resume`.
    pub async fn enter_maintenance(&self, timeout: Duration) -> Result<(), MaintenanceError> {
        let _ = self.inner.phase.compare_exchange(
            ACTIVE,
            DRAINING,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if self.phase() == MaintenancePhase::Maintenance {
            return Ok(());
        }
        let drain = async {
            loop {
                let changed = self.inner.changed.notified();
                if self.active_writes() == 0 {
                    self.inner.phase.store(MAINTENANCE, Ordering::Release);
                    self.inner.changed.notify_waiters();
                    return;
                }
                changed.await;
            }
        };
        time::timeout(timeout, drain)
            .await
            .map_err(|_| MaintenanceError::DrainTimedOut)
    }

    /// Explicitly reopens mutation admission after maintenance or a timed-out
    /// drain. Callers own the operational checks that make resuming safe.
    pub fn resume(&self) {
        self.inner.phase.store(ACTIVE, Ordering::Release);
        self.inner.changed.notify_waiters();
    }
}

pub fn public_router(gate: MaintenanceGate) -> Router {
    Router::new().route(
        "/api/v1/maintenance",
        get(move || {
            let gate = gate.clone();
            async move {
                let phase = gate.phase();
                Json(PublicMaintenanceView {
                    phase: match phase {
                        MaintenancePhase::Active => "active",
                        MaintenancePhase::Draining => "draining",
                        MaintenancePhase::Maintenance => "maintenance",
                    },
                    read_only: phase != MaintenancePhase::Active,
                })
            }
        }),
    )
}

impl Drop for WritePermit {
    fn drop(&mut self) {
        release_write(&self.inner);
    }
}

fn release_write(inner: &GateInner) {
    let previous = inner.active_writes.fetch_sub(1, Ordering::AcqRel);
    debug_assert!(previous > 0, "write permit counter cannot underflow");
    if previous == 1 {
        inner.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn active_write_drains_before_maintenance_and_new_writes_are_rejected() {
        let gate = MaintenanceGate::default();
        let permit = gate.try_enter_write().unwrap();
        let controller = gate.clone();
        let entering =
            tokio::spawn(async move { controller.enter_maintenance(Duration::from_secs(1)).await });
        tokio::task::yield_now().await;

        assert_eq!(gate.phase(), MaintenancePhase::Draining);
        assert_eq!(
            gate.try_enter_write().unwrap_err(),
            MaintenanceError::WriteAdmissionClosed
        );
        drop(permit);

        entering.await.unwrap().unwrap();
        assert_eq!(gate.phase(), MaintenancePhase::Maintenance);
        assert_eq!(gate.active_writes(), 0);
    }

    #[tokio::test]
    async fn timeout_stays_fail_closed_until_explicit_resume() {
        let gate = MaintenanceGate::default();
        let permit = gate.try_enter_write().unwrap();
        assert_eq!(
            gate.enter_maintenance(Duration::from_millis(1)).await,
            Err(MaintenanceError::DrainTimedOut)
        );
        assert_eq!(gate.phase(), MaintenancePhase::Draining);
        drop(permit);
        assert!(gate.try_enter_write().is_err());

        gate.resume();
        assert_eq!(gate.phase(), MaintenancePhase::Active);
        assert!(gate.try_enter_write().is_ok());
    }

    #[tokio::test]
    async fn concurrent_maintenance_requests_converge() {
        let gate = MaintenanceGate::default();
        let first = gate.clone();
        let second = gate.clone();
        let (left, right) = tokio::join!(
            first.enter_maintenance(Duration::from_secs(1)),
            second.enter_maintenance(Duration::from_secs(1))
        );
        assert_eq!(left, Ok(()));
        assert_eq!(right, Ok(()));
        assert_eq!(gate.phase(), MaintenancePhase::Maintenance);
    }

    #[tokio::test]
    async fn public_status_exposes_only_read_only_state() {
        let gate = MaintenanceGate::default();
        gate.enter_maintenance(Duration::from_secs(1))
            .await
            .unwrap();
        let response = public_router(gate)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/maintenance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "phase": "maintenance",
                "readOnly": true
            })
        );
    }
}
