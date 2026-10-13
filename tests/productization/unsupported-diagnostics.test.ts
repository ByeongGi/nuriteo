import assert from "node:assert/strict";
import fs from "node:fs";

import {
  assertRuntimeFeatureSupported,
  createPackageManagerRecoveryDiagnostic,
  createRuntimeNetworkRecoveryDiagnostic,
  createRuntimeRecoveryPlan,
  createRuntimeSupportBundle,
  createUnsupportedRuntimeDiagnostic,
  UnsupportedRuntimeFeatureError
} from "../../packages/browser-host/src/index.ts";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/unsupported-diagnostics.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.productRuntime, "browser-guest-node-runtime");
assert.equal(matrix.gate.status, "pass");
assert.deepEqual(matrix.gate.requiredBeforeDone, []);
for (const evidence of matrix.evidence) {
  assert.equal(fs.existsSync(new URL(`../../${evidence}`, import.meta.url)), true, `evidence missing: ${evidence}`);
}
for (const entry of matrix.cases) {
  assert.equal(entry.status, "unsupported");
  assert.ok(entry.requiredErrorCode, `${entry.id} must define required error code`);
  assert.deepEqual(entry.recovery, ["open-docs", "export-support-bundle"]);
}

const docker = createUnsupportedRuntimeDiagnostic({
  kind: "docker",
  resource: "docker compose up",
  command: "docker compose up",
  requestId: "req-docker"
});
assert.equal(docker.code, "ERR_RUNTIME_DOCKER_UNSUPPORTED");
assert.equal(docker.requestId, "req-docker");
assert.match(docker.message, /Docker/);
assert.match(docker.remediation, /hosted service/);

const tcpDatabase = createUnsupportedRuntimeDiagnostic({
  kind: "direct-tcp-database",
  resource: "postgres://localhost:5432/app"
});
assert.equal(tcpDatabase.code, "ERR_RUNTIME_TCP_DB_UNSUPPORTED");
assert.match(tcpDatabase.remediation, /HTTP adapter/);

const binary = createUnsupportedRuntimeDiagnostic({
  kind: "arbitrary-linux-binary",
  resource: "./node_modules/.bin/linux-tool"
});
assert.equal(binary.code, "ERR_RUNTIME_UNSUPPORTED_BINARY");

assert.throws(
  () => assertRuntimeFeatureSupported({ kind: "native-addon", resource: "sharp.node" }),
  (error) => {
    assert.equal(error instanceof UnsupportedRuntimeFeatureError, true);
    assert.equal(error.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
    assert.equal(error.diagnostic.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
    return true;
  }
);

const bundle = createRuntimeSupportBundle({
  createdAt: "2026-09-16T00:00:00.000Z",
  diagnostics: [docker, tcpDatabase, binary]
});
const recovery = createRuntimeRecoveryPlan({
  diagnostics: bundle.diagnostics,
  supportBundle: bundle
});
assert.equal(recovery.blocked, true);
assert.equal(recovery.supportBundleRecommended, true);
assert.equal(recovery.actions[0].kind, "open-docs");
assert.equal(recovery.actions.at(-1).kind, "export-support-bundle");

const packageRecovery = createPackageManagerRecoveryDiagnostic({
  entry: "npm",
  args: ["run", "postinstall"],
  error: {
    code: "ERR_PM_NATIVE_ADDON_UNSUPPORTED",
    message: "native addon execution is unsupported"
  }
});
assert.equal(packageRecovery.diagnostic.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
assert.equal(packageRecovery.recovery.blocked, true);

const networkRecovery = createRuntimeNetworkRecoveryDiagnostic({
  error: { code: "ERR_BROWSER_TCP_UNSUPPORTED", message: "Direct TCP sockets are not available" },
  host: "database.local",
  port: 5432
});
assert.equal(networkRecovery.diagnostic.code, "ERR_RUNTIME_TCP_DB_UNSUPPORTED");
assert.equal(networkRecovery.recovery.blocked, true);

console.log("unsupported diagnostics conformance test ok");
