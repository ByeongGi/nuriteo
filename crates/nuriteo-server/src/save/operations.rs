use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::time;

use crate::database::DatabasePool;
use crate::observability::MetricsService;

const MAX_STATUS_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupOperationsPolicy {
    stale_threshold: Duration,
    failed_threshold: u64,
    query_timeout: Duration,
}

impl CleanupOperationsPolicy {
    pub fn new(
        stale_threshold: Duration,
        failed_threshold: u64,
        query_timeout: Duration,
    ) -> Result<Self, CleanupOperationsError> {
        if !(Duration::from_secs(60)..=Duration::from_secs(24 * 60 * 60)).contains(&stale_threshold)
            || !(1..=1_000_000).contains(&failed_threshold)
            || !(Duration::from_millis(100)..=Duration::from_secs(10)).contains(&query_timeout)
        {
            return Err(CleanupOperationsError::InvalidPolicy);
        }
        Ok(Self {
            stale_threshold,
            failed_threshold,
            query_timeout,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupOperationsError {
    InvalidPolicy,
    Capacity,
    Unavailable,
    InvalidData,
}

impl std::fmt::Display for CleanupOperationsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPolicy => "cleanup operations policy is invalid",
            Self::Capacity => "cleanup operations status capacity is exhausted",
            Self::Unavailable => "cleanup operations status is unavailable",
            Self::InvalidData => "cleanup operations status data is invalid",
        })
    }
}

impl std::error::Error for CleanupOperationsError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanupOperatorState {
    Nominal,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CleanupOperationsSnapshot {
    pub state: CleanupOperatorState,
    pub queue_depth: u64,
    pub oldest_eligible_age_seconds: Option<u64>,
    pub running_count: u64,
    pub retry_count: u64,
    pub failed_count: u64,
}

#[derive(Clone)]
pub struct CleanupOperationsService {
    pool: DatabasePool,
    policy: CleanupOperationsPolicy,
    gate: Arc<Semaphore>,
    metrics: MetricsService,
}

impl CleanupOperationsService {
    #[must_use]
    pub fn new(pool: DatabasePool, policy: CleanupOperationsPolicy) -> Self {
        Self {
            pool,
            policy,
            gate: Arc::new(Semaphore::new(MAX_STATUS_CONCURRENCY)),
            metrics: MetricsService::new(),
        }
    }

    #[must_use]
    pub fn with_metrics(mut self, metrics: MetricsService) -> Self {
        self.metrics = metrics;
        self
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/health/cleanup", get(cleanup_status))
            .route("/metrics", get(cleanup_metrics))
            .with_state(self)
    }

    pub async fn snapshot(&self) -> Result<CleanupOperationsSnapshot, CleanupOperationsError> {
        let _permit = self
            .gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| CleanupOperationsError::Capacity)?;
        let query = async {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|_| CleanupOperationsError::Unavailable)?;
            sqlx::query_as::<_, (i64, Option<i64>, i64, i64, i64)>(
                "WITH jobs AS (SELECT status,CASE \
                     WHEN status='queued' THEN eligible_at \
                     WHEN status='retry_wait' THEN retry_at END AS ready_at \
                   FROM save_cleanup_jobs) \
                 SELECT \
                   COUNT(*) FILTER (WHERE status IN ('queued','retry_wait'))::bigint, \
                   FLOOR(EXTRACT(EPOCH FROM (transaction_timestamp()-MIN(ready_at) \
                     FILTER (WHERE status IN ('queued','retry_wait') \
                       AND ready_at <= transaction_timestamp()))))::bigint, \
                   COUNT(*) FILTER (WHERE status='running')::bigint, \
                   COUNT(*) FILTER (WHERE status='retry_wait')::bigint, \
                   COUNT(*) FILTER (WHERE status='failed')::bigint \
                 FROM jobs",
            )
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| CleanupOperationsError::Unavailable)
        };
        let row = time::timeout(self.policy.query_timeout, query)
            .await
            .map_err(|_| CleanupOperationsError::Unavailable)??;
        snapshot_from_row(row, self.policy)
    }
}

