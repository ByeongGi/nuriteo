import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

type Baseline = {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  baselineCommit: string;
  recordedAt: string;
  sourceGate: { id: string; status: string; verdict: string; release: string; sourceCommit: string };
  freeze: { state: string; allowedTaskPrefixes: string[]; changePolicy: string };
  rcArtifact: {
    manifestPath: string;
    manifestSha256: string;
    artifactAggregateSha256: string;
    images: Record<string, string>;
  };
  blockers: Record<string, string>;
  artifacts: Array<{ path: string; sha256: string; immutable: boolean }>;
};

const baseline = JSON.parse(fs.readFileSync("compat/self-hosted-ga-baseline.json", "utf8")) as Baseline;
const sha256 = (bytes: Buffer | string): string => crypto.createHash("sha256").update(bytes).digest("hex");
const gitBytes = (revision: string, file: string): Buffer => execFileSync("git", ["show", `${revision}:${file}`]);

assert.equal(baseline.schemaVersion, 1);
assert.equal(baseline.taskId, "GA-001");
assert.equal(baseline.releaseLineage, "nuriteo-self-hosted-v1");
assert.match(baseline.baselineCommit, /^[a-f0-9]{40}$/u);
assert.match(baseline.recordedAt, /^\d{4}-\d{2}-\d{2}$/u);
execFileSync("git", ["merge-base", "--is-ancestor", baseline.baselineCommit, "HEAD"]);

assert.deepEqual(baseline.sourceGate, {
  id: "GATE-006",
  status: "PASS",
  verdict: "self-hosted-v1-rc-ready",
  release: "1.0.0-rc.1",
  sourceCommit: "2989315174536de2bdbe9e3b9b98ed89d9ac4b93",
});
assert.equal(baseline.freeze.state, "release-frozen");
assert.deepEqual(baseline.freeze.allowedTaskPrefixes, ["GA", "OBS", "AUD", "SEC", "REL", "SUP", "QUAL", "GATE"]);
assert.ok(baseline.freeze.changePolicy.length >= 180, "GA change policy is incomplete");
assert.equal(Object.keys(baseline.blockers).length, 7);
assert.ok(Object.values(baseline.blockers).every((value) => value === "must-remain-zero"));

const manifestBytes = fs.readFileSync(baseline.rcArtifact.manifestPath);
assert.equal(sha256(manifestBytes), baseline.rcArtifact.manifestSha256, "RC manifest drifted");
const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
  release: string;
  releaseLineage: string;
  sourceCommit: string;
  artifactAggregateSha256: string;
  images: Array<{ role: string; digest: string }>;
};
assert.equal(manifest.release, baseline.sourceGate.release);
assert.equal(manifest.releaseLineage, baseline.releaseLineage);
assert.equal(manifest.sourceCommit, baseline.sourceGate.sourceCommit);
assert.equal(manifest.artifactAggregateSha256, baseline.rcArtifact.artifactAggregateSha256);
assert.deepEqual(Object.fromEntries(manifest.images.map(({ role, digest }) => [role, digest])), baseline.rcArtifact.images);

const seen = new Set<string>();
for (const artifact of baseline.artifacts) {
  assert.ok(!artifact.path.startsWith("/") && !artifact.path.includes(".."), `unsafe artifact path: ${artifact.path}`);
  assert.ok(!seen.has(artifact.path), `duplicate artifact path: ${artifact.path}`);
  seen.add(artifact.path);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(typeof artifact.immutable, "boolean", `${artifact.path}: immutable policy is missing`);
  assert.equal(sha256(gitBytes(baseline.baselineCommit, artifact.path)), artifact.sha256, `${artifact.path}: frozen bytes drifted`);
  if (artifact.immutable) {
    assert.equal(sha256(fs.readFileSync(artifact.path)), artifact.sha256, `${artifact.path}: immutable working tree drifted`);
  }
}

const gateEvidence = fs.readFileSync("docs/implementation/self-hosted/evidence/GATE-006.md", "utf8");
assert.match(gateEvidence, /상태: `PASS`/u);
assert.ok(gateEvidence.includes(baseline.sourceGate.verdict));
assert.ok(gateEvidence.includes(baseline.sourceGate.sourceCommit));

console.log(JSON.stringify({
  status: "pass",
  task: baseline.taskId,
  release: baseline.sourceGate.release,
  artifacts: baseline.artifacts.length,
  images: Object.keys(baseline.rcArtifact.images).length,
  blockers: Object.keys(baseline.blockers).length,
}));
