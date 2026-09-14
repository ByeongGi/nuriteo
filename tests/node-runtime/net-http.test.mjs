import assert from "node:assert/strict";

import { createLoopbackNetwork } from "../../packages/node-runtime/src/index.ts";

const net = createLoopbackNetwork({ maxBytes: 128 * 1024 });
const server = net.listen(4173, async (request) => {
  if (request.path === "/large") {
    return {
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: "x".repeat(64 * 1024)
    };
  }
  if (request.path === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { statusCode: 200, body: "late" };
  }
  return {
    statusCode: 200,
    headers: { "x-method": request.method },
    body: `echo:${request.path}:${request.body}`
  };
});

const response = await net.fetch("http://127.0.0.1:4173/hello", { method: "POST", body: "body" });
assert.equal(response.statusCode, 200);
assert.equal(response.headers["x-method"], "POST");
assert.equal(response.body, "echo:/hello:body");

const large = await net.fetch("http://127.0.0.1:4173/large");
assert.equal(large.body.length, 64 * 1024);

await assert.rejects(
  net.fetch("http://127.0.0.1:4173/large", { maxBytes: 1024 }),
  (error) => error.code === "ETOOBIG"
);

const controller = new AbortController();
const pending = net.fetch("http://127.0.0.1:4173/slow", { signal: controller.signal });
controller.abort();
await assert.rejects(pending, (error) => error.code === "ECONNABORTED");

server.close();
await assert.rejects(
  net.fetch("http://127.0.0.1:4173/hello"),
  (error) => error.code === "ECONNREFUSED"
);

const relistened = net.listen(4173, () => ({ statusCode: 204, statusText: "No Content" }));
const empty = await net.fetch("http://127.0.0.1:4173/again");
assert.equal(empty.statusCode, 204);
relistened.close();

console.log("node runtime net http test ok");

