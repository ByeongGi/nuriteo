import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/public-compatibility-matrix.json", import.meta.url), "utf8"));
const docs = fs.readFileSync(new URL("../../docs/productization/public-compatibility-matrix.md", import.meta.url), "utf8");

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.productRuntime, "browser-guest-node-runtime");
assert.match(matrix.scope.parityBoundary, /Docker/);
assert.equal(matrix.projectFixtures.total, 10);
assert.equal(matrix.projectFixtures.minimumPassForMilestoneB, 7);

for (const section of [matrix.frameworks, matrix.packages, matrix.unsupported]) {
  assert.ok(section.length > 0);
}

for (const framework of matrix.frameworks) {
  assert.match(docs, new RegExp(escapeRegExp(framework.name)));
  assert.ok(framework.evidence.length > 0, `${framework.name} must reference evidence`);
  for (const evidence of framework.evidence) {
    assert.equal(fs.existsSync(new URL(`../../${evidence}`, import.meta.url)), true, `${framework.name} evidence missing: ${evidence}`);
  }
}

for (const cohort of matrix.packages) {
  assert.match(docs, new RegExp(escapeRegExp(cohort.cohort)));
  for (const evidence of cohort.evidence) {
    assert.equal(fs.existsSync(new URL(`../../${evidence}`, import.meta.url)), true, `${cohort.cohort} evidence missing: ${evidence}`);
  }
}

for (const unsupported of matrix.unsupported) {
  assert.equal(unsupported.status, "unsupported");
  assert.match(docs, new RegExp(escapeRegExp(unsupported.requiredErrorCode)));
}

for (const command of matrix.reproduce) {
  assert.match(docs, new RegExp(escapeRegExp(command)));
}

assert.equal(matrix.gate.id, "P18-04");
assert.equal(matrix.gate.status, "partial-pass");

console.log("public compatibility matrix test ok");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
