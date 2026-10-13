import assert from "node:assert/strict";
import fs from "node:fs";

type Result = { id: string; status: string; iterations: number; threshold: string; evidence: string };
const baseline = JSON.parse(fs.readFileSync("compat/self-hosted-v1-reliability-baseline.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  measuredAt: string;
  status: string;
  results: Result[];
  resourceContract: {
    workspaceAdmissionBytes: number;
    workspaceStorageBytes: number;
    wasmMaximumPages: number;
    browserWorkerHeapHardCap: string;
    pageMemory: string;
  };
  releaseBlockers: string[];
};
const resources = JSON.parse(fs.readFileSync("compat/browser-worker-resource-results.json", "utf8")) as {
  date: string;
  status: string;
  iterations: number;
  successfulBoots: number;
  forcedBootFailuresAndRecoveries: number;
  workerTargetsBefore: number;
  workerTargetsAfter: number;
};
const soak = JSON.parse(fs.readFileSync("compat/soak-baseline.json", "utf8")) as { requiredIterations: number };
const documentation = fs.readFileSync("docs/operations/self-hosted-v1-reliability-baseline.md", "utf8");

assert.equal(baseline.schemaVersion, 1);
assert.equal(baseline.taskId, "QUAL-002");
assert.equal(baseline.status, "pass");
assert.deepEqual(baseline.results.map(({ id }) => id), [
  "browser-runtime-soak", "browser-worker-resource-churn", "browser-watchdog-recovery",
  "large-node-modules", "offline-workflow", "otlp-outage-and-shutdown", "production-server-lifecycle"
]);
for (const result of baseline.results) {
  assert.equal(result.status, "pass", `${result.id}: required result did not pass`);
  assert.ok(result.iterations >= 1, `${result.id}: iteration count missing`);
  assert.ok(result.threshold.length >= 40, `${result.id}: threshold is incomplete`);
  assert.ok(fs.existsSync(result.evidence), `${result.id}: evidence is missing`);
  assert.ok(documentation.includes(`| \`${result.id}\` |`), `${result.id}: documentation row missing`);
}
assert.equal(baseline.results[0]?.iterations, soak.requiredIterations);
assert.equal(resources.date, baseline.measuredAt);
assert.equal(resources.status, "pass-with-product-resource-contract");
assert.equal(resources.successfulBoots, resources.iterations);
assert.ok(resources.forcedBootFailuresAndRecoveries >= 3);
assert.equal(resources.workerTargetsAfter, resources.workerTargetsBefore);
assert.equal(baseline.resourceContract.workspaceAdmissionBytes, 256 * 1024 * 1024);
assert.equal(baseline.resourceContract.workspaceStorageBytes, 256 * 1024 * 1024);
assert.equal(baseline.resourceContract.wasmMaximumPages, 32_768);
assert.equal(baseline.resourceContract.browserWorkerHeapHardCap, "unavailable-not-claimed");
assert.equal(baseline.resourceContract.pageMemory, "observational-only-no-regression-threshold");
assert.equal(baseline.releaseBlockers.length, 4);

console.log(JSON.stringify({ status: "pass", task: baseline.taskId, results: baseline.results.length, soakIterations: soak.requiredIterations }));
