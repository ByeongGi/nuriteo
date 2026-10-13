import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/public-compatibility-matrix.json", import.meta.url), "utf8"));
const docs = fs.readFileSync(new URL("../../docs/productization/public-compatibility-matrix.md", import.meta.url), "utf8");

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.productRuntime, "browser-guest-node-runtime");
assert.match(matrix.scope.parityBoundary, /Docker/);
assert.equal(matrix.projectFixtures.total, 20);
assert.equal(matrix.projectFixtures.minimumPassForMilestoneB, 7);
assert.equal(matrix.projectFixtures.status, "sg25-service-workflow-pass");
assert.equal(matrix.projectFixtures.referenceInstallPass, 7);
assert.equal(matrix.projectFixtures.referenceBuildPass, 6);
assert.equal(matrix.projectFixtures.referenceDevPreviewPass, 6);
assert.equal(matrix.projectFixtures.referenceHmrPass, 4);
assert.equal(matrix.projectFixtures.referencePass, 4);
assert.equal(matrix.projectFixtures.productAdapterPass, 10);
assert.equal(matrix.projectFixtures.productAdapterScoreAtLeast75, 10);
assert.equal(matrix.projectFixtures.actualProductMeasured, 10);
assert.equal(matrix.projectFixtures.actualProductPass, 10);
assert.equal(matrix.projectFixtures.actualProductPartialPass, 0);
assert.equal(matrix.projectFixtures.actualProductScoreAtLeast50, 10);
assert.equal(matrix.projectFixtures.actualProductScoreAtLeast75, 10);
assert.equal(matrix.projectFixtures.actualProductScoreAtLeast100, 10);
assert.equal(matrix.projectFixtures.actualProductExecutionHost, "node-worker-thread");
assert.deepEqual(matrix.projectFixtures.actualProductBlockers, []);
assert.equal(matrix.projectFixtures.serviceWorkflowTotal, 20);
assert.equal(matrix.projectFixtures.serviceWorkflowPass, 18);
assert.equal(matrix.projectFixtures.serviceWorkflowHold, 2);
assert.equal(matrix.projectFixtures.serviceWorkflowPassOrHold, 20);
assert.equal(fs.existsSync(new URL(`../../${matrix.projectFixtures.productAdapterResults}`, import.meta.url)), true);
assert.equal(fs.existsSync(new URL(`../../${matrix.projectFixtures.actualProductResults}`, import.meta.url)), true);

for (const section of [matrix.frameworks, matrix.packages, matrix.unsupported]) {
  assert.ok(section.length > 0);
}

for (const framework of matrix.frameworks) {
  assert.match(docs, new RegExp(escapeRegExp(framework.name), "i"));
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
assert.equal(matrix.gate.status, "pass");
assert.deepEqual(matrix.gate.requiredBeforeDone, []);
assert.equal(matrix.gate.requiredBeforeDone.includes("Wire unsupported diagnostics into UI acceptance tests"), false);
assert.ok(matrix.packages.every((cohort) => cohort.evidence.includes("tests/productization/package-cohort-execution.test.ts")));

console.log("public compatibility matrix test ok");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
