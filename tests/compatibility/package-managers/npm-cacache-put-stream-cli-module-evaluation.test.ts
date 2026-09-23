import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createAsyncCliModuleEvaluator,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const mountRoot = "/workspace";
const workspace = new MemoryPackageManagerWorkspace([
  ...readMounts(repoRoot, mountRoot, "vendor/cli/npm/10.9.2/package"),
  {
    path: "/workspace/cacache-put-cli/bin.js",
    data: `
      (async function run(process) {
        try {
          const cacache = require("/workspace/vendor/cli/npm/10.9.2/package/node_modules/cacache/lib/index.js");
          const stream = cacache.put.stream("/home/webcontainer/.npm/_cacache", "fixture-key");
          let size = 0;
          stream.on("size", (value) => {
            size = value;
          });
          const done = stream.promise();
          stream.write(Buffer.from("cache-ok"));
          stream.end();
          await done;
          process.stdout.write(String(size) + "\\n");
        } catch (error) {
          process.stderr.write((error.stack || error.message) + "\\n");
          process.exitCode = 1;
        }
      })(process);
    `
  }
]);

const result = await createAsyncCliModuleEvaluator({
  root: mountRoot,
  reader: workspace,
  writer: workspace,
  settleTicks: 5000,
  settleTimeoutMs: 5000
})({
  entry: {
    name: "npm-cacache-put-stream-fixture",
    version: "0.0.0",
    entry: "/workspace/cacache-put-cli/bin.js"
  },
  args: [],
  cwd: "/workspace",
  env: {
    HOME: "/home/webcontainer",
    PATH: "/usr/local/bin:/usr/bin:/bin"
  }
});

assert.equal(result.stderr, "");
assert.equal(result.exitCode, 0);
assert.equal(result.stdout, "8\n");

console.log("npm cacache put stream cli module evaluation test ok");

function readMounts(repoRoot, mountRoot, relativeSource) {
  const sourceRoot = path.join(repoRoot, relativeSource);
  const mounts = [];
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const sourceRelative = path.relative(repoRoot, sourcePath);
    const targetPath = `${mountRoot}/${sourceRelative}`;
    if (entry.isDirectory()) {
      mounts.push(...readMounts(repoRoot, mountRoot, sourceRelative));
    } else if (entry.isFile()) {
      mounts.push({
        path: targetPath,
        data: fs.readFileSync(sourcePath, "utf8")
      });
    }
  }
  return mounts;
}
