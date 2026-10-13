use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, SystemTime};

use opentelemetry::logs::{AnyValue, LogRecord, Logger, LoggerProvider, Severity};
use opentelemetry::{KeyValue, global};
use opentelemetry_otlp::{
    LogExporter, MetricExporter, Protocol, SpanExporter, WithExportConfig, WithHttpConfig,
    WithTonicConfig,
};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::{BatchConfigBuilder as LogBatchConfigBuilder, BatchLogProcessor};
use opentelemetry_sdk::logs::{SdkLogger, SdkLoggerProvider};
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::{
    BatchConfigBuilder as SpanBatchConfigBuilder, BatchSpanProcessor, Sampler, SdkTracerProvider,
};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

use crate::config::{Environment, FileReader, load_secret};
use crate::{VERSION, observability::collect_json_fields};

const SERVICE_NAME: &str = "nuriteo-server";
const AUTHORIZATION_FILE: &str = "NURITEO_OTLP_AUTHORIZATION_FILE";
const CA_FILE: &str = "NURITEO_OTLP_CA_FILE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtlpProtocol {
    Grpc,
    HttpProtobuf,
}

#[derive(Clone)]
pub struct TelemetryConfig {
    pub traces: bool,
    pub metrics: bool,
    pub logs: bool,
    pub endpoint: Option<String>,
    pub protocol: OtlpProtocol,
    pub timeout: Duration,
    pub queue_size: usize,
    pub batch_size: usize,
    pub trace_sample_ratio: f64,
    pub log_min_level: Level,
    authorization: Option<String>,
    ca_pem: Option<String>,
}

impl fmt::Debug for TelemetryConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TelemetryConfig")
            .field("traces", &self.traces)
            .field("metrics", &self.metrics)
            .field("logs", &self.logs)
            .field("endpoint", &self.endpoint)
            .field("protocol", &self.protocol)
            .field("timeout", &self.timeout)
            .field("queue_size", &self.queue_size)
            .field("batch_size", &self.batch_size)
            .field("trace_sample_ratio", &self.trace_sample_ratio)
            .field("log_min_level", &self.log_min_level)
            .field(
                "authorization",
                &self.authorization.as_ref().map(|_| "[REDACTED]"),
            )
            .field("ca_pem", &self.ca_pem.as_ref().map(|_| "configured"))
            .finish()
    }
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            traces: false,
            metrics: false,
            logs: false,
            endpoint: None,
            protocol: OtlpProtocol::Grpc,
            timeout: Duration::from_secs(5),
            queue_size: 2_048,
            batch_size: 512,
            trace_sample_ratio: 0.1,
            log_min_level: Level::INFO,
            authorization: None,
            ca_pem: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetryConfigError {
    InvalidExporter,
    MissingEndpoint,
    InvalidEndpoint,
    InvalidProtocol,
    InvalidTimeout,
    InvalidQueue,
    InvalidBatch,
    InvalidSampleRatio,
    InvalidLogLevel,
    Authorization,
    InvalidCa,
}

