import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixtures.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.productRuntime, "browser-guest-node-runtime");
assert.equal(matrix.scope.referenceRuntime, "host-node-reference-harness");
assert.equal(matrix.scope.minimumPassForMilestoneB, 7);
assert.equal(matrix.scope.fixtureCount, 20);
assert.equal(matrix.fixtures.length, 20);
assert.equal(matrix.referenceNodeBaseline.status, "install-build-dev-preview-hmr-measured");

const criteriaPoints = matrix.scoringRubric.criteria.reduce((total, criterion) => total + criterion.points, 0);
assert.equal(criteriaPoints, matrix.scoringRubric.totalPoints);

const ids = new Set();
const packageManagers = new Set();
for (const fixture of matrix.fixtures) {
  assert.equal(ids.has(fixture.id), false, `duplicate fixture id: ${fixture.id}`);
  ids.add(fixture.id);
  packageManagers.add(fixture.packageManager);
  assert.ok(fixture.name, `${fixture.id} must have a name`);
  assert.ok(fixture.license, `${fixture.id} must record license status`);
  assert.ok(fixture.lockfile, `${fixture.id} must record lockfile status`);
  assert.ok(["low", "medium", "high"].includes(fixture.nativeDependencyRisk), `${fixture.id} must classify native risk`);
  assert.equal(fixture.status, "selected");
  assert.ok(fixture.expectedCommands.install?.trim(), `${fixture.id} must define install command`);
  assert.ok(fixture.expectedCommands.dev?.trim(), `${fixture.id} must define dev command`);
  assert.ok(fixture.expectedCommands.build?.trim(), `${fixture.id} must define build command`);
}

const publicFixtures = matrix.fixtures.filter((fixture) => fixture.repository.startsWith("https://github.com/"));
const localFixtures = matrix.fixtures.filter((fixture) => fixture.repository.startsWith("local://"));

assert.equal(publicFixtures.length, 10, "the reproducible public-fixture cohort must contain 10 repositories");
assert.equal(localFixtures.length, 10, "the local framework and product cohort must contain 10 fixtures");

for (const fixture of publicFixtures) {
  assert.match(fixture.source, /^https:\/\/github\.com\//, `${fixture.id} must reference a public source URL`);
  assert.match(fixture.revision, /^[0-9a-f]{40}$/, `${fixture.id} must pin an exact Git revision`);
}

for (const fixture of localFixtures) {
  assert.ok(fixture.cohort, `${fixture.id} must identify its local cohort`);
  assert.ok(!fixture.revision, `${fixture.id} must not pretend to pin an external Git revision`);
}

assert.deepEqual([...packageManagers].sort(), ["npm", "pnpm"]);
assert.ok(matrix.fixtures.some((fixture) => fixture.subdirectory), "at least one monorepo subdirectory fixture must be represented");
assert.ok(matrix.fixtures.some((fixture) => fixture.nativeDependencyRisk === "low"), "low-risk starter fixture must be represented");
assert.ok(matrix.fixtures.some((fixture) => fixture.nativeDependencyRisk === "medium"), "medium-risk app fixture must be represented");
assert.ok(matrix.scoringRubric.classification.unsupported.includes("Docker"));

console.log("ecosystem fixtures matrix test ok");
