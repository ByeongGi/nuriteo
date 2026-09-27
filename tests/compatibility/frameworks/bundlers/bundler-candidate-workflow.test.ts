import assert from "node:assert/strict";
import fs from "node:fs";
import { BundlerCandidateBlockedError, BundlerCandidateWorkflow } from "../../../../packages/node-runtime/src/index.ts";

const results = JSON.parse(fs.readFileSync(new URL("../../../../compat/bundler-dev-workflow-results.json", import.meta.url), "utf8"));

assert.equal(results.supportDecision, "hold");
assert.equal(results.results.length, 2);

for (const candidate of results.results) {
  const workflow = new BundlerCandidateWorkflow({
    bundler: candidate.bundler,
    dependencies: candidate.dependencies,
    fixture: candidate.fixture
  });
  const install = workflow.install();
  assert.equal(install.installed, true);
  assert.equal(install.lock, "exact-version-and-sri");
  assert.match(install.fixture.revision, /^[0-9a-f]{40}$/);

  const readiness = workflow.inspectReadiness();
  assert.equal(readiness.status, "candidate-blocked");
  assert.equal(readiness.productSupport, false);
  assert.equal(readiness.blockers[0].code, "ERR_BUNDLER_STRICT_CSP_FACTORY_MISSING");
  if (candidate.bundler === "rspack") {
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "ERR_BUNDLER_WASM_RUNTIME_UNVALIDATED"));
  }

  assert.throws(
    () => workflow.startDevServer(),
    (error) => error instanceof BundlerCandidateBlockedError
      && error.code === "ERR_BUNDLER_STRICT_CSP_FACTORY_MISSING"
      && error.stage === "cli-bootstrap"
  );
  assert.equal(workflow.network.listeners.size, 0, "a blocked candidate must not bind a preview port");

  assert.throws(() => workflow.preview(), (error) => error instanceof BundlerCandidateBlockedError && error.stage === "preview");
  assert.throws(() => workflow.editSource(), (error) => error instanceof BundlerCandidateBlockedError && error.stage === "edit-update");
  assert.throws(() => workflow.build(), (error) => error instanceof BundlerCandidateBlockedError && error.stage === "build");
  assert.throws(() => workflow.restart(), (error) => error instanceof BundlerCandidateBlockedError);
  assert.deepEqual(workflow.stop(), { listenerCount: 0, recovered: true, restartCount: 1 });
}

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
