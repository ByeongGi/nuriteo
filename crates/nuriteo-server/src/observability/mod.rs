//! Structured, redacting process logs.
//!
//! Every event carries the process identity and an application timestamp while
//! ANSI escapes, thread identifiers, and source locations stay disabled. Field
//! values are redacted at the subscriber boundary as defense in depth; callers
//! must still avoid recording raw credentials and untrusted error text.

use std::collections::{BTreeMap, VecDeque};
use std::error::Error;
use std::fmt;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime as StdSystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{Map, Number, Value};
use tracing::field::{Field, Visit};
use tracing::{Dispatch, Event, Span, Subscriber};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::format::{FormatFields, Writer};
use tracing_subscriber::fmt::time::{FormatTime, SystemTime};
use tracing_subscriber::fmt::writer::MakeWriter;
use tracing_subscriber::fmt::{
    FmtContext, FormatEvent, FormattedFields, Subscriber as FmtSubscriber,
};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{Layer as _, layer::SubscriberExt};

use crate::VERSION;

mod metrics;
mod telemetry;

pub use metrics::{MetricsService, observe_http};
pub use telemetry::{TelemetryConfig, TelemetryConfigError, TelemetryProviders};

const REDACTED: &str = "[REDACTED]";
const SERVICE_NAME: &str = "nuriteo-server";
const UNCLASSIFIED_EVENT: &str = "application.event";
const DIAGNOSTIC_RING_CAPACITY: usize = 128;
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

fn record_diagnostic(
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

fn push_bounded_diagnostic(ring: &mut VecDeque<DiagnosticRingEvent>, event: DiagnosticRingEvent) {
    if ring.len() == DIAGNOSTIC_RING_CAPACITY {
        ring.pop_front();
    }
    ring.push_back(event);
}

static CONNECTION_STRING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps)://[^\s\"'`,;}\]]+"#,
    )
    .expect("the connection-string redaction expression is valid")
});
static USERINFO_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b[a-z][a-z0-9+.-]*://[^\s/\"'`,;:@]+:[^\s/\"'`,;@]+@[^\s\"'`,;}\]]+"#)
        .expect("the URL userinfo redaction expression is valid")
});
static SECRET_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?ix)
        \b(password|passwd|pwd|passphrase|secret|token|access[_-]?token|refresh[_-]?token|
           id[_-]?token|access[_-]?key|api[_-]?key|x[_-]?api[_-]?key|client[_-]?secret|
           secret[_-]?access[_-]?key|private[_-]?key|credential|credentials|authorization|
           cookie|dsn|database[_-]?url|connection(?:[_-]|\s+)?string)
        \b[\"']?\s*[:=]\s*(?:\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|[^,;\r\n}\]]+)
        "#,
    )
    .expect("the secret-assignment redaction expression is valid")
});
static AUTHORIZATION_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+")
        .expect("the authorization redaction expression is valid")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Text,
    Json,
}

impl FromStr for LogFormat {
    type Err = ParseLogFormatError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "text" => Ok(Self::Text),
            "json" => Ok(Self::Json),
            _ => Err(ParseLogFormatError),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseLogFormatError;

impl fmt::Display for ParseLogFormatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("log format must be `text` or `json`")
    }
}

impl Error for ParseLogFormatError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

impl LogLevel {
    const fn as_filter(self) -> LevelFilter {
        match self {
            Self::Error => LevelFilter::ERROR,
            Self::Warn => LevelFilter::WARN,
            Self::Info => LevelFilter::INFO,
            Self::Debug => LevelFilter::DEBUG,
        }
    }
}

impl FromStr for LogLevel {
    type Err = ParseLogLevelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "error" => Ok(Self::Error),
            "warn" => Ok(Self::Warn),
            "info" => Ok(Self::Info),
            "debug" => Ok(Self::Debug),
            _ => Err(ParseLogLevelError),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseLogLevelError;

impl fmt::Display for ParseLogLevelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("log level must be `error`, `warn`, `info`, or `debug`")
    }
}

impl Error for ParseLogLevelError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogConfig {
    pub format: LogFormat,
    pub level: LogLevel,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            format: LogFormat::Text,
            level: LogLevel::Info,
        }
    }
}

