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
    path: "/workspace/minizlib-cli/bin.js",
    data: `
      (function run(process) {
        try {
          const zlib = require("node:zlib");
          const minizlib = require("/workspace/vendor/cli/npm/10.9.2/package/node_modules/minizlib/index.js");
          const input = zlib.gzipSync(Buffer.from("minizlib-ok"));
          const unzip = new minizlib.Unzip();
          const chunks = [];
          unzip.on("data", (chunk) => chunks.push(chunk));
          unzip.on("end", () => {
            process.stdout.write(Buffer.concat(chunks).toString("utf8") + "\\n");
          });
          unzip.end(input);
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
  settleTicks: 1000,
  settleTimeoutMs: 1000
})({
  entry: {
    name: "npm-minizlib-fixture",
    version: "0.0.0",
    entry: "/workspace/minizlib-cli/bin.js"
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
assert.equal(result.stdout, "minizlib-ok\n");

console.log("npm minizlib cli module evaluation test ok");

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
