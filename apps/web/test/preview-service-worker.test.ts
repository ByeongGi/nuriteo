import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const runtimeId = "a".repeat(45);
const binding = `r-${runtimeId}-p4173`;
const origin = `https://${binding}.preview.example.test`;
const listeners = new Map<string, (event: Record<string, unknown>) => void>();
const ownerMessages: unknown[] = [];
const owner = {
  id: "bootstrap-client",
  url: `${origin}/runtime-preview/bootstrap`,
  postMessage(value: unknown) { ownerMessages.push(value); }
};
const registration = {
  active: null,
  async unregister() { return true; }
};
const workerGlobal = {
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) { listeners.set(type, listener); },
  clients: {
    async claim() { return undefined; },
    async get(id: string) { return id === owner.id ? owner : undefined; },
    async matchAll() { return []; }
  },
  location: new URL(`${origin}/runtime-preview/sw.js`),
  registration,
  skipWaiting: async () => undefined
};
vm.runInNewContext(fs.readFileSync(new URL("../public/runtime-preview/sw.js", import.meta.url), "utf8"), {
  ArrayBuffer,
  Headers,
  Map,
  Number,
  Promise,
  RegExp,
  Response,
  URL,
  clearTimeout,
  console,
  self: workerGlobal,
  setTimeout
});

const channel = new MessageChannel();
listeners.get("message")?.({
  data: {
    type: "nuriteo-preview:bind",
    version: 1,
    applicationOrigin: "https://app.example.test",
    binding,
    generation: runtimeId,
    nonce: "a".repeat(32)
  },
  ports: [channel.port1],
  source: owner
});
channel.port2.start();
channel.port2.postMessage({
  type: "nuriteo-preview:ready",
  version: 1,
  binding,
  generation: runtimeId,
  nonce: "a".repeat(32)
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(ownerMessages.length, 1);

for (const status of [204, 205, 304]) {
  const response = await relayFetch(status, new ArrayBuffer(0), "GET");
  assert.equal(response.status, status);
  assert.equal(await response.text(), "");
}
const head = await relayFetch(200, new TextEncoder().encode("must be discarded").buffer, "HEAD");
assert.equal(head.status, 200);
assert.equal(await head.text(), "");
const malformed = await relayFetch(200, "not-an-array-buffer", "GET");
assert.equal(malformed.status, 502);
assert.equal(await malformed.text(), "Preview relay response rejected");
channel.port1.close();
channel.port2.close();

async function relayFetch(status: number, body: unknown, method: "GET" | "HEAD"): Promise<Response> {
  let responsePromise: Promise<Response> | undefined;
  const requestMessage = new Promise<Record<string, unknown>>((resolve) => {
    channel.port2.onmessage = (event) => resolve(event.data as Record<string, unknown>);
  });
  listeners.get("fetch")?.({
    request: new Request(`${origin}/fixture`, { method }),
    respondWith(value: Promise<Response>) { responsePromise = value; }
  });
  const request = await requestMessage;
  channel.port2.postMessage({
    type: "nuriteo-preview:response",
    version: 1,
    id: request.id,
    status,
    headers: { "content-type": "text/plain" },
    body
  });
  assert(responsePromise);
  return responsePromise;
}