/// Builds a dispatcher without mutating the process-global default.
///
/// Keeping construction separate from installation lets tests and embedded
/// callers scope the subscriber with [`tracing::dispatcher::with_default`].
#[must_use]
pub fn build_dispatch<W>(config: LogConfig, writer: W) -> Dispatch
where
    W: for<'writer> MakeWriter<'writer> + Send + Sync + 'static,
{
    match config.format {
        LogFormat::Text => Dispatch::new(
            FmtSubscriber::builder()
                .with_max_level(config.level.as_filter())
                .with_writer(writer)
                .with_ansi(false)
                .with_target(false)
                .with_thread_ids(false)
                .with_thread_names(false)
                .with_file(false)
                .with_line_number(false)
                .fmt_fields(RedactedJsonFields)
                .event_format(RedactedTextEvent)
                .finish(),
        ),
        LogFormat::Json => Dispatch::new(
            FmtSubscriber::builder()
                .fmt_fields(RedactedJsonFields)
                .event_format(RedactedJsonEvent)
                .with_max_level(config.level.as_filter())
                .with_writer(writer)
                .finish(),
        ),
    }
}

/// Installs the process logger on standard error.
pub fn install(config: LogConfig) -> Result<(), tracing::dispatcher::SetGlobalDefaultError> {
    tracing::dispatcher::set_global_default(build_dispatch(config, std::io::stderr))
}

#[derive(Debug)]
pub enum TelemetryInstallError {
    Configuration(TelemetryConfigError),
    Subscriber,
}

/// Installs the local redacting logger and optional OTLP layers as one global subscriber.
///
/// The returned providers own the bounded exporters and flush them on drop. Collector
/// availability is deliberately not checked here: batch export failures remain isolated
/// from request processing and are surfaced by the SDK's internal diagnostics.
pub fn install_with_telemetry(
    log: LogConfig,
    telemetry: &TelemetryConfig,
) -> Result<TelemetryProviders, TelemetryInstallError> {
    let providers =
        TelemetryProviders::build(telemetry).map_err(TelemetryInstallError::Configuration)?;
    let log_layer = providers.log_layer(telemetry.log_min_level);

    match log.format {
        LogFormat::Text => {
            let fmt = tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(false)
                .with_target(false)
                .with_thread_ids(false)
                .with_thread_names(false)
                .with_file(false)
                .with_line_number(false)
                .fmt_fields(RedactedJsonFields)
                .event_format(RedactedTextEvent)
                .with_filter(log.level.as_filter());
            tracing::subscriber::set_global_default(
                tracing_subscriber::registry().with(log_layer).with(fmt),
            )
            .map_err(|_| TelemetryInstallError::Subscriber)?;
        }
        LogFormat::Json => {
            let fmt = tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .fmt_fields(RedactedJsonFields)
                .event_format(RedactedJsonEvent)
                .with_filter(log.level.as_filter());
            tracing::subscriber::set_global_default(
                tracing_subscriber::registry().with(log_layer).with(fmt),
            )
            .map_err(|_| TelemetryInstallError::Subscriber)?;
        }
    }
    Ok(providers)
}

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

/// Removes credentials from free-form values before they reach any formatter.
///
/// Subscriber visitors call this for every string, debug value, and error in
/// addition to replacing values whose field name is intrinsically sensitive.
#[must_use]
pub fn redact_text(value: &str) -> String {
    let value = CONNECTION_STRING.replace_all(value, REDACTED);
    let value = USERINFO_URL.replace_all(&value, REDACTED);
    let value = SECRET_ASSIGNMENT.replace_all(&value, "$1=[REDACTED]");
    AUTHORIZATION_VALUE
        .replace_all(&value, REDACTED)
        .into_owned()
}

fn is_sensitive_field(field: &Field) -> bool {
    let normalized = field
        .name()
        .to_ascii_lowercase()
        .replace(['_', '-', '.'], "");
    [
        "password",
        "passwd",
        "pwd",
        "passphrase",
        "passwordhash",
        "passworddigest",
        "secret",
        "token",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "clientsecret",
        "secretaccesskey",
        "privatekey",
        "accesskey",
        "apikey",
        "credential",
        "credentials",
        "authorization",
        "authorizationheader",
        "cookie",
        "cookieheader",
        "setcookie",
        "dsn",
        "databaseurl",
        "connectionstring",
    ]
    .into_iter()
    .any(|suffix| normalized.ends_with(suffix))
}

#[derive(Debug)]
struct RedactedJsonFields;

#[derive(Debug)]
struct RedactedTextEvent;

#[derive(Debug)]
struct RedactedJsonEvent;

impl<S> FormatEvent<S, RedactedJsonFields> for RedactedTextEvent
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn format_event(
        &self,
        context: &FmtContext<'_, S, RedactedJsonFields>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let timestamp = timestamp()?;
        let mut fields = collect_json_fields(event);
        let event_name = take_event_name(&mut fields);
        write!(
            writer,
            "timestamp={timestamp:?} level={} service={SERVICE_NAME:?} release={VERSION:?} event_name={event_name:?}",
            event.metadata().level()
        )?;

        let spans = collect_span_values(context);
        if !spans.is_empty() {
            write!(writer, " spans={}", Value::Array(spans))?;
        }
        for (name, value) in fields {
            write!(writer, " {name}={value}")?;
        }
        writeln!(writer)
    }
}

