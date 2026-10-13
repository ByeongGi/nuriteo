import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixtures.json", import.meta.url), "utf8"));
const results = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixture-results.json", import.meta.url), "utf8"));

assert.equal(results.schemaVersion, 1);
assert.equal(results.source, "compat/ecosystem-fixtures.json");
assert.deepEqual(results.failureSummary, {
  "build-dist-command-failed": 1,
  "dev-preview-unavailable": 5,
  "hmr-socket-connect-failed": 1,
  "hmr-update-timeout": 1,
  "package-manager-ignored-build-scripts": 9
});
assert.equal(results.minimumPassForMilestoneB, matrix.scope.minimumPassForMilestoneB);
const publicFixtures = matrix.fixtures.filter((fixture) => fixture.repository.startsWith("https://github.com/"));
assert.equal(results.results.length, publicFixtures.length);
assert.equal(results.summary.total, publicFixtures.length);
assert.equal(results.summary.milestoneB, "not-yet");

const fixtureIds = new Set(publicFixtures.map((fixture) => fixture.id));
const resultIds = new Set(results.results.map((result) => result.id));
assert.deepEqual(resultIds, fixtureIds);

const criteriaIds = matrix.scoringRubric.criteria.map((criterion) => criterion.id).sort();
for (const result of results.results) {
  assert.ok(fixtureIds.has(result.id), `unknown fixture result: ${result.id}`);
  assert.ok(["pass", "partial-pass", "hold", "unsupported"].includes(result.status), `${result.id} has invalid status`);
  assert.equal(typeof result.score, "number", `${result.id} must have score`);
  assert.deepEqual(result.criteria.map((criterion) => criterion.id).sort(), criteriaIds);
  assert.ok(result.criteria.every((criterion) => criterion.status === "pass" || criterion.failureCategory), `${result.id} failed criteria must be classified`);
}

assert.equal(results.results.filter((result) => result.criteria.some((criterion) => criterion.id === "install" && criterion.status === "pass")).length, 7);
assert.equal(results.results.filter((result) => result.criteria.some((criterion) => criterion.id === "build-dist" && criterion.status === "pass")).length, 6);
assert.equal(results.results.filter((result) => result.criteria.some((criterion) => criterion.id === "dev-preview" && criterion.status === "pass")).length, 6);
assert.equal(results.results.filter((result) => result.criteria.some((criterion) => criterion.id === "edit-hmr" && criterion.status === "pass")).length, 4);
assert.equal(results.summary.passCount, 4);
assert.equal(results.results.filter((result) => result.score >= 75).length, 6);

console.log("ecosystem fixture results test ok");