impl TelemetryConfig {
    pub fn load(
        environment: &impl Environment,
        files: &impl FileReader,
    ) -> Result<Self, TelemetryConfigError> {
        let values = environment_values(environment);
        let traces = exporter_enabled(&values, "OTEL_TRACES_EXPORTER")?;
        let metrics = exporter_enabled(&values, "OTEL_METRICS_EXPORTER")?;
        let logs = exporter_enabled(&values, "OTEL_LOGS_EXPORTER")?;
        let enabled = traces || metrics || logs;
        let endpoint = values.get("OTEL_EXPORTER_OTLP_ENDPOINT").cloned();
        if enabled {
            let endpoint = endpoint
                .as_deref()
                .ok_or(TelemetryConfigError::MissingEndpoint)?;
            validate_endpoint(endpoint)?;
        }
        let protocol = match value_or(&values, "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc") {
            "grpc" => OtlpProtocol::Grpc,
            "http/protobuf" => OtlpProtocol::HttpProtobuf,
            _ => return Err(TelemetryConfigError::InvalidProtocol),
        };
        let timeout = bounded_u64(&values, "OTEL_EXPORTER_OTLP_TIMEOUT", 5_000, 100, 10_000)
            .map(Duration::from_millis)
            .ok_or(TelemetryConfigError::InvalidTimeout)?;
        let queue_size = bounded_u64(&values, "OTEL_BSP_MAX_QUEUE_SIZE", 2_048, 64, 4_096)
            .ok_or(TelemetryConfigError::InvalidQueue)? as usize;
        let batch_size = bounded_u64(&values, "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512, 1, 512)
            .ok_or(TelemetryConfigError::InvalidBatch)? as usize;
        if batch_size > queue_size {
            return Err(TelemetryConfigError::InvalidBatch);
        }
        let trace_sample_ratio = value_or(&values, "OTEL_TRACES_SAMPLER_ARG", "0.1")
            .parse::<f64>()
            .ok()
            .filter(|ratio| ratio.is_finite() && (0.0..=1.0).contains(ratio))
            .ok_or(TelemetryConfigError::InvalidSampleRatio)?;
        let log_min_level = match value_or(&values, "OTEL_LOG_LEVEL", "info") {
            "error" => Level::ERROR,
            "warn" => Level::WARN,
            "info" => Level::INFO,
            "debug" => Level::DEBUG,
            _ => return Err(TelemetryConfigError::InvalidLogLevel),
        };
        let authorization = load_secret(
            environment,
            files,
            "NURITEO_OTLP_AUTHORIZATION",
            AUTHORIZATION_FILE,
        )
        .map_err(|_| TelemetryConfigError::Authorization)?
        .map(|secret| secret.expose_secret().trim().to_owned());
        if authorization.as_ref().is_some_and(String::is_empty) {
            return Err(TelemetryConfigError::Authorization);
        }
        let ca_pem = load_secret(environment, files, "NURITEO_OTLP_CA", CA_FILE)
            .map_err(|_| TelemetryConfigError::InvalidCa)?
            .map(|value| value.expose_secret().to_owned());
        Ok(Self {
            traces,
            metrics,
            logs,
            endpoint,
            protocol,
            timeout,
            queue_size,
            batch_size,
            trace_sample_ratio,
            log_min_level,
            authorization,
            ca_pem,
        })
    }

    #[must_use]
    pub const fn enabled(&self) -> bool {
        self.traces || self.metrics || self.logs
    }
}

pub struct TelemetryProviders {
    pub tracer: Option<SdkTracerProvider>,
    pub meter: Option<SdkMeterProvider>,
    pub logger: Option<SdkLoggerProvider>,
    timeout: Duration,
}

impl TelemetryProviders {
    pub fn build(config: &TelemetryConfig) -> Result<Self, TelemetryConfigError> {
        if !config.enabled() {
            return Ok(Self {
                tracer: None,
                meter: None,
                logger: None,
                timeout: config.timeout,
            });
        }
        let resource = Resource::builder()
            .with_service_name(SERVICE_NAME)
            .with_attribute(KeyValue::new("service.version", VERSION))
            .build();
        let tracer = config
            .traces
            .then(|| build_tracer(config, resource.clone()))
            .transpose()?;
        let meter = config
            .metrics
            .then(|| build_meter(config, resource.clone()))
            .transpose()?;
        let logger = config
            .logs
            .then(|| build_logger(config, resource))
            .transpose()?;
        if let Some(provider) = &tracer {
            global::set_text_map_propagator(
                opentelemetry_sdk::propagation::TraceContextPropagator::new(),
            );
            global::set_tracer_provider(provider.clone());
        }
        if let Some(provider) = &meter {
            global::set_meter_provider(provider.clone());
        }
        Ok(Self {
            tracer,
            meter,
            logger,
            timeout: config.timeout,
        })
    }

