import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const config = readJson("compat/ecosystem-rescore-config.json");
const catalog = readJson(config.fixtureCatalog);
const publicFixtures = catalog.fixtures.filter((fixture) => config.publicFixtureIds.includes(fixture.id));

assert.equal(config.schemaVersion, 1);
assert.equal(config.resultSchemaVersion, 1);
assert.match(config.runtime.node, /^\d+\.\d+\.\d+$/);
assert.match(config.runtime.pnpm, /^\d+\.\d+\.\d+$/);
assert.match(config.toolchain.vite, /^\d+\.\d+\.\d+$/);
assert.match(config.toolchain.rolldown, /^\d+\.\d+\.\d+$/);
assert.match(config.toolchain.rolldownWasiBinding, /^\d+\.\d+\.\d+$/);
assert.equal(
  config.toolchain.rolldownWasiBinding,
  config.toolchain.rolldown,
  "Rolldown loader and WASI binding versions must remain aligned"
);
assert.equal(config.publicFixtureIds.length, 10, "public re-score lane must contain the ten public Vite React fixtures");
assert.equal(publicFixtures.length, config.publicFixtureIds.length, "all configured public fixture ids must exist");
assert.deepEqual(publicFixtures.map((fixture) => fixture.id), config.publicFixtureIds, "fixture order must be stable");
for (const fixture of publicFixtures) {
  assert.match(fixture.repository, /^https:\/\/github\.com\//, `${fixture.id} must be a public GitHub repository`);
  assert.match(fixture.revision || "", /^[0-9a-f]{40}$/, `${fixture.id} must pin an exact commit SHA`);
}
assert.ok(fs.existsSync(config.toolchain.wasmPolicy), "configured WASM adapter policy must exist");

const plan = spawnSync(process.execPath, [
  "scripts/score-ecosystem-fixtures.mjs",
  "--plan",
  `--fixtures=${config.publicFixtureIds.join(",")}`
], { encoding: "utf8" });
assert.equal(plan.status, 0, plan.stderr);
const planned = JSON.parse(plan.stdout);
assert.equal(planned.schemaVersion, config.resultSchemaVersion);
assert.deepEqual(planned.inputContract.fixtureRevisions, Object.fromEntries(publicFixtures.map((fixture) => [fixture.id, fixture.revision])));
assert.ok(planned.results.every((result) => result.revision === planned.inputContract.fixtureRevisions[result.id]));

const canonicalPath = path.resolve("compat/ecosystem-fixture-actual-product-results.json");
const defaultRunnerPlan = runPlan([]);
assert.equal(defaultRunnerPlan.outputKind, "review-artifact");
assert.notEqual(defaultRunnerPlan.output, canonicalPath, "default re-score output must not be the canonical evidence file");
assert.equal(defaultRunnerPlan.output, path.resolve("artifacts/ecosystem-fixture-actual-product-results.json"));
assert.deepEqual(defaultRunnerPlan.fixtureIds, config.publicFixtureIds);
assert.deepEqual(defaultRunnerPlan.fixtureDependencyPreparation, {
  enabled: true,
  ignoreScripts: true,
  lockfileMode: "frozen"
});

const subsetIds = config.publicFixtureIds.slice(0, 2);
const subsetRunnerPlan = runPlan([`--fixtures=${subsetIds.join(",")}`]);
assert.deepEqual(subsetRunnerPlan.fixtureIds, subsetIds, "manual subset selection must remain ordered and scoped");

verifyFailedRunPreservesCanonicalAndCleansUp();

const resultsPath = valueAfter("--results");
if (resultsPath) validateResults(readJson(resultsPath));

console.log(`ecosystem re-score automation ok fixtures=${publicFixtures.length}${resultsPath ? ` results=${resultsPath}` : ""}`);

function validateResults(results) {
  assert.equal(results.schemaVersion, config.resultSchemaVersion);
  assert.equal(results.source, config.fixtureCatalog);
  assert.equal(results.inputContract.viteVersion, config.toolchain.vite);
  const resultIds = results.results.map((result) => result.id);
  assert.ok(resultIds.length > 0, "result set must not be empty");
  assert.deepEqual(resultIds, config.publicFixtureIds.filter((id) => resultIds.includes(id)), "result ids must be an ordered public-fixture subset");
  assert.deepEqual(
    results.inputContract.fixtureRevisions,
    Object.fromEntries(publicFixtures.filter((fixture) => resultIds.includes(fixture.id)).map((fixture) => [fixture.id, fixture.revision]))
  );
  for (const result of results.results) {
    assert.equal(result.mode, "measured-product-actual", `${result.id} must use the actual product path`);
    assert.equal(result.revision, results.inputContract.fixtureRevisions[result.id], `${result.id} result revision drifted`);
    assert.equal(result.criteria.length, 4, `${result.id} must record all four scoring criteria`);
  }
}

function runPlan(extraArgs) {
  const result = spawnSync(process.execPath, ["scripts/rescore-public-fixtures.mjs", "--plan", ...extraArgs], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function verifyFailedRunPreservesCanonicalAndCleansUp() {
  const canonicalBefore = fs.readFileSync(canonicalPath);
  const tempPrefix = "cargo-container-public-rescore-";
  const workdirsBefore = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(tempPrefix)));
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cargo-container-rescore-safety-test-"));
  const existingOutput = path.join(testRoot, "existing.json");
  const sentinel = "existing-review-artifact\n";
  fs.writeFileSync(existingOutput, sentinel);
  try {
    const failed = spawnSync(process.execPath, [
      "scripts/rescore-public-fixtures.mjs",
      `--fixtures=${config.publicFixtureIds[0]}`,
      `--output=${existingOutput}`
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: path.join(testRoot, "missing-bin") }
    });
    assert.notEqual(failed.status, 0, "forced toolchain failure must fail the runner");
    assert.equal(fs.readFileSync(existingOutput, "utf8"), sentinel, "failed run must preserve an existing review artifact");
    assert.deepEqual(fs.readFileSync(canonicalPath), canonicalBefore, "failed run must preserve canonical evidence");
    const workdirsAfter = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(tempPrefix));
    assert.deepEqual(workdirsAfter.filter((entry) => !workdirsBefore.has(entry)), [], "failed run must clean its automatic workdir");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function valueAfter(name) {
  const prefix = `${name}=`;
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return inline?.slice(prefix.length);
}
