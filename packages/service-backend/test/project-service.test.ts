import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  InMemoryRemoteBackup,
  ServiceBackendError,
  createServiceBackend,
  resetIdSequence
} from "../src/index.ts";

let clock = 1_700_000_100_000;
resetIdSequence(0);

const persistPath = path.join(os.tmpdir(), `cargo-service-backend-${process.pid}.json`);
try {
  fs.unlinkSync(persistPath);
} catch {
  // absent is fine
}

const remoteBackup = new InMemoryRemoteBackup();
const backend = createServiceBackend({
  persistPath,
  remoteBackup,
  now: () => {
    clock += 1000;
    return clock;
  }
});

const { session } = backend.auth.signup({
  email: "owner@example.com",
  displayName: "Owner"
});
const actor = backend.auth.requireUser(session.token);

const created = backend.projects.create(actor, { name: "Demo" });
assert.equal(created.permissions?.[0]?.role, "owner");
assert.equal(created.teamId, null);

backend.projects.saveSnapshot(actor, created.id, {
  files: [{ path: "/app/index.js", content: "export default 1\n" }]
});

const remote = await remoteBackup.pullSnapshot(created.id);
assert.ok(remote);
assert.equal(remote.generation, 1);

// Simulate local wipe + resume from remote backup.
backend.store.deleteProject(created.id);
backend.store.putProject(created);
const resumed = await backend.projects.resumeSnapshot(actor, created.id);
assert.equal(resumed.generation, 1);

const listed = backend.projects.list(actor);
assert.equal(listed.length, 1);

const bundle = backend.projects.export(actor, created.id);
assert.equal(bundle.snapshot?.files[0]?.content, "export default 1\n");

const roundTrip = backend.projects.import(actor, bundle, { name: "Demo import" });
assert.equal(roundTrip.metadata.ownerId, actor.id);
assert.equal(roundTrip.snapshot?.files.length, 1);

assert.throws(
  () => backend.projects.getPrivate(null, created.id),
  (error) => error instanceof ServiceBackendError && error.code === "EFORBIDDEN"
);

const readOnly = backend.shares.createShareLink(actor, created.id, "read_only");
const preview = backend.shares.openReadOnlyPreview(readOnly.token);
assert.equal(preview.project.name, "Demo");

const forkable = backend.shares.createShareLink(actor, created.id, "forkable");
const other = backend.auth.signup({ email: "other@example.com", displayName: "Other" });
const otherActor = backend.auth.requireUser(other.session.token);
const forked = backend.shares.forkFromShare(otherActor, forkable.token, "Forked demo");
assert.equal(forked.forked.name, "Forked demo");
assert.equal(forked.forked.ownerId, otherActor.id);

assert.ok(fs.existsSync(persistPath));
const persisted = JSON.parse(fs.readFileSync(persistPath, "utf8"));
assert.equal(persisted.schemaVersion, 1);
assert.ok(persisted.users.length >= 2);
assert.ok(persisted.projects.length >= 1);

backend.usage.recordInstall(actor.id);
backend.usage.recordRuntimeMinutes(actor.id, 1.5);
const usage = backend.usage.get(actor.id);
assert.equal(usage.installCount, 1);
assert.equal(usage.runtimeMinutes, 1.5);
assert.ok(usage.storageBytes >= 0);

console.log("service-backend project-service test ok");
