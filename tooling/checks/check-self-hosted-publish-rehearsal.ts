import assert from "node:assert/strict";
import fs from "node:fs";

const policy = JSON.parse(fs.readFileSync("release/ga/publish-policy.json", "utf8"));
assert.equal(policy.taskId, "REL-005");
assert.equal(policy.sourceToReleaseVerification, true);
assert.equal(policy.immutableReleasePaths, true);
assert.equal(policy.channelConflictPolicy, "reject");
const script = fs.readFileSync("release/ga/rehearse-publish.sh", "utf8");
for (const term of ["verify-supply-chain.sh", "verify-chart-binding.mjs", "verify-release-manifest.mjs", "merge-base --is-ancestor"])
  assert.ok(script.includes(term), `publish rehearsal missing ${term}`);
console.log(JSON.stringify({ status: "pass", task: "REL-005", implementation: true }));
