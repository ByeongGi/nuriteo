import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  CliRegistry,
  createAsyncCliModuleEvaluator,
  gzip,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const installed = JSON.parse(fs.readFileSync(new URL("../../../vendor/cli/pnpm/9.15.9/installed.json", import.meta.url), "utf8"));
const registry = new CliRegistry([installed]);
const entry = registry.resolve("pnpm");
const mountRoot = "/workspace";
const tarball = createTar([
  {
    path: "package/package.json",
    body: new TextEncoder().encode(JSON.stringify({
      name: "fixture-registry",
      version: "1.0.0",
      main: "index.js",
      bin: {
        "fixture-registry": "cli.js"
      }
    }))
  },
  {
    path: "package/index.js",
    body: new TextEncoder().encode("module.exports = 'registry-ok';\n")
  },
  {
    path: "package/cli.js",
    mode: "0000755",
    body: new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('registry-bin-ok');\n")
  }
]);
const compressed = gzip(tarball);
let requestCount = 0;
const server = http.createServer((req, res) => {
  requestCount += 1;
  if (req.url === "/fixture-registry-1.0.0.tgz") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(compressed);
    return;
  }
  res.writeHead(404);
  res.end("missing");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const { port } = server.address();
  const workspace = new MemoryPackageManagerWorkspace([
    ...readMounts(repoRoot, mountRoot, "vendor/cli/pnpm/9.15.9/package"),
    {
      path: "/workspace/project/package.json",
      data: JSON.stringify({
        name: "pnpm-registry-install-fixture",
        version: "0.0.0",
        private: true,
        scripts: {},
        dependencies: {
          "fixture-registry": `http://127.0.0.1:${port}/fixture-registry-1.0.0.tgz`
        }
      })
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
      ...entry,
      entry: `${mountRoot}/${path.relative(repoRoot, entry.entry)}`
    },
    args: ["install", "--ignore-scripts", "--store-dir", "/workspace/.pnpm-store"],
    cwd: "/workspace/project",
    env: {
      CI: "true",
      HOME: "/home/webcontainer",
      PNPM_HOME: "/home/webcontainer/.local/share/pnpm",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      npm_config_user_agent: `pnpm/${installed.version} node/v22.23.0 browser`
    }
  });

  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(requestCount >= 1, true);
  assert.equal(workspace.exists("/workspace/project/node_modules/fixture-registry/package.json"), true);
  assert.equal(workspace.readText("/workspace/project/node_modules/fixture-registry/index.js"), "module.exports = 'registry-ok';\n");
  assert.equal(workspace.exists("/workspace/project/node_modules/.bin/fixture-registry"), true);
  assert.match(workspace.readlink("/workspace/project/node_modules/fixture-registry"), /node_modules\/\.pnpm\/fixture-registry@http/);
  assert.match(workspace.readText("/workspace/project/pnpm-lock.yaml"), /specifier: http:\/\/127\.0\.0\.1:\d+\/fixture-registry-1\.0\.0\.tgz/);
  assert.match(workspace.readText("/workspace/project/node_modules/.modules.yaml"), /packageManager: pnpm@9\.15\.9/);
  assert.match(workspace.readText("/workspace/project/node_modules/.pnpm/lock.yaml"), /fixture-registry@http:\/\/127\.0\.0\.1:\d+\/fixture-registry-1\.0\.0\.tgz/);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("pnpm registry install cli module evaluation test ok");

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

function createTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeString(header, 0, 100, entry.path);
    writeString(header, 100, 8, entry.mode || "0000644");
    writeString(header, 108, 8, "0000000");
    writeString(header, 116, 8, "0000000");
    writeString(header, 124, 12, entry.body.byteLength.toString(8).padStart(11, "0"));
    writeString(header, 136, 12, "00000000000");
    for (let index = 148; index < 156; index += 1) header[index] = 0x20;
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
    writeString(header, 148, 6, checksum);
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, entry.body, new Uint8Array((512 - entry.body.byteLength % 512) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function writeString(bytes, offset, length, value) {
  for (let index = 0; index < Math.min(length, value.length); index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
