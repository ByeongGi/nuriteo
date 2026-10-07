import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Artifact = { path: string; sha256: string };
type ArtifactGroup = { aggregateSha256: string; artifacts: Artifact[] };

const manifestPath = "compat/self-hosted-beta-baseline.json";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  baselineCommit: string;
  sourceGate: { id: string; status: string; implementationCommit: string };
  recordedAt: string;
  contracts: {
    migrationPrefix: { first: number; last: number };
    openapi: { specification: string; version: string };
    bundleFormat: string;
    acceptanceJourney: string;
  };
  groups: Record<string, ArtifactGroup>;
};

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
const gitBytes = (revision: string, path: string): Buffer => execFileSync("git", ["show", `${revision}:${path}`]);

assert(manifest.schemaVersion === 1, "unexpected Beta baseline schema version");
assert(manifest.taskId === "BETA-001", "Beta baseline must belong to BETA-001");
assert(manifest.releaseLineage === "nuriteo-self-hosted-v1", "unexpected release lineage");
assert(/^[0-9a-f]{40}$/u.test(manifest.baselineCommit), "baselineCommit must be a full Git SHA");
assert(/^\d{4}-\d{2}-\d{2}$/u.test(manifest.recordedAt), "recordedAt must use YYYY-MM-DD");
assert(manifest.sourceGate.id === "GATE-004" && manifest.sourceGate.status === "PASS", "Alpha gate must be PASS");
assert(manifest.contracts.migrationPrefix.first === 1, "migration prefix must start at 1");
assert(manifest.contracts.migrationPrefix.last === 21, "Alpha migration prefix must end at 21");
assert(manifest.contracts.openapi.specification === "3.1.0", "unexpected OpenAPI specification");
assert(manifest.contracts.openapi.version === "1.0.0", "unexpected public API version");
assert(manifest.contracts.bundleFormat === "project-bundle-v1", "unexpected Bundle format");
assert(manifest.contracts.acceptanceJourney === "A1-A9", "unexpected Alpha acceptance journey");

try {
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.baselineCommit, "HEAD"], { stdio: "ignore" });
} catch {
  throw new Error("current HEAD must descend from the frozen Alpha/Beta baseline commit");
}

const expectedGroups = ["migrations", "api", "bundle", "images", "acceptance"];
assert(
  JSON.stringify(Object.keys(manifest.groups).sort()) === JSON.stringify([...expectedGroups].sort()),
  "Beta baseline artifact groups are incomplete"
);

const allPaths = new Set<string>();
for (const groupName of expectedGroups) {
  const group = manifest.groups[groupName];
  assert(group && Array.isArray(group.artifacts) && group.artifacts.length > 0, `${groupName}: artifacts are required`);
  const canonicalEntries: string[] = [];

  for (const artifact of group.artifacts) {
    assert(!artifact.path.startsWith("/") && !artifact.path.includes(".."), `${groupName}: unsafe path ${artifact.path}`);
    assert(!allPaths.has(artifact.path), `artifact appears in multiple groups: ${artifact.path}`);
    assert(/^[0-9a-f]{64}$/u.test(artifact.sha256), `${artifact.path}: invalid SHA-256`);
    allPaths.add(artifact.path);

    const baselineBytes = gitBytes(manifest.baselineCommit, artifact.path);
    assert(sha256(baselineBytes) === artifact.sha256, `${artifact.path}: baseline Git object fingerprint mismatch`);
    canonicalEntries.push(`${artifact.path}\0${artifact.sha256}`);

    if (groupName === "migrations" || groupName === "bundle") {
      assert(fs.existsSync(artifact.path), `${artifact.path}: immutable contract removed from working tree`);
      assert(sha256(fs.readFileSync(artifact.path)) === artifact.sha256, `${artifact.path}: immutable contract drift`);
    }
  }

  assert(
    sha256(canonicalEntries.join("\n")) === group.aggregateSha256,
    `${groupName}: aggregate fingerprint mismatch`
  );
}

const migrationPaths = manifest.groups.migrations.artifacts.map(({ path }) => path);
for (let version = manifest.contracts.migrationPrefix.first; version <= manifest.contracts.migrationPrefix.last; version += 1) {
  const prefix = version.toString().padStart(4, "0");
  assert(
    migrationPaths.filter((path) => path.includes(`/migrations/${prefix}_`)).length === 1,
    `migration ${prefix} must appear exactly once in the frozen prefix`
  );
}

const openapiArtifact = manifest.groups.api.artifacts[0];
const openapi = JSON.parse(gitBytes(manifest.baselineCommit, openapiArtifact.path).toString("utf8")) as {
  openapi?: string;
  info?: { version?: string };
};
assert(openapi.openapi === manifest.contracts.openapi.specification, "OpenAPI snapshot specification drift");
assert(openapi.info?.version === manifest.contracts.openapi.version, "OpenAPI snapshot version drift");

const bundleArtifact = manifest.groups.bundle.artifacts[0];
const bundle = JSON.parse(fs.readFileSync(bundleArtifact.path, "utf8")) as { bundleFormat?: string };
assert(bundle.bundleFormat === manifest.contracts.bundleFormat, "Bundle contract name drift");

const gateEvidencePath = "docs/implementation/self-hosted/evidence/GATE-004.md";
const gateEvidence = gitBytes(manifest.baselineCommit, gateEvidencePath).toString("utf8");
assert(gateEvidence.includes("- 상태: `PASS`"), "frozen GATE-004 evidence is not PASS");
assert(gateEvidence.includes("A1~A9"), "frozen GATE-004 evidence does not cover A1-A9");
assert(
  git("rev-parse", `${manifest.sourceGate.implementationCommit}^{commit}`).length === 40,
  "Alpha implementation commit cannot be resolved"
);

console.log(
  `self-hosted Beta baseline ok (${allPaths.size} artifacts, migrations 1..${manifest.contracts.migrationPrefix.last}, ${manifest.contracts.bundleFormat}, ${manifest.contracts.acceptanceJourney})`
);
