const PROTOCOL_VERSION = 1;
const MAX_RELAY_WAIT_MS = 10_000;
const MAX_PENDING_REQUESTS = 8;
const ACTIVE_SESSION_CACHE = "nuriteo-preview-active-v1";
let relay = null;
let relayBinding = null;
let relayGeneration = null;
let relayNonce = null;
let relayOwnerClientId = null;
let relayApplicationOrigin = null;
let sequence = 0;
const pending = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(ACTIVE_SESSION_CACHE);
    await cache.add(new Request("/runtime-preview/hmr.js", { cache: "reload" }));
    if (!self.registration.active) await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  const message = event.data;
  if (isExactRecord(message, ["binding", "generation", "type", "version"])
      && message.type === "nuriteo-preview:ping"
      && message.version === PROTOCOL_VERSION
      && message.binding === self.location.hostname.split(".")[0]
      && message.generation === runtimeIdFromBinding(message.binding)
      && event.ports.length === 1) {
    event.ports[0].postMessage({
      type: "nuriteo-preview:pong",
      version: PROTOCOL_VERSION,
      binding: message.binding,
      generation: message.generation,
      bound: relay !== null
    });
    event.ports[0].close();
    return;
  }
  if (!isExactRecord(message, ["applicationOrigin", "binding", "generation", "nonce", "type", "version"]) || event.ports.length !== 1) return;
  const source = event.source;
  if (message.type !== "nuriteo-preview:bind"
      || message.version !== PROTOCOL_VERSION
      || !validBinding(message.binding)
      || message.binding !== self.location.hostname.split(".")[0]
      || message.generation !== runtimeIdFromBinding(message.binding)
      || !/^[0-9a-f]{32}$/.test(message.nonce)
      || !validApplicationOrigin(message.applicationOrigin)
      || !source
      || typeof source.id !== "string"
      || !validBootstrapClient(source.url)
      || relay !== null) return;
  relay = event.ports[0];
  relayBinding = message.binding;
  relayGeneration = message.generation;
  relayNonce = message.nonce;
  relayOwnerClientId = source.id;
  relayApplicationOrigin = message.applicationOrigin;
  relay.onmessage = receiveRelayMessage;
  relay.start();
});
self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname === "/runtime-preview/hmr.js") {
    event.respondWith(caches.match(event.request).then((response) => response ?? new Response("Preview session asset unavailable", { status: 503 })));
    return;
  }
  if (requestUrl.origin !== self.location.origin || !relay || !relayBinding) return;
  event.respondWith(relayFetch(event.request));
});

function receiveRelayMessage(event) {
  const message = event.data;
  if (isExactRecord(message, ["binding", "generation", "nonce", "path", "sequence", "type", "version"])
      && message.type === "nuriteo-preview:hmr"
      && message.version === PROTOCOL_VERSION
      && message.binding === relayBinding
      && message.generation === relayGeneration
      && message.nonce === relayNonce
      && typeof message.path === "string"
      && /^src\/(?!.*\.\.)[^\\]{1,508}$/.test(message.path)
      && Number.isSafeInteger(message.sequence)
      && message.sequence > 0) {
    void notifyControlledWindows({ type: "nuriteo-preview:hmr", version: PROTOCOL_VERSION, binding: relayBinding, generation: relayGeneration, path: message.path, sequence: message.sequence });
    return;
  }
  if (isExactRecord(message, ["binding", "generation", "nonce", "type", "version"])
      && message.type === "nuriteo-preview:dispose"
      && message.version === PROTOCOL_VERSION
      && message.binding === relayBinding
      && message.generation === relayGeneration
      && message.nonce === relayNonce) {
    void disposeRelay();
    return;
  }
  if (isExactRecord(message, ["binding", "generation", "nonce", "type", "version"])
      && message.type === "nuriteo-preview:ready"
      && message.version === PROTOCOL_VERSION
      && message.binding === relayBinding
      && message.generation === relayGeneration
      && message.nonce === relayNonce) {
    void notifyOwner({ type: "nuriteo-preview:relay-ready", version: PROTOCOL_VERSION, binding: relayBinding, generation: relayGeneration, nonce: relayNonce });
    return;
  }
  if (!isExactRecord(message, ["body", "headers", "id", "status", "type", "version"]) || message.type !== "nuriteo-preview:response" || message.version !== PROTOCOL_VERSION) return;
  const request = pending.get(message.id);
  if (!request) return;
  const response = relayResponse(message, request);
  pending.delete(message.id);
  clearTimeout(request.timeout);
  request.resolve(response);
}

