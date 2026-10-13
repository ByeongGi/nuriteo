import assert from "node:assert/strict";

import {
  createPackageManagerRecoveryDiagnostic,
  createPackageManagerUnsupportedDiagnostic
} from "../../browser-host/src/index.ts";

const nativeAddonResult = {
  entry: "npm",
  args: ["run", "postinstall"],
  cwd: "/workspace/app",
  commandKind: "run-script",
  stderr: "native fallback is unsupported without a proven WASM adapter or browser polyfill: lightningcss-darwin-arm64\n",
  error: {
    code: "ERR_PM_NATIVE_ADDON_UNSUPPORTED",
    message: "native addon execution is unsupported"
  }
};

const diagnostic = createPackageManagerUnsupportedDiagnostic(nativeAddonResult);
assert.equal(diagnostic.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
assert.equal(diagnostic.source, "package-manager");
assert.match(diagnostic.message, /Native addon execution is unsupported/);
assert.match(diagnostic.message, /npm/);

const recovery = createPackageManagerRecoveryDiagnostic(nativeAddonResult, ["install log"]);
assert.equal(recovery.diagnostic.code, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
assert.equal(recovery.recovery.blocked, true);
assert.deepEqual(recovery.recovery.actions.map((action) => action.kind), ["open-docs", "export-support-bundle"]);
assert.equal(recovery.supportBundle.diagnostics[0].source, "package-manager");
assert.match(recovery.supportBundle.logs.join("\n"), /install log/);

assert.equal(
  createPackageManagerUnsupportedDiagnostic({
    entry: "npm",
    error: { code: "ERR_PM_REAL_CLI_EVALUATION_REQUIRED", message: "real CLI required" }
  }),
  null
);

console.log("browser host package manager diagnostics test ok");
