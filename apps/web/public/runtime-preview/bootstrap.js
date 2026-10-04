const PROTOCOL_VERSION = 1;
const RUNTIME_ID = /^[a-z2-7]{45}$/;
const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_TIMEOUT_MS = 500;

void boot().catch(() => renderFailure("Preview connection could not be established."));

async function boot() {
  const applicationOrigin = readMeta("nuriteo-application-origin");
  const binding = readMeta("nuriteo-preview-binding");
  const generation = readMeta("nuriteo-runtime-id");
  if (!RUNTIME_ID.test(generation)) throw new Error("invalid runtime binding");

  const registration = await navigator.serviceWorker.register("/runtime-preview/sw.js", {
    scope: "/",
    updateViaCache: "none"
  });
  await navigator.serviceWorker.ready;
  await waitForController();

  let connecting = null;
  let consecutiveFailures = 0;
  const ensureRelay = async () => {
    if (connecting) return connecting;
    connecting = (async () => {
      const worker = navigator.serviceWorker.controller ?? registration.active;
      if (!worker) throw new Error("Preview service worker is unavailable");
      if (await relayIsBound(worker, binding, generation)) {
        consecutiveFailures = 0;
        return;
      }
      await connectRelay(worker, applicationOrigin, binding, generation);
      consecutiveFailures = 0;
    })().catch((error) => {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) {
        window.parent.postMessage({
          type: "nuriteo-preview:recovery-required",
          version: PROTOCOL_VERSION,
          binding,
          generation
        }, applicationOrigin);
      }
      throw error;
    }).finally(() => { connecting = null; });
    return connecting;
  };
  await ensureRelay();
  mountProjectFrame();
  setInterval(() => { void ensureRelay().catch(() => undefined); }, HEARTBEAT_INTERVAL_MS);
  navigator.serviceWorker.addEventListener("controllerchange", () => { void ensureRelay().catch(() => undefined); });
}

async function connectRelay(worker, applicationOrigin, binding, generation) {
  const relay = new MessageChannel();
  const nonce = randomHex(16);
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Preview connection timed out")), 10_000);
    navigator.serviceWorker.addEventListener("message", function receive(event) {
      const message = event.data;
      if (!isExactRecord(message, ["binding", "generation", "nonce", "type", "version"])) return;
      if (message.type !== "nuriteo-preview:relay-ready" || message.version !== PROTOCOL_VERSION || message.binding !== binding || message.generation !== generation || message.nonce !== nonce) return;
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("message", receive);
      resolve();
    });
  });
  window.parent.postMessage({ type: "nuriteo-preview:connect", version: PROTOCOL_VERSION, binding, generation, nonce }, applicationOrigin, [relay.port1]);
  worker.postMessage({ type: "nuriteo-preview:bind", version: PROTOCOL_VERSION, applicationOrigin, binding, generation, nonce }, [relay.port2]);
  await ready;
}

async function relayIsBound(worker, binding, generation) {
  const channel = new MessageChannel();
  const result = new Promise((resolve) => {
    const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, HEARTBEAT_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      const message = event.data;
      resolve(isExactRecord(message, ["binding", "bound", "generation", "type", "version"])
        && message.type === "nuriteo-preview:pong"
        && message.version === PROTOCOL_VERSION
        && message.binding === binding
        && message.generation === generation
        && message.bound === true);
      channel.port1.close();
    };
  });
  worker.postMessage({ type: "nuriteo-preview:ping", version: PROTOCOL_VERSION, binding, generation }, [channel.port2]);
  return await result;
}

function mountProjectFrame() {
  if (document.querySelector("#nuriteo-preview-frame")) return;
  document.body.textContent = "";
  const frame = document.createElement("iframe");
  frame.id = "nuriteo-preview-frame";
  frame.title = "Project Preview";
  frame.referrerPolicy = "no-referrer";
  frame.src = "/";
  document.body.append(frame);
}

async function waitForController() {
  if (navigator.serviceWorker.controller) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Preview service worker control timed out")), 10_000);
    navigator.serviceWorker.addEventListener("controllerchange", function changed() {
      if (!navigator.serviceWorker.controller) return;
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      resolve();
    });
  });
}

function readMeta(name) {
  const value = document.querySelector(`meta[name="${name}"]`)?.content;
  if (!value) throw new Error("Preview bootstrap metadata is missing");
  return value;
}

function randomHex(bytes) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function renderFailure(message) {
  document.body.textContent = message;
}

function isExactRecord(value, keys) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
