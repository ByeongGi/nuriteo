import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../../compat/sdk-consumer-bundler-matrix.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.packageArtifact, "dist/sdk/nuriteo-sdk-0.1.0-beta.1.tgz");
assert.ok(Array.isArray(matrix.cases));

const casesById = new Map(matrix.cases.map((entry) => [entry.id, entry]));

for (const id of ["typescript-bundler-resolution", "node-commonjs-require", "vite-consumer-build", "webpack-consumer-build", "rspack-consumer-build", "next-consumer-build"]) {
  const entry = casesById.get(id);
  assert.equal(entry?.status, "pass");
}

for (const entry of matrix.cases) {
  assert.ok(entry.evidence.length > 0, `${entry.id} must reference evidence`);
  for (const evidence of entry.evidence) {
    assert.equal(fs.existsSync(new URL(`../../../${evidence}`, import.meta.url)), true, `${entry.id} evidence missing: ${evidence}`);
  }
}

assert.equal(matrix.gate.id, "P14-03");
assert.equal(matrix.gate.status, "pass");
assert.deepEqual(matrix.gate.requiredToPass, []);

console.log("sdk consumer bundler matrix test ok");