function relayFetch(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return Promise.resolve(new Response("Method not allowed", { status: 405 }));
  if (pending.size >= MAX_PENDING_REQUESTS) return Promise.resolve(new Response("Preview relay capacity exceeded", { status: 429 }));
  const id = `${relayBinding}:${++sequence}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      resolve(new Response("Preview relay timed out", { status: 504 }));
    }, MAX_RELAY_WAIT_MS);
    pending.set(id, { resolve, timeout, head: request.method === "HEAD", navigation: request.mode === "navigate" });
    const url = new URL(request.url);
    relay.postMessage({
      type: "nuriteo-preview:request",
      version: PROTOCOL_VERSION,
      binding: relayBinding,
      id,
      method: request.method,
      destination: request.destination,
      path: `${url.pathname}${url.search}`
    });
  });
}

function relayResponse(message, request) {
  try {
    if (!(message.body instanceof ArrayBuffer) || !validStatus(message.status)) throw new Error("invalid relay response");
    const nullBody = request.head || message.status === 204 || message.status === 205 || message.status === 304;
    return new Response(nullBody ? null : message.body, {
      status: message.status,
      headers: responseHeaders(message.headers, request.navigation)
    });
  } catch {
    return new Response("Preview relay response rejected", {
      status: 502,
      headers: responseHeaders({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, request.navigation)
    });
  }
}

function responseHeaders(value, navigation) {
  const headers = new Headers();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (typeof value["content-type"] === "string") headers.set("Content-Type", value["content-type"]);
    if (typeof value["cache-control"] === "string") headers.set("Cache-Control", value["cache-control"]);
  }
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  if (navigation) {
    const nonce = typeof value?.["x-nuriteo-script-nonce"] === "string" && /^[A-Za-z0-9_-]{22}$/.test(value["x-nuriteo-script-nonce"])
      ? value["x-nuriteo-script-nonce"]
      : null;
    headers.set("Content-Security-Policy", `default-src 'none'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'self' ${relayApplicationOrigin}; base-uri 'none'; form-action 'none'`);
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
  }
  return headers;
}

function validBinding(value) {
  return typeof value === "string" && /^r-[a-z2-7]{45}-p[1-9][0-9]{0,4}$/.test(value);
}

function runtimeIdFromBinding(value) {
  return /^r-([a-z2-7]{45})-p[1-9][0-9]{0,4}$/.exec(value)?.[1];
}

function validStatus(value) {
  return Number.isInteger(value) && value >= 200 && value <= 599;
}

function rejectPending() {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.resolve(new Response("Preview relay replaced", { status: 410 }));
  }
  pending.clear();
}

async function disposeRelay() {
  const current = relay;
  rejectPending();
  const message = { type: "nuriteo-preview:disposed", version: PROTOCOL_VERSION, binding: relayBinding, generation: relayGeneration, nonce: relayNonce };
  relay = null;
  relayBinding = null;
  relayGeneration = null;
  relayNonce = null;
  relayOwnerClientId = null;
  relayApplicationOrigin = null;
  await caches.delete(ACTIVE_SESSION_CACHE);
  await self.registration.unregister();
  current?.postMessage(message);
  current?.close();
}

async function notifyOwner(message) {
  const client = relayOwnerClientId ? await self.clients.get(relayOwnerClientId) : null;
  client?.postMessage(message);
}

async function notifyControlledWindows(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: false, type: "window" });
  for (const client of clients) {
    try {
      const url = new URL(client.url);
      if (url.origin === self.location.origin && url.pathname === "/") client.postMessage(message);
    } catch { /* ignore invalid client metadata */ }
  }
}

function validApplicationOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}

function validBootstrapClient(value) {
  try {
    const url = new URL(value);
    return url.origin === self.location.origin && url.pathname === "/runtime-preview/bootstrap" && !url.search && !url.hash;
  } catch { return false; }
}

function isExactRecord(value, keys) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
