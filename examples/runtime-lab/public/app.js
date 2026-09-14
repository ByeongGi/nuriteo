import { createContainer } from "/packages/sdk/src/container.ts";
import {
  createHmrClient,
  createPreviewRelay,
  createPreviewServiceWorker,
  createPreviewSessionRegistry
} from "/packages/preview/src/index.ts";

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const bootButton = document.getElementById("boot");
const teardownButton = document.getElementById("teardown");

let container = null;

function log(value) {
  const line = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  logEl.textContent += `${line}\n`;
}

function setStatus(status) {
  statusEl.textContent = status;
}

function ensureIsolated() {
  if (!crossOriginIsolated) {
    throw new Error("runtime-lab requires COOP/COEP isolation for SharedArrayBuffer");
  }
}

async function boot(options = {}) {
  ensureIsolated();
  await teardown();
  container = createContainer({
    systemWorkerUrl: new URL("/workers/system-worker.ts", location.href),
    processWorkerUrl: new URL("/workers/process-worker.ts", location.href),
    timeoutMs: 2500
  });
  setStatus("booting");
  try {
    const ready = await container.boot(options);
    setStatus(container.status);
    log(ready);
    return ready;
  } catch (error) {
    setStatus(container.status);
    throw error;
  }
}

async function teardown() {
  if (!container) {
    setStatus("stopped");
    return;
  }
  await container.teardown();
  setStatus(container.status);
  log("teardown complete");
  container = null;
}

async function runFsSmoke() {
  if (!container || container.status !== "ready") {
    await boot();
  }
  const run = await container.run("", { entrypoint: "fs-smoke", timeoutMs: 7000 });
  log(run);
  return run;
}

async function runPreviewSmoke() {
  const sessions = createPreviewSessionRegistry({ ttlMs: 1000 });
  const loopbackContainer = {
    async fetch(url, request) {
      return {
        statusCode: 200,
        headers: { "content-type": "text/plain", "x-method": request.method },
        body: `preview:${new URL(url).pathname}`
      };
    }
  };
  const session = sessions.create({
    origin: location.origin,
    projectId: "runtime-lab",
    port: 4173,
    container: loopbackContainer
  });
  const relay = createPreviewRelay({ sessions, timeoutMs: 250 });
  const serviceWorker = createPreviewServiceWorker({ relay });
  const ready = await serviceWorker.handleMessage({
    data: {
      type: "preview:handshake",
      clientId: "runtime-lab-client",
      sessionId: session.sessionId,
      origin: location.origin,
      projectId: "runtime-lab"
    }
  });
  const routed = await serviceWorker.handleMessage({
    data: {
      type: "preview:fetch",
      clientId: "runtime-lab-client",
      path: "/index.html",
      method: "GET"
    }
  });

  const sockets = [];
  const events = [];
  const hmr = createHmrClient({
    maxRetries: 1,
    connect() {
      const socket = {
        close() {
          this.onclose?.();
        },
        sendMessage(payload) {
          this.onmessage?.({ data: JSON.stringify(payload) });
        }
      };
      sockets.push(socket);
      return socket;
    }
  });
  hmr.on("open", (event) => events.push(`open:${event.attempt}`));
  hmr.on("message", (event) => events.push(`message:${event.type}`));
  hmr.on("close", () => events.push("close"));
  hmr.start();
  sockets[0].sendMessage({ type: "connected" });
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  sockets[1].sendMessage({ type: "update" });
  hmr.close();

  const result = { ready, routed, hmr: events };
  log(result);
  return result;
}

bootButton.addEventListener("click", () => {
  boot().catch((error) => {
    setStatus("failed");
    log(error.message);
  });
});

teardownButton.addEventListener("click", () => {
  teardown().catch((error) => log(error.message));
});

globalThis.__runtimeLab = {
  boot,
  runFsSmoke,
  runPreviewSmoke,
  systemMetrics: () => container?.systemMetrics() || null,
  teardown,
  status: () => statusEl.textContent,
  metrics: () => container?.metrics || null,
  log: () => logEl.textContent
};

setStatus(crossOriginIsolated ? "idle" : "isolation-missing");
