import assert from "node:assert/strict";

import { createMemoryOpfs, createProjectWorkspaceStore, createStorageLease } from "../../browser-host/src/index.ts";

let now = 1000;
const opfs = createMemoryOpfs();
const lease = createStorageLease({ now: () => now, ttlMs: 100 });

const firstTab = createProjectWorkspaceStore({
  projectId: "project-recovery",
  root: "/workspace/project",
  opfs,
  lease
});
const secondTab = createProjectWorkspaceStore({
  projectId: "project-recovery",
  root: "/workspace/project",
  opfs,
  lease
});

firstTab.acquireWriter("tab-a");
assert.throws(
  () => secondTab.acquireWriter("tab-b"),
  (error) => error.code === "ELEASEHELD"
);

firstTab.writeText("package.json", "{\"name\":\"before-crash\"}\n");
const firstSave = firstTab.save({ owner: "tab-a", metadata: { name: "Before Crash" } });
assert.equal(firstSave.generation, 1);

opfs.writeFile("projects/project-recovery/2.tmp", {
  schemaVersion: 1,
  generation: 2,
  snapshot: { broken: true },
  integrity: "bad"
});

const reloaded = createProjectWorkspaceStore({
  projectId: "project-recovery",
  root: "/workspace/project",
  opfs,
  lease
});
const recovered = reloaded.recoverLatest();
assert.equal(recovered.metadata.name, "Before Crash");
assert.equal(reloaded.readText("package.json"), "{\"name\":\"before-crash\"}\n");
assert.equal(opfs.readFile("projects/project-recovery/CURRENT").generation, 1);

now += 101;
secondTab.acquireWriter("tab-b");
secondTab.recoverLatest();
secondTab.writeText("package.json", "{\"name\":\"after-recovery\"}\n");
const secondSave = secondTab.save({ owner: "tab-b", metadata: { name: "After Recovery" } });
assert.equal(secondSave.generation, 2);
assert.throws(
  () => firstTab.save({ owner: "tab-a" }),
  (error) => error.code === "ELEASEMISSING"
);

const reopened = createProjectWorkspaceStore({
  projectId: "project-recovery",
  root: "/workspace/project",
  opfs,
  lease
});
assert.equal(reopened.loadLatest().metadata.name, "After Recovery");
assert.equal(reopened.readText("package.json"), "{\"name\":\"after-recovery\"}\n");

console.log("browser host project recovery test ok");
