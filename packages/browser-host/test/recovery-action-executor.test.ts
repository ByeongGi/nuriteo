import assert from "node:assert/strict";

import {
  createRuntimeRecoveryActionExecutor,
  createRuntimeSupportBundle
} from "../../browser-host/src/index.ts";

const calls = [];
const bundle = createRuntimeSupportBundle({
  createdAt: "2026-09-16T00:00:00.000Z",
  diagnostics: [
    {
      code: "ERR_PM_NATIVE_ADDON_UNSUPPORTED",
      severity: "error",
      message: "native addon execution is unsupported",
      source: "package-manager"
    }
  ],
  logs: ["npm install failed"]
});

const executor = createRuntimeRecoveryActionExecutor({
  supportBundle: bundle,
  handlers: {
    clearCache(action) {
      calls.push(action.kind);
      return { cleared: true };
    },
    exportSupportBundle(supportBundle, action) {
      calls.push(action.kind);
      return { createdAt: supportBundle.createdAt, diagnostics: supportBundle.diagnostics.length };
    },
    openDocs(href, action) {
      calls.push(action.kind);
      return href || "default-docs";
    },
    resetRuntime(action) {
      calls.push(action.kind);
      return "reset";
    },
    retry(action) {
      calls.push(`${action.kind}:${action.command}`);
      return "retried";
    }
  }
});

assert.deepEqual(
  await executor.execute({
    kind: "retry",
    label: "Retry package command",
    reason: "Retry package manager.",
    command: "npm install"
  }),
  {
    action: {
      kind: "retry",
      label: "Retry package command",
      reason: "Retry package manager.",
      command: "npm install"
    },
    message: "Retried operation.",
    status: "handled",
    value: "retried"
  }
);

assert.equal(
  (await executor.execute({
    kind: "reset-runtime",
    label: "Restart runtime",
    reason: "Restart dev server."
  })).status,
  "handled"
);
assert.equal(
  (await executor.execute({
    kind: "clear-cache",
    label: "Clear package cache",
    reason: "Free package cache space."
  })).status,
  "handled"
);
assert.equal(
  (await executor.execute({
    kind: "open-docs",
    label: "View supported runtime scope",
    reason: "Unsupported feature.",
    href: "/docs/supported-runtime"
  })).value,
  "/docs/supported-runtime"
);

const exported = await executor.execute({
  kind: "export-support-bundle",
  label: "Export support bundle",
  reason: "Attach diagnostics."
});
assert.equal(exported.status, "handled");
assert.deepEqual(exported.value, { createdAt: "2026-09-16T00:00:00.000Z", diagnostics: 1 });

executor.setSupportBundle(null);
assert.equal(
  (await executor.execute({
    kind: "export-support-bundle",
    label: "Export support bundle",
    reason: "Attach diagnostics."
  })).status,
  "unhandled"
);

assert.deepEqual(calls, [
  "retry:npm install",
  "reset-runtime",
  "clear-cache",
  "open-docs",
  "export-support-bundle"
]);

console.log("browser host recovery action executor test ok");
