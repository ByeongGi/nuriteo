import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  createAsyncCliModuleEvaluator,
  gzip,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const mountRoot = "/workspace";
const body = gzip(new TextEncoder().encode("fixture-fetch-body"));
const server = http.createServer((req, res) => {
  if (req.url === "/fixture.tgz") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end("missing");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const { port } = server.address();
  const workspace = new MemoryPackageManagerWorkspace([
    ...readMounts(repoRoot, mountRoot, "vendor/cli/npm/10.9.2/package"),
    {
      path: "/workspace/fetch-cli/bin.js",
      data: `
        (async function run(process) {
          try {
            const fetch = require("/workspace/vendor/cli/npm/10.9.2/package/node_modules/minipass-fetch/lib/index.js");
            const response = await fetch("http://127.0.0.1:${port}/fixture.tgz");
            const buffer = await response.buffer();
            process.stdout.write(response.status + " " + response.statusText + " " + buffer.length + "\\n");
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
      name: "npm-fetch-fixture",
      version: "0.0.0",
      entry: "/workspace/fetch-cli/bin.js"
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
  assert.match(result.stdout, /^200 OK \d+\n$/);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("npm fetch cli module evaluation test ok");

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
