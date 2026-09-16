import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixtures.json", import.meta.url), "utf8"));
const results = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixture-actual-product-results.json", import.meta.url), "utf8"));

assert.equal(results.schemaVersion, 1);
assert.equal(results.source, "compat/ecosystem-fixtures.json");
assert.equal(results.minimumPassForMilestoneB, matrix.scope.minimumPassForMilestoneB);
assert.ok(results.results.length >= 1);
assert.equal(results.summary.total, results.results.length);
assert.equal(results.summary.milestoneB, "not-yet");

const criteriaIds = matrix.scoringRubric.criteria.map((criterion) => criterion.id).sort();
for (const result of results.results) {
  assert.equal(result.mode, "measured-product-actual");
  assert.deepEqual(result.criteria.map((criterion) => criterion.id).sort(), criteriaIds);
  assert.ok(result.evidence);
  assert.ok(Array.isArray(result.evidence.missingFixtureDependencyArtifacts));
}

console.log("ecosystem fixture actual product results test ok");
