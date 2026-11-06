import assert from "node:assert/strict";
import fs from "node:fs";

const policy = JSON.parse(fs.readFileSync("release/gates/self-hosted-support-bundle-v1.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  format: string;
  authorization: string;
  delivery: { trigger: string; automaticUpload: boolean; serverRetention: string; maximumBytes: number };
  diagnostics: { ringCapacity: number; bundleMaximumEvents: number; persistenceGuaranteed: boolean; fields: string[] };
  included: string[];
  excluded: string[];
  evidence: string[];
};

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.taskId, "SUP-002");
assert.equal(policy.format, "nuriteo-support-bundle-v1+json");
assert.equal(policy.authorization, "instance-admin-only");
assert.deepEqual(policy.delivery, {
  trigger: "manual-download",
  automaticUpload: false,
  serverRetention: "none-streamed-response-only",
  maximumBytes: 65_536
});
assert.equal(policy.diagnostics.ringCapacity, 128);
assert.equal(policy.diagnostics.bundleMaximumEvents, 64);
assert.equal(policy.diagnostics.persistenceGuaranteed, false);
assert.equal(policy.included.length, 5);
assert.equal(policy.excluded.length, 5);
for (const path of policy.evidence) assert.ok(fs.existsSync(path), `missing evidence: ${path}`);

const operations = fs.readFileSync("crates/nuriteo-server/src/admin/operations_service.rs", "utf8");
const bundle = fs.readFileSync("crates/nuriteo-server/src/admin/support_bundle.rs", "utf8");
const observability = fs.readFileSync("crates/nuriteo-server/src/observability/diagnostics.rs", "utf8");
const routes = fs.readFileSync("crates/nuriteo-server/src/admin/http_routes.rs", "utf8");
const consoleRoutes = fs.readFileSync("crates/nuriteo-server/src/admin/http_routes/console.rs", "utf8");
const bff = fs.readFileSync("apps/web/src/app/api/v1/admin/support-bundle/route.ts", "utf8");
const ui = fs.readFileSync("apps/web/src/app/(admin)/admin/operations/_components/support-bundle-download.tsx", "utf8");
const download = fs.readFileSync("apps/web/src/app/(admin)/admin/operations/_hooks/use-support-bundle-download.ts", "utf8");

for (const term of [policy.format, "maximum_bytes: 65_536", "Project source", "authorization headers"])
  assert.ok(operations.includes(term), `operations preview missing ${term}`);
for (const term of ["support_bundle(", "diagnostic_snapshot(63)", "retained_until: None", "load_integrations"])
  assert.ok(bundle.includes(term), `bundle service missing ${term}`);
for (const term of ["DIAGNOSTIC_RING_CAPACITY: usize = 128", "DIAGNOSTIC_BUNDLE_LIMIT: usize = 64", "VecDeque"])
  assert.ok(observability.includes(term), `diagnostic ring missing ${term}`);
assert.ok(routes.includes("/api/v1/admin/support-bundle"));
assert.ok(consoleRoutes.includes(`path = SUPPORT_BUNDLE,\n    tag = "administration",\n    security(("projectSessionCookie" = [])),`));
assert.ok(bff.includes('path: "/api/v1/admin/support-bundle"'));
assert.ok(bff.includes("requireCsrf: false"));
assert.ok(ui.includes("어떤 정보도 자동으로 업로드되지 않습니다"), "diagnostic UI missing the no-upload notice");
for (const term of ["preview.maximumBytes", "URL.revokeObjectURL"])
  assert.ok(download.includes(term), `diagnostic download missing ${term}`);

console.log(JSON.stringify({
  status: "pass",
  task: policy.taskId,
  format: policy.format,
  maximumBytes: policy.delivery.maximumBytes,
  ringCapacity: policy.diagnostics.ringCapacity,
  bundleMaximumEvents: policy.diagnostics.bundleMaximumEvents
}));
