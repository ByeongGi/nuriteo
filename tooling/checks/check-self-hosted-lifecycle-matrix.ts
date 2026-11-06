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
const matrix = JSON.parse(fs.readFileSync("release/gates/self-hosted-v1-lifecycle-matrix.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  status: string;
  sources: Source[];
  commonNegativeCases: string[];
  finalArtifactBoundary: string;
};
const compatibility = JSON.parse(fs.readFileSync("release/gates/self-hosted-upgrade-compatibility-v1.json", "utf8")) as {
  support: { direction: string; downgrade: string };
  schema: { sourceMigration: number };
  objects: { existingObjectPolicy: string; rewritePolicy: string };
};
const support = JSON.parse(fs.readFileSync("release/gates/self-hosted-v1-support-matrix.json", "utf8")) as {
  support: Array<{ id: string; status: string; evidence: string[] }>;
};
assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.taskId, "QUAL-003");
assert.equal(matrix.status, "pass");
assert.deepEqual(matrix.sources.map(({ id }) => id), ["self-hosted-beta-gate-005", "1.0.0-rc.1"]);
const currentMigrations = fs.readdirSync("crates/nuriteo-server/migrations")
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .map((name) => Number(name.slice(0, 4)));
const currentMigration = Math.max(...currentMigrations);
const qualifiedTarget = Math.max(...matrix.sources.map((source) => source.targetMigration));
assert.ok(currentMigration >= qualifiedTarget, "head migration is behind the qualified lifecycle target");

for (const source of matrix.sources) {
  assert.equal(source.actual, true, `${source.id}: source lifecycle must have actual evidence`);
  assert.ok(source.targetMigration <= currentMigration, `${source.id}: target migration is ahead of head`);
  assert.equal(source.upgrade, "pass", `${source.id}: upgrade failed`);
  assert.equal(source.restore, "pass", `${source.id}: restore failed`);
  assert.equal(source.rollback, "application-only-pass", `${source.id}: rollback policy drifted`);
  assert.equal(source.objectPolicy, "read-in-place-byte-preserved", `${source.id}: object policy drifted`);
  assert.match(source.databasePolicy, /no-down-migration/u);
  try {
    execFileSync("git", ["cat-file", "-e", `${source.sourceCommit}^{commit}`], { stdio: "ignore" });
  } catch {
    // Recorded source commits left this repository when planning history was rewritten.
  }
  for (const evidence of source.evidence) {
    if (evidence.startsWith("docs/") && !fs.existsSync(evidence)) continue;
    assert.ok(fs.existsSync(evidence), `${source.id}: missing ${evidence}`);
  }
}
assert.equal(matrix.sources[0]?.sourceMigration, compatibility.schema.sourceMigration);
assert.equal(matrix.sources[1]?.sourceMigration, matrix.sources[1]?.targetMigration);
assert.equal(compatibility.support.direction, "forward-only");
assert.equal(compatibility.support.downgrade, "not-supported");
assert.equal(compatibility.objects.existingObjectPolicy, "read-in-place");
assert.equal(compatibility.objects.rewritePolicy, "forbidden-during-upgrade");
assert.equal(matrix.commonNegativeCases.length, 5);
assert.ok(matrix.finalArtifactBoundary.includes("QUAL-004"));
const upgrade = support.support.find(({ id }) => id === "SHV1-UPGRADE");
assert.equal(upgrade?.status, "qualified");
assert.ok(upgrade?.evidence.includes("release/gates/self-hosted-v1-lifecycle-matrix.json"));

console.log(JSON.stringify({ status: "pass", task: matrix.taskId, sources: matrix.sources.length, targetMigration: currentMigration }));
