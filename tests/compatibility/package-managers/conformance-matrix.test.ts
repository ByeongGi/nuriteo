import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../../compat/package-manager-conformance.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.productRuntime, "browser-guest-node-runtime");
assert.equal(matrix.scope.testHelperRuntime, "host-node-test-helper");
assert.ok(Array.isArray(matrix.cases));

const casesById = new Map(matrix.cases.map((entry) => [entry.id, entry]));
for (const id of ["npm-version", "pnpm-version", "pnpm-store-plan", "registry-cache-tarball", "cli-module-graph-preflight"]) {
  const entry = casesById.get(id);
  assert.equal(entry?.runtime, "browser-guest-node-runtime");
  assert.equal(entry.status, "pass");
}

for (const id of [
  "npm-install",
  "npm-ci",
  "npm-run-exec-lifecycle-peer-optional-interrupt",
  "pnpm-install",
  "pnpm-run-exec-lifecycle-peer-optional-interrupt"
]) {
  const entry = casesById.get(id);
  assert.equal(entry?.runtime, "browser-guest-node-runtime");
  assert.equal(entry.status, "pass");
}

for (const entry of matrix.cases) {
  assert.ok(entry.evidence.length > 0, `${entry.id} must reference evidence`);
  for (const evidence of entry.evidence) {
    assert.equal(fs.existsSync(new URL(`../../../${evidence}`, import.meta.url)), true, `${entry.id} evidence missing: ${evidence}`);
  }
}

assert.equal(matrix.gate.id, "PG10");
assert.equal(matrix.gate.status, "pass");
assert.deepEqual(matrix.gate.requiredToPass, []);

console.log("package manager conformance matrix test ok");
