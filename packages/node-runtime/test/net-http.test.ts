import assert from "node:assert/strict";

import { createHttpBuiltin, createLoopbackNetwork, netBuiltin } from "../../node-runtime/src/index.ts";

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

const websocketServer = net.listen(5173, () => ({ statusCode: 426, body: "Upgrade Required" }), {
  websocket(socket, request, context) {
    assert.equal(request.path, "/");
    assert.equal(context.protocol, "vite-hmr");
    socket.onmessage = (event) => socket.send(`echo:${event.data}`);
    socket.send(JSON.stringify({ type: "connected" }));
  }
});
const websocketMessages = [];
const websocket = net.connectWebSocket("ws://127.0.0.1:5173/", { protocol: "vite-hmr" });
websocket.onmessage = (event) => websocketMessages.push(event.data);
await Promise.resolve();
websocket.send("hello");
await Promise.resolve();
await Promise.resolve();
assert.equal(JSON.stringify(websocketMessages), JSON.stringify([JSON.stringify({ type: "connected" }), "echo:hello"]));
websocketServer.close();
assert.throws(
  () => net.connectWebSocket("ws://127.0.0.1:5173/", { protocol: "vite-hmr" }),
  (error) => error.code === "ECONNREFUSED"
);

const upgradeNetwork = createLoopbackNetwork();
const http = createHttpBuiltin(undefined, "http:", upgradeNetwork);
const upgradeServer = http.createServer((_request, response) => {
  response.writeHead(426);
  response.end("Upgrade Required");
});
const upgradeEvents = [];
upgradeServer.on("upgrade", (request, socket) => {
  upgradeEvents.push(`${request.url}:${request.headers["sec-websocket-protocol"]}`);
  socket.on("data", (frame) => {
    const payloadLength = frame[1] & 0x7f;
    const mask = frame.slice(2, 6);
    const payload = frame.slice(6, 6 + payloadLength).map((byte, index) => byte ^ mask[index % 4]);
    upgradeEvents.push(new TextDecoder().decode(payload));
  });
  socket.write(new Uint8Array([0x81, 0x07, ...new TextEncoder().encode("welcome")]));
});
upgradeServer.listen(5300, "127.0.0.1");
const upgradedMessages = [];
const upgradedSocket = upgradeNetwork.connectWebSocket("ws://127.0.0.1:5300/", { protocol: "vite-hmr" });
upgradedSocket.onmessage = (event) => upgradedMessages.push(event.data);
await Promise.resolve();
upgradedSocket.send("hello");
await Promise.resolve();
assert.equal(JSON.stringify(upgradeEvents), JSON.stringify(["/:vite-hmr", "hello"]));
assert.equal(JSON.stringify(upgradedMessages), JSON.stringify(["welcome"]));
upgradeServer.close();

const optionsNetwork = createLoopbackNetwork();
const optionsHttp = createHttpBuiltin(undefined, "http:", optionsNetwork);
const optionsServer = optionsHttp.createServer({}, (_request, response) => response.end("options"));
optionsServer.listen({ host: "127.0.0.1", port: 5301 });
assert.equal((await optionsNetwork.fetch("http://127.0.0.1:5301/")).body, "options");
optionsServer.close();

const nativeFetch = globalThis.fetch;
let browserCredentialBoundary: RequestInit | undefined;
try {
  globalThis.fetch = async (_input, init) => {
    browserCredentialBoundary = init;
    return new Response("credential-safe", { status: 200 });
  };
  const publicRuntimeHttp = createHttpBuiltin();
  const body = await new Promise<string>((resolve, reject) => {
    publicRuntimeHttp.get("https://app.example.test/api/v1/me", (runtimeResponse) => {
      const chunks: string[] = [];
      runtimeResponse.on("data", (chunk) => chunks.push(String(chunk)));
      runtimeResponse.on("end", () => resolve(chunks.join("")));
      runtimeResponse.on("error", reject);
    }).on("error", reject);
  });
  assert.equal(body, "credential-safe");
  assert.equal(browserCredentialBoundary?.credentials, "omit");
  assert.equal(browserCredentialBoundary?.referrerPolicy, "no-referrer");
} finally {
  globalThis.fetch = nativeFetch;
}

const probeServer = netBuiltin.createServer();
probeServer.listen({ host: "127.0.0.1", port: 5302 });
await Promise.resolve();
assert.deepEqual(probeServer.address(), { address: "127.0.0.1", family: "IPv4", port: 5302 });
probeServer.close();

console.log("node runtime net http test ok");
