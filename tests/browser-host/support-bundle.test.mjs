import assert from "node:assert/strict";

import {
  createRuntimeSupportBundle,
  createRuntimeTraceCollector,
  createRuntimeTraceReport,
  redactRuntimeLog
} from "../../packages/browser-host/src/index.ts";

let now = 0;
const trace = createRuntimeTraceCollector(() => now);

const fast = trace.startSpan({
  category: "network",
  name: "host-fetch.download",
  requestId: "project-a",
  attributes: { url: "https://registry.npmjs.org/react" }
});
now += 40;
fast.end();

const slow = trace.startSpan({
  category: "package-manager",
  name: "package-script.run",
  requestId: "install-1"
});
now += 1500;
slow.end();

const failed = trace.startSpan({
  category: "preview",
  name: "preview-relay.request",
  requestId: "session-a"
});
now += 5;
failed.end({ status: "error", errorCode: "ESTALESESSION" });

const report = createRuntimeTraceReport(trace.export(), { slowSpanThresholdMs: 1000 });
assert.equal(report.spanCount, 3);
assert.equal(report.errorCount, 1);
assert.equal(report.runningCount, 0);
assert.equal(report.diagnostics.map((entry) => entry.code).join(","), "ESTALESESSION,WARN_RUNTIME_SLOW_OPERATION");
assert.equal(report.flameHints[0], "package-manager:package-script.run 1500ms");

assert.equal(
  redactRuntimeLog("Authorization=Bearer npm_secret password=hunter2 token=ghp_abc123 https://user:secret@example.test"),
  "Authorization=[REDACTED] password=[REDACTED] token=[REDACTED] https://user:[REDACTED]@example.test"
);

const bundle = createRuntimeSupportBundle({
  trace,
  createdAt: "2026-09-15T00:00:00.000Z",
  logs: ["npm token=npm_abcdef failed"],
  environment: {
    browser: "Chrome",
    npmToken: "npm_abcdef",
    registryUrl: "https://user:secret@registry.npmjs.org"
  },
  diagnostics: [
    {
      code: "ERR_USER_VISIBLE",
      severity: "info",
      message: "Visible diagnostic",
      source: "test"
    }
  ],
  slowSpanThresholdMs: 1000
});

assert.equal(bundle.schemaVersion, 1);
assert.equal(bundle.createdAt, "2026-09-15T00:00:00.000Z");
assert.equal(bundle.logs[0], "npm token=[REDACTED] failed");
assert.equal(bundle.environment.npmToken, "[REDACTED]");
assert.equal(bundle.environment.registryUrl, "https://user:[REDACTED]@registry.npmjs.org");
assert.equal(bundle.diagnostics.at(-1).code, "ERR_USER_VISIBLE");
assert.equal(bundle.trace.slowestSpans[0].name, "package-script.run");

console.log("browser host support bundle test ok");
