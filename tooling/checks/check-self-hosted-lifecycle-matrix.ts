import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

type Source = {
  id: string;
  sourceCommit: string;
  sourceMigration: number;
  targetMigration: number;
  actual: boolean;
  upgrade: string;
  restore: string;
  rollback: string;
  objectPolicy: string;
  databasePolicy: string;
  evidence: string[];
};
const matrix = JSON.parse(fs.readFileSync("compat/self-hosted-v1-lifecycle-matrix.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  status: string;
  sources: Source[];
  commonNegativeCases: string[];
  finalArtifactBoundary: string;
};
const compatibility = JSON.parse(fs.readFileSync("compat/self-hosted-upgrade-compatibility-v1.json", "utf8")) as {
  support: { direction: string; downgrade: string };
  schema: { sourceMigration: number };
  objects: { existingObjectPolicy: string; rewritePolicy: string };
};
const support = JSON.parse(fs.readFileSync("compat/self-hosted-v1-support-matrix.json", "utf8")) as {
  support: Array<{ id: string; status: string; evidence: string[] }>;
};
const documentation = fs.readFileSync("docs/operations/self-hosted-v1-lifecycle-matrix.md", "utf8");

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.taskId, "QUAL-003");
assert.equal(matrix.status, "pass");
assert.deepEqual(matrix.sources.map(({ id }) => id), ["self-hosted-beta-gate-005", "1.0.0-rc.1"]);
const currentMigrations = fs.readdirSync("crates/nuriteo-server/migrations")
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .map((name) => Number(name.slice(0, 4)));
const currentMigration = Math.max(...currentMigrations);
assert.equal(currentMigration, 50, "GA candidate migration changed without lifecycle matrix update");

for (const source of matrix.sources) {
  assert.equal(source.actual, true, `${source.id}: source lifecycle must have actual evidence`);
  assert.equal(source.targetMigration, currentMigration, `${source.id}: target migration drifted`);
  assert.equal(source.upgrade, "pass", `${source.id}: upgrade failed`);
  assert.equal(source.restore, "pass", `${source.id}: restore failed`);
  assert.equal(source.rollback, "application-only-pass", `${source.id}: rollback policy drifted`);
  assert.equal(source.objectPolicy, "read-in-place-byte-preserved", `${source.id}: object policy drifted`);
  assert.match(source.databasePolicy, /no-down-migration/u);
  execFileSync("git", ["cat-file", "-e", `${source.sourceCommit}^{commit}`]);
  for (const evidence of source.evidence) assert.ok(fs.existsSync(evidence), `${source.id}: missing ${evidence}`);
  assert.ok(documentation.includes(`| \`${source.id}\` |`), `${source.id}: documentation row missing`);
}
assert.equal(matrix.sources[0]?.sourceMigration, compatibility.schema.sourceMigration);
assert.equal(matrix.sources[1]?.sourceMigration, currentMigration);
assert.equal(compatibility.support.direction, "forward-only");
assert.equal(compatibility.support.downgrade, "not-supported");
assert.equal(compatibility.objects.existingObjectPolicy, "read-in-place");
assert.equal(compatibility.objects.rewritePolicy, "forbidden-during-upgrade");
assert.equal(matrix.commonNegativeCases.length, 5);
assert.ok(matrix.finalArtifactBoundary.includes("QUAL-004"));
const upgrade = support.support.find(({ id }) => id === "SHV1-UPGRADE");
assert.equal(upgrade?.status, "qualified");
assert.ok(upgrade?.evidence.includes("compat/self-hosted-v1-lifecycle-matrix.json"));

console.log(JSON.stringify({ status: "pass", task: matrix.taskId, sources: matrix.sources.length, targetMigration: currentMigration }));
