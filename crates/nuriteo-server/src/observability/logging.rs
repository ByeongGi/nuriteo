use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::str::FromStr;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Number, Value};
use tracing::field::{Field, Visit};
use tracing::{Dispatch, Event, Subscriber};
use tracing_subscriber::Layer as _;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::format::{FormatFields, Writer};
use tracing_subscriber::fmt::time::{FormatTime, SystemTime};
use tracing_subscriber::fmt::writer::MakeWriter;
use tracing_subscriber::fmt::{
    FmtContext, FormatEvent, FormattedFields, Subscriber as FmtSubscriber,
};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;

use crate::VERSION;

use super::telemetry::{TelemetryConfig, TelemetryConfigError, TelemetryProviders};

pub(crate) const REDACTED: &str = "[REDACTED]";
pub(crate) const SERVICE_NAME: &str = "nuriteo-server";
const UNCLASSIFIED_EVENT: &str = "application.event";
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

pub(crate) fn collect_json_fields<R: tracing_subscriber::field::RecordFields>(
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
