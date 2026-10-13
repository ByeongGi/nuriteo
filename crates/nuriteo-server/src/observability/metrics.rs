use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use axum::extract::MatchedPath;
use axum::http::{Method, Request};
use axum::middleware::Next;
use axum::response::Response;
use opentelemetry::context::FutureExt as _;
use opentelemetry::metrics::{Counter, Histogram, UpDownCounter};
use opentelemetry::trace::{SpanKind, Status, TraceContextExt, Tracer as _};
use opentelemetry::{Context, KeyValue, global};

use crate::VERSION;

const BUCKETS: [f64; 8] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1.0, 5.0];
#[derive(Clone)]
pub struct MetricsService {
    inner: Arc<MetricsInner>,
}

struct MetricsInner {
    in_flight: AtomicU64,
    requests: Mutex<BTreeMap<HttpKey, RequestSeries>>,
    otlp_requests: Counter<u64>,
    otlp_duration: Histogram<f64>,
    otlp_in_flight: UpDownCounter<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct HttpKey {
    method: &'static str,
    route: String,
    status_class: &'static str,
}

#[derive(Debug, Clone, Default)]
struct RequestSeries {
    count: u64,
    sum_seconds: f64,
    buckets: [u64; BUCKETS.len()],
}

impl MetricsService {
    #[must_use]
    pub fn new() -> Self {
        let meter = global::meter("nuriteo-server");
        Self {
            inner: Arc::new(MetricsInner {
                in_flight: AtomicU64::new(0),
                requests: Mutex::new(BTreeMap::new()),
                otlp_requests: meter.u64_counter("nuriteo.http.requests").build(),
                otlp_duration: meter.f64_histogram("nuriteo.http.request.duration").build(),
                otlp_in_flight: meter
                    .i64_up_down_counter("nuriteo.http.requests_in_flight")
                    .build(),
            }),
        }
    }

    fn begin_request(&self) -> InFlightGuard {
        self.inner.in_flight.fetch_add(1, Ordering::Relaxed);
        self.inner.otlp_in_flight.add(1, &[]);
        InFlightGuard {
            inner: Arc::clone(&self.inner),
        }
    }

    fn record(&self, method: &'static str, route: String, status: u16, elapsed: f64) {
        let key = HttpKey {
            method,
            route: route.clone(),
            status_class: status_class(status),
        };
        let mut requests = lock(&self.inner.requests);
        let series = requests.entry(key).or_default();
        series.count = series.count.saturating_add(1);
        series.sum_seconds += elapsed;
        for (index, upper_bound) in BUCKETS.iter().enumerate() {
            if elapsed <= *upper_bound {
                series.buckets[index] = series.buckets[index].saturating_add(1);
            }
        }
        let attributes = [
            KeyValue::new("http.request.method", method),
            KeyValue::new("http.route", route),
            KeyValue::new("http.response.status_class", status_class(status)),
        ];
        self.inner.otlp_requests.add(1, &attributes);
        self.inner.otlp_duration.record(elapsed, &attributes);
    }

