import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "compat/error-catalog.json"), "utf8"));

const {
  ERROR_CATALOG,
  SUPPORT_ERROR_CATEGORIES,
  SUPPORT_RECOVERY_ACTIONS,
  WORKFLOW_STAGES,
  aggregateFailureCategories,
  classifyErrorCode,
  classifySupportBundle,
  clearRecoveryOutcomes,
  createFailedWorkflowReplayFixture,
  createRuntimeMetricsSnapshot,
  createWorkflowTrace,
  exportSupportBundle,
  importSupportBundle,
  listRecoveryOutcomes,
  recordRecoveryOutcome
} = await import(pathToFileURL(path.join(root, "packages/workspace-runtime/src/observability.ts")).href);

const {
  createRuntimeRecoveryActionExecutor,
  createRuntimeRecoveryPlan,
  createRuntimeSupportBundle
} = await import(pathToFileURL(path.join(root, "packages/browser-host/src/observability/index.ts")).href);

assert.equal(catalog.gate, "SG28");
assert.deepEqual([...SUPPORT_ERROR_CATEGORIES], catalog.categories);
assert.deepEqual([...WORKFLOW_STAGES], catalog.workflowStages);
assert.deepEqual([...SUPPORT_RECOVERY_ACTIONS], catalog.recoveryActions);

for (const [code, category] of Object.entries(catalog.codes)) {
  assert.equal(ERROR_CATALOG[code], category, `catalog code ${code}`);
  assert.equal(classifyErrorCode(code), category, `classifyErrorCode(${code})`);
}

clearRecoveryOutcomes();

let now = 0;
const workflowTrace = createWorkflowTrace("test-session", () => now);
const install = workflowTrace.startStage("install");
now += 100;
install.end();
const dev = workflowTrace.startStage("dev");
now += 50;
dev.end();
const build = workflowTrace.startStage("build");
now += 80;
build.end({ status: "error", errorCode: "ERR_PM_REAL_CLI_EVALUATION_REQUIRED" });
const preview = workflowTrace.startStage("preview");
now += 20;
preview.end();

assert.match(workflowTrace.traceIdFor("install"), /:install:/);
assert.match(workflowTrace.traceIdFor("dev"), /:dev:/);
assert.match(workflowTrace.traceIdFor("build"), /:build:/);
assert.match(workflowTrace.traceIdFor("preview"), /:preview:/);

const categories = [
  ["unsupported", "ERR_RUNTIME_DOCKER_UNSUPPORTED"],
  ["package-manager", "ERR_IMPORT_MISSING_SCRIPT"],
  ["preview", "ENOSERVER"],
  ["quota", "EOPFSQUOTA"],
  ["permission", "EPERMISSION"],
  ["crash", "ERR_WORKER_CRASH"]
];

for (const [category, code] of categories) {
  const { bundle } = exportSupportBundle({
    diagnostics: [{ code, severity: "error", message: `${category} failure`, source: "test" }]
  });
  assert.equal(classifySupportBundle(bundle), category, `bundle classification for ${code}`);
}

const secretExport = exportSupportBundle({
  createdAt: "2026-09-18T12:00:00.000Z",
  logs: ["Authorization=Bearer npm_pipeline_secret"],
  environment: { NPM_TOKEN: "npm_pipeline_secret" },
  diagnostics: [{ code: "EOPFSQUOTA", severity: "error", message: "quota exceeded", source: "storage" }]
});
assert.equal(secretExport.serialized.includes("npm_pipeline_secret"), false);

const imported = importSupportBundle(secretExport.serialized);
assert.equal(imported.environment.NPM_TOKEN, "[REDACTED]");
assert.equal(classifySupportBundle(imported), "quota");

const reused = createRuntimeSupportBundle({
  diagnostics: [{ code: "ESTALESESSION", severity: "error", message: "stale", source: "preview" }],
  logs: ["preview relay rejected forged session"]
});
assert.equal(classifySupportBundle(reused), "preview");
assert.equal(classifySupportBundle(importSupportBundle(reused)), "preview");

