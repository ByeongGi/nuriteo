import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FileProductionDatabase,
  FileProductionObjectStorage,
  HmacSessionIdentityProvider,
  ProductionServiceBackend,
  ServiceBackendError,
  handleProductionApi
} from "../src/index.ts";
import type { UsageEvent } from "../src/index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cargo-production-backend-"));
const databasePath = path.join(root, "database.json");
const objectRoot = path.join(root, "objects");
let clock = 1_800_000_000_000;
const now = () => ++clock;
const identity = new HmacSessionIdentityProvider({ secret: "production-test-secret-is-at-least-32-bytes", now });
const owner = { tenantId: "tenant-a", subject: "owner", email: "owner@example.com", displayName: "Owner" };
const editor = { tenantId: "tenant-a", subject: "editor", email: "editor@example.com", displayName: "Editor" };
const outsider = { tenantId: "tenant-b", subject: "outsider", email: "out@example.com", displayName: "Out" };
const ownerToken = identity.issueSession(owner);

const first = new ProductionServiceBackend({
  identity,
  database: new FileProductionDatabase({ persistPath: databasePath }),
  objects: new FileProductionObjectStorage({ root: objectRoot }),
  now
});

assert.deepEqual(await first.authenticate(ownerToken), owner);
assert.equal(await identity.verifySession(`${ownerToken}tampered`), null);

const project = await first.createProject(owner, "Cloud project");
await first.grantProjectAccess(owner, project.id, editor.subject, "editor");
const saved = await first.saveProject(editor, project.id, [{ path: "src/main.ts", content: "export default 1\n" }]);
assert.equal(saved.generation, 1);

// A separately constructed host observes database metadata and object storage.
const second = new ProductionServiceBackend({
  identity,
  database: new FileProductionDatabase({ persistPath: databasePath }),
  objects: new FileProductionObjectStorage({ root: objectRoot }),
  now
});
const resumed = await second.resumeProject(owner, project.id);
assert.ok(resumed.snapshot.files[0]);
assert.equal(resumed.snapshot.files[0].content, "export default 1\n");
assert.equal((await second.listProjects(editor)).length, 1);
assert.equal((await second.listProjects(outsider)).length, 0);

const readOnly = await second.createShare(owner, project.id, "read_only");
assert.equal((await second.openShare(readOnly.token)).project.id, project.id);
const rotated = await second.rotateShare(owner, readOnly.share.id);
await assert.rejects(
  () => second.openShare(readOnly.token),
  (error) => error instanceof ServiceBackendError && error.code === "EREVOKED"
);
assert.equal((await second.openShare(rotated.token)).share.id, rotated.share.id);
await second.revokeShare(owner, rotated.share.id);
await assert.rejects(() => second.openShare(rotated.token), { code: "EREVOKED" });

const forkable = await second.createShare(owner, project.id, "forkable");
const fork = await second.forkShare(outsider, forkable.token, "Cross tenant fork");
assert.equal(fork.tenantId, outsider.tenantId);
assert.equal((await second.resumeProject(outsider, fork.id)).snapshot.files.length, 1);

const event: Omit<UsageEvent, "tenantId" | "actorId"> = {
  id: "runtime-1",
  kind: "runtime_minutes",
  quantity: 2.5,
  occurredAt: new Date(now()).toISOString()
};
assert.equal(await second.ingestUsage(owner, event), true);
assert.equal(await second.ingestUsage(owner, event), false);
assert.equal((await second.usageSummary(owner)).runtimeMinutes, 2.5);
assert.ok((await second.listAudit(owner, project.id)).some((item) => item.action === "project.save"));

const listResponse = await handleProductionApi(second, {
  method: "GET",
  path: "/api/projects",
  authorization: `Bearer ${ownerToken}`
});
assert.equal(listResponse.status, 200);
assert.ok(Array.isArray(listResponse.body));
const unauthenticated = await handleProductionApi(second, { method: "GET", path: "/api/projects" });
assert.equal(unauthenticated.status, 401);

fs.rmSync(root, { recursive: true, force: true });
console.log("service-backend production backend test ok");
