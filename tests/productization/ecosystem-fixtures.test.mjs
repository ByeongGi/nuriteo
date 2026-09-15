import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/ecosystem-fixtures.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.productRuntime, "browser-guest-node-runtime");
assert.equal(matrix.scope.referenceRuntime, "host-node-reference-harness");
assert.equal(matrix.scope.minimumPassForMilestoneB, 7);
assert.equal(matrix.scope.fixtureCount, 10);
assert.equal(matrix.fixtures.length, 10);
assert.equal(matrix.referenceNodeBaseline.status, "install-build-dev-preview-measured");

const criteriaPoints = matrix.scoringRubric.criteria.reduce((total, criterion) => total + criterion.points, 0);
assert.equal(criteriaPoints, matrix.scoringRubric.totalPoints);

const ids = new Set();
const packageManagers = new Set();
for (const fixture of matrix.fixtures) {
  assert.equal(ids.has(fixture.id), false, `duplicate fixture id: ${fixture.id}`);
  ids.add(fixture.id);
  packageManagers.add(fixture.packageManager);
  assert.match(fixture.repository, /^https:\/\/github\.com\//, `${fixture.id} must use a public GitHub repository URL`);
  assert.match(fixture.source, /^https:\/\/github\.com\//, `${fixture.id} must reference a source URL`);
  assert.ok(fixture.name, `${fixture.id} must have a name`);
  assert.ok(fixture.license, `${fixture.id} must record license status`);
  assert.ok(fixture.lockfile, `${fixture.id} must record lockfile status`);
  assert.ok(["low", "medium", "high"].includes(fixture.nativeDependencyRisk), `${fixture.id} must classify native risk`);
  assert.equal(fixture.status, "selected");
  assert.ok(fixture.expectedCommands.install.includes(" install"), `${fixture.id} must define install command`);
  assert.ok(fixture.expectedCommands.dev.includes("dev"), `${fixture.id} must define dev command`);
  assert.ok(fixture.expectedCommands.build.includes("build"), `${fixture.id} must define build command`);
}

assert.deepEqual([...packageManagers].sort(), ["npm", "pnpm"]);
assert.ok(matrix.fixtures.some((fixture) => fixture.subdirectory), "at least one monorepo subdirectory fixture must be represented");
assert.ok(matrix.fixtures.some((fixture) => fixture.nativeDependencyRisk === "low"), "low-risk starter fixture must be represented");
assert.ok(matrix.fixtures.some((fixture) => fixture.nativeDependencyRisk === "medium"), "medium-risk app fixture must be represented");
assert.ok(matrix.scoringRubric.classification.unsupported.includes("Docker"));

console.log("ecosystem fixtures matrix test ok");
