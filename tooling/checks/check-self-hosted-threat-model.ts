import assert from "node:assert/strict";
import fs from "node:fs";

const model = JSON.parse(fs.readFileSync("security/self-hosted-v1-threat-model.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  trustBoundaries: Array<{ id: string; controls: string[] }>;
  threats: Array<{ id: string; severity: string; status: string; controls: string[]; evidence: string[] }>;
  review: { ownerRole: string; decision: string; openCritical: number; openHigh: number; releaseGatedThreats: string[] };
};

assert.equal(model.schemaVersion, 1);
assert.equal(model.taskId, "SEC-001");
assert.equal(model.releaseLineage, "nuriteo-self-hosted-v1");
assert.ok(model.trustBoundaries.length >= 7);
assert.equal(new Set(model.trustBoundaries.map(({ id }) => id)).size, model.trustBoundaries.length);
assert.ok(model.trustBoundaries.every(({ controls }) => controls.length >= 3));
assert.ok(model.threats.length >= 12);
assert.equal(new Set(model.threats.map(({ id }) => id)).size, model.threats.length);

const allowedSeverity = new Set(["critical", "high", "medium", "low"]);
const allowedStatus = new Set(["mitigated", "release-gated", "accepted"]);
for (const threat of model.threats) {
  assert.match(threat.id, /^TM-\d{2}$/u);
  assert.ok(allowedSeverity.has(threat.severity), `${threat.id}: invalid severity`);
  assert.ok(allowedStatus.has(threat.status), `${threat.id}: invalid status`);
  assert.ok(threat.controls.length >= 2, `${threat.id}: insufficient controls`);
  assert.ok(threat.evidence.length >= 1, `${threat.id}: missing evidence`);
  for (const evidence of threat.evidence) assert.ok(fs.existsSync(evidence), `${threat.id}: missing ${evidence}`);
}

assert.equal(model.review.ownerRole, "self-hosted release owner");
assert.equal(model.review.decision, "approved-for-ga-hardening");
assert.equal(model.review.openCritical, 0);
assert.equal(model.review.openHigh, 0);
const threatById = new Map(model.threats.map((threat) => [threat.id, threat]));
for (const id of model.review.releaseGatedThreats) assert.equal(threatById.get(id)?.status, "release-gated");
assert.ok(model.threats.filter(({ severity }) => severity === "critical" || severity === "high")
  .every(({ status }) => status === "mitigated" || status === "release-gated"));

const document = fs.readFileSync("docs/security/self-hosted-v1-threat-model.md", "utf8");
for (const section of ["범위와 자산", "주요 신뢰 경계", "Release 판정", "명시적 비보장"])
  assert.ok(document.includes(section), `threat model document missing ${section}`);

console.log(JSON.stringify({ status: "pass", task: model.taskId, boundaries: model.trustBoundaries.length,
  threats: model.threats.length, releaseGated: model.review.releaseGatedThreats.length }));
