import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert.equal = (actual, expected, message) => {
  assert(actual === expected, message || `expected ${expected}, got ${actual}`);
};

assert.deepEqual = (actual, expected, message) => {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message || `deepEqual failed: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
};

const catalog = readJson("compat/error-catalog.json");

assert(catalog.schemaVersion === 1, "unexpected error catalog schema");
assert(catalog.gate === "SG28", "error catalog must target SG28");
assert(catalog.status === "pass", "error catalog status must be pass");
assert(Array.isArray(catalog.categories) && catalog.categories.length === 6, "error catalog must list 6 categories");
assert(Array.isArray(catalog.workflowStages) && catalog.workflowStages.length === 4, "error catalog must list workflow stages");
assert(Array.isArray(catalog.recoveryActions) && catalog.recoveryActions.length === 4, "error catalog must list recovery actions");
assert(Array.isArray(catalog.metricsCandidates) && catalog.metricsCandidates.length >= 4, "error catalog must list metrics candidates");
assert(catalog.codes && typeof catalog.codes === "object", "error catalog codes missing");

const requiredCategories = ["unsupported", "package-manager", "preview", "quota", "permission", "crash"];
for (const category of requiredCategories) {
  assert(catalog.categories.includes(category), `missing category: ${category}`);
}

const covered = new Set(Object.values(catalog.codes));
for (const category of requiredCategories) {
  assert(covered.has(category), `no catalog codes map to category: ${category}`);
}

for (const requiredPath of catalog.requiredPaths) {
  assert(fs.existsSync(path.resolve(requiredPath)), `missing required observability path: ${requiredPath}`);
}

const observability = await import(pathToFileURL(path.resolve("packages/workspace-runtime/src/observability.ts")).href);

assert.deepEqual([...observability.SUPPORT_ERROR_CATEGORIES], catalog.categories, "SUPPORT_ERROR_CATEGORIES must match catalog");
assert.deepEqual([...observability.WORKFLOW_STAGES], catalog.workflowStages, "WORKFLOW_STAGES must match catalog");
assert.deepEqual([...observability.SUPPORT_RECOVERY_ACTIONS], catalog.recoveryActions, "SUPPORT_RECOVERY_ACTIONS must match catalog");
assert.deepEqual([...observability.RUNTIME_METRICS_CANDIDATES], catalog.metricsCandidates, "RUNTIME_METRICS_CANDIDATES must match catalog");

const catalogCodes = Object.keys(catalog.codes).sort();
const shippedCodes = Object.keys(observability.ERROR_CATALOG).sort();
assert.deepEqual(shippedCodes, catalogCodes, "ERROR_CATALOG keys must match compat/error-catalog.json");
for (const code of catalogCodes) {
  assert.equal(
    observability.ERROR_CATALOG[code],
    catalog.codes[code],
    `ERROR_CATALOG mismatch for ${code}`
  );
}

observability.clearRecoveryOutcomes();

let now = 1_000;
const trace = observability.createWorkflowTrace("session-sg28", () => now);
const install = trace.startStage("install");
now += 25;
install.end();
const preview = trace.startStage("preview");
now += 10;
preview.end({ status: "error", errorCode: "ESTALESESSION" });

assert(Boolean(trace.traceIdFor("install")), "install stage must assign a trace id");
assert(Boolean(trace.traceIdFor("preview")), "preview stage must assign a trace id");
assert(trace.traceIdFor("install").includes(":install:"), "install trace id must encode stage");
assert(trace.traceIdFor("preview").includes(":preview:"), "preview trace id must encode stage");

const { bundle, serialized } = observability.exportSupportBundle({
  createdAt: "2026-09-18T00:00:00.000Z",
  diagnostics: [
    {
      code: "ESTALESESSION",
      severity: "error",
      message: "Preview session is stale",
      source: "preview"
    }
  ],
  logs: ["preview failed token=npm_secret_token"],
  environment: {
    NPM_TOKEN: "npm_secret_token",
    workflowStage: "preview"
  }
});

assert.equal(observability.classifySupportBundle(bundle), "preview", "support bundle should classify as preview");
assert(!serialized.includes("npm_secret_token"), "exported support bundle must redact secrets");

const imported = observability.importSupportBundle(serialized);
assert.equal(imported.schemaVersion, 1, "imported bundle schemaVersion");
assert.equal(imported.environment.NPM_TOKEN, "[REDACTED]", "imported bundle must keep redaction");
assert.equal(observability.classifySupportBundle(imported), "preview", "imported bundle classification");

const quotaBundle = observability.exportSupportBundle({
  diagnostics: [{ code: "EOPFSQUOTA", severity: "error", message: "quota exceeded", source: "storage" }]
}).bundle;
const unsupportedBundle = observability.exportSupportBundle({
  diagnostics: [{
    code: "ERR_PM_NATIVE_ADDON_UNSUPPORTED",
    severity: "error",
    message: "native addon unsupported",
    source: "package-manager"
  }]
}).bundle;

const top = observability.aggregateFailureCategories([bundle, quotaBundle, unsupportedBundle, quotaBundle]);
assert.equal(top[0].category, "quota", "top failure category should be quota");
assert.equal(top[0].count, 2, "quota category count");

const success = observability.recordRecoveryOutcome("clear-package-cache", "success", "freed cache");
const failure = observability.recordRecoveryOutcome("retry-install", "failure", "registry timeout");
assert.equal(success.status, "success");
assert.equal(failure.status, "failure");
assert.equal(observability.listRecoveryOutcomes().length, 2, "recovery outcomes must be recorded");

const metrics = observability.createRuntimeMetricsSnapshot({
  bootTimeMs: 120,
  installTimeMs: 2400,
  hmrLatencyMs: 35,
  memoryUsageBytes: 64_000_000,
  quotaUsageBytes: 10_000_000,
  quotaLimitBytes: 268_435_456
});
assert.equal(metrics.hmrLatencyMs, 35, "metrics snapshot should retain HMR latency");

const fixture = observability.createFailedWorkflowReplayFixture({
  phase: "failed",
  stage: "preview",
  projectId: "demo",
  manager: "pnpm",
  previewUrl: null,
  diagnostics: bundle.diagnostics,
  logs: bundle.logs,
  environment: bundle.environment,
  trace,
  metrics,
  lastError: { code: "ESTALESESSION", message: "Preview session is stale", source: "preview" }
});

assert.equal(fixture.kind, "failed-workflow-replay");
assert.equal(fixture.category, "preview");
assert.equal(fixture.stage, "preview");
assert(Boolean(fixture.traceIds.install), "replay fixture must retain install trace id");
assert(Boolean(fixture.traceIds.preview), "replay fixture must retain preview trace id");
assert.equal(fixture.recoveryOutcomes.length, 2, "replay fixture must include recovery outcomes");
assert.equal(fixture.metrics.bootTimeMs, 120, "replay fixture must include metrics candidates");

const planSource = fs.readFileSync("docs/productization/service-readiness-plan.md", "utf8");
assert(planSource.includes("### SG28 상태"), "service-readiness-plan must document SG28 status");
assert(planSource.includes("PASS"), "SG28 status section must include PASS evidence");

const decision = readJson("compat/launch-decision.json");
assert.equal(decision.gates.SG28, "pass", "launch-decision SG28 must be pass");

console.log(
  `observability support ok categories=${catalog.categories.length} codes=${catalogCodes.length} recovery=${catalog.recoveryActions.length}`
);