const ranked = aggregateFailureCategories([
  exportSupportBundle({ diagnostics: [{ code: "EOPFSQUOTA", severity: "error", message: "q", source: "storage" }] }).bundle,
  exportSupportBundle({ diagnostics: [{ code: "EOPFSQUOTA", severity: "error", message: "q2", source: "storage" }] }).bundle,
  exportSupportBundle({ diagnostics: [{ code: "ESTALESESSION", severity: "error", message: "p", source: "preview" }] }).bundle
]);
assert.equal(ranked[0].category, "quota");
assert.equal(ranked[0].count, 2);

recordRecoveryOutcome("retry-install", "success");
recordRecoveryOutcome("clear-package-cache", "success", "evicted=3");
recordRecoveryOutcome("restart-dev-server", "failure", "port busy");
recordRecoveryOutcome("export-project", "success");
assert.equal(listRecoveryOutcomes().length, 4);
assert.equal(listRecoveryOutcomes().filter((entry) => entry.status === "failure").length, 1);

const recoveryPlan = createRuntimeRecoveryPlan({
  diagnostics: [{ code: "EOPFSQUOTA", severity: "error", message: "quota exceeded", source: "storage" }]
});
assert.ok(recoveryPlan.actions.some((action) => action.kind === "clear-cache"));
assert.ok(recoveryPlan.actions.some((action) => action.kind === "retry"));

const calls = [];
const executor = createRuntimeRecoveryActionExecutor({
  supportBundle: secretExport.bundle,
  handlers: {
    clearCache(action) {
      calls.push(action.kind);
      recordRecoveryOutcome("clear-package-cache", "success");
      return { cleared: true };
    },
    resetRuntime(action) {
      calls.push(action.kind);
      recordRecoveryOutcome("restart-dev-server", "success");
      return { restarted: true };
    },
    retry(action) {
      calls.push(action.kind);
      recordRecoveryOutcome("retry-install", "failure", action.command || "retry");
      return { retried: false };
    },
    exportSupportBundle(bundle, action) {
      calls.push(action.kind);
      return { createdAt: bundle.createdAt };
    }
  }
});

assert.equal((await executor.execute(recoveryPlan.actions.find((action) => action.kind === "clear-cache"))).status, "handled");
assert.equal((await executor.execute({ kind: "reset-runtime", label: "Restart dev server", reason: "test" })).status, "handled");
assert.equal((await executor.execute({ kind: "retry", label: "Retry install", reason: "test", command: "npm install" })).status, "handled");
assert.deepEqual(calls, ["clear-cache", "reset-runtime", "retry"]);

const metrics = createRuntimeMetricsSnapshot({
  bootTimeMs: 90,
  installTimeMs: 1500,
  hmrLatencyMs: 42,
  memoryUsageBytes: 32_000_000,
  quotaUsageBytes: 8_000_000,
  quotaLimitBytes: 268_435_456
});

const fixture = createFailedWorkflowReplayFixture({
  phase: "failed",
  stage: "build",
  projectId: "vite-react-demo",
  manager: "pnpm",
  diagnostics: [
    {
      code: "ERR_PM_REAL_CLI_EVALUATION_REQUIRED",
      severity: "error",
      message: "package manager evaluation failed",
      source: "package-manager"
    }
  ],
  logs: ["pnpm run build failed"],
  trace: workflowTrace,
  metrics,
  lastError: {
    code: "ERR_PM_REAL_CLI_EVALUATION_REQUIRED",
    message: "package manager evaluation failed",
    source: "package-manager"
  }
});

assert.equal(fixture.schemaVersion, 1);
assert.equal(fixture.kind, "failed-workflow-replay");
assert.equal(fixture.stage, "build");
assert.equal(fixture.category, "package-manager");
assert.equal(fixture.traceIds.build, workflowTrace.traceIdFor("build"));
assert.equal(fixture.metrics.installTimeMs, 1500);
assert.ok(fixture.recoveryOutcomes.length >= 4);
assert.equal(fixture.supportBundle.diagnostics.some((entry) => entry.code === "ERR_PM_REAL_CLI_EVALUATION_REQUIRED"), true);

console.log(
  `observability-support.test.ts ok categories=${SUPPORT_ERROR_CATEGORIES.length} stages=${WORKFLOW_STAGES.length}`
);
