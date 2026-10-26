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

const burstMessages: Record<string, unknown>[] = [];
channel.port2.onmessage = (event) => burstMessages.push(event.data as Record<string, unknown>);
const burstResponses: Array<Promise<Response>> = [];
for (let index = 0; index < 20; index += 1) {
  listeners.get("fetch")?.({
    request: new Request(`${origin}/mod-${index}`),
    respondWith(value: Promise<Response>) { burstResponses.push(value); }
  });
}
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(burstMessages.length, 8, "a module burst must wait behind the pending cap instead of failing");
while (burstMessages.length > 0 || burstResponses.length < 20) {
  const batch = burstMessages.splice(0);
  assert.ok(batch.length > 0);
  for (const request of batch) {
    channel.port2.postMessage({
      type: "nuriteo-preview:response",
      version: 1,
      id: request.id,
      status: 200,
      headers: { "content-type": "text/plain" },
      body: new ArrayBuffer(0)
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.deepEqual(await Promise.all(burstResponses.map(async (response) => (await response).status)), Array.from({ length: 20 }, () => 200));

const overflowResponses: Array<Promise<Response>> = [];
for (let index = 0; index < 8 + 1024 + 1; index += 1) {
  listeners.get("fetch")?.({
    request: new Request(`${origin}/overflow-${index}`),
    respondWith(value: Promise<Response>) { overflowResponses.push(value); }
  });
}
await new Promise((resolve) => setTimeout(resolve, 0));
const overflowStatus = await Promise.race([
  Promise.any(overflowResponses.map(async (response) => {
    const status = (await response).status;
    if (status !== 429) return new Promise<number>(() => undefined);
    return status;
  })),
  new Promise<number>((resolve) => setTimeout(() => resolve(0), 500))
]);
assert.equal(overflowStatus, 429);
channel.port1.close();
channel.port2.close();

const cachedAssets = new Map<string, string>();
const cacheListeners = new Map<string, (event: Record<string, unknown>) => void>();
class PreviewAssetRequest {
  url: string;
  constructor(input: string) {
    this.url = new URL(input, origin).href;
  }
}
const previewCaches = {
  async open() {
    return {
      async add(request: PreviewAssetRequest) {
        cachedAssets.set(new URL(request.url).pathname, `cached:${request.url}`);
      }
    };
  },
  async match(request: Request) {
    const body = cachedAssets.get(new URL(request.url).pathname);
    return body === undefined ? undefined : new Response(body, { status: 200 });
  }
};
const cacheGlobal = {
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) { cacheListeners.set(type, listener); },
  clients: { async claim() { return undefined; } },
  location: new URL(`${origin}/runtime-preview/sw.js`),
  registration: { active: null, async unregister() { return true; } },
  skipWaiting: async () => undefined
};
vm.runInNewContext(fs.readFileSync(new URL("../public/runtime-preview/sw.js", import.meta.url), "utf8"), {
  ArrayBuffer,
  Headers,
  Map,
  Number,
  Promise,
  RegExp,
  Request: PreviewAssetRequest,
  Response,
  URL,
  caches: previewCaches,
  clearTimeout,
  console,
  self: cacheGlobal,
  setTimeout
});
const installDone = new Promise<void>((resolve, reject) => {
  cacheListeners.get("install")?.({ waitUntil(value: Promise<void>) { value.then(resolve, reject); } });
});
await installDone;
assert.equal(cachedAssets.has("/runtime-preview/console-bridge.js"), true);
let consoleBridgeResponse: Promise<Response> | undefined;
cacheListeners.get("fetch")?.({
  request: new Request(`${origin}/runtime-preview/console-bridge.js`),
  respondWith(value: Promise<Response>) { consoleBridgeResponse = value; }
});
assert.equal(await (await consoleBridgeResponse)?.text(), `cached:${origin}/runtime-preview/console-bridge.js`);

const consoleMessages: Array<{ origin: string; value: Record<string, unknown> }> = [];
const consoleWindow = {
  __nuriteoPreviewConsole: false,
  addEventListener(type: string, listener: (event: { error?: unknown; message?: string; reason?: unknown }) => void) {
    consoleWindow.listeners.set(type, listener);
  },
  listeners: new Map<string, (event: { error?: unknown; message?: string; reason?: unknown }) => void>(),
  location: { origin: "https://preview.example.test" },
  parent: {
    postMessage(value: Record<string, unknown>, targetOrigin: string) {
      consoleMessages.push({ origin: targetOrigin, value });
    }
  }
};
const previewConsole = { error(..._args: unknown[]) { /* original sink */ } };
vm.runInNewContext(fs.readFileSync(new URL("../public/runtime-preview/console-bridge.js", import.meta.url), "utf8"), {
  Date,
  Error,
  JSON,
  String,
  console: previewConsole,
  window: consoleWindow
});
previewConsole.error("studio-console-check");
previewConsole.error("studio-console-check");
const failure = new Error("render failed");
previewConsole.error(failure);
consoleWindow.listeners.get("unhandledrejection")?.({ reason: "rejected-promise" });
assert.equal(consoleMessages.length, 3);
assert.equal(consoleMessages[0]?.origin, "https://preview.example.test");
assert.equal(consoleMessages[0]?.value.level, "error");
assert.equal(consoleMessages[0]?.value.message, "studio-console-check");
assert.equal(consoleMessages[0]?.value.stack, "");
assert.equal(consoleMessages[0]?.value.type, "nuriteo-preview:console");
assert.equal(consoleMessages[0]?.value.version, 1);
assert.equal(consoleMessages[1]?.value.message, "render failed");
assert.match(String(consoleMessages[1]?.value.stack), /render failed/u);
assert.equal(consoleMessages[2]?.value.message, "rejected-promise");

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