impl<S> FormatEvent<S, RedactedJsonFields> for RedactedJsonEvent
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn format_event(
        &self,
        context: &FmtContext<'_, S, RedactedJsonFields>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let mut output = Map::new();
        output.insert("timestamp".to_owned(), Value::String(timestamp()?));
        output.insert(
            "level".to_owned(),
            Value::String(event.metadata().level().as_str().to_owned()),
        );
        output.insert("service".to_owned(), Value::String(SERVICE_NAME.to_owned()));
        output.insert("release".to_owned(), Value::String(VERSION.to_owned()));

        let mut fields = collect_json_fields(event);
        output.insert(
            "event_name".to_owned(),
            Value::String(take_event_name(&mut fields)),
        );
        output.insert("fields".to_owned(), map_value(fields));

        let spans = collect_span_values(context);
        if !spans.is_empty() {
            output.insert("spans".to_owned(), Value::Array(spans));
        }

        let json = serde_json::to_string(&output).map_err(|_| fmt::Error)?;
        writeln!(writer, "{json}")
    }
}

fn timestamp() -> Result<String, fmt::Error> {
    let mut timestamp = String::new();
    SystemTime.format_time(&mut Writer::new(&mut timestamp))?;
    Ok(timestamp)
}

fn take_event_name(fields: &mut BTreeMap<String, Value>) -> String {
    fields
        .remove("event_name")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| UNCLASSIFIED_EVENT.to_owned())
}

fn collect_span_values<S>(context: &FmtContext<'_, S, RedactedJsonFields>) -> Vec<Value>
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    context
        .event_scope()
        .into_iter()
        .flat_map(|scope| scope.from_root())
        .map(|span| {
            let extensions = span.extensions();
            let mut fields = extensions
                .get::<FormattedFields<RedactedJsonFields>>()
                .and_then(|fields| serde_json::from_str::<Map<String, Value>>(fields).ok())
                .unwrap_or_default();
            fields.insert(
                "name".to_owned(),
                Value::String(span.metadata().name().to_owned()),
            );
            Value::Object(fields)
        })
        .collect()
}

impl<'writer> FormatFields<'writer> for RedactedJsonFields {
    fn format_fields<R: tracing_subscriber::field::RecordFields>(
        &self,
        mut writer: Writer<'writer>,
        fields: R,
    ) -> fmt::Result {
        let values = collect_json_fields(fields);
        let json = serde_json::to_string(&values).map_err(|_| fmt::Error)?;
        write!(writer, "{json}")
    }

    fn add_fields(
        &self,
        current: &'writer mut FormattedFields<Self>,
        fields: &tracing::span::Record<'_>,
    ) -> fmt::Result {
        let mut values: BTreeMap<String, Value> =
            serde_json::from_str(&current.fields).map_err(|_| fmt::Error)?;
        fields.record(&mut JsonVisitor {
            values: &mut values,
        });
        current.fields.clear();
        current.fields = serde_json::to_string(&values).map_err(|_| fmt::Error)?;
        Ok(())
    }
}

fn collect_json_fields<R: tracing_subscriber::field::RecordFields>(
    fields: R,
) -> BTreeMap<String, Value> {
    let mut values = BTreeMap::new();
    fields.record(&mut JsonVisitor {
        values: &mut values,
    });
    values
}

fn map_value(values: BTreeMap<String, Value>) -> Value {
    Value::Object(values.into_iter().collect())
}

struct JsonVisitor<'values> {
    values: &'values mut BTreeMap<String, Value>,
}

impl JsonVisitor<'_> {
    fn insert(&mut self, field: &Field, value: Value) {
        let value = if is_sensitive_field(field) {
            Value::String(REDACTED.to_owned())
        } else if let Value::String(value) = value {
            Value::String(redact_text(&value))
        } else {
            value
        };
        self.values.insert(field.name().to_owned(), value);
    }
}

impl Visit for JsonVisitor<'_> {
    fn record_f64(&mut self, field: &Field, value: f64) {
        let value = Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null);
        self.insert(field, value);
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.insert(field, Value::Number(value.into()));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.insert(field, Value::Number(value.into()));
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.insert(field, Value::String(value.to_string()));
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.insert(field, Value::String(value.to_string()));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.insert(field, Value::Bool(value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(field, Value::String(value.to_owned()));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn Error + 'static)) {
        self.insert(field, Value::String(value.to_string()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.insert(field, Value::String(format!("{value:?}")));
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};

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
