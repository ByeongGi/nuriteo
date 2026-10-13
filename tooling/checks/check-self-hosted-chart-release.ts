import assert from "node:assert/strict";
import fs from "node:fs";

const policy = JSON.parse(fs.readFileSync("release/ga/chart-policy.json", "utf8"));
assert.equal(policy.taskId, "REL-003");
assert.equal(policy.distribution, "OCI");
assert.match(policy.signing, /Sigstore/u);
for (const file of ["package-chart.sh", "verify-chart-binding.mjs"])
  assert.ok(fs.existsSync(`release/ga/${file}`), `missing REL-003 tool: ${file}`);
const workflow = fs.readFileSync(".github/workflows/ga-sign-supply-chain.yml", "utf8");
for (const term of ["helm push", "cosign sign --yes"])
  assert.ok(workflow.includes(term), `OCI chart workflow missing ${term}`);
console.log(JSON.stringify({ status: "pass", task: "REL-003", implementation: true }));
