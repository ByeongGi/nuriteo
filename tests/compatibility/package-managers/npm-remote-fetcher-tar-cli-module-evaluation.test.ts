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
const compressed = gzip(createTar([
  {
    path: "package/package.json",
    body: new TextEncoder().encode('{"name":"fixture-registry","version":"1.0.0"}\n')
  },
  {
    path: "package/index.js",
    body: new TextEncoder().encode("module.exports = 'registry-ok';\n")
  }
]));
const server = http.createServer((req, res) => {
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
    ...readMounts(repoRoot, mountRoot, "vendor/cli/npm/10.9.2/package"),
    {
      path: "/workspace/remote-fetcher-cli/bin.js",
      data: `
        (async function run(process) {
          try {
            const RemoteFetcher = require("/workspace/vendor/cli/npm/10.9.2/package/node_modules/pacote/lib/remote.js");
            const protectedSymbols = require("/workspace/vendor/cli/npm/10.9.2/package/node_modules/pacote/lib/util/protected.js");
            const tar = require("/workspace/vendor/cli/npm/10.9.2/package/node_modules/cacache/node_modules/tar/dist/commonjs/index.js");
            const fetcher = new RemoteFetcher("http://127.0.0.1:${port}/fixture-registry-1.0.0.tgz", {
              cache: "/home/webcontainer/.npm/_cacache",
              npmBin: "/workspace/vendor/cli/npm/10.9.2/package/bin/npm-cli.js"
            });
            const stream = fetcher[protectedSymbols.tarballFromResolved]();
            const extractor = tar.x({ cwd: "/workspace/out", strip: 1, noChmod: true, noMtime: true, preserveOwner: false });
            extractor.on("end", () => process.stdout.write("remote-fetcher-tar-end\\n"));
            extractor.on("error", (error) => {
              process.stderr.write((error.stack || error.message) + "\\n");
              process.exitCode = 1;
            });
            stream.pipe(extractor);
          } catch (error) {
            process.stderr.write((error.stack || error.message) + "\\n");
            process.exitCode = 1;
          }
        })(process);
      `
    }
  ]);
  workspace.mkdir("/workspace/out");

  const result = await createAsyncCliModuleEvaluator({
    root: mountRoot,
    reader: workspace,
    writer: workspace,
    settleTicks: 5000,
    settleTimeoutMs: 5000
  })({
    entry: {
      name: "npm-remote-fetcher-tar-fixture",
      version: "0.0.0",
      entry: "/workspace/remote-fetcher-cli/bin.js"
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
  assert.equal(result.stdout, "remote-fetcher-tar-end\n");
  assert.equal(workspace.readText("/workspace/out/package.json"), '{"name":"fixture-registry","version":"1.0.0"}\n');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("npm remote fetcher tar cli module evaluation test ok");

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
    writeString(header, 100, 8, "0000644");
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
