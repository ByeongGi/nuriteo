use tracing::Span;

use super::diagnostics::record_diagnostic;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleEvent {
    Starting,
    Running,
    Draining,
    Stopped,
}

impl LifecycleEvent {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Draining => "draining",
            Self::Stopped => "stopped",
        }
    }
}

/// Emits a stable lifecycle event name for process supervision correlation.
pub fn record_lifecycle(event: LifecycleEvent) {
    record_diagnostic(
        "server.lifecycle.transition",
        "INFO",
        None,
        Some(event.as_str()),
        None,
    );
    tracing::info!(
        event_name = "server.lifecycle.transition",
        event_category = "lifecycle",
        lifecycle_event = event.as_str(),
        "server lifecycle transition"
    );
}

/// Creates the request correlation span used by HTTP handlers and middleware.
///
/// `route` must be a bounded route template. Callers must not pass a raw URI,
/// query string, or user-controlled path parameter.
#[must_use]
pub fn request_span(request_id: &str, method: &str, route: &str) -> Span {
    tracing::info_span!(
        "http.request",
        request_id,
        http_method = method,
        http_route = route
    )
}

/// Emits the terminal success event for a request.
pub fn record_request_completed(request_id: &str, status_code: u16) {
    record_diagnostic(
        "http.request.completed",
        "INFO",
        Some(request_id),
        Some("REQUEST_COMPLETED"),
        Some(status_code),
    );
    tracing::info!(
        event_name = "http.request.completed",
        event_category = "request",
        request_id,
        request_outcome = "completed",
        http_status_code = status_code,
        "request completed"
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestFailure {
    NotFound,
    MethodNotAllowed,
    Validation,
    Internal,
    DependencyUnavailable,
}

impl RequestFailure {
    const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "ROUTE_NOT_FOUND",
            Self::MethodNotAllowed => "METHOD_NOT_ALLOWED",
            Self::Validation => "VALIDATION_FAILED",
            Self::Internal => "INTERNAL_SERVER_ERROR",
            Self::DependencyUnavailable => "DEPENDENCY_UNAVAILABLE",
        }
    }

    const fn category(self) -> &'static str {
        match self {
            Self::NotFound | Self::MethodNotAllowed | Self::Validation => "client",
            Self::Internal => "server",
            Self::DependencyUnavailable => "dependency",
        }
    }
}

/// Emits a terminal failure event using only allowlisted diagnostics.
pub fn record_request_failed(request_id: &str, status_code: u16, failure: RequestFailure) {
    record_diagnostic(
        "http.request.failed",
        "ERROR",
        Some(request_id),
        Some(failure.code()),
        Some(status_code),
    );
    tracing::error!(
        event_name = "http.request.failed",
        event_category = "request",
        request_id,
        request_outcome = "failed",
        http_status_code = status_code,
        error_code = failure.code(),
        error_category = failure.category(),
        "request failed"
    );
}
