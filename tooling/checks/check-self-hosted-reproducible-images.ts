import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const policy = JSON.parse(fs.readFileSync("release/ga/reproducible-images-policy.json", "utf8")) as {
  schemaVersion: number; taskId: string; version: string; platforms: string[]; roles: string[];
  cleanPasses: number; cacheAllowed: boolean; timestampSource: string; requiredLabels: string[];
  report: string;
};
assert.equal(policy.schemaVersion, 1);
assert.equal(policy.taskId, "REL-001");
assert.deepEqual(policy.platforms, ["linux/amd64", "linux/arm64"]);
assert.deepEqual(policy.roles, ["server", "web", "operations"]);
assert.equal(policy.cleanPasses, 2);
assert.equal(policy.cacheAllowed, false);
assert.equal(policy.timestampSource, "source-commit");

const script = fs.readFileSync("release/ga/reproducible-images.sh", "utf8");
for (const term of ["--no-cache", "--layers=false", "--platform", "--timestamp",
  "SOURCE_DATE_EPOCH", "skopeo inspect", 'test "${digests[0]}" = "${digests[1]}"'])
  assert.ok(script.includes(term), `reproducible build script missing ${term}`);

for (const role of policy.roles) {
  const dockerfile = fs.readFileSync(`deploy/docker/${role}.Dockerfile`, "utf8");
  for (const label of policy.requiredLabels)
    assert.ok(dockerfile.includes(label), `${role} image label missing ${label}`);
  assert.ok(dockerfile.includes("NURITEO_SOURCE_DATE_EPOCH"), `${role} epoch input missing`);
}
const merger = fs.readFileSync("release/ga/merge-reproducible-images.mjs", "utf8");
for (const term of ["duplicate reproducibility result", "missing reproducibility result", "sourceCommit"])
  assert.ok(merger.includes(term), `reproducibility merger missing ${term}`);
const workflow = fs.readFileSync(".github/workflows/ga-reproducible-images.yml", "utf8");
for (const term of ["ubuntu-24.04", "ubuntu-24.04-arm", "merge-reproducible-images.mjs"])
  assert.ok(workflow.includes(term), `native reproducibility workflow missing ${term}`);
const next = fs.readFileSync("apps/web/next.config.ts", "utf8");
assert.ok(next.includes("generateBuildId"));
assert.ok(next.includes("NURITEO_BUILD_REVISION"));
const nextCanonicalizer = fs.readFileSync("apps/web/tooling/canonicalize-next-output.mjs", "utf8");
for (const term of ["previewModeId", "previewModeSigningKey", "previewModeEncryptionKey",
  "server-reference-manifest.json", "NURITEO_BUILD_REVISION"])
  assert.ok(nextCanonicalizer.includes(term), `Next.js reproducibility normalization missing ${term}`);

if (fs.existsSync(policy.report)) {
  const report = JSON.parse(fs.readFileSync(policy.report, "utf8")) as {
    status: string; sourceCommit: string; images: Array<{ role: string; platform: string;
      digest: string; passes: number }>;
  };
  assert.equal(report.status, "PASS");
  execFileSync("git", ["merge-base", "--is-ancestor", report.sourceCommit, "HEAD"]);
  assert.equal(report.images.length, policy.roles.length * policy.platforms.length);
  for (const role of policy.roles) for (const platform of policy.platforms) {
    const image = report.images.find((candidate) => candidate.role === role && candidate.platform === platform);
    assert.ok(image, `${role}/${platform} result missing`);
    assert.match(image.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(image.passes, policy.cleanPasses);
  }
}

console.log(JSON.stringify({ status: "pass", task: policy.taskId,
  platforms: policy.platforms.length, roles: policy.roles.length,
  evidence: fs.existsSync(policy.report) }));