    pub fn shutdown(&self) {
        if let Some(provider) = &self.logger {
            let _ = provider.shutdown_with_timeout(self.timeout);
        }
        if let Some(provider) = &self.meter {
            let _ = provider.shutdown_with_timeout(self.timeout);
        }
        if let Some(provider) = &self.tracer {
            let _ = provider.shutdown_with_timeout(self.timeout);
        }
    }

    pub fn log_layer(&self, minimum: Level) -> Option<RedactingOtlpLogLayer> {
        self.logger.as_ref().map(|provider| RedactingOtlpLogLayer {
            logger: provider.logger(SERVICE_NAME),
            minimum,
        })
    }
}

impl Drop for TelemetryProviders {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub struct RedactingOtlpLogLayer {
    logger: SdkLogger,
    minimum: Level,
}

impl<S> Layer<S> for RedactingOtlpLogLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        if *event.metadata().level() > self.minimum {
            return;
        }
        let mut record = self.logger.create_log_record();
        let metadata = event.metadata();
        record.set_event_name(metadata.name());
        record.set_target(metadata.target());
        record.set_timestamp(SystemTime::now());
        record.set_observed_timestamp(SystemTime::now());
        record.set_severity_text(metadata.level().as_str());
        record.set_severity_number(severity(metadata.level()));
        for (key, value) in collect_json_fields(event) {
            record.add_attribute(key, json_value(value));
        }
        self.logger.emit(record);
    }
}

fn build_tracer(
    config: &TelemetryConfig,
    resource: Resource,
) -> Result<SdkTracerProvider, TelemetryConfigError> {
    let exporter = span_exporter(config)?;
    let batch = SpanBatchConfigBuilder::default()
        .with_max_queue_size(config.queue_size)
        .with_max_export_batch_size(config.batch_size)
        .with_scheduled_delay(Duration::from_secs(1))
        .build();
    let processor = BatchSpanProcessor::builder(exporter)
        .with_batch_config(batch)
        .build();
    Ok(SdkTracerProvider::builder()
        .with_resource(resource)
        .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
            config.trace_sample_ratio,
        ))))
        .with_span_processor(processor)
        .build())
}

fn build_meter(
    config: &TelemetryConfig,
    resource: Resource,
) -> Result<SdkMeterProvider, TelemetryConfigError> {
    let exporter = metric_exporter(config)?;
    Ok(SdkMeterProvider::builder()
        .with_resource(resource)
        .with_periodic_exporter(exporter)
        .build())
}

fn build_logger(
    config: &TelemetryConfig,
    resource: Resource,
) -> Result<SdkLoggerProvider, TelemetryConfigError> {
    let exporter = log_exporter(config)?;
    let batch = LogBatchConfigBuilder::default()
        .with_max_queue_size(config.queue_size)
        .with_max_export_batch_size(config.batch_size)
        .with_scheduled_delay(Duration::from_secs(1))
        .build();
    let processor = BatchLogProcessor::builder(exporter)
        .with_batch_config(batch)
        .build();
    Ok(SdkLoggerProvider::builder()
        .with_resource(resource)
        .with_log_processor(processor)
        .build())
}

fn span_exporter(config: &TelemetryConfig) -> Result<SpanExporter, TelemetryConfigError> {
    let endpoint = signal_endpoint(config, "traces");
    match config.protocol {
        OtlpProtocol::Grpc => grpc_span_builder(config)?
            .with_endpoint(endpoint)
            .with_timeout(config.timeout)
            .with_metadata(metadata(config)?)
            .build()
            .map_err(|_| TelemetryConfigError::InvalidEndpoint),
        OtlpProtocol::HttpProtobuf => http_span_builder(config)?
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(endpoint)
            .with_timeout(config.timeout)
            .with_headers(headers(config))
            .with_max_request_body_size(4 * 1024 * 1024)
            .build()
            .map_err(|_| TelemetryConfigError::InvalidEndpoint),
    }
}

