import assert from "node:assert/strict";
import fs from "node:fs";

type Metric = { name: string; type: string; unit: string; labels: string[]; buckets?: number[]; cardinality: string };
const catalog = JSON.parse(fs.readFileSync("observability/metric-catalog.json", "utf8")) as {
  schemaVersion: number; taskId: string; endpoint: string; format: string; visibility: string;
  metrics: Metric[]; boundedLabels: Record<string, string | string[]>; prohibitedLabels: string[];
  compatibility: string;
};

assert.equal(catalog.schemaVersion, 1);
assert.equal(catalog.taskId, "OBS-002");
assert.equal(catalog.endpoint, "/metrics");
assert.equal(catalog.format, "OpenMetrics 1.0");
assert.match(catalog.visibility, /cluster-internal/u);
assert.equal(new Set(catalog.metrics.map(({ name }) => name)).size, catalog.metrics.length);
assert.deepEqual(catalog.metrics.map(({ name }) => name).sort(), [
  "nuriteo_build_info",
  "nuriteo_cleanup_degraded",
  "nuriteo_cleanup_failed_count",
  "nuriteo_cleanup_oldest_eligible_age_seconds",
  "nuriteo_cleanup_queue_depth",
  "nuriteo_cleanup_retry_count",
  "nuriteo_cleanup_running_count",
  "nuriteo_http_request_duration_seconds",
  "nuriteo_http_requests_in_flight",
  "nuriteo_http_requests_total",
]);
for (const metric of catalog.metrics) {
  assert.match(metric.name, /^nuriteo_[a-z0-9_]+$/u);
  assert.ok(["counter", "gauge", "histogram"].includes(metric.type));
  assert.ok(metric.cardinality.length >= 20);
  for (const label of metric.labels) {
    assert.ok(label in catalog.boundedLabels, `${metric.name}: unbounded label ${label}`);
    assert.ok(!catalog.prohibitedLabels.includes(label), `${metric.name}: prohibited label ${label}`);
  }
}
assert.deepEqual(catalog.metrics.find(({ type }) => type === "histogram")?.buckets,
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5]);
assert.ok(catalog.compatibility.length >= 180);

const source = [
  "crates/nuriteo-server/src/observability/metrics.rs",
  "crates/nuriteo-server/src/save/operations.rs",
].map((file) => fs.readFileSync(file, "utf8")).join("\n");
for (const metric of catalog.metrics) assert.ok(source.includes(metric.name), `metric is not implemented: ${metric.name}`);
for (const prohibited of catalog.prohibitedLabels) assert.ok(!source.includes(`${prohibited}=\\\"`), `source emits prohibited label: ${prohibited}`);
assert.ok(source.includes("MatchedPath"));
assert.ok(source.includes('"unmatched"'));
assert.ok(source.includes('"OTHER"'));

const operations = fs.readFileSync("docs/operations/prometheus-metrics.md", "utf8");
for (const term of ["/metrics", "ClusterIP", "route template", "observability/metric-catalog.json"])
  assert.ok(operations.includes(term), `metrics operations guide missing: ${term}`);

console.log(JSON.stringify({ status: "pass", task: catalog.taskId, metrics: catalog.metrics.length,
  prohibitedLabels: catalog.prohibitedLabels.length }));
