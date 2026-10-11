import assert from "node:assert/strict";
import fs from "node:fs";

const policy = JSON.parse(fs.readFileSync("observability/otlp-policy.json", "utf8")) as {
  schemaVersion: number; taskId: string; defaultEnabled: boolean; phoneHome: boolean;
  signals: string[]; protocols: string[]; endpoint: { requiredWhenEnabled: boolean; tlsRequired: boolean; fallback: boolean };
  bounds: Record<string, { default: number; minimum: number; maximum: number }>;
  authorization: { environment: string; file: string; rendered: boolean; redacted: boolean };
  customCaFile: string;
  shutdown: string; dataPolicy: string;
};
assert.equal(policy.schemaVersion, 1);
assert.equal(policy.taskId, "OBS-003");
assert.equal(policy.defaultEnabled, false);
assert.equal(policy.phoneHome, false);
assert.deepEqual(policy.signals, ["traces", "metrics", "logs"]);
assert.deepEqual(policy.protocols, ["grpc", "http/protobuf"]);
assert.deepEqual([policy.endpoint.requiredWhenEnabled, policy.endpoint.tlsRequired, policy.endpoint.fallback], [true, true, false]);
for (const [name, bound] of Object.entries(policy.bounds)) {
  assert.ok(bound.minimum <= bound.default && bound.default <= bound.maximum, `${name}: invalid default`);
}
assert.deepEqual([policy.authorization.rendered, policy.authorization.redacted], [false, true]);
assert.ok(policy.shutdown.length > 80);
assert.ok(policy.dataPolicy.length > 180);

const source = fs.readFileSync("crates/nuriteo-server/src/observability/telemetry.rs", "utf8");
for (const required of [
  "SpanExporter", "MetricExporter", "LogExporter", "BatchSpanProcessor", "BatchLogProcessor",
  "TraceContextPropagator", "RedactingOtlpLogLayer", "with_max_queue_size", "shutdown_with_timeout",
  "with_max_request_body_size", "https", "127.0.0.1",
]) assert.ok(source.includes(required), `telemetry implementation missing ${required}`);
for (const secretName of [policy.authorization.environment, policy.authorization.file])
  assert.ok(source.includes(secretName), `authorization source missing ${secretName}`);
assert.ok(source.includes(policy.customCaFile));

const metrics = fs.readFileSync("crates/nuriteo-server/src/observability/metrics.rs", "utf8");
for (const required of ["HeaderExtractor", "SpanKind::Server", "http.route", "with_context"])
  assert.ok(metrics.includes(required), `request telemetry missing ${required}`);

const chart = fs.readFileSync("charts/nuriteo/templates/core.yaml", "utf8");
const values = fs.readFileSync("charts/nuriteo/values.yaml", "utf8");
const compose = fs.readFileSync("deploy/compose/compose.yaml", "utf8");
for (const deployment of [chart, compose]) {
  for (const name of ["OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_EXPORTER_OTLP_PROTOCOL"])
    assert.ok(deployment.includes(name), `deployment mapping missing ${name}`);
}
assert.ok(values.includes("tracesEnabled: false"));
assert.ok(values.includes("metricsEnabled: false"));
assert.ok(values.includes("logsEnabled: false"));
assert.ok(chart.includes("secretKeyRef:"));

const guide = fs.readFileSync("docs/operations/opentelemetry.md", "utf8");
for (const term of ["phone-home", "OTLP/gRPC", "OTLP/HTTP", "NURITEO_OTLP_AUTHORIZATION_FILE", "Collector lifecycle"])
  assert.ok(guide.includes(term), `operations guide missing ${term}`);

console.log(JSON.stringify({ status: "pass", task: policy.taskId, signals: policy.signals.length,
  protocols: policy.protocols.length, maxQueue: policy.bounds.queueSize.maximum }));
