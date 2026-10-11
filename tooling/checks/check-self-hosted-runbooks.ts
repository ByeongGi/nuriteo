import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("compat/self-hosted-runbooks-v1.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  document: string;
  rehearsal: string;
  runbooks: Array<{ id: string; command: string; contractCheck: string; actualEvidence: string }>;
};

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.taskId, "SUP-003");
assert.equal(manifest.releaseLineage, "nuriteo-self-hosted-v1");
assert.deepEqual(manifest.runbooks.map(({ id }) => id), [
  "install-compose",
  "install-helm",
  "upgrade-rollback",
  "backup-restore",
  "incident-triage"
]);
assert.equal(new Set(manifest.runbooks.map(({ id }) => id)).size, manifest.runbooks.length);

const document = fs.readFileSync(manifest.document, "utf8");
const rehearsal = fs.readFileSync(manifest.rehearsal, "utf8");
for (const runbook of manifest.runbooks) {
  const marker = `<!-- runbook-command:${runbook.id} -->\n\`\`\`sh\n${runbook.command}\n\`\`\``;
  assert.ok(document.includes(marker), `${runbook.id}: documented command drifted`);
  assert.ok(fs.existsSync(runbook.actualEvidence), `${runbook.id}: actual evidence is missing`);
  const evidence = fs.readFileSync(runbook.actualEvidence, "utf8");
  assert.match(evidence, /(?:판정: `PASS`|상태: `PASS`)/u, `${runbook.id}: evidence is not PASS`);
  assert.ok(rehearsal.includes(runbook.contractCheck), `${runbook.id}: contract check is not rehearsed`);
}
for (const term of [
  "forward-only",
  "database down migration",
  "빈 DB와 빈 bucket",
  "request reference/operation ID",
  "임시 cluster/container/volume"
]) assert.ok(document.includes(term), `runbook safety boundary missing: ${term}`);

console.log(JSON.stringify({ status: "pass", task: manifest.taskId, runbooks: manifest.runbooks.length }));
