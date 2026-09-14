import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredDocs = [
  "docs/release/support-matrix.md",
  "docs/release/known-limitations.md",
  "docs/release/operations.md",
  "docs/release/fingerprint.json",
  "docs/evaluation/node-upgrade.md",
  "docs/evaluation/package-manager-upgrade.md",
  "docs/evaluation/sdk-packaging.md",
  "docs/implementation/evidence/P8-01.md",
  "docs/implementation/evidence/P8-02.md",
  "docs/implementation/evidence/P8-03.md"
];

for (const file of requiredDocs) {
  assert(fs.existsSync(path.resolve(file)), `missing release document: ${file}`);
}

const versions = readJson("compat/versions.json");
const npmManifest = readJson("vendor/manifests/npm.json");
const pnpmManifest = readJson("vendor/manifests/pnpm.json");
const assetManifest = readJson("dist/sdk/package/asset-manifest.json");
const fingerprint = readJson("docs/release/fingerprint.json");
const progress = fs.readFileSync("docs/implementation/PROGRESS.md", "utf8");

assert(versions.runtimeBaseline.node.version === "22.23.0", "unexpected Node baseline");
assert(versions.runtimeBaseline.node.rehearsalCandidate.status === "rehearsed-not-promoted", "Node candidate must not be promoted");
assert(npmManifest.version === "10.9.2", "unexpected npm baseline");
assert(npmManifest.rehearsalCandidate.version === "10.9.8", "unexpected npm candidate");
assert(npmManifest.rollbackArtifact.version === npmManifest.version, "npm rollback artifact mismatch");
assert(pnpmManifest.version === "9.15.9", "unexpected pnpm baseline");
assert(pnpmManifest.rehearsalCandidate.runtimeDecision === "hold-browser-promotion", "pnpm candidate must stay on hold");
assert(pnpmManifest.rollbackArtifact.version === pnpmManifest.version, "pnpm rollback artifact mismatch");
assert(assetManifest.basePath === "/sdk/", "SDK package base path mismatch");
assert(assetManifest.assets.systemWasm.sha256 === sha256("dist/sdk/package/assets/system_wasm.wasm"), "SDK wasm fingerprint mismatch");
assert(fingerprint.sdkPackage.assetManifestSha256 === sha256("dist/sdk/package/asset-manifest.json"), "asset manifest fingerprint mismatch");
assert(fingerprint.releaseDecision.status === "internal-release-ready", "release decision must be internal release ready");
assert(progress.includes("G8: PASS"), "progress must mark G8 PASS");
assert(progress.includes("36 / 36"), "progress must mark all tasks done");

console.log("release readiness manifest ok");