    #[must_use]
    pub fn render(&self) -> String {
        let mut output = String::with_capacity(4096);
        output.push_str("# HELP nuriteo_build_info Static build identity.\n");
        output.push_str("# TYPE nuriteo_build_info gauge\n");
        let _ = writeln!(
            output,
            "nuriteo_build_info{{version=\"{}\"}} 1",
            escape(VERSION)
        );
        output.push_str("# HELP nuriteo_http_requests_in_flight Current HTTP requests.\n");
        output.push_str("# TYPE nuriteo_http_requests_in_flight gauge\n");
        let _ = writeln!(
            output,
            "nuriteo_http_requests_in_flight {}",
            self.inner.in_flight.load(Ordering::Relaxed)
        );
        output.push_str("# HELP nuriteo_http_requests_total Completed HTTP requests.\n");
        output.push_str("# TYPE nuriteo_http_requests_total counter\n");
        output.push_str("# HELP nuriteo_http_request_duration_seconds HTTP request latency.\n");
        output.push_str("# TYPE nuriteo_http_request_duration_seconds histogram\n");
        for (key, series) in lock(&self.inner.requests).iter() {
            let labels = format!(
                "method=\"{}\",route=\"{}\",status_class=\"{}\"",
                key.method,
                escape(&key.route),
                key.status_class
            );
            let _ = writeln!(
                output,
                "nuriteo_http_requests_total{{{labels}}} {}",
                series.count
            );
            for (index, upper_bound) in BUCKETS.iter().enumerate() {
                let _ = writeln!(
                    output,
                    "nuriteo_http_request_duration_seconds_bucket{{{labels},le=\"{upper_bound}\"}} {}",
                    series.buckets[index]
                );
            }
            let _ = writeln!(
                output,
                "nuriteo_http_request_duration_seconds_bucket{{{labels},le=\"+Inf\"}} {}",
                series.count
            );
            let _ = writeln!(
                output,
                "nuriteo_http_request_duration_seconds_sum{{{labels}}} {}",
                series.sum_seconds
            );
            let _ = writeln!(
                output,
                "nuriteo_http_request_duration_seconds_count{{{labels}}} {}",
                series.count
            );
        }
        output.push_str("# EOF\n");
        output
    }
}

pub async fn observe_http(
    metrics: MetricsService,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let method = bounded_method(request.method());
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_owned(), |path| path.as_str().to_owned());
    let parent = global::get_text_map_propagator(|propagator| {
        propagator.extract(&HeaderExtractor(request.headers()))
    });
    let tracer = global::tracer("nuriteo-server");
    let span = tracer
        .span_builder("HTTP request")
        .with_kind(SpanKind::Server)
        .with_attributes([
            KeyValue::new("http.request.method", method),
            KeyValue::new("http.route", route.clone()),
        ])
        .start_with_context(&tracer, &parent);
    let context = Context::current_with_span(span);
    let started = Instant::now();
    let in_flight = metrics.begin_request();
    let response = next.run(request).with_context(context.clone()).await;
    drop(in_flight);
    context.span().set_attribute(KeyValue::new(
        "http.response.status_code",
        i64::from(response.status().as_u16()),
    ));
    if response.status().is_server_error() {
        context.span().set_status(Status::error("server error"));
    }
    metrics.record(
        method,
        route,
        response.status().as_u16(),
        started.elapsed().as_secs_f64(),
    );
    response
}

struct InFlightGuard {
    inner: Arc<MetricsInner>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.inner.in_flight.fetch_sub(1, Ordering::Relaxed);
        self.inner.otlp_in_flight.add(-1, &[]);
    }
}

impl Default for MetricsService {
    fn default() -> Self {
        Self::new()
    }
}

struct HeaderExtractor<'headers>(&'headers axum::http::HeaderMap);

impl opentelemetry::propagation::Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(axum::http::HeaderName::as_str).collect()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn bounded_method(method: &Method) -> &'static str {
    match *method {
        Method::GET => "GET",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::PATCH => "PATCH",
        Method::DELETE => "DELETE",
        Method::HEAD => "HEAD",
        Method::OPTIONS => "OPTIONS",
        _ => "OTHER",
    }
}

fn status_class(status: u16) -> &'static str {
    match status / 100 {
        1 => "1xx",
        2 => "2xx",
        3 => "3xx",
        4 => "4xx",
        5 => "5xx",
        _ => "other",
    }
}

fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn exports_bounded_route_labels_without_path_values_or_queries() {
        let metrics = MetricsService::new();
        let observed = metrics.clone();
        let app = Router::new()
            .route(
                "/api/v1/projects/{project_id}",
                get(|| async { StatusCode::OK }),
            )
            .layer(axum::middleware::from_fn(move |request, next| {
                observe_http(observed.clone(), request, next)
            }));

        let secret_path = "customer-project-secret";
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/projects/{secret_path}?token=not-a-metric"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = metrics.render();
        assert!(body.contains("route=\"/api/v1/projects/{project_id}\""));
        assert!(body.contains("status_class=\"2xx\""));
        assert!(body.contains("nuriteo_http_request_duration_seconds_bucket"));
        assert!(!body.contains(secret_path));
        assert!(!body.contains("not-a-metric"));
        assert!(body.ends_with("# EOF\n"));
    }
}
