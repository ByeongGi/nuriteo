import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
  "packages/service-backend/package.json",
  "packages/service-backend/src/index.ts",
  "packages/service-backend/src/types.ts",
  "packages/service-backend/src/store.ts",
  "packages/service-backend/src/remote-backup.ts",
  "packages/service-backend/src/project-service.ts",
  "packages/service-backend/src/share-service.ts",
  "packages/service-backend/src/usage-meter.ts",
  "packages/service-backend/src/auth.ts",
  "docs/productization/service-backend.md",
  "tests/service-backend/project-service.test.mjs"
];

for (const rel of requiredFiles) {
  assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
}

const {
  SERVICE_BACKEND_SCHEMA_VERSION,
  ServiceBackendError,
  createServiceBackend,
  resetIdSequence
} = await import("../packages/service-backend/src/index.ts");

assert.equal(SERVICE_BACKEND_SCHEMA_VERSION, 1, "schemaVersion must be 1 for private beta");

let clock = 1_700_000_000_000;
resetIdSequence(0);
const backend = createServiceBackend({
  now: () => {
    clock += 1000;
    return clock;
  }
});

const { user, session } = backend.auth.signup({
  email: "beta@example.com",
  displayName: "Beta User"
});
assert.equal(user.schemaVersion, 1);
assert.equal(user.email, "beta@example.com");
assert.ok(session.token);

const loggedIn = backend.auth.login("beta@example.com");
assert.equal(loggedIn.user.id, user.id);
const actor = backend.auth.requireUser(loggedIn.session.token);

const projectA = backend.projects.create(actor, { name: "Alpha" });
const projectB = backend.projects.create(actor, { name: "Beta" });
assert.equal(backend.projects.list(actor).length, 2);

const saved = backend.projects.saveSnapshot(actor, projectA.id, {
  files: [
    { path: "/workspace/package.json", content: "{\"name\":\"alpha\"}\n" },
    { path: "/workspace/src/main.js", content: "console.log(1)\n" }
  ]
});
assert.equal(saved.generation, 1);
assert.ok(saved.byteSize > 0);

const resumed = await backend.projects.resumeSnapshot(actor, projectA.id);
assert.equal(resumed.generation, 1);
assert.deepEqual(
  resumed.files.map((f) => f.path),
  ["/workspace/package.json", "/workspace/src/main.js"]
);

const dup = backend.projects.duplicate(actor, projectA.id);
assert.equal(dup.name, "Alpha copy");
const dupSnap = backend.projects.loadSnapshot(actor, dup.id);
assert.equal(dupSnap.files.length, 2);

assert.throws(
  () => backend.projects.getPrivate(null, projectA.id),
  (error) => error instanceof ServiceBackendError && error.code === "EFORBIDDEN"
);
assert.throws(
  () => backend.auth.requireUser(null),
  (error) => error instanceof ServiceBackendError && error.code === "EAUTH"
);

const readOnly = backend.shares.createShareLink(actor, projectA.id, "read_only");
const preview = backend.shares.openReadOnlyPreview(readOnly.token);
assert.equal(preview.accessMode, "read_only");
assert.equal(preview.project.id, projectA.id);
assert.equal(preview.snapshot?.generation, 1);

const forkable = backend.shares.createShareLink(actor, projectA.id, "forkable");
const strangerSignup = backend.auth.signup({
  email: "forker@example.com",
  displayName: "Forker"
});
const stranger = backend.auth.requireUser(strangerSignup.session.token);
const forked = backend.shares.forkFromShare(stranger, forkable.token);
assert.equal(forked.forked.ownerId, stranger.id);
assert.notEqual(forked.forked.id, projectA.id);
const forkedSnap = backend.projects.loadSnapshot(stranger, forked.forked.id);
assert.equal(forkedSnap.files.length, 2);

assert.throws(
  () => backend.shares.forkFromShare(stranger, readOnly.token),
  (error) => error instanceof ServiceBackendError && error.code === "EFORBIDDEN"
);
assert.throws(
  () => backend.shares.openReadOnlyPreview(forkable.token),
  (error) => error instanceof ServiceBackendError && error.code === "EFORBIDDEN"
);

const exported = backend.projects.export(actor, projectB.id);
assert.equal(exported.kind, "cargo-container.project-export");
const imported = backend.projects.import(actor, exported, { name: "Beta imported" });
assert.equal(imported.metadata.name, "Beta imported");

backend.usage.recordInstall(actor.id, 2);
backend.usage.recordRuntimeMinutes(actor.id, 5);
const usage = backend.usage.get(actor.id);
assert.equal(usage.installCount, 2);
assert.equal(usage.runtimeMinutes, 5);
assert.ok(usage.storageBytes > 0);

const renamed = backend.projects.rename(actor, projectB.id, "Beta2");
assert.equal(renamed.name, "Beta2");
backend.projects.delete(actor, projectB.id);
assert.equal(
  backend.projects.list(actor).some((p) => p.id === projectB.id),
  false
);

console.log(
  `service-backend check ok users=2 projects=${backend.projects.list(actor).length} schema=${SERVICE_BACKEND_SCHEMA_VERSION}`
);
