import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixtures.json", import.meta.url), "utf8"));
const results = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixture-product-results.json", import.meta.url), "utf8"));

assert.equal(results.schemaVersion, 1);
assert.equal(results.source, "compat/ecosystem-fixtures.json");
assert.deepEqual(results.failureSummary, {});
assert.equal(results.minimumPassForMilestoneB, matrix.scope.minimumPassForMilestoneB);
const publicFixtures = matrix.fixtures.filter((fixture) => fixture.repository.startsWith("https://github.com/"));
assert.equal(results.results.length, publicFixtures.length);
assert.equal(results.summary.total, publicFixtures.length);
assert.equal(results.summary.passCount, 10);
assert.equal(results.summary.milestoneB, "pass");

const criteriaIds = matrix.scoringRubric.criteria.map((criterion) => criterion.id).sort();
const publicFixtureIds = new Set(publicFixtures.map((fixture) => fixture.id));
for (const result of results.results) {
  assert.ok(publicFixtureIds.has(result.id), `unknown public fixture result: ${result.id}`);
  assert.equal(result.mode, "measured-product-adapter");
  assert.equal(result.score, 100);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.criteria.map((criterion) => criterion.id).sort(), criteriaIds);
  assert.ok(result.criteria.every((criterion) => criterion.status === "pass"));
}

console.log("ecosystem fixture product results test ok");