fn metric_exporter(config: &TelemetryConfig) -> Result<MetricExporter, TelemetryConfigError> {
    let endpoint = signal_endpoint(config, "metrics");
    match config.protocol {
        OtlpProtocol::Grpc => grpc_metric_builder(config)?
            .with_endpoint(endpoint)
            .with_timeout(config.timeout)
            .with_metadata(metadata(config)?)
            .build()
            .map_err(|_| TelemetryConfigError::InvalidEndpoint),
        OtlpProtocol::HttpProtobuf => http_metric_builder(config)?
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(endpoint)
            .with_timeout(config.timeout)
            .with_headers(headers(config))
            .with_max_request_body_size(4 * 1024 * 1024)
            .build()
            .map_err(|_| TelemetryConfigError::InvalidEndpoint),
    }
}

fn log_exporter(config: &TelemetryConfig) -> Result<LogExporter, TelemetryConfigError> {
    let endpoint = signal_endpoint(config, "logs");
    match config.protocol {
        OtlpProtocol::Grpc => grpc_log_builder(config)?
            .with_endpoint(endpoint)
            .with_timeout(config.timeout)
            .with_metadata(metadata(config)?)
            .build()
            .map_err(|_| TelemetryConfigError::InvalidEndpoint),
        OtlpProtocol::HttpProtobuf => http_log_builder(config)?
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(endpoint)
            .with_timeout(config.timeout)
            .with_headers(headers(config))
            .with_max_request_body_size(4 * 1024 * 1024)
            .build()
            .map_err(|_| TelemetryConfigError::InvalidEndpoint),
    }
}

fn metadata(
    config: &TelemetryConfig,
) -> Result<opentelemetry_otlp::tonic_types::metadata::MetadataMap, TelemetryConfigError> {
    let mut metadata = opentelemetry_otlp::tonic_types::metadata::MetadataMap::new();
    if let Some(value) = &config.authorization {
        metadata.insert(
            "authorization",
            value
                .parse()
                .map_err(|_| TelemetryConfigError::Authorization)?,
        );
    }
    Ok(metadata)
}

fn headers(config: &TelemetryConfig) -> HashMap<String, String> {
    config
        .authorization
        .as_ref()
        .map(|value| HashMap::from([("authorization".to_owned(), value.clone())]))
        .unwrap_or_default()
}

fn grpc_span_builder(
    config: &TelemetryConfig,
) -> Result<
    opentelemetry_otlp::SpanExporterBuilder<opentelemetry_otlp::TonicExporterBuilderSet>,
    TelemetryConfigError,
> {
    let builder = SpanExporter::builder().with_tonic();
    Ok(match grpc_tls(config) {
        Some(tls) => builder.with_tls_config(tls),
        None => builder,
    })
}

fn grpc_metric_builder(
    config: &TelemetryConfig,
) -> Result<
    opentelemetry_otlp::MetricExporterBuilder<opentelemetry_otlp::TonicExporterBuilderSet>,
    TelemetryConfigError,
> {
    let builder = MetricExporter::builder().with_tonic();
    Ok(match grpc_tls(config) {
        Some(tls) => builder.with_tls_config(tls),
        None => builder,
    })
}

fn grpc_log_builder(
    config: &TelemetryConfig,
) -> Result<
    opentelemetry_otlp::LogExporterBuilder<opentelemetry_otlp::TonicExporterBuilderSet>,
    TelemetryConfigError,
> {
    let builder = LogExporter::builder().with_tonic();
    Ok(match grpc_tls(config) {
        Some(tls) => builder.with_tls_config(tls),
        None => builder,
    })
}

fn grpc_tls(
    config: &TelemetryConfig,
) -> Option<opentelemetry_otlp::tonic_types::transport::ClientTlsConfig> {
    config.ca_pem.as_ref().map(|pem| {
        opentelemetry_otlp::tonic_types::transport::ClientTlsConfig::new()
            .with_native_roots()
            .ca_certificate(opentelemetry_otlp::tonic_types::transport::Certificate::from_pem(pem))
    })
}

