import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const policy = JSON.parse(fs.readFileSync("release/ga/gate-policy.json", "utf8"));
assert.equal(policy.taskId, "GATE-007");
assert.equal(policy.release, "1.0.0");
assert.equal(policy.passVerdict, "v1-ga-ready");
assert.equal(policy.requiredTasks.length, 21);
for (const report of policy.requiredReports) assert.ok(fs.existsSync(report), `GA report missing: ${report}`);
for (const task of policy.requiredTasks) {
  const evidence = `docs/implementation/self-hosted/evidence/${task}.md`;
  assert.ok(fs.existsSync(evidence), `GA evidence missing: ${task}`);
  assert.match(fs.readFileSync(evidence, "utf8"), /상태: `DONE`/u, `${task} is not DONE`);
}
const reproducibility = JSON.parse(fs.readFileSync("release/ga/reproducible-images.json", "utf8"));
assert.equal(reproducibility.status, "PASS");
assert.equal(reproducibility.images.length, 6);
const qualification = JSON.parse(fs.readFileSync("release/ga/qualification-report.json", "utf8"));
assert.equal(qualification.status, "PASS");
assert.equal(qualification.signedArtifacts, true);
const security = JSON.parse(fs.readFileSync("security/reports/SEC-004.json", "utf8"));
assert.equal(security.status, "PASS");
assert.equal(security.images.reduce((sum, image) => sum + image.critical, 0), 0);
assert.equal(security.images.reduce((sum, image) => sum + image.high, 0), 0);
const manifest = JSON.parse(fs.readFileSync("release/ga/artifacts/nuriteo-1.0.0.release.json", "utf8"));
assert.equal(manifest.release, "1.0.0");
execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceCommit, "HEAD"]);
console.log(JSON.stringify({ status: "pass", gate: "GATE-007", verdict: policy.passVerdict, release: policy.release }));
