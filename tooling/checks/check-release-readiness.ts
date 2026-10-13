import fs from "node:fs";
import path from "node:path";
import { assert, verifyReleaseArtifacts } from "../shared/release-fingerprint.ts";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const requiredDocs = [
  "docs/release/support-matrix.md",
  "docs/release/known-limitations.md",
  "docs/release/operations.md",
  "docs/release/fingerprint.json",
  "docs/evaluation/node-upgrade.md",
  "docs/evaluation/package-manager-upgrade.md",
  "docs/evaluation/sdk-packaging.md",
  "docs/archive/implementation-2026-09-15/evidence/P8-01.md",
  "docs/archive/implementation-2026-09-15/evidence/P8-02.md",
  "docs/archive/implementation-2026-09-15/evidence/P8-03.md"
];

for (const file of requiredDocs) {
  assert(fs.existsSync(path.resolve(file)), `missing release document: ${file}`);
}

const versions = readJson("compat/versions.json");
const npmManifest = readJson("vendor/manifests/npm.json");
const pnpmManifest = readJson("vendor/manifests/pnpm.json");
const progress = fs.readFileSync("docs/archive/implementation-2026-09-15/PROGRESS.md", "utf8");
const operations = fs.readFileSync("docs/release/operations.md", "utf8");

assert(versions.runtimeBaseline.node.version === "22.23.0", "unexpected Node baseline");
assert(versions.runtimeBaseline.node.rehearsalCandidate.status === "rehearsed-not-promoted", "Node candidate must not be promoted");
assert(npmManifest.version === "10.9.2", "unexpected npm baseline");
assert(npmManifest.rehearsalCandidate.version === "10.9.8", "unexpected npm candidate");
assert(npmManifest.rollbackArtifact.version === npmManifest.version, "npm rollback artifact mismatch");
assert(pnpmManifest.version === "9.15.9", "unexpected pnpm baseline");
assert(pnpmManifest.rehearsalCandidate.runtimeDecision === "hold-browser-promotion", "pnpm candidate must stay on hold");
assert(pnpmManifest.rollbackArtifact.version === pnpmManifest.version, "pnpm rollback artifact mismatch");
assert(progress.includes("G8: PASS"), "progress must mark G8 PASS");
assert(progress.includes("36 / 36"), "progress must mark all tasks done");
assert(operations.includes("Fingerprint Recovery"), "operations doc must include fingerprint recovery");
assert(operations.includes("--write-fingerprint"), "operations doc must include fingerprint rewrite command");

const { fingerprint } = verifyReleaseArtifacts();

console.log(
  `release readiness manifest ok node=${versions.runtimeBaseline.node.version} basePath=${fingerprint.sdkPackage.basePath} tarball=${fingerprint.sdkPackage.tarballSha256.slice(0, 12)}…`
);
