import assert from "node:assert/strict";
import http from "node:http";

import { FetchPolicy, HostFetcher } from "../../../packages/browser-host/src/index.ts";
import {
  createHttpClient,
  createPackageTarballCache,
  extractTarEntries,
  gzip,
  integritySha512
} from "../../../packages/node-runtime/src/index.ts";

const tarball = createTar([
  { path: "package/package.json", body: new TextEncoder().encode('{"name":"fixture","version":"1.0.0"}\n') },
  { path: "package/index.js", body: new TextEncoder().encode("module.exports = 'ok'\n") }
]);
const compressed = gzip(tarball);
let requests = 0;

const server = http.createServer((req, res) => {
  requests += 1;
  if (req.url === "/fixture.tgz") {
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
  const origin = `http://127.0.0.1:${port}`;
  const client = createHttpClient(new HostFetcher({
    policy: new FetchPolicy({
      allowedHosts: [`127.0.0.1:${port}`],
      maxBytes: compressed.byteLength * 2
    })
  }));
  const cache = createPackageTarballCache({ maxEntries: 1 });
  const integrity = integritySha512(compressed);

  const cold = await cache.get(client, `${origin}/fixture.tgz`, {
    cacheKey: "fixture@1.0.0",
    integrity,
    retries: 1
  });
  assert.equal(cold.cacheHit, false);
  assert.equal(cold.integrity, integrity);
  assert.equal(cache.metrics.downloads, 1);
  assert.equal(requests, 1);

  const warm = await cache.get(client, `${origin}/fixture.tgz`, {
    cacheKey: "fixture@1.0.0",
    integrity,
    offline: true
  });
  assert.equal(warm.cacheHit, true);
  assert.equal(requests, 1);
  assert.equal(cache.metrics.hits, 1);

  const entries = extractTarEntries(warm.body);
  assert.deepEqual(entries.map((entry) => entry.path), ["package/package.json", "package/index.js"]);
  assert.equal(new TextDecoder().decode(entries[1].body), "module.exports = 'ok'\n");

  await cache.get(client, `${origin}/fixture.tgz`, {
    cacheKey: "fixture-copy@1.0.0",
    integrity
  });
  assert.equal(cache.metrics.evictions, 1);

  await assert.rejects(
    cache.get(client, `${origin}/fixture.tgz`, {
      cacheKey: "fixture@1.0.0",
      offline: true
    }),
    (error) => error.code === "ECACHEMISS"
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("package tarball cache test ok");

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
