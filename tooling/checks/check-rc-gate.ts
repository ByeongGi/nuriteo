import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(".");
const manifestPath = path.join(root, "release/rc/1.0.0-rc.1.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  schemaVersion: number;
  releaseLineage: string;
  release: string;
  sourceCommit: string;
  images: Array<{ role: string; reference: string; digest: string; localDigest: string; user: string; entrypoint: string[] }>;
  artifactAggregateSha256: string;
  artifacts: Array<{ path: string; sha256: string }>;
  qualifications: string[];
};

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.releaseLineage, "nuriteo-self-hosted-v1");
assert.equal(manifest.release, "1.0.0-rc.1");
assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/u);
assert.deepEqual(manifest.images.map(({ role }) => role), ["server", "web", "operations"]);
assert.equal(new Set(manifest.images.map(({ digest }) => digest)).size, 3);
for (const image of manifest.images) {
  assert.match(image.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(image.localDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(image.user, "65532:65532");
  assert.ok(image.reference.endsWith(`:${manifest.release}`));
}

for (const artifact of manifest.artifacts) {
  const absolute = path.join(root, artifact.path);
  assert.equal(sha256(fs.readFileSync(absolute)), artifact.sha256, `RC artifact drift: ${artifact.path}`);
}
const aggregate = manifest.artifacts.map(({ path: artifactPath, sha256: artifactHash }) =>
  `${artifactPath}\0${artifactHash}\n`).join("");
assert.equal(sha256(aggregate), manifest.artifactAggregateSha256, "RC artifact aggregate drift");

assert.deepEqual(manifest.qualifications, ["RC-002", "RC-003", "RC-004", "RC-005"]);
for (const task of manifest.qualifications) {
  const evidence = fs.readFileSync(path.join(root, `docs/implementation/self-hosted/evidence/${task}.md`), "utf8");
  assert.match(evidence, /상태: `DONE`/u, `${task} evidence is not DONE`);
}
const betaGate = fs.readFileSync(path.join(root, "docs/implementation/self-hosted/evidence/GATE-005.md"), "utf8");
assert.match(betaGate, /상태: `PASS`/u);

const compatibility = JSON.parse(fs.readFileSync(path.join(root, "compat/self-hosted-upgrade-compatibility-v1.json"), "utf8"));
assert.equal(compatibility.releaseLineage, manifest.releaseLineage);
assert.equal(compatibility.support.upgradeTo, "self-hosted-v1-rc-lineage");

const byRole = new Map(manifest.images.map((image) => [image.role, image]));
const render = spawnSync("helm", [
  "template", "nuriteo", "charts/nuriteo",
  "--set-string", "global.imageRegistry=registry.internal:5443/nuriteo",
  "--set-string", "images.server.repository=server",
  "--set-string", `images.server.digest=${byRole.get("server")?.digest}`,
  "--set-string", "images.web.repository=web",
  "--set-string", `images.web.digest=${byRole.get("web")?.digest}`,
  "--set-string", "images.operations.repository=operations",
  "--set-string", `images.operations.digest=${byRole.get("operations")?.digest}`,
  "--set", "toolbox.enabled=true",
  "--set", "networkPolicy.enabled=true",
  "--set-string", "networkPolicy.externalEgress.cidrBlocks[0]=10.40.12.0/24",
], { cwd: root, encoding: "utf8" });
assert.equal(render.status, 0, render.stderr);
for (const image of manifest.images) {
  assert.match(render.stdout, new RegExp(`registry\\.internal:5443/nuriteo/${image.role}@${image.digest}`, "u"));
}
assert.equal((render.stdout.match(/^kind: NetworkPolicy$/gmu) ?? []).length, 4);
assert.doesNotMatch(render.stdout, /(?:docker\.io|ghcr\.io|quay\.io|registry\.k8s\.io)/u);

console.log(JSON.stringify({
  status: "pass",
  gate: "GATE-006",
  release: manifest.release,
  sourceCommit: manifest.sourceCommit,
  artifactAggregateSha256: manifest.artifactAggregateSha256,
  images: Object.fromEntries(manifest.images.map(({ role, digest }) => [role, digest])),
  qualifications: manifest.qualifications,
}));
