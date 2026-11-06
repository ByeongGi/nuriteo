use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime as StdSystemTime, UNIX_EPOCH};

pub(crate) const DIAGNOSTIC_RING_CAPACITY: usize = 128;
const DIAGNOSTIC_BUNDLE_LIMIT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiagnosticRingEvent {
    pub sequence: u64,
    pub occurred_at_unix_ms: u64,
    pub event_name: &'static str,
    pub level: &'static str,
    pub operation_id: Option<String>,
    pub code: Option<&'static str>,
    pub status_code: Option<u16>,
}

static DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static DIAGNOSTIC_RING: LazyLock<Mutex<VecDeque<DiagnosticRingEvent>>> =
    LazyLock::new(|| Mutex::new(VecDeque::with_capacity(DIAGNOSTIC_RING_CAPACITY)));

pub(crate) fn diagnostic_snapshot(limit: usize) -> Vec<DiagnosticRingEvent> {
    let Ok(ring) = DIAGNOSTIC_RING.lock() else {
        return Vec::new();
    };
    let mut snapshot = ring
        .iter()
        .rev()
        .take(limit.min(DIAGNOSTIC_BUNDLE_LIMIT))
        .cloned()
        .collect::<Vec<_>>();
    snapshot.reverse();
    snapshot
}

pub(crate) fn record_diagnostic(
    event_name: &'static str,
    level: &'static str,
    operation_id: Option<&str>,
    code: Option<&'static str>,
    status_code: Option<u16>,
) {
    let occurred_at_unix_ms = StdSystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        });
    let event = DiagnosticRingEvent {
        sequence: DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        occurred_at_unix_ms,
        event_name,
        level,
        operation_id: operation_id.map(str::to_owned),
        code,
        status_code,
    };
    if let Ok(mut ring) = DIAGNOSTIC_RING.lock() {
        push_bounded_diagnostic(&mut ring, event);
    }
}

pub(crate) fn push_bounded_diagnostic(
    ring: &mut VecDeque<DiagnosticRingEvent>,
    event: DiagnosticRingEvent,
) {
    if ring.len() == DIAGNOSTIC_RING_CAPACITY {
        ring.pop_front();
    }
    ring.push_back(event);
}
