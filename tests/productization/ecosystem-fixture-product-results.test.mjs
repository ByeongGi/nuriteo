import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixtures.json", import.meta.url), "utf8"));
const results = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixture-product-results.json", import.meta.url), "utf8"));

assert.equal(results.schemaVersion, 1);
assert.equal(results.source, "compat/ecosystem-fixtures.json");
assert.deepEqual(results.failureSummary, {});
assert.equal(results.minimumPassForMilestoneB, matrix.scope.minimumPassForMilestoneB);
assert.equal(results.results.length, matrix.fixtures.length);
assert.equal(results.summary.total, matrix.fixtures.length);
assert.equal(results.summary.passCount, 10);
assert.equal(results.summary.milestoneB, "pass");

const criteriaIds = matrix.scoringRubric.criteria.map((criterion) => criterion.id).sort();
for (const result of results.results) {
  assert.equal(result.mode, "measured-product-adapter");
  assert.equal(result.score, 100);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.criteria.map((criterion) => criterion.id).sort(), criteriaIds);
  assert.ok(result.criteria.every((criterion) => criterion.status === "pass"));
}

console.log("ecosystem fixture product results test ok");
