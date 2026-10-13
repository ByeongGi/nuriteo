import assert from "node:assert/strict";

import { MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/index.ts";

const workspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/package.json",
    data: JSON.stringify({ name: "snapshot-fixture" })
  },
  {
    path: "/workspace/vendor/probe.wasm",
    data: "AAECA/8=",
    encoding: "base64"
  }
]);
workspace.mkdir("/workspace/empty");
workspace.symlink("/workspace/vendor", "/workspace/vendor-link");
workspace.writeText("/workspace/src/index.js", "export const ok = true;\n");

const snapshot = workspace.snapshot();
assert.equal(snapshot.files.every((file) => file.encoding === "base64"), true);
assert.deepEqual(snapshot.links, [{ path: "/workspace/vendor-link", target: "/workspace/vendor" }]);
assert.equal(snapshot.directories.includes("/workspace/empty"), true);

const restored = MemoryPackageManagerWorkspace.fromSnapshot(snapshot);
assert.equal(restored.readText("/workspace/package.json"), JSON.stringify({ name: "snapshot-fixture" }));
assert.deepEqual([...restored.readBytes("/workspace/vendor/probe.wasm")], [0, 1, 2, 3, 255]);
assert.equal(restored.readText("/workspace/src/index.js"), "export const ok = true;\n");
assert.equal(restored.readText("/workspace/vendor-link/probe.wasm").length, 5);
assert.deepEqual(restored.snapshot(), snapshot);

console.log("package manager workspace snapshot test ok");
