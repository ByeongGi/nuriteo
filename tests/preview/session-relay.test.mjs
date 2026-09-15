import assert from "node:assert/strict";

import {
  createPreviewRelay,
  createPreviewServiceWorker,
  createPreviewSessionRegistry
} from "../../packages/preview/src/index.ts";

let now = 1000;
const sessions = createPreviewSessionRegistry({ now: () => now, ttlMs: 100 });
const container = {
  async fetch(url, request) {
    if (url.endsWith("/slow")) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    }
    return {
      statusCode: 200,
      headers: { "x-preview": request.method },
      body: url
    };
  }
};
const session = sessions.create({
  origin: "https://preview.local",
  projectId: "project-a",
  port: 4173,
  container
});
now += 1;
const secondPort = sessions.create({
  origin: "https://preview.local",
  projectId: "project-a",
  port: 5173,
  container
});
now += 1;
const otherProject = sessions.create({
  origin: "https://preview.local",
  projectId: "project-b",
  port: 5173,
  container
});
assert.equal(sessions.find({ origin: "https://preview.local", projectId: "project-a", port: 5173 }).sessionId, secondPort.sessionId);
assert.deepEqual(
  sessions.list({ origin: "https://preview.local", projectId: "project-a" }).map((entry) => entry.port),
  [5173, 4173]
);
assert.equal(sessions.get(otherProject.sessionId, { projectId: "project-a" }), null);
const relay = createPreviewRelay({ sessions, timeoutMs: 10 });

const response = await relay.request({
  sessionId: session.sessionId,
  origin: "https://preview.local",
  projectId: "project-a",
  path: "/index.html"
});
assert.equal(response.statusCode, 200);
assert.equal(response.body, "http://127.0.0.1:4173/index.html");

await assert.rejects(
  relay.request({
    sessionId: session.sessionId,
    origin: "https://evil.local",
    projectId: "project-a"
  }),
  (error) => error.code === "ESTALESESSION"
);

now += 101;
assert.deepEqual(sessions.list({ origin: "https://preview.local" }), []);
await assert.rejects(
  relay.request({
    sessionId: session.sessionId,
    origin: "https://preview.local",
    projectId: "project-a"
  }),
  (error) => error.code === "ESTALESESSION"
);

const fresh = sessions.create({
  origin: "https://preview.local",
  projectId: "project-a",
  port: 4173,
  container
});
const unavailable = sessions.create({
  origin: "https://preview.local",
  projectId: "project-a",
  port: 5173,
  container: {
    async fetch() {
      const error = new Error("connection refused");
      error.code = "ECONNREFUSED";
      throw error;
    }
  }
});
await assert.rejects(
  relay.request({
    sessionId: unavailable.sessionId,
    origin: "https://preview.local",
    projectId: "project-a",
    path: "/index.html"
  }),
  (error) => error.code === "ENOSERVER"
);
await assert.rejects(
  relay.request({
    sessionId: fresh.sessionId,
    origin: "https://preview.local",
    projectId: "project-a",
    path: "/slow"
  }),
  (error) => error.code === "ETIMEOUT"
);

const serviceWorker = createPreviewServiceWorker({ relay });
const ready = await serviceWorker.handleMessage({
  data: {
    type: "preview:handshake",
    clientId: "client-1",
    sessionId: fresh.sessionId,
    origin: "https://preview.local",
    projectId: "project-a"
  }
});
assert.equal(ready.type, "preview:ready");
const routed = await serviceWorker.handleMessage({
  data: {
    type: "preview:fetch",
    clientId: "client-1",
    path: "/app.js",
    method: "GET"
  }
});
assert.equal(routed.type, "preview:response");

serviceWorker.restart();
const afterRestart = await serviceWorker.handleMessage({
  data: {
    type: "preview:fetch",
    clientId: "client-1",
    path: "/app.js"
  }
});
assert.equal(afterRestart.code, "ENOCLIENT");

console.log("preview session relay test ok");
