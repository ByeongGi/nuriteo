import assert from "node:assert/strict";
import fs from "node:fs";

const policy = JSON.parse(fs.readFileSync("operations/audit-operations-policy.json", "utf8")) as {
  schemaVersion: number; taskId: string; sourceOfTruth: string;
  retention: { defaultDays: number; minimumDays: number; maximumDays: number;
    unlimitedAllowed: boolean; batchSize: number; scheduler: string; replicaCoordination: string;
    auditAtomic: boolean; protectedReferences: string[] };
  export: { formats: string[]; maximumEventsPerPage: number; maximumBytesPerPage: number;
    formulaSafeCsv: boolean; exportIsAudited: boolean };
  backup: { databaseArchiveIncludesAuditEvents: boolean; restoreValidatesProjectHistoryReference: boolean;
    backupRetentionIndependent: boolean };
  actualTests: string[];
};

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.taskId, "AUD-003");
assert.equal(policy.sourceOfTruth, "postgresql");
assert.deepEqual(
  [policy.retention.minimumDays, policy.retention.defaultDays, policy.retention.maximumDays],
  [30, 365, 3650],
);
assert.equal(policy.retention.unlimitedAllowed, true);
assert.equal(policy.retention.batchSize, 1000);
assert.equal(policy.retention.scheduler, "embedded-policy-maintenance");
assert.equal(policy.retention.replicaCoordination, "for-update-skip-locked");
assert.equal(policy.retention.auditAtomic, true);
assert.deepEqual(policy.retention.protectedReferences, ["project_history_promotions.audit_event_id"]);
assert.deepEqual(policy.export.formats, ["jsonl", "csv"]);
assert.deepEqual(
  [policy.export.maximumEventsPerPage, policy.export.maximumBytesPerPage],
  [1000, 20 * 1024 * 1024],
);
assert.equal(policy.export.formulaSafeCsv && policy.export.exportIsAudited, true);
assert.equal(Object.values(policy.backup).every(Boolean), true);
for (const fixture of policy.actualTests) assert.ok(fs.existsSync(fixture), `fixture missing: ${fixture}`);

const maintenance = fs.readFileSync("crates/nuriteo-server/src/policy/maintenance.rs", "utf8");
for (const term of [
  "AUDIT_BATCH: i64 = 1_000", "sweep_audit_events", "FOR UPDATE SKIP LOCKED",
  "project_history_promotions", "audit.retention_pruned", "ActorType::BackgroundJob",
  "AuditWriter::append(&mut tx",
]) assert.ok(maintenance.includes(term), `audit maintenance missing ${term}`);

const admin = fs.readFileSync("crates/nuriteo-server/src/admin/audit_service.rs", "utf8");
for (const term of ["MAX_EXPORT_EVENTS: u16 = 1_000", "MAX_EXPORT_BYTES", "csv_cell",
  "audit.exported", "project_history_promotions"])
  assert.ok(admin.includes(term), `admin audit operation missing ${term}`);

const restore = fs.readFileSync("crates/nuriteo-server/tests/backup_restore.rs", "utf8");
for (const term of ["project.history_promoted", "project_history_promotions", "restored_audit"])
  assert.ok(restore.includes(term), `backup audit evidence missing ${term}`);

const guide = fs.readFileSync("docs/operations/audit-log.md", "utf8");
for (const term of ["SKIP LOCKED", "rollback", "JSONL", "20MiB", "backup", "OTLP"])
  assert.ok(guide.includes(term), `audit operations guide missing ${term}`);

console.log(JSON.stringify({ status: "pass", task: policy.taskId,
  batchSize: policy.retention.batchSize, fixtures: policy.actualTests.length }));
