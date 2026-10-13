import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const relativeManifest = "compat/self-hosted-legacy-replacement.json";

type Replacement = {
  id: string;
  source: string;
  target: string;
  secondaryTarget?: string;
  generatedTarget?: string;
  testFixtureTarget?: string;
  state: "removed" | "renamed" | "relocated" | "cleaned";
  behavior: string[];
  evidence: string[];
  nextAction: string;
  nextTask: "LEG-002" | "LEG-003";
};

type Inventory = {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  baselineManifest: string;
  recordedAt: string;
  migrationCompletedAt: string;
  cleanupCompletedAt: string;
  policy: {
    productionSurfaces: string[];
    targetRuntimePackage: string;
    removalTask: string;
    cleanupTask: string;
  };
  replacements: Replacement[];
};

function resolveRepositoryPath(relativePath: string): string {
  assert(!path.isAbsolute(relativePath), `absolute repository path is forbidden: ${relativePath}`);
  const resolved = path.resolve(repositoryRoot, relativePath);
  assert(resolved.startsWith(`${repositoryRoot}${path.sep}`), `repository path escapes root: ${relativePath}`);
  return resolved;
}

function assertExisting(relativePath: string, label: string): void {
  assert(fs.existsSync(resolveRepositoryPath(relativePath)), `${label} does not exist: ${relativePath}`);
}

const inventory = JSON.parse(
  fs.readFileSync(resolveRepositoryPath(relativeManifest), "utf8")
) as Inventory;

assert.equal(inventory.schemaVersion, 1);
assert.equal(inventory.taskId, "LEG-001");
assert.equal(inventory.releaseLineage, "nuriteo-self-hosted-v1");
assert.match(inventory.recordedAt, /^\d{4}-\d{2}-\d{2}$/u);
assert.equal(inventory.migrationCompletedAt, "2026-10-11");
assert.equal(inventory.cleanupCompletedAt, "2026-10-11");
assert.equal(inventory.baselineManifest, "compat/self-hosted-rc-baseline.json");
assertExisting(inventory.baselineManifest, "RC baseline manifest");

assert.deepEqual(
  inventory.policy.productionSurfaces,
  ["apps/web", "crates/nuriteo-server", "packages/api-client"]
);
assert.equal(inventory.policy.targetRuntimePackage, "packages/workspace-runtime");
assert.equal(inventory.policy.removalTask, "LEG-002");
assert.equal(inventory.policy.cleanupTask, "LEG-003");

const requiredIds = [
  "legacy-node-backend",
  "legacy-root-commands",
  "legacy-web-app",
  "runtime-lab",
  "runtime-static-assets",
  "runtime-workflow-package"
];
assert.deepEqual(inventory.replacements.map(({ id }) => id).sort(), requiredIds);

const sources = new Set<string>();
for (const replacement of inventory.replacements) {
  assert(!sources.has(replacement.source), `duplicate legacy source: ${replacement.source}`);
  sources.add(replacement.source);
  assert(replacement.behavior.length > 0, `${replacement.id} must list replacement behavior`);
  assert(replacement.evidence.length >= 1, `${replacement.id} must have evidence`);
  for (const evidence of replacement.evidence) assertExisting(evidence, `${replacement.id} evidence`);
  assert.match(replacement.nextAction, /^[a-z][a-z-]+$/u, `${replacement.id} next action is invalid`);

  if (replacement.nextTask === "LEG-002") {
    assert.equal(fs.existsSync(resolveRepositoryPath(replacement.source)), false, `${replacement.id} legacy source must be removed`);
    assertExisting(replacement.target, `${replacement.id} replacement target`);
  } else {
    assert.equal(replacement.state, "cleaned");
    assertExisting(replacement.target, `${replacement.id} replacement target`);
  }
  if (replacement.secondaryTarget) assertExisting(replacement.secondaryTarget, `${replacement.id} secondary target`);
  if (replacement.generatedTarget) assertExisting(replacement.generatedTarget, `${replacement.id} generated target`);
  if (replacement.testFixtureTarget) assertExisting(replacement.testFixtureTarget, `${replacement.id} test fixture target`);
}

const gate004 = fs.readFileSync(resolveRepositoryPath("docs/implementation/self-hosted/evidence/GATE-004.md"), "utf8");
const gate005 = fs.readFileSync(resolveRepositoryPath("docs/implementation/self-hosted/evidence/GATE-005.md"), "utf8");
assert.match(gate004, /상태: `PASS`/u, "GATE-004 replacement evidence must be PASS");
assert.match(gate005, /상태: `PASS`/u, "GATE-005 replacement evidence must be PASS");

const webManifest = JSON.parse(fs.readFileSync(resolveRepositoryPath("apps/web/package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
assert.equal(webManifest.dependencies?.["@nuriteo/service-backend"], undefined);
assert.equal(webManifest.dependencies?.["@nuriteo/workspace-runtime"], "workspace:*");

const assetBuilder = fs.readFileSync(resolveRepositoryPath("apps/web/tooling/build-runtime-assets.ts"), "utf8");
assert.match(assetBuilder, /packages\/workspace-runtime\/assets/u, "asset builder must use relocated Runtime assets");
assert.doesNotMatch(assetBuilder, /apps\/preview-service/u);

console.log(
  `self-hosted legacy replacement inventory ok (${inventory.replacements.length} paths, `
  + `${inventory.replacements.filter(({ state }) => state !== "cleaned").length} source migrations and `
  + `${inventory.replacements.filter(({ state }) => state === "cleaned").length} cleanups complete)`
);
