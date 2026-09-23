import assert from "node:assert/strict";
import fs from "node:fs";

const acceptance = readJson("../../compat/parity-acceptance.json");
const publicMatrix = readJson("../../compat/public-compatibility-matrix.json");
const actualResults = readJson("../../compat/ecosystem-fixture-actual-product-results.json");
const unsupported = readJson("../../compat/unsupported-diagnostics.json");
const progress = readText("../../docs/archive/productization-2026-09-16/PROGRESS.md");
const acceptanceDoc = readText("../../docs/productization/parity-acceptance.md");

assert.equal(acceptance.schemaVersion, 1);
assert.equal(acceptance.status, "pg20-pass");
assert.equal(acceptance.gate.id, "PG20");
assert.equal(acceptance.gate.status, "pass");
assert.deepEqual(acceptance.gate.requiredBeforeDone, []);
assert.equal(acceptance.releaseDecision, "release-candidate-ready-for-scoped-browser-js-ts-development");

assert.equal(publicMatrix.gate.status, "pass");
assert.equal(publicMatrix.projectFixtures.status, "sg25-service-workflow-pass");
assert.equal(actualResults.summary.milestoneB, "pass");
assert.equal(actualResults.summary.passCount, acceptance.scope.included.find((item) => item.area === "Actual public Vite React ecosystem fixture gate").actualPass);

for (const item of acceptance.scope.included) {
  assert.match(item.status, /product-supported/);
  assert.ok(item.evidence.length > 0, `${item.area} must cite evidence`);
  for (const evidence of item.evidence) assertPathExists(evidence, `${item.area} evidence missing`);
}

const unsupportedCodes = new Set(unsupported.cases.map((entry) => entry.requiredErrorCode));
for (const item of acceptance.scope.excluded) {
  assert.ok(["unsupported", "not-claimed"].includes(item.status), `${item.area} has unexpected status: ${item.status}`);
  for (const evidence of item.evidence) assertPathExists(evidence, `${item.area} evidence missing`);
  if (item.status === "unsupported") {
    assert.ok(unsupportedCodes.has(item.requiredErrorCode), `${item.area} diagnostic must be covered by unsupported matrix`);
    assert.match(acceptanceDoc, new RegExp(escapeRegExp(item.requiredErrorCode)));
  }
}

for (const doc of acceptance.documentation.requiredDocs) {
  assertPathExists(doc, "required documentation missing");
}
for (const command of acceptance.operations.requiredChecks) {
  assert.match(acceptanceDoc, new RegExp(escapeRegExp(command)), `acceptance doc missing command: ${command}`);
}
for (const evidence of [
  ...acceptance.walkthrough.evidence,
  ...acceptance.documentation.evidence,
  ...acceptance.operations.evidence
]) {
  assertPathExists(evidence, "acceptance evidence missing");
}

assert.equal(acceptance.walkthrough.status, "pass");
assert.deepEqual(acceptance.walkthrough.covers, ["install", "dev", "preview", "edit-hmr", "build", "reload-recovery"]);
assert.equal(acceptance.documentation.status, "pass");
assert.equal(acceptance.operations.status, "pass");
assert.equal(acceptance.operations.supportOwner, "maintainer");
assert.ok(acceptance.operations.remainingBacklog.length > 0);

assert.match(progress, /\| P20 \| .* \| 4\/4 \| PG20: PASS \| DONE \|/);
assert.match(progress, /\| C \| WebContainers parity scope \| PASS \|/);

console.log("parity acceptance test ok");

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function assertPathExists(relativePath, message) {
  assert.equal(fs.existsSync(new URL(`../../${relativePath}`, import.meta.url)), true, `${message}: ${relativePath}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
