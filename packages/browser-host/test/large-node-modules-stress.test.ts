import assert from "node:assert/strict";
import { createMemoryOpfs, createQuotaManagedOpfs, createProjectWorkspaceStore } from "../../browser-host/src/index.ts";
import { MemoryPackageManagerWorkspace, WorkspaceMemoryLimitError } from "../../node-runtime/src/package-managers/workspace.ts";

const policy = JSON.parse(
  await import("node:fs").then((fs) => fs.readFileSync(new URL("../../../compat/runtime-reliability-policy.json", import.meta.url), "utf8"))
);
const fileCount = Number(process.env.LARGE_NODE_MODULES_FILES || policy.soak.largeNodeModulesFileCount || 2500);
assert.ok(fileCount >= 500, "stress file count too small");

const workspace = new MemoryPackageManagerWorkspace([]);
const root = "/workspace/stress/node_modules";
const started = Date.now();

for (let i = 0; i < fileCount; i += 1) {
  const packageName = `pkg-${i % 50}`;
  const filePath = `${root}/${packageName}/file-${i}.js`;
  workspace.writeText(filePath, `export const value = ${i};\n`);
}

const samplePaths = [];
for (let i = 0; i < fileCount; i += 97) {
  samplePaths.push(`${root}/pkg-${i % 50}/file-${i}.js`);
}
for (const filePath of samplePaths) {
  const text = workspace.readText(filePath);
  assert.match(text, /export const value = \d+;/);
}

const listed = workspace.listDir(root);
assert.equal(listed.length, 50);

const opfs = createQuotaManagedOpfs({
  opfs: createMemoryOpfs(),
  quotaBytes: policy.storage.quotaBytesDefault,
  evictionPrefixes: policy.storage.evictionPrefixes,
  protectedPrefixes: policy.storage.protectedPrefixes
});

for (let i = 0; i < 200; i += 1) {
  opfs.writeFile(`cache/dep-${i}.json`, { id: i, body: "x".repeat(256) });
}
const beforeEvict = opfs.usage("cache/").usedBytes;
const eviction = opfs.evict({ prefixes: ["cache/"], requiredBytes: beforeEvict });
assert.ok(eviction.freedBytes > 0, "cache eviction must free bytes under quota pressure");
assert.ok(opfs.usage("cache/").usedBytes < beforeEvict, "cache usage must drop after eviction");

const project = createProjectWorkspaceStore({
  projectId: "large-node-modules-stress",
  root: "/workspace/stress-app"
});
for (let i = 0; i < 100; i += 1) {
  project.writeText(`/workspace/stress-app/src/mod-${i}.js`, `export const n = ${i};\n`);
}
assert.equal(project.listFiles().length, 100);

const boundedWorkspace = new MemoryPackageManagerWorkspace([], 10);
boundedWorkspace.writeText("/workspace/cache/a", "123456");
assert.equal(boundedWorkspace.usedBytes, 6);
assert.throws(
  () => boundedWorkspace.writeText("/workspace/cache/b", "12345"),
  (error) => error instanceof WorkspaceMemoryLimitError && error.code === "ENOMEM" && error.limitBytes === 10
);
assert.equal(boundedWorkspace.usedBytes, 6);
assert.equal(boundedWorkspace.exists("/workspace/cache/b"), false);
boundedWorkspace.remove("/workspace/cache/a");
boundedWorkspace.writeText("/workspace/cache/b", "12345");
assert.equal(boundedWorkspace.usedBytes, 5);
boundedWorkspace.writeText("/workspace/cache/b", "12");
assert.equal(boundedWorkspace.usedBytes, 2);
boundedWorkspace.writeText("/workspace/cache/a", "12345678");
assert.equal(boundedWorkspace.usedBytes, 10);
boundedWorkspace.rename("/workspace/cache/a", "/workspace/cache/c");
assert.equal(boundedWorkspace.usedBytes, 10);
assert.equal(boundedWorkspace.readText("/workspace/cache/c"), "12345678");

console.log(
  `large node_modules stress ok files=${fileCount} samples=${samplePaths.length} elapsedMs=${Date.now() - started} freedCacheBytes=${eviction.freedBytes}`
);
