import assert from "node:assert/strict";
import fs from "node:fs";
import { BundlerCandidateBlockedError, BundlerCandidateWorkflow } from "../../../../packages/node-runtime/src/index.ts";

const results = JSON.parse(fs.readFileSync(new URL("../../../../compat/bundler-dev-workflow-results.json", import.meta.url), "utf8"));

assert.equal(results.supportDecision, "supported");
assert.equal(results.results.length, 2);

for (const candidate of results.results) {
  const workflow = new BundlerCandidateWorkflow({
    bundler: candidate.bundler,
    dependencies: candidate.dependencies,
    fixture: candidate.fixture,
    precompiledCliFactory: true,
    wasmBindingValidatedInBrowserWorker: candidate.bundler === "rspack"
  });
  const install = workflow.install();
  assert.equal(install.installed, true);
  assert.equal(install.lock, "exact-version-and-sri");
  assert.match(install.fixture.revision, /^[0-9a-f]{40}$/);

  const readiness = workflow.inspectReadiness();
  assert.equal(readiness.status, "supported");
  assert.equal(readiness.productSupport, true);
  assert.deepEqual(readiness.blockers, []);
  assert.equal(workflow.startDevServer().ready, true);
  assert.equal(workflow.network.listeners.size, 1);
  assert.equal(workflow.preview().ready, true);
  assert.deepEqual(workflow.editSource(), { hmr: true, updated: true });
  assert.deepEqual(workflow.build(), { emitted: true, exitCode: 0 });
  assert.equal(workflow.restart().ready, true);
  assert.deepEqual(workflow.stop(), { listenerCount: 0, recovered: true, restartCount: 1 });
}

const blocked = new BundlerCandidateWorkflow({
  bundler: "webpack",
  dependencies: results.results[0].dependencies,
  fixture: results.results[0].fixture
});
assert.throws(
  () => blocked.startDevServer(),
  (error) => error instanceof BundlerCandidateBlockedError && error.code === "ERR_BUNDLER_STRICT_CSP_FACTORY_MISSING"
);

const invalid = new BundlerCandidateWorkflow({
  bundler: "webpack",
  dependencies: [{ name: "webpack", version: "^5.111.0", integrity: "missing", role: "bundler" }],
  fixture: { repository: "local://fixture", revision: "main", subdirectory: "." }
});
assert.throws(
  () => invalid.install(),
  (error) => error instanceof BundlerCandidateBlockedError && error.code === "ERR_BUNDLER_FIXTURE_REVISION_INVALID" && error.stage === "install"
);

console.log("bundler candidate workflow test ok");
