import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const policy = JSON.parse(fs.readFileSync("release/ga/qualification-policy.json", "utf8"));
assert.equal(policy.taskId, "QUAL-004");
assert.equal(policy.cleanEnvironment, true);
assert.equal(policy.signedArtifactsOnly, true);
assert.deepEqual(policy.requiredPhases, ["verify", "install", "beta-journey", "backup", "upgrade", "restore", "helm"]);
const script = fs.readFileSync("release/ga/qualify.sh", "utf8");
for (const term of ["verify-supply-chain.sh", "test-compose.sh", "backup-restore/run.sh", "run-upgrade-rehearsal.sh", "kind-release.sh", "@sha256:"])
  assert.ok(script.includes(term), `GA qualification missing ${term}`);
if (fs.existsSync(policy.report)) {
  const report = JSON.parse(fs.readFileSync(policy.report, "utf8"));
  assert.equal(report.status, "PASS");
  assert.equal(report.signedArtifacts, true);
  assert.equal(report.cleanEnvironment, true);
  for (const phase of Object.values(report.phases)) assert.equal(phase, true);
  execFileSync("git", ["merge-base", "--is-ancestor", report.sourceCommit, "HEAD"]);
}
console.log(JSON.stringify({ status: "pass", task: "QUAL-004", evidence: fs.existsSync(policy.report) }));
