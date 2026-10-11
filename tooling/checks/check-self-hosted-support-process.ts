import assert from "node:assert/strict";
import fs from "node:fs";

type Severity = { level: string; cvssMinimum: number; acknowledgeHours: number; triageHours: number; targetResolutionDays: number };
const policy = JSON.parse(fs.readFileSync("security/vulnerability-response-policy.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  reporting: { preferred: string; publicIssueSecretsForbidden: boolean; automaticSupportBundleUpload: boolean; bugBountyOffered: boolean };
  supportedVersions: { previousMinorOverlapDays: number; endOfSupportNoticeDays: number };
  severity: Severity[];
  releaseBlockers: string[];
  roles: string[];
  incidentStates: string[];
  disclosure: { mode: string; creditRequiresConsent: boolean; publishAfter: string[] };
};
const drill = JSON.parse(fs.readFileSync("security/incident-drill-v1.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  severity: string;
  startedAt: string;
  events: Array<{ state: string; at: string; owner: string; evidence: string }>;
  secretMaterialPresent: boolean;
  artifacts: string[];
};

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.taskId, "SUP-004");
assert.equal(policy.reporting.preferred, "github-private-vulnerability-reporting");
assert.equal(policy.reporting.publicIssueSecretsForbidden, true);
assert.equal(policy.reporting.automaticSupportBundleUpload, false);
assert.equal(policy.reporting.bugBountyOffered, false);
assert.equal(policy.supportedVersions.previousMinorOverlapDays, 90);
assert.equal(policy.supportedVersions.endOfSupportNoticeDays, 90);
assert.deepEqual(policy.severity.map(({ level }) => level), ["critical", "high", "medium", "low"]);
for (let index = 1; index < policy.severity.length; index += 1) {
  assert.ok(policy.severity[index - 1]!.cvssMinimum > policy.severity[index]!.cvssMinimum);
  assert.ok(policy.severity[index - 1]!.acknowledgeHours <= policy.severity[index]!.acknowledgeHours);
}
assert.ok(policy.releaseBlockers.includes("unresolved-critical-or-high"));
assert.deepEqual(policy.incidentStates, ["reported", "acknowledged", "triaged", "contained", "remediated", "disclosed", "closed"]);
assert.equal(policy.disclosure.mode, "coordinated");
assert.equal(policy.disclosure.creditRequiresConsent, true);
assert.equal(policy.disclosure.publishAfter.length, 3);

assert.equal(drill.schemaVersion, 1);
assert.equal(drill.taskId, policy.taskId);
assert.equal(drill.secretMaterialPresent, false);
assert.deepEqual(drill.events.map(({ state }) => state), policy.incidentStates);
const severity = policy.severity.find(({ level }) => level === drill.severity);
assert.ok(severity !== undefined);
const started = Date.parse(drill.startedAt);
const acknowledged = Date.parse(drill.events.find(({ state }) => state === "acknowledged")!.at);
const triaged = Date.parse(drill.events.find(({ state }) => state === "triaged")!.at);
assert.ok((acknowledged - started) / 3_600_000 <= severity.acknowledgeHours);
assert.ok((triaged - started) / 3_600_000 <= severity.triageHours);
for (let index = 1; index < drill.events.length; index += 1) {
  assert.ok(Date.parse(drill.events[index - 1]!.at) <= Date.parse(drill.events[index]!.at));
}
for (const event of drill.events) {
  assert.ok(policy.roles.includes(event.owner), `${event.state}: owner is outside policy`);
  assert.match(event.evidence, /^[a-z0-9-]{8,80}$/u);
}
assert.ok(drill.artifacts.every((artifact) => !/token|password|private-key|source|backup-raw/u.test(artifact)));

const security = fs.readFileSync("SECURITY.md", "utf8");
const normalizedSecurity = security.replace(/\s+/gu, " ");
const guide = fs.readFileSync("docs/security/vulnerability-and-incident-response.md", "utf8");
for (const term of ["Security → Report a vulnerability", "Do not open a public issue", "4 hours", "bug bounty"])
  assert.ok(normalizedSecurity.includes(term), `SECURITY.md missing ${term}`);
for (const term of ["Critical", "Incident Commander", "coordinated advisory", "best-effort", "Managed cloud"])
  assert.ok(guide.includes(term), `response guide missing ${term}`);

console.log(JSON.stringify({
  status: "pass",
  task: policy.taskId,
  severityLevels: policy.severity.length,
  roles: policy.roles.length,
  drillStates: drill.events.length,
  criticalAcknowledgementHours: severity.acknowledgeHours
}));
