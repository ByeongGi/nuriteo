import assert from "node:assert/strict";

import { createMemoryOpfs, createSnapshotStore, createStorageLease } from "../../browser-host/src/index.ts";

let now = 1000;
const opfs = createMemoryOpfs();
const lease = createStorageLease({ now: () => now, ttlMs: 100 });
const store = createSnapshotStore({ opfs, lease, root: "project-a" });

store.acquireWriter("writer-a");
assert.throws(
  () => store.acquireWriter("writer-b"),
  (error) => error.code === "ELEASEHELD"
);

const snapshot = {
  version: 1,
  nextInode: 4,
  entries: [
    { inode: 0, kind: "directory", entries: { workspace: 1 } },
    { inode: 1, kind: "directory", entries: { "a.txt": 2, "hard.txt": 2, "link.txt": 3 } },
    { inode: 2, kind: "file", nlink: 2, data: "hello" },
    { inode: 3, kind: "symlink", target: "/workspace/a.txt" }
  ]
};

const saved = store.save(snapshot, { owner: "writer-a" });
assert.equal(saved.generation, 1);
assert.equal(saved.flushed, true);
assert.equal(opfs.readFile("project-a/1.tmp"), null);
assert.deepEqual(store.loadLatest(), snapshot);

opfs.writeFile("project-a/2.tmp", { snapshot: { broken: true } });
assert.deepEqual(store.loadLatest(), snapshot);

opfs.writeFile("project-a/1.snapshot", { ...opfs.readFile("project-a/1.snapshot"), integrity: "bad" });
assert.throws(
  () => store.loadLatest(),
  (error) => error.code === "EINTEGRITY"
);

now += 101;
assert.throws(
  () => store.save(snapshot, { owner: "writer-a" }),
  (error) => error.code === "ELEASEMISSING"
);

console.log("browser host storage snapshot test ok");