fn http_span_builder(
    config: &TelemetryConfig,
) -> Result<
    opentelemetry_otlp::SpanExporterBuilder<opentelemetry_otlp::HttpExporterBuilderSet>,
    TelemetryConfigError,
> {
    let builder = SpanExporter::builder().with_http();
    Ok(match blocking_http_client(config)? {
        Some(client) => builder.with_http_client(client),
        None => builder,
    })
}

fn http_metric_builder(
    config: &TelemetryConfig,
) -> Result<
    opentelemetry_otlp::MetricExporterBuilder<opentelemetry_otlp::HttpExporterBuilderSet>,
    TelemetryConfigError,
> {
    let builder = MetricExporter::builder().with_http();
    Ok(match blocking_http_client(config)? {
        Some(client) => builder.with_http_client(client),
        None => builder,
    })
}

fn http_log_builder(
    config: &TelemetryConfig,
) -> Result<
    opentelemetry_otlp::LogExporterBuilder<opentelemetry_otlp::HttpExporterBuilderSet>,
    TelemetryConfigError,
> {
    let builder = LogExporter::builder().with_http();
    Ok(match blocking_http_client(config)? {
        Some(client) => builder.with_http_client(client),
        None => builder,
    })
}

fn blocking_http_client(
    config: &TelemetryConfig,
) -> Result<Option<reqwest::blocking::Client>, TelemetryConfigError> {
    let Some(pem) = &config.ca_pem else {
        return Ok(None);
    };
    let certificate = reqwest::Certificate::from_pem(pem.as_bytes())
        .map_err(|_| TelemetryConfigError::InvalidCa)?;
    reqwest::blocking::Client::builder()
        .add_root_certificate(certificate)
        .timeout(config.timeout)
        .build()
        .map(Some)
        .map_err(|_| TelemetryConfigError::InvalidCa)
}

fn signal_endpoint(config: &TelemetryConfig, signal: &str) -> String {
    let base = config
        .endpoint
        .as_deref()
        .unwrap_or_default()
        .trim_end_matches('/');
    match config.protocol {
        OtlpProtocol::Grpc => base.to_owned(),
        OtlpProtocol::HttpProtobuf => format!("{base}/v1/{signal}"),
    }
}

fn validate_endpoint(endpoint: &str) -> Result<(), TelemetryConfigError> {
    let url = url::Url::parse(endpoint).map_err(|_| TelemetryConfigError::InvalidEndpoint)?;
    let loopback = url.host_str().is_some_and(|host| host == "localhost")
        || url.host().is_some_and(|host| match host {
            url::Host::Ipv4(address) => address.is_loopback(),
            url::Host::Ipv6(address) => address.is_loopback(),
            url::Host::Domain(_) => false,
        });
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(TelemetryConfigError::InvalidEndpoint);
    }
    if url.query().is_some() || url.fragment().is_some() || url.cannot_be_a_base() {
        return Err(TelemetryConfigError::InvalidEndpoint);
    }
    Ok(())
}

fn exporter_enabled(
    values: &HashMap<String, String>,
    name: &str,
) -> Result<bool, TelemetryConfigError> {
    match value_or(values, name, "none") {
        "none" => Ok(false),
        "otlp" => Ok(true),
        _ => Err(TelemetryConfigError::InvalidExporter),
    }
}

