import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Artifact = { immutable?: boolean; path: string; sha256: string };

const manifestPath = "compat/self-hosted-rc-baseline.json";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  baselineCommit: string;
  sourceGate: { id: string; status: string; releaseCommit: string; verdict: string };
  recordedAt: string;
  freeze: { state: string; allowedTaskPrefixes: string[]; changePolicy: string };
  contracts: {
    migrationPrefix: { first: number; last: number; count: number; aggregateSha256: string };
    openapi: { specification: string; version: string; compatibility: string };
    bundleFormat: string;
    betaAcceptance: {
      requiredStages: number;
      sameComposeProject: boolean;
      sameDatabaseLineage: boolean;
      secretScan: string;
    };
  };
  images: Array<{ name: string; digest: string }>;
  artifactAggregateSha256: string;
  artifacts: Artifact[];
};

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
const gitBytes = (revision: string, path: string): Buffer => execFileSync("git", ["show", `${revision}:${path}`]);

assert(manifest.schemaVersion === 1, "unexpected RC baseline schema version");
assert(manifest.taskId === "RC-001", "RC baseline must belong to RC-001");
assert(manifest.releaseLineage === "nuriteo-self-hosted-v1", "unexpected release lineage");
assert(/^[0-9a-f]{40}$/u.test(manifest.baselineCommit), "baselineCommit must be a full Git SHA");
assert(/^\d{4}-\d{2}-\d{2}$/u.test(manifest.recordedAt), "recordedAt must use YYYY-MM-DD");
assert(
  manifest.sourceGate.id === "GATE-005"
    && manifest.sourceGate.status === "PASS"
    && manifest.sourceGate.verdict === "self-hosted-beta-ready",
  "Beta gate must be self-hosted-beta-ready"
);
assert(/^[0-9a-f]{40}$/u.test(manifest.sourceGate.releaseCommit), "source release commit must be full SHA");
assert(manifest.freeze.state === "feature-frozen", "RC baseline must be feature frozen");
assert(manifest.freeze.changePolicy.length >= 80, "feature-freeze change policy is incomplete");
assert(
  JSON.stringify(manifest.freeze.allowedTaskPrefixes) === JSON.stringify(["BKP", "MNT", "UPG", "K8S", "AIR", "LEG", "RC", "GATE"]),
  "RC change lanes drifted"
);

for (const revision of [manifest.sourceGate.releaseCommit, manifest.baselineCommit]) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", revision, "HEAD"], { stdio: "ignore" });
  } catch {
    throw new Error(`current HEAD must descend from ${revision}`);
  }
}
try {
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceGate.releaseCommit, manifest.baselineCommit], {
    stdio: "ignore"
  });
} catch {
  throw new Error("RC documentation baseline must descend from the GATE-005 release commit");
}

const migration = manifest.contracts.migrationPrefix;
assert(migration.first === 1 && migration.last === 46 && migration.count === 46, "RC migration prefix must be 1..46");
const migrationPaths = git("ls-tree", "-r", "--name-only", manifest.baselineCommit, "--", "crates/nuriteo-server/migrations")
  .split("\n")
  .filter((path) => /\/\d{4}_.+\.sql$/u.test(path))
  .sort();
assert(migrationPaths.length === migration.count, "frozen migration count drifted");
const migrationEntries: string[] = [];
for (let version = migration.first; version <= migration.last; version += 1) {
  const prefix = version.toString().padStart(4, "0");
  const matches = migrationPaths.filter((path) => path.includes(`/migrations/${prefix}_`));
  assert(matches.length === 1, `migration ${prefix} must appear exactly once`);
  const path = matches[0];
  const frozen = gitBytes(manifest.baselineCommit, path);
  assert(fs.existsSync(path), `${path}: frozen migration removed`);
  assert(sha256(fs.readFileSync(path)) === sha256(frozen), `${path}: frozen migration bytes changed`);
  migrationEntries.push(`${path}\0${sha256(frozen)}`);
}
assert(sha256(migrationEntries.join("\n")) === migration.aggregateSha256, "migration aggregate fingerprint mismatch");

