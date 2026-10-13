import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/package-compatibility-cohorts.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.productRuntime, "browser-guest-node-runtime");
assert.equal(matrix.scope.unsupportedMustBeDiagnostic, true);

const cohorts = new Map(matrix.cohorts.map((cohort) => [cohort.id, cohort]));
for (const id of [
  "pure-js-cjs-esm",
  "registry-cache-tarball",
  "lifecycle-js",
  "wasm-tool-fallback",
  "optional-native-polyfill",
  "unsupported-native-addon",
  "binary-tool-wrapper"
]) {
  assert.ok(cohorts.has(id), `missing cohort: ${id}`);
}

for (const cohort of matrix.cohorts) {
  assert.ok(cohort.category, `${cohort.id} must have category`);
  assert.ok(cohort.status, `${cohort.id} must have status`);
  assert.ok(cohort.expectedRuntimePath, `${cohort.id} must have runtime path`);
  assert.ok(cohort.packages.length > 0, `${cohort.id} must list packages`);
  assert.ok(cohort.evidence.length > 0, `${cohort.id} must list evidence`);
  for (const evidence of cohort.evidence) {
    assert.equal(fs.existsSync(new URL(`../../${evidence}`, import.meta.url)), true, `${cohort.id} evidence missing: ${evidence}`);
  }
}

assert.equal(cohorts.get("unsupported-native-addon").requiredErrorCode, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
assert.equal(cohorts.get("binary-tool-wrapper").requiredErrorCode, "ERR_RUNTIME_UNSUPPORTED_BINARY");
assert.ok(cohorts.get("wasm-tool-fallback").notes.includes("integrity"));
assert.ok(cohorts.get("optional-native-polyfill").notes.includes("polyfill"));
assert.equal(matrix.gate.status, "pass");
assert.deepEqual(matrix.gate.requiredBeforeDone, []);

console.log("package compatibility cohorts matrix test ok");
