import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

type Policy = {
  schemaVersion: number; taskId: string;
  scanner: { name: string; version: string; image: string };
  scanners: string[]; severities: string[];
  maximumFindings: { high: number; critical: number; secrets: number };
  requiredImages: string[]; requiredInputs: string[]; report: string; revalidation: string;
};
type Report = {
  schemaVersion: number; taskId: string; status: string; scannedAt: string; sourceCommit: string;
  scanner: Policy["scanner"];
  images: Array<{ role: string; reference: string; digest: string; os: string; user: string;
    high: number; critical: number; secrets: number; runtimeSmoke: string }>;
};

const policy = JSON.parse(fs.readFileSync("security/image-release-policy.json", "utf8")) as Policy;
const report = JSON.parse(fs.readFileSync(policy.report, "utf8")) as Report;

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.taskId, "SEC-004");
assert.equal(policy.scanner.name, "trivy");
assert.match(policy.scanner.image, /@sha256:[0-9a-f]{64}$/u);
assert.deepEqual(policy.scanners, ["vuln", "secret"]);
assert.deepEqual(policy.severities, ["HIGH", "CRITICAL"]);
assert.deepEqual(policy.maximumFindings, { high: 0, critical: 0, secrets: 0 });
assert.ok(policy.revalidation.length >= 150);
for (const input of policy.requiredInputs) assert.ok(fs.existsSync(input), `security input missing: ${input}`);

assert.equal(report.schemaVersion, 1);
assert.equal(report.taskId, policy.taskId);
assert.equal(report.status, "PASS");
assert.match(report.scannedAt, /^\d{4}-\d{2}-\d{2}T/u);
assert.match(report.sourceCommit, /^[0-9a-f]{40}$/u);
execFileSync("git", ["merge-base", "--is-ancestor", report.sourceCommit, "HEAD"]);
assert.deepEqual(report.scanner, policy.scanner);
assert.deepEqual(report.images.map(({ role }) => role).sort(), [...policy.requiredImages].sort());
for (const image of report.images) {
  assert.match(image.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(image.os, /^debian 13\./u);
  assert.equal(image.user, "65532:65532");
  assert.equal(image.high, policy.maximumFindings.high, `${image.role}: High vulnerability gate failed`);
  assert.equal(image.critical, policy.maximumFindings.critical, `${image.role}: Critical vulnerability gate failed`);
  assert.equal(image.secrets, policy.maximumFindings.secrets, `${image.role}: secret scan gate failed`);
  assert.equal(image.runtimeSmoke, "PASS");
}

const incident = fs.readFileSync("docs/security/incident-intake.md", "utf8");
for (const term of ["digest", "audit event ID", "critical", "high", "Release 차단 입력"])
  assert.ok(incident.includes(term), `incident intake missing: ${term}`);

console.log(JSON.stringify({ status: "pass", task: policy.taskId, images: report.images.length,
  high: 0, critical: 0, secrets: 0 }));
