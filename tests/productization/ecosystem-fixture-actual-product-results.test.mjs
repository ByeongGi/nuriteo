import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixtures.json", import.meta.url), "utf8"));
const results = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixture-actual-product-results.json", import.meta.url), "utf8"));
const rescoreConfig = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-rescore-config.json", import.meta.url), "utf8"));

assert.equal(results.schemaVersion, 1);
assert.equal(results.source, "compat/ecosystem-fixtures.json");
assert.equal(results.minimumPassForMilestoneB, matrix.scope.minimumPassForMilestoneB);
assert.equal(results.results.length, rescoreConfig.publicFixtureIds.length);
assert.equal(results.inputContract.executionHost, "node-worker-thread");
assert.equal(results.inputContract.nodeVersion, rescoreConfig.runtime.node);
assert.equal(results.inputContract.npmVersion, rescoreConfig.runtime.npm);
assert.equal(results.inputContract.pnpmVersion, rescoreConfig.runtime.pnpm);
assert.deepEqual(results.results.map((result) => result.id), rescoreConfig.publicFixtureIds);
assert.equal(results.summary.total, results.results.length);
assert.equal(results.summary.milestoneB, "pass");
assert.equal(results.summary.passCount, 10);
assert.equal(results.results.filter((result) => result.score >= 50).length, 10);
assert.equal(results.results.filter((result) => result.score >= 75).length, 10);
assert.equal(results.results.filter((result) => result.score === 100).length, 10);

const criteriaIds = matrix.scoringRubric.criteria.map((criterion) => criterion.id).sort();
for (const result of results.results) {
  assert.equal(result.mode, "measured-product-actual");
  assert.equal(result.revision, results.inputContract.fixtureRevisions[result.id]);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.criteria.map((criterion) => criterion.id).sort(), criteriaIds);
  assert.ok(result.criteria.every((criterion) => criterion.status === "pass"));
  assert.ok(result.evidence);
  assert.ok(Array.isArray(result.evidence.missingFixtureDependencyArtifacts));
  assert.deepEqual(result.evidence.missingFixtureDependencyArtifacts, []);
  const generatedLock = rescoreConfig.generatedFixtureLockSha256[result.id];
  if (generatedLock) {
    assert.deepEqual(result.evidence.fixtureDependencyLockfile, { source: "generated", sha256: generatedLock });
  }
}

console.log("ecosystem fixture actual product results test ok");
