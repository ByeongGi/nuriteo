import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  readJson,
  sha256File,
  verifyReleaseArtifacts
} from "../shared/release-fingerprint.ts";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: "pipe" });
  assert(result.status === 0, `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

const policy = readJson("compat/release-provenance.json");
const npmManifest = readJson("vendor/manifests/npm.json");
const pnpmManifest = readJson("vendor/manifests/pnpm.json");
const packageJson = readJson("package.json");
const workflow = fs.readFileSync(".github/workflows/release-provenance.yml", "utf8");
const sourceCommit = git(["rev-parse", "HEAD"]);

assert(policy.schemaVersion === 1, "unexpected release provenance schema");
assert(/^[0-9a-f]{40}$/.test(sourceCommit), "source commit must be a full git sha");
for (const artifact of policy.requiredArtifacts) {
  assert(fs.existsSync(path.resolve(artifact)), `missing release artifact: ${artifact}`);
  assert(/^[0-9a-f]{64}$/.test(sha256File(artifact)), `invalid artifact hash: ${artifact}`);
}

const { fingerprint } = verifyReleaseArtifacts();

const components = new Map(policy.sbom.requiredComponents.map((component) => [component.name, component]));
assert(components.get("npm")?.version === npmManifest.version, "npm SBOM version mismatch");
assert(components.get("npm")?.license === npmManifest.license, "npm SBOM license mismatch");
assert(components.get("pnpm")?.version === pnpmManifest.version, "pnpm SBOM version mismatch");
assert(components.get("pnpm")?.license === pnpmManifest.license, "pnpm SBOM license mismatch");
assert(packageJson.dependencies.fflate === "^0.8.3", "fflate dependency drift");
assert(packageJson.devDependencies.typescript === "6.0.3", "typescript dependency drift");

for (const command of policy.ci.requiredCommands) {
  assert(workflow.includes(command), `release provenance workflow missing command: ${command}`);
}
assert(policy.signing.stable.includes("sigstore"), "stable signing policy must require sigstore or equivalent");

console.log(`release provenance ok ${sourceCommit} basePath=${fingerprint.sdkPackage.basePath}`);
