//! Structured, redacting process logs.
//!
//! Every event carries the process identity and an application timestamp while
//! ANSI escapes, thread identifiers, and source locations stay disabled. Field
//! values are redacted at the subscriber boundary as defense in depth; callers
//! must still avoid recording raw credentials and untrusted error text.

mod diagnostics;
mod logging;
mod metrics;
mod requests;
mod telemetry;

pub(crate) use diagnostics::{
    DIAGNOSTIC_RING_CAPACITY, DiagnosticRingEvent, diagnostic_snapshot, push_bounded_diagnostic,
};
pub use logging::{
    LogConfig, LogFormat, LogLevel, ParseLogFormatError, ParseLogLevelError, TelemetryInstallError,
    build_dispatch, install, install_with_telemetry, redact_text,
};
pub(crate) use logging::{REDACTED, SERVICE_NAME, collect_json_fields};
pub use metrics::{MetricsService, observe_http};
pub use requests::{
    LifecycleEvent, RequestFailure, record_lifecycle, record_request_completed,
    record_request_failed, request_span,
};
pub use telemetry::{TelemetryConfig, TelemetryConfigError, TelemetryProviders};

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};

    use serde_json::Value;

    use crate::VERSION;

    use super::*;

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Captured {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    struct CapturedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn capture_at(format: LogFormat, level: LogLevel, emit: impl FnOnce()) -> String {
        let captured = Captured::default();
        let writer_capture = captured.clone();
        let dispatch = build_dispatch(LogConfig { format, level }, move || {
            CapturedWriter(Arc::clone(&writer_capture.0))
        });
        tracing::dispatcher::with_default(&dispatch, emit);
        captured.text()
    }

    fn capture(format: LogFormat, emit: impl FnOnce()) -> String {
        capture_at(format, LogLevel::Debug, emit)
    }

    #[test]
    fn parses_only_explicit_deterministic_logging_values() {
        assert_eq!("text".parse(), Ok(LogFormat::Text));
        assert_eq!("json".parse(), Ok(LogFormat::Json));
        assert!("pretty".parse::<LogFormat>().is_err());
        assert_eq!("debug".parse(), Ok(LogLevel::Debug));
        assert!("off".parse::<LogLevel>().is_err());
        assert!("trace".parse::<LogLevel>().is_err());
        assert!("verbose".parse::<LogLevel>().is_err());
    }

    #[test]
    fn text_logs_correlate_request_and_lifecycle_events() {
        let output = capture(LogFormat::Text, || {
            record_lifecycle(LifecycleEvent::Running);
            let span = request_span("req-01", "GET", "/api/v1/health");
            let _entered = span.enter();
            record_request_completed("req-01", 200);
        });

        assert!(output.contains("event_category=\"lifecycle\""));
        assert!(output.contains("lifecycle_event=\"running\""));
        assert!(output.contains("service=\"nuriteo-server\""));
        assert!(output.contains("release=\"0.1.0\""));
        assert!(output.contains("event_name=\"server.lifecycle.transition\""));
        assert!(output.contains("timestamp=\""));
        assert!(output.contains("request_id=\"req-01\""));
        assert!(output.contains("request_outcome=\"completed\""));
        assert!(output.contains("http_status_code=200"));
    }

    #[test]
    fn json_logs_capture_typed_normal_and_error_events() {
        let output = capture(LogFormat::Json, || {
            record_request_completed("req-ok", 204);
            record_request_failed("req-failed", 503, RequestFailure::DependencyUnavailable);
        });
        let lines: Vec<Value> = output
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["level"], "INFO");
        assert_eq!(lines[0]["service"], SERVICE_NAME);
        assert_eq!(lines[0]["release"], VERSION);
        assert_eq!(lines[0]["event_name"], "http.request.completed");
        assert!(lines[0]["timestamp"].as_str().unwrap().contains('T'));
        assert_eq!(lines[0]["fields"]["request_id"], "req-ok");
        assert_eq!(lines[0]["fields"]["http_status_code"], 204);
        assert_eq!(lines[1]["level"], "ERROR");
        assert_eq!(lines[1]["event_name"], "http.request.failed");
        assert_eq!(lines[1]["fields"]["request_id"], "req-failed");
        assert_eq!(lines[1]["fields"]["request_outcome"], "failed");
        assert_eq!(lines[1]["fields"]["error_code"], "DEPENDENCY_UNAVAILABLE");
        assert_eq!(lines[1]["fields"]["error_category"], "dependency");
    }

    #[test]
    fn redacts_sensitive_fields_and_secrets_embedded_in_messages() {
        const PASSWORD: &str = "correct-horse-battery-staple";
        const TOKEN: &str = "header.payload.signature";
        const CONNECTION: &str = "postgres://admin:db-pass@database.example/nuriteo";
        const USERINFO_URL: &str = "https://service-user:web-pass@example.test/path";

        for format in [LogFormat::Text, LogFormat::Json] {
            let output = capture(format, || {
                tracing::error!(
                    event_name = "credential.failure",
                    password = PASSWORD,
                    access_token = TOKEN,
                    clientSecret = "camel-case-secret",
                    private_key = "private-key-material",
                    x_api_key = "header-key-material",
                    endpoint = CONNECTION,
                    error = %format_args!(
                        "connect failed: {CONNECTION}; authorization=Bearer {TOKEN}; url={USERINFO_URL}"
                    ),
                    "credential failure"
                );
            });

            assert!(output.contains(REDACTED));
            assert!(!output.contains(PASSWORD));
            assert!(!output.contains(TOKEN));
            assert!(!output.contains("db-pass"));
            assert!(!output.contains("web-pass"));
            assert!(!output.contains("camel-case-secret"));
            assert!(!output.contains("private-key-material"));
            assert!(!output.contains("header-key-material"));
        }
    }

    #[test]
    fn directly_redacts_connection_strings_and_secret_assignments() {
        let cases = [
            "redis://default:secret@cache.internal/0",
            "password=visible-until-redacted",
            "access_token=opaque-access-token",
            "clientSecret=camel-case-secret",
            "private_key=private-key-material",
            "x-api-key=header-key-material",
            "Authorization: Basic dXNlcjpwYXNz",
            "request to https://user:password@example.test failed",
        ];

        for value in cases {
            let redacted = redact_text(value);
            assert!(redacted.contains(REDACTED));
            assert!(!redacted.contains("visible-until-redacted"));
            assert!(!redacted.contains("opaque-access-token"));
            assert!(!redacted.contains("dXNlcjpwYXNz"));
            assert!(!redacted.contains("password@example"));
            assert!(!redacted.contains("camel-case-secret"));
            assert!(!redacted.contains("private-key-material"));
            assert!(!redacted.contains("header-key-material"));
        }
    }

    #[test]
    fn json_nested_spans_preserve_ancestor_correlation_and_redaction() {
        let output = capture(LogFormat::Json, || {
            let request = request_span("req-updated", "GET", "/api/v1/version");
            let _request_entered = request.enter();
            request.record("request_id", "req-updated");
            let child = tracing::info_span!(
                "database.query",
                database_system = "postgresql",
                token = tracing::field::Empty
            );
            child.record("token", "must-never-appear");
            let _child_entered = child.enter();
            tracing::info!(event_name = "database.query.completed", "query completed");
        });
        let line: Value = serde_json::from_str(output.trim()).unwrap();

        assert_eq!(line["spans"][0]["name"], "http.request");
        assert_eq!(line["spans"][0]["request_id"], "req-updated");
        assert_eq!(line["spans"][1]["name"], "database.query");
        assert_eq!(line["spans"][1]["token"], REDACTED);
        assert!(!output.contains("must-never-appear"));
    }

    #[test]
    fn preserves_safe_operational_fields_with_sensitive_words() {
        let output = capture(LogFormat::Json, || {
            tracing::info!(
                event_name = "runtime.capacity",
                token_count = 7_u64,
                secret_rotation_enabled = true,
                cookie_count = 3_u64,
                "capacity sampled"
            );
        });
        let line: Value = serde_json::from_str(output.trim()).unwrap();

        assert_eq!(line["fields"]["token_count"], 7);
        assert_eq!(line["fields"]["secret_rotation_enabled"], true);
        assert_eq!(line["fields"]["cookie_count"], 3);
    }

    #[test]
    fn filters_events_at_the_configured_level() {
        let output = capture_at(LogFormat::Json, LogLevel::Warn, || {
            tracing::info!(event_name = "filtered.info", "not emitted");
            tracing::warn!(event_name = "visible.warning", "emitted");
        });
        let lines: Vec<Value> = output
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["event_name"], "visible.warning");
    }

    #[test]
    fn diagnostic_ring_evicts_oldest_events_at_its_fixed_capacity() {
        let mut ring = VecDeque::new();
        for sequence in 0..=DIAGNOSTIC_RING_CAPACITY {
            push_bounded_diagnostic(
                &mut ring,
                DiagnosticRingEvent {
                    sequence: u64::try_from(sequence).unwrap(),
                    occurred_at_unix_ms: 0,
                    event_name: "fixture.event",
                    level: "INFO",
                    operation_id: None,
                    code: None,
                    status_code: None,
                },
            );
        }
        assert_eq!(ring.len(), DIAGNOSTIC_RING_CAPACITY);
        assert_eq!(ring.front().map(|event| event.sequence), Some(1));
        assert_eq!(ring.back().map(|event| event.sequence), Some(128));
    }
}
