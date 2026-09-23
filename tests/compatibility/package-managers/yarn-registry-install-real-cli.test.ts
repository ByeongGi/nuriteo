import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { gzip } from "../../../packages/node-runtime/src/network/zlib.ts";
import { createAsyncCliModuleEvaluator } from "../../../packages/node-runtime/src/package-managers/cli-evaluator.ts";
import { MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/package-managers/workspace.ts";

const repositoryRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const artifactRoot = path.join(repositoryRoot, "vendor/cli/yarn/1.22.22/package");
const guestRoot = "/workspace/vendor/yarn/package";
const tarball = gzip(createTar([
  { path: "package/package.json", body: bytes(JSON.stringify({ name: "fixture-registry", version: "1.0.0", main: "index.js" })) },
  { path: "package/index.js", body: bytes("module.exports = 'registry-ok';\n") }
]));
let requestCount = 0;
const server = http.createServer((request, response) => {
  requestCount += 1;
  const port = server.address().port;
  if (request.url === "/fixture-registry") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      name: "fixture-registry",
      versions: {
        "1.0.0": {
          name: "fixture-registry",
          version: "1.0.0",
          dist: {
            integrity: `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`,
            shasum: crypto.createHash("sha1").update(tarball).digest("hex"),
            tarball: `http://127.0.0.1:${port}/fixture-registry-1.0.0.tgz`
          }
        }
      },
      "dist-tags": { latest: "1.0.0" }
    }));
    return;
  }
  if (request.url === "/fixture-registry-1.0.0.tgz") {
    response.setHeader("content-type", "application/octet-stream");
    response.end(tarball);
    return;
  }
  response.statusCode = 404;
  response.end("missing");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { port } = server.address();
  const workspace = new MemoryPackageManagerWorkspace([
    ...readMounts(artifactRoot, guestRoot),
    {
      path: "/workspace/project/package.json",
      data: JSON.stringify({ name: "yarn-registry-fixture", private: true, dependencies: { "fixture-registry": "1.0.0" } })
    }
  ]);
  const result = await createAsyncCliModuleEvaluator({
    reader: workspace,
    root: "/workspace",
    settleTicks: 5000,
    settleTimeoutMs: 5000,
    writer: workspace
  })({
    args: ["install", "--ignore-scripts", "--non-interactive", "--registry", `http://127.0.0.1:${port}`, "--cache-folder", "/workspace/.yarn-cache"],
    cwd: "/workspace/project",
    entry: { entry: `${guestRoot}/bin/yarn.js`, name: "yarn", version: "1.22.22" },
    env: { HOME: "/home/webcontainer", PATH: "/usr/local/bin:/usr/bin:/bin", YARN_IGNORE_PATH: "1" }
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(requestCount >= 2, true);
  assert.equal(workspace.readText("/workspace/project/node_modules/fixture-registry/index.js"), "module.exports = 'registry-ok';\n");
  assert.match(workspace.readText("/workspace/project/yarn.lock"), /fixture-registry@1\.0\.0/);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("yarn real CLI registry install ok");

function bytes(value) {
  return new TextEncoder().encode(value);
}

function readMounts(sourceRoot, targetRoot) {
  const mounts = [];
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = `${targetRoot}/${entry.name}`;
    if (entry.isDirectory()) mounts.push(...readMounts(sourcePath, targetPath));
    else if (entry.isFile()) mounts.push({ path: targetPath, data: fs.readFileSync(sourcePath, "utf8") });
  }
  return mounts;
}

function createTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeString(header, 0, 100, entry.path);
    writeString(header, 100, 8, "0000644");
    writeString(header, 108, 8, "0000000");
    writeString(header, 116, 8, "0000000");
    writeString(header, 124, 12, entry.body.byteLength.toString(8).padStart(11, "0"));
    writeString(header, 136, 12, "00000000000");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    writeString(header, 148, 6, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"));
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, entry.body, new Uint8Array((512 - (entry.body.byteLength % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function writeString(buffer, offset, length, value) {
  const encoded = new TextEncoder().encode(value);
  buffer.set(encoded.subarray(0, length), offset);
}
