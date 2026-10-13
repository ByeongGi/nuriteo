import assert from "node:assert/strict";

import { createMemoryOpfs, createProjectWorkspaceStore, createStorageLease, migrateProjectWorkspaceSnapshot } from "../../browser-host/src/index.ts";

let now = 1000;
const opfs = createMemoryOpfs();
const lease = createStorageLease({ now: () => now, ttlMs: 100 });
const source = createProjectWorkspaceStore({
  projectId: "project-export",
  root: "/workspace/project",
  metadata: { name: "Exported", packageManager: "npm", framework: "vite-react" },
  opfs,
  lease
});

source.writeText("package.json", "{\"name\":\"exported\"}\n");
source.writeText("src/main.js", "console.log(\"exported\")\n");
const archive = source.exportArchive(1234);
assert.equal(archive.schemaVersion, 1);
assert.equal(archive.format, "nuriteo-project-archive");
assert.equal(archive.exportedAt, 1234);
assert.equal(archive.snapshot.files.length, 2);

const imported = createProjectWorkspaceStore({
  projectId: "project-import",
  root: "/workspace/project",
  opfs,
  lease
});
imported.acquireWriter("importer");
const importedSnapshot = imported.importArchive(archive, { owner: "importer", save: true });
assert.equal(importedSnapshot.projectId, "project-export");
assert.equal(imported.readText("src/main.js"), "console.log(\"exported\")\n");
assert.equal(opfs.readFile("projects/project-import/CURRENT").generation, 1);
assert.equal(imported.loadLatest().metadata.framework, "vite-react");

const encoded = source.exportSnapshot(1236);
assert.ok(encoded instanceof Uint8Array);
const binaryImport = createProjectWorkspaceStore({
  projectId: "project-binary-import",
  root: "/workspace/project"
});
const binarySnapshot = binaryImport.importSnapshot(encoded);
assert.equal(binarySnapshot.metadata.name, "Exported");
assert.equal(binaryImport.readText("src/main.js"), "console.log(\"exported\")\n");

const corruptedArchive = JSON.parse(new TextDecoder().decode(encoded));
corruptedArchive.snapshot.files[0].data = "tampered";
assert.throws(
  () => binaryImport.importSnapshot(new TextEncoder().encode(JSON.stringify(corruptedArchive))),
  /integrity mismatch/
);

now += 101;
const legacy = migrateProjectWorkspaceSnapshot({
  schemaVersion: 0,
  projectId: "legacy-project",
  root: "/workspace/legacy/",
  metadata: { name: "Legacy" },
  files: {
    "/workspace/legacy/package.json": "{\"name\":\"legacy\"}\n",
    "/workspace/legacy/src/main.js": "console.log(\"legacy\")\n"
  }
});
assert.equal(legacy.schemaVersion, 1);
assert.equal(legacy.root, "/workspace/legacy");
assert.deepEqual(legacy.files.map((file) => file.path), [
  "/workspace/legacy/package.json",
  "/workspace/legacy/src/main.js"
]);

const legacyImport = createProjectWorkspaceStore({
  projectId: "legacy-import",
  root: "/workspace/legacy",
  opfs,
  lease
});
legacyImport.importArchive({
  schemaVersion: 1,
  format: "nuriteo-project-archive",
  exportedAt: 1235,
  snapshot: {
    projectId: "legacy-project",
    root: "/workspace/legacy",
    metadata: { name: "Legacy Archive" },
    files: {
      "/workspace/legacy/package.json": "{\"name\":\"legacy\"}\n"
    }
  }
});
assert.equal(legacyImport.readText("package.json"), "{\"name\":\"legacy\"}\n");
assert.equal(legacyImport.snapshot().metadata.name, "Legacy Archive");

console.log("browser host project import export test ok");