fn environment_values(environment: &impl Environment) -> HashMap<String, String> {
    environment
        .entries()
        .into_iter()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

fn value_or<'a>(values: &'a HashMap<String, String>, name: &str, default: &'a str) -> &'a str {
    values.get(name).map_or(default, String::as_str)
}

fn bounded_u64(
    values: &HashMap<String, String>,
    name: &str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> Option<u64> {
    values
        .get(name)
        .map_or(Some(default), |value| value.parse().ok())
        .filter(|value| (minimum..=maximum).contains(value))
}

const fn severity(level: &Level) -> Severity {
    match *level {
        Level::ERROR => Severity::Error,
        Level::WARN => Severity::Warn,
        Level::INFO => Severity::Info,
        Level::DEBUG => Severity::Debug,
        Level::TRACE => Severity::Trace,
    }
}

fn json_value(value: serde_json::Value) -> AnyValue {
    match value {
        serde_json::Value::Bool(value) => AnyValue::Boolean(value),
        serde_json::Value::Number(value) => value.as_i64().map_or_else(
            || AnyValue::Double(value.as_f64().unwrap_or(0.0)),
            AnyValue::Int,
        ),
        serde_json::Value::String(value) => AnyValue::String(value.into()),
        other => AnyValue::String(other.to_string().into()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Instant;

    use super::*;
    use opentelemetry::metrics::MeterProvider as _;
    use opentelemetry::trace::{Span as _, Tracer as _, TracerProvider as _};
    use tracing_subscriber::layer::SubscriberExt as _;

    static EXPORT_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[derive(Default)]
    struct TestEnvironment(BTreeMap<OsString, OsString>);

    impl Environment for TestEnvironment {
        fn entries(&self) -> Vec<(OsString, OsString)> {
            self.0.clone().into_iter().collect()
        }
    }

    struct NoFiles;

    impl FileReader for NoFiles {
        fn read(&self, _path: &Path, _limit: usize) -> std::io::Result<Vec<u8>> {
            Err(std::io::ErrorKind::NotFound.into())
        }
    }

    fn environment(values: &[(&str, &str)]) -> TestEnvironment {
        TestEnvironment(
            values
                .iter()
                .map(|(key, value)| (OsString::from(key), OsString::from(value)))
                .collect(),
        )
    }

    #[test]
    fn exporters_are_off_by_default_and_require_an_explicit_secure_endpoint() {
        let disabled = TelemetryConfig::load(&TestEnvironment::default(), &NoFiles).unwrap();
        assert!(!disabled.enabled());
        let missing = environment(&[("OTEL_TRACES_EXPORTER", "otlp")]);
        assert_eq!(
            TelemetryConfig::load(&missing, &NoFiles).unwrap_err(),
            TelemetryConfigError::MissingEndpoint
        );
        let insecure = environment(&[
            ("OTEL_TRACES_EXPORTER", "otlp"),
            (
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "http://collector.internal:4317",
            ),
        ]);
        assert_eq!(
            TelemetryConfig::load(&insecure, &NoFiles).unwrap_err(),
            TelemetryConfigError::InvalidEndpoint
        );
    }

    #[test]
    fn queue_batch_and_sampling_are_bounded() {
        let invalid = environment(&[
            ("OTEL_TRACES_EXPORTER", "otlp"),
            (
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "https://collector.example:4317",
            ),
            ("OTEL_BSP_MAX_QUEUE_SIZE", "32"),
        ]);
        assert_eq!(
            TelemetryConfig::load(&invalid, &NoFiles).unwrap_err(),
            TelemetryConfigError::InvalidQueue
        );
    }

    #[test]
    fn debug_output_never_exposes_authorization() {
        let config = TelemetryConfig {
            authorization: Some("Bearer collector-secret".to_owned()),
            ..TelemetryConfig::default()
        };
        let output = format!("{config:?}");
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("collector-secret"));
    }

    #[test]
    fn actual_http_export_is_bounded_redacted_and_flushes_on_shutdown() {
        let _serial = EXPORT_TEST_LOCK.lock().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let server_capture = Arc::clone(&captured);
        let server = thread::spawn(move || collect_three_signals(listener, server_capture));
        let config = TelemetryConfig {
            traces: true,
            metrics: true,
            logs: true,
            endpoint: Some(format!("http://{address}")),
            protocol: OtlpProtocol::HttpProtobuf,
            timeout: Duration::from_millis(500),
            queue_size: 64,
            batch_size: 16,
            trace_sample_ratio: 1.0,
            log_min_level: Level::INFO,
            authorization: Some("Bearer test-collector-credential".to_owned()),
            ca_pem: None,
        };
        let providers = TelemetryProviders::build(&config).unwrap();

        let tracer = providers.tracer.as_ref().unwrap().tracer(SERVICE_NAME);
        let mut span = tracer.start("bounded-operation");
        span.set_attribute(KeyValue::new("operation.type", "qualification"));
        span.end();
        let meter = providers.meter.as_ref().unwrap().meter(SERVICE_NAME);
        meter
            .u64_counter("nuriteo.test.counter")
            .build()
            .add(1, &[]);
        let subscriber = tracing_subscriber::registry().with(providers.log_layer(Level::INFO));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(
                event_name = "qualification.event",
                password = "payload-secret",
                message = "authorization=payload-token",
            );
        });

        providers.shutdown();
        server.join().unwrap();
        let requests = captured.lock().unwrap();
        for path in ["/v1/traces", "/v1/metrics", "/v1/logs"] {
            assert!(
                requests.iter().any(|request| request.path == path),
                "missing {path}"
            );
        }
        for request in requests.iter() {
            assert_eq!(
                request.authorization.as_deref(),
                Some("Bearer test-collector-credential")
            );
            let body = String::from_utf8_lossy(&request.body);
            assert!(!body.contains("payload-secret"));
            assert!(!body.contains("payload-token"));
        }
        assert!(requests.iter().any(|request| {
            request.path == "/v1/logs"
                && String::from_utf8_lossy(&request.body).contains("[REDACTED]")
        }));
    }

    #[test]
    fn collector_outage_does_not_block_beyond_the_shutdown_budget() {
        let _serial = EXPORT_TEST_LOCK.lock().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let config = TelemetryConfig {
            traces: true,
            endpoint: Some(format!("http://{address}")),
            protocol: OtlpProtocol::HttpProtobuf,
            timeout: Duration::from_millis(100),
            queue_size: 64,
            batch_size: 16,
            trace_sample_ratio: 1.0,
            ..TelemetryConfig::default()
        };
        let providers = TelemetryProviders::build(&config).unwrap();
        let tracer = providers.tracer.as_ref().unwrap().tracer(SERVICE_NAME);
        tracer.start("collector-outage").end();
        let started = Instant::now();
        providers.shutdown();
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    struct CapturedRequest {
        path: String,
        authorization: Option<String>,
        body: Vec<u8>,
    }

    fn collect_three_signals(listener: TcpListener, captured: Arc<Mutex<Vec<CapturedRequest>>>) {
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    if let Some(request) = read_request(&mut stream) {
                        captured.lock().unwrap().push(request);
                    }
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                        )
                        .unwrap();
                    if captured
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|request| request.path.as_str())
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        >= 3
                    {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("collector accept failed: {error}"),
            }
        }
        panic!("collector did not receive all three signals");
    }

    fn read_request(stream: &mut TcpStream) -> Option<CapturedRequest> {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let read = stream.read(&mut buffer).ok()?;
            if read == 0 {
                return None;
            }
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
            if bytes.len() > 64 * 1024 {
                return None;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = headers.lines();
        let path = lines.next()?.split_whitespace().nth(1)?.to_owned();
        let content_length = lines
            .clone()
            .find_map(|line| {
                line.strip_prefix("content-length: ")
                    .or_else(|| line.strip_prefix("Content-Length: "))
            })
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let authorization = lines.find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_owned())
        });
        while bytes.len() < header_end + content_length {
            let read = stream.read(&mut buffer).ok()?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        Some(CapturedRequest {
            path,
            authorization,
            body: bytes[header_end..bytes.len().min(header_end + content_length)].to_vec(),
        })
    }
}