assert(manifest.contracts.openapi.specification === "3.1.0", "unexpected OpenAPI specification");
assert(manifest.contracts.openapi.version === "1.0.0", "unexpected public API version");
assert(manifest.contracts.openapi.compatibility === "additive-within-v1", "unexpected API compatibility policy");
assert(manifest.contracts.bundleFormat === "project-bundle-v1", "unexpected Bundle format");
assert(
  manifest.contracts.betaAcceptance.requiredStages === 18
    && manifest.contracts.betaAcceptance.sameComposeProject
    && manifest.contracts.betaAcceptance.sameDatabaseLineage
    && manifest.contracts.betaAcceptance.secretScan === "PASS",
  "Beta acceptance contract is incomplete"
);

const artifactPaths = new Set<string>();
const artifactEntries: string[] = [];
for (const artifact of manifest.artifacts) {
  assert(!artifact.path.startsWith("/") && !artifact.path.includes(".."), `unsafe artifact path: ${artifact.path}`);
  assert(!artifactPaths.has(artifact.path), `duplicate artifact path: ${artifact.path}`);
  assert(/^[0-9a-f]{64}$/u.test(artifact.sha256), `${artifact.path}: invalid SHA-256`);
  artifactPaths.add(artifact.path);
  const frozen = gitBytes(manifest.baselineCommit, artifact.path);
  assert(sha256(frozen) === artifact.sha256, `${artifact.path}: baseline fingerprint mismatch`);
  artifactEntries.push(`${artifact.path}\0${artifact.sha256}`);
  if (artifact.immutable) {
    assert(fs.existsSync(artifact.path), `${artifact.path}: immutable contract removed`);
    assert(sha256(fs.readFileSync(artifact.path)) === artifact.sha256, `${artifact.path}: immutable contract drift`);
  }
}
assert(sha256(artifactEntries.join("\n")) === manifest.artifactAggregateSha256, "artifact aggregate fingerprint mismatch");

const openapi = JSON.parse(
  gitBytes(manifest.baselineCommit, "crates/nuriteo-server/tests/fixtures/openapi-v1.json").toString("utf8")
) as { openapi?: string; info?: { version?: string } };
assert(openapi.openapi === manifest.contracts.openapi.specification, "OpenAPI snapshot specification drift");
assert(openapi.info?.version === manifest.contracts.openapi.version, "OpenAPI snapshot version drift");
const bundle = JSON.parse(fs.readFileSync("compat/project-bundle-admission-v1.json", "utf8")) as {
  bundleFormat?: string;
};
assert(bundle.bundleFormat === manifest.contracts.bundleFormat, "Bundle contract name drift");

assert(manifest.images.length === 3, "exactly three Beta release images are required");
assert(
  JSON.stringify(manifest.images.map(({ name }) => name).sort()) === JSON.stringify(["postgres", "server", "web"]),
  "Beta release image set drifted"
);
for (const image of manifest.images) {
  assert(/^sha256:[0-9a-f]{64}$/u.test(image.digest), `${image.name}: invalid release image digest`);
}

const gateEvidence = gitBytes(manifest.baselineCommit, "docs/implementation/self-hosted/evidence/GATE-005.md")
  .toString("utf8");
assert(gateEvidence.includes("- 상태: `PASS`"), "frozen GATE-005 evidence is not PASS");
assert(gateEvidence.includes(manifest.sourceGate.releaseCommit), "GATE-005 evidence release commit drifted");
assert(gateEvidence.includes(manifest.sourceGate.verdict), "GATE-005 verdict drifted");

console.log(
  `self-hosted RC baseline ok (${migration.count} migrations, ${manifest.artifacts.length} artifacts, `
  + `${manifest.images.length} images, ${manifest.contracts.bundleFormat}, feature-frozen)`
);
