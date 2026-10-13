import assert from "node:assert/strict";

import { createMemoryOpfs, createQuotaManagedOpfs } from "../../browser-host/src/index.ts";

const opfs = createMemoryOpfs();
const storage = createQuotaManagedOpfs({
  opfs,
  quotaBytes: 42,
  evictionPrefixes: ["cache/"],
  protectedPrefixes: ["projects/"]
});

storage.writeFile("cache/a.json", "1234567890");
storage.writeFile("projects/project-a/CURRENT", { generation: 1 });
assert.equal(storage.usage().usedBytes <= 42, true);
assert.deepEqual(storage.usage().files.map((file) => file.path), ["cache/a.json", "projects/project-a/CURRENT"]);

storage.writeFile("projects/project-a/1.snapshot", "123456789012345");
assert.equal(storage.readFile("cache/a.json"), null);
assert.equal(storage.readFile("projects/project-a/1.snapshot"), "123456789012345");
assert.equal(storage.usage().usedBytes <= 42, true);

storage.writeFile("cache/b.json", "123456");
const cleanup = storage.evict({ prefixes: ["cache/"], requiredBytes: 0 });
assert.equal(cleanup.evicted.length, 1);
assert.equal(cleanup.evicted[0].path, "cache/b.json");
assert.equal(cleanup.freedBytes > 0, true);

assert.throws(
  () => storage.writeFile("projects/project-a/2.snapshot", "123456789012345678901234567890"),
  (error) => {
    assert.equal(error.code, "EOPFSQUOTA");
    assert.equal(error.usage.usedBytes <= 42, true);
    assert.equal(error.requiredBytes > 0, true);
    return true;
  }
);

console.log("browser host storage quota test ok");
