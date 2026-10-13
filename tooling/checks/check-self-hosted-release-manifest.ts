import assert from "node:assert/strict";
import fs from "node:fs";

const policy = JSON.parse(fs.readFileSync("release/ga/release-manifest-policy.json", "utf8"));
assert.equal(policy.taskId, "REL-004");
assert.equal(policy.release, "1.0.0");
assert.equal(policy.channel, "stable");
assert.equal(policy.immutable, true);
assert.equal(policy.rollback.database, "restore-pre-upgrade-backup-only");
for (const file of ["generate-release-manifest.mjs", "verify-release-manifest.mjs"])
  assert.ok(fs.existsSync(`release/ga/${file}`), `missing REL-004 tool: ${file}`);
console.log(JSON.stringify({ status: "pass", task: "REL-004", implementation: true }));
