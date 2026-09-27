import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const support = readJson("compat/framework-product-support.json");
const fixtures = readJson("compat/ecosystem-fixtures.json");
const validation = readJson("compat/framework-actual-validation.json");
const publicMatrix = readJson("compat/public-compatibility-matrix.json");
const bundlerResults = readJson("compat/bundler-dev-workflow-results.json");

assert(support.schemaVersion === 1, "unexpected framework support schema");
assert(support.gate?.status === "pass", "framework promotion gate must pass");
assert(support.performanceBudgets.adapterWorkflowMs > 0, "adapter workflow budget is required");
assert(support.performanceBudgets.cliBackedWorkflowMs > 0, "CLI-backed workflow budget is required");

for (const id of support.gate.requiredSupported) {
  const entry = support.frameworks.find((candidate) => candidate.id === id);
  assert(entry?.grade === "supported", `${id} must be supported`);
  assert(entry.packageManagers.join(",") === "npm,pnpm", `${id} must cover npm and pnpm`);
  assert(entry.requiredCapabilities.join(",") === "install,dev-preview,edit-hmr,build-dist,reload-recovery", `${id} capability contract is incomplete`);
  assert(/^https:\/\/github\.com\//.test(entry.publicFixture.repository), `${id} must use a public fixture`);
  assert(/^[0-9a-f]{40}$/.test(entry.publicFixture.revision), `${id} public fixture must pin an exact revision`);

  const fixture = fixtures.fixtures.find((candidate) => candidate.id === entry.fixtureId);
  assert(fixture, `${id} local fixture is missing`);
  assert(fixture.upstream?.revision === entry.publicFixture.revision, `${id} fixture revision is not aligned`);
  assert(fixture.upstream?.subdirectory === entry.publicFixture.subdirectory, `${id} fixture subdirectory is not aligned`);

  const actual = validation.results.find((candidate) => candidate.framework === id);
  assert(actual?.grade === "supported", `${id} actual validation is not supported`);
  assert(actual.validation === "actual-worker-backed", `${id} must remain worker-backed`);

  const matrix = publicMatrix.frameworks.find((candidate) => candidate.name === actual.publicName);
  assert(matrix?.status === "supported", `${id} public matrix is not supported`);

  for (const evidence of entry.evidence) {
    assert(fs.existsSync(path.join(root, evidence)), `${id} evidence missing: ${evidence}`);
  }
}

const stages = new Set(support.failureTaxonomy.map((entry) => entry.stage));
for (const stage of ["install", "dev-preview", "edit-hmr", "build-dist"]) {
  assert(stages.has(stage), `failure taxonomy missing ${stage}`);
}
for (const entry of support.failureTaxonomy) {
  assert(entry.codes.length > 0, `${entry.id} must name diagnostic codes`);
  assert(entry.supportPolicy.length > 0, `${entry.id} must define recovery policy`);
}

for (const candidate of support.bundlerCandidates) {
  assert(candidate.grade === "supported", `${candidate.id} must be supported`);
  assert(candidate.productSupport === true, `${candidate.id} must claim product support`);
  assert(candidate.blocker.length === 0, `${candidate.id} must not retain a blocker`);
  assert(candidate.diagnosticCodes.length > 0, `${candidate.id} must name typed diagnostics`);
  for (const evidence of candidate.evidence) {
    assert(fs.existsSync(path.join(root, evidence)), `${candidate.id} evidence missing: ${evidence}`);
  }
}

assert(bundlerResults.supportDecision === "supported", "bundler workflows must be promoted after browser gates pass");
for (const bundler of ["webpack", "rspack"]) {
  const result = bundlerResults.results.find((candidate) => candidate.bundler === bundler);
  assert(result?.grade === "supported", `${bundler} result must be supported`);
  assert(result.productSupport === true, `${bundler} must claim product support`);
  assert(/^[0-9a-f]{40}$/.test(result.fixture.revision), `${bundler} fixture revision must be exact`);
  assert(result.measurements.install === "pass-exact-version-and-sri", `${bundler} install pin validation must pass`);
  assert(result.measurements.devServer === "pass-loopback-port-bind", `${bundler} dev server must bind through loopback`);
  assert(result.measurements.update === "pass-invalid-hash-ok-and-updated-asset", `${bundler} HMR evidence is incomplete`);
  assert(result.measurements.productionBuild.startsWith("pass-real"), `${bundler} build output must be real`);
  assert(result.measurements.teardown === "pass-no-worker-target-or-listener-leak", `${bundler} teardown must be leak-free`);
  assert(result.blockers.length === 0, `${bundler} must not retain blockers`);
  assert(result.dependencies.every((dependency) => /^\d+\.\d+\.\d+/.test(dependency.version)), `${bundler} dependencies must use exact versions`);
  assert(result.dependencies.every((dependency) => /^sha512-/.test(dependency.integrity)), `${bundler} dependencies must pin integrity`);
}

console.log(`framework product support ok supported=${support.frameworks.length} candidates=${support.bundlerCandidates.length}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
