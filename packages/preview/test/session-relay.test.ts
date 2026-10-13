import assert from "node:assert/strict";

import {
  createPreviewUrl,
  createPreviewRelay,
  createPreviewServiceWorker,
  createPreviewSessionRegistry
} from "../../preview/src/index.ts";

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
const secondContainer = {
  async fetch(url) {
    return {
      statusCode: 200,
      headers: { "x-preview": "second" },
      body: `second:${url}`
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
assert.equal(session.baseUrl, "https://preview.local/__preview/project-a/4173/");
assert.equal(session.serverState, "running");
assert.equal(session.lastErrorCode, null);
assert.equal(createPreviewUrl(session, "/index.html"), "https://preview.local/__preview/project-a/4173/index.html");
assert.equal(createPreviewUrl(secondPort, "src/main.js"), "https://preview.local/__preview/project-a/5173/src/main.js");
const moved = sessions.replace(secondPort.sessionId, { port: 6173 });
assert.equal(moved.baseUrl, "https://preview.local/__preview/project-a/6173/");
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
assert.equal(sessions.get(unavailable.sessionId).serverState, "stopped");
assert.equal(sessions.get(unavailable.sessionId).lastErrorCode, "ENOSERVER");
sessions.replace(unavailable.sessionId, { container });
const afterServerRestart = await relay.request({
  sessionId: unavailable.sessionId,
  origin: "https://preview.local",
  projectId: "project-a",
  path: "/index.html"
});
assert.equal(afterServerRestart.statusCode, 200);
assert.equal(sessions.get(unavailable.sessionId).serverState, "running");
assert.equal(sessions.get(unavailable.sessionId).lastErrorCode, null);
await assert.rejects(
  relay.request({
    sessionId: fresh.sessionId,
    origin: "https://preview.local",
    projectId: "project-a",
    path: "/slow"
  }),
  (error) => error.code === "ETIMEOUT"
);

const serviceWorker = createPreviewServiceWorker({ relay, now: () => now });
const clientOneMessages = [];
const ready = await serviceWorker.handleMessage({
  data: {
    type: "preview:handshake",
    clientId: "client-1",
    sessionId: fresh.sessionId,
    origin: "https://preview.local",
    projectId: "project-a"
  },
  port: { postMessage: (message) => clientOneMessages.push(message) }
});
assert.equal(ready.type, "preview:ready");
assert.equal(clientOneMessages[0].type, "preview:ready");
const secondLivePort = sessions.create({
  origin: "https://preview.local",
  projectId: "project-a",
  port: 6173,
  container: secondContainer
});
const clientTwoMessages = [];
const secondReady = await serviceWorker.handleMessage({
  data: {
    type: "preview:handshake",
    clientId: "client-2",
    sessionId: secondLivePort.sessionId,
    origin: "https://preview.local",
    projectId: "project-a"
  },
  port: { postMessage: (message) => clientTwoMessages.push(message) }
});
assert.equal(secondReady.type, "preview:ready");
const logged = await serviceWorker.handleMessage({
  data: {
    type: "preview:console",
    clientId: "client-1",
    level: "warn",
    message: "vite warning"
  }
});
assert.equal(logged.type, "preview:ready");
assert.equal(clientOneMessages.at(-1).type, "preview:overlay");
assert.equal(clientOneMessages.at(-1).clientId, "client-1");
assert.equal(clientOneMessages.at(-1).diagnostic.message, "vite warning");
assert.equal(clientTwoMessages.length, 1);
const buildDiagnostic = await serviceWorker.handleMessage({
  data: {
    type: "preview:error-diagnostic",
    clientId: "client-1",
    source: "build",
    code: "EVITEBUILD",
    message: "Unexpected token",
    file: "/workspace/app/src/App.jsx",
    line: 7,
    column: 12,
    stack: "App.jsx:7:12"
  }
});
assert.equal(buildDiagnostic.type, "preview:ready");
assert.equal(clientOneMessages.at(-1).type, "preview:overlay");
assert.equal(clientOneMessages.at(-1).diagnostic.source, "build");
assert.equal(clientOneMessages.at(-1).diagnostic.file, "/workspace/app/src/App.jsx");
assert.equal(clientOneMessages.at(-1).diagnostic.line, 7);
assert.deepEqual(clientOneMessages.at(-1).diagnostic.recoveryActions, [
  { kind: "open-file", label: "Open file", path: "/workspace/app/src/App.jsx" },
  { kind: "rerun-build", label: "Rerun build", command: "npm run build" }
]);
const routed = await serviceWorker.handleMessage({
  data: {
    type: "preview:fetch",
    clientId: "client-1",
    path: "/app.js",
    method: "GET"
  }
});
assert.equal(routed.type, "preview:response");
assert.equal(routed.response.body, "http://127.0.0.1:4173/app.js");
const secondRouted = await serviceWorker.handleMessage({
  data: {
    type: "preview:fetch",
    clientId: "client-2",
    path: "/app.js",
    method: "GET"
  }
});
assert.equal(secondRouted.type, "preview:response");
assert.equal(secondRouted.response.body, "second:http://127.0.0.1:6173/app.js");

serviceWorker.restart();
const afterRestart = await serviceWorker.handleMessage({
  data: {
    type: "preview:fetch",
    clientId: "client-1",
    path: "/app.js"
  }
});
assert.equal(afterRestart.code, "ENOCLIENT");
assert.equal(clientOneMessages.at(-1).type, "preview:overlay");
assert.equal(clientOneMessages.at(-1).state.lastError.code, "ENOCLIENT");
const overlay = serviceWorker.overlayState("client-1");
assert.deepEqual(overlay.diagnostics.map((entry) => `${entry.source}:${entry.level}:${entry.message}`), [
  "console:warn:vite warning",
  "build:error:Unexpected token",
  "service-worker:error:ENOCLIENT"
]);
assert.equal(overlay.lastError.code, "ENOCLIENT");

console.log("preview session relay test ok");