fn snapshot_from_row(
    row: (i64, Option<i64>, i64, i64, i64),
    policy: CleanupOperationsPolicy,
) -> Result<CleanupOperationsSnapshot, CleanupOperationsError> {
    let queue_depth = positive(row.0)?;
    let oldest_eligible_age_seconds = row.1.map(positive).transpose()?;
    let running_count = positive(row.2)?;
    let retry_count = positive(row.3)?;
    let failed_count = positive(row.4)?;
    let stale =
        oldest_eligible_age_seconds.is_some_and(|age| age >= policy.stale_threshold.as_secs());
    let state = if stale || failed_count >= policy.failed_threshold {
        CleanupOperatorState::Degraded
    } else {
        CleanupOperatorState::Nominal
    };
    Ok(CleanupOperationsSnapshot {
        state,
        queue_depth,
        oldest_eligible_age_seconds,
        running_count,
        retry_count,
        failed_count,
    })
}

fn positive(value: i64) -> Result<u64, CleanupOperationsError> {
    u64::try_from(value).map_err(|_| CleanupOperationsError::InvalidData)
}

async fn cleanup_status(State(service): State<CleanupOperationsService>) -> impl IntoResponse {
    match service.snapshot().await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"state": "unavailable"})),
        )
            .into_response(),
    }
}

async fn cleanup_metrics(State(service): State<CleanupOperationsService>) -> impl IntoResponse {
    match service.snapshot().await {
        Ok(snapshot) => {
            let degraded = u8::from(snapshot.state == CleanupOperatorState::Degraded);
            let oldest = snapshot.oldest_eligible_age_seconds.unwrap_or(0);
            let cleanup = format!(
                "# TYPE nuriteo_cleanup_queue_depth gauge\n\
                 nuriteo_cleanup_queue_depth {}\n\
                 # TYPE nuriteo_cleanup_oldest_eligible_age_seconds gauge\n\
                 nuriteo_cleanup_oldest_eligible_age_seconds {oldest}\n\
                 # TYPE nuriteo_cleanup_running_count gauge\n\
                 nuriteo_cleanup_running_count {}\n\
                 # TYPE nuriteo_cleanup_retry_count gauge\n\
                 nuriteo_cleanup_retry_count {}\n\
                 # TYPE nuriteo_cleanup_failed_count gauge\n\
                 nuriteo_cleanup_failed_count {}\n\
                 # TYPE nuriteo_cleanup_degraded gauge\n\
                 nuriteo_cleanup_degraded {degraded}\n",
                snapshot.queue_depth,
                snapshot.running_count,
                snapshot.retry_count,
                snapshot.failed_count,
            );
            let mut body = service.metrics.render();
            if let Some(position) = body.rfind("# EOF\n") {
                body.truncate(position);
            }
            body.push_str(&cleanup);
            body.push_str("# EOF\n");
            (
                StatusCode::OK,
                [(
                    header::CONTENT_TYPE,
                    "application/openmetrics-text; version=1.0.0; charset=utf-8",
                )],
                body,
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "cleanup metrics unavailable\n",
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> CleanupOperationsPolicy {
        CleanupOperationsPolicy::new(Duration::from_secs(600), 2, Duration::from_secs(1)).unwrap()
    }

    #[test]
    fn ordinary_backlog_is_nominal_until_it_is_stale() {
        let snapshot = snapshot_from_row((20, Some(599), 1, 4, 0), policy()).unwrap();
        assert_eq!(snapshot.state, CleanupOperatorState::Nominal);
        let stale = snapshot_from_row((20, Some(600), 1, 4, 0), policy()).unwrap();
        assert_eq!(stale.state, CleanupOperatorState::Degraded);
    }

    #[test]
    fn failed_threshold_is_degraded_without_job_identity() {
        let snapshot = snapshot_from_row((0, None, 0, 0, 2), policy()).unwrap();
        assert_eq!(snapshot.state, CleanupOperatorState::Degraded);
        let serialized = serde_json::to_string(&snapshot).unwrap();
        for forbidden in ["object", "upload", "credential", "session"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn policy_and_database_values_fail_closed() {
        assert!(
            CleanupOperationsPolicy::new(Duration::from_secs(59), 1, Duration::from_secs(1))
                .is_err()
        );
        assert!(snapshot_from_row((-1, None, 0, 0, 0), policy()).is_err());
    }
}
