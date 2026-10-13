import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const policy = JSON.parse(fs.readFileSync("release/ga/supply-chain-policy.json", "utf8"));
assert.equal(policy.taskId, "REL-002");
assert.equal(policy.formats.sbom, "SPDX-2.3");
assert.match(policy.formats.provenance, /SLSA/u);
assert.equal(policy.signing.privateKeysInRepository, false);
for (const file of ["generate-supply-chain.mjs", "sign-checksums.sh", "verify-supply-chain.sh", "rehearse-signing.sh"])
  assert.ok(fs.existsSync(`release/ga/${file}`), `missing REL-002 tool: ${file}`);
const generator = fs.readFileSync("release/ga/generate-supply-chain.mjs", "utf8");
for (const term of ["SPDX-2.3", "in-toto.io/Statement/v1", "slsa.dev/provenance/v1", "sourceCommit"])
  assert.ok(generator.includes(term), `supply-chain generator missing ${term}`);
const workflow = fs.readFileSync(".github/workflows/ga-sign-supply-chain.yml", "utf8");
for (const term of ["id-token: write", "cosign sign --yes", "cosign verify", "@sha256:"])
  assert.ok(workflow.includes(term), `keyless signing workflow missing ${term}`);
execFileSync("release/ga/rehearse-signing.sh", { stdio: "inherit" });
console.log(JSON.stringify({ status: "pass", task: "REL-002", implementation: true }));
