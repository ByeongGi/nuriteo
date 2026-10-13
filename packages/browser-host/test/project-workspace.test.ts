import assert from "node:assert/strict";

import { createMemoryOpfs, createProjectWorkspaceStore, createStorageLease } from "../../browser-host/src/index.ts";

let now = 1000;
const opfs = createMemoryOpfs();
const lease = createStorageLease({ now: () => now, ttlMs: 100 });
const project = createProjectWorkspaceStore({
  projectId: "project-a",
  root: "/workspace/app",
  metadata: {
    name: "App",
    packageManager: "pnpm",
    framework: "vite-react"
  },
  opfs,
  lease
});

project.acquireWriter("writer-a");
project.writeText("package.json", "{\"name\":\"app\"}\n");
project.writeText("/workspace/app/src/main.js", "console.log(\"hello\")\n");

const saved = project.save({
  owner: "writer-a",
  metadata: { framework: "vite-react" }
});
assert.equal(saved.generation, 1);
assert.equal(saved.flushed, true);
assert.equal(saved.path, "projects/project-a/1.snapshot");

const snapshot = project.snapshot();
assert.equal(snapshot.projectId, "project-a");
assert.equal(snapshot.root, "/workspace/app");
assert.equal(snapshot.metadata.packageManager, "pnpm");
assert.deepEqual(snapshot.files.map((file) => file.path), [
  "/workspace/app/package.json",
  "/workspace/app/src/main.js"
]);

const restored = createProjectWorkspaceStore({
  projectId: "project-a",
  root: "/workspace/app",
  opfs,
  lease
});
assert.deepEqual(restored.loadLatest(), snapshot);
assert.equal(restored.readText("src/main.js"), "console.log(\"hello\")\n");

opfs.writeFile("projects/project-a/2.tmp", { broken: true });
assert.deepEqual(restored.recoverLatest(), snapshot);

now += 101;
assert.throws(
  () => project.save({ owner: "writer-a" }),
  (error) => error.code === "ELEASEMISSING"
);

console.log("browser host project workspace test ok");
