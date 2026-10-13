import assert from "node:assert/strict";
import http from "node:http";

import { FetchPolicy, HostFetcher } from "../../../packages/browser-host/src/index.ts";
import { createHttpClient, gunzip, gzip, integritySha512, sha256Hex } from "../../../packages/node-runtime/src/index.ts";

const packageBytes = new TextEncoder().encode("package tarball bytes".repeat(4096));
const compressedBytes = gzip(packageBytes);

const server = http.createServer((req, res) => {
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/package.tgz" });
    res.end();
    return;
  }
  if (req.url === "/package.tgz") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(packageBytes);
    return;
  }
  if (req.url === "/compressed.tgz") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(compressedBytes);
    return;
  }
  if (req.url === "/unauthorized") {
    res.writeHead(401, { "www-authenticate": "Bearer" });
    res.end("auth required");
    return;
  }
  if (req.url === "/slow") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      res.write(new Uint8Array(1024));
      if (sent === 64) {
        clearInterval(timer);
        res.end();
      }
    }, 10);
    req.on("close", () => clearInterval(timer));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const fetcher = new HostFetcher({
    policy: new FetchPolicy({
      allowedHosts: [`127.0.0.1:${port}`],
      maxBytes: packageBytes.byteLength * 2
    })
  });
  const client = createHttpClient(fetcher);

  const [direct, redirected, unauthorized, missing] = await Promise.all([
    client.get(`${origin}/package.tgz`, { integrity: integritySha512(packageBytes) }),
    client.get(`${origin}/redirect`),
    client.get(`${origin}/unauthorized`),
    client.get(`${origin}/missing`)
  ]);

  assert.equal(direct.status, 200);
  assert.equal(direct.sha256, sha256Hex(packageBytes));
  assert.equal(redirected.redirected, true);
  assert.equal(redirected.redirects[0].status, 302);
  assert.equal(unauthorized.status, 401);
  assert.equal(missing.status, 404);

  const compressed = await client.get(`${origin}/compressed.tgz`);
  assert.deepEqual(gunzip(compressed.body), Buffer.from(packageBytes));

  await assert.rejects(
    client.get(`${origin}/package.tgz`, { integrity: "sha512-bad" }),
    (error) => error.code === "EINTEGRITY"
  );
  await assert.rejects(
    client.get(`${origin}/package.tgz`, { maxBytes: 16 }),
    (error) => error.code === "ETOOBIG"
  );
  await assert.rejects(
    client.get(`${origin}/slow`, { timeoutMs: 5 }),
    (error) => error.code === "FETCH_TIMEOUT"
  );
  await assert.rejects(
    client.get("https://registry.npmjs.org/npm"),
    (error) => error.name === "FetchPolicyError"
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("package manager fetcher test ok");
