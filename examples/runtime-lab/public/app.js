import { createContainer } from "/packages/sdk/src/container.ts";
import { createTerminalSession } from "/packages/node-runtime/src/shell/index.ts";
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
const terminalForm = document.getElementById("terminal-form");
const terminalInput = document.getElementById("terminal-command");
const terminalRunButton = document.getElementById("terminal-run");
const terminalCancelButton = document.getElementById("terminal-cancel");
const terminalRestartButton = document.getElementById("terminal-restart");
const terminalStatusEl = document.getElementById("terminal-status");
const terminalLogEl = document.getElementById("terminal-log");
const terminalHistoryEl = document.getElementById("terminal-history");

let container = null;
let terminal = createLabTerminal();

function log(value) {
  const line = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  logEl.textContent += `${line}\n`;
}

function setStatus(status) {
  statusEl.textContent = status;
}

function setTerminalStatus(status) {
  terminalStatusEl.textContent = status;
}

function appendTerminalOutput(value) {
  terminalLogEl.textContent += value;
  terminalLogEl.scrollTop = terminalLogEl.scrollHeight;
}

function renderTerminalTranscript() {
  const transcript = terminal.transcript();
  terminalHistoryEl.replaceChildren(
    ...transcript.map((entry) => {
      const item = document.createElement("li");
      item.textContent = `$ ${entry.command} -> ${entry.status}${entry.exitCode === null ? "" : ` (${entry.exitCode})`}`;
      return item;
    })
  );
}

function createLabTerminal() {
  return createTerminalSession({
    onChunk(chunk) {
      appendTerminalOutput(chunk.data);
    },
    commands: {
      echo({ argv }) {
        return { stdout: `${argv.slice(1).join(" ")}\n`, stderr: "", exitCode: 0 };
      },
      npm({ argv }) {
        return packageManagerCommand("npm", argv.slice(1));
      },
      pnpm({ argv }) {
        return packageManagerCommand("pnpm", argv.slice(1));
      },
      vite({ argv }) {
        return viteCommand(argv.slice(1));
      },
      sleep({ signal }) {
        return cancellableDelay(signal);
      }
    }
  });
}

function packageManagerCommand(manager, args) {
  const action = args.join(" ") || "--help";
  if (action === "install") {
    return {
      stdout: `${manager} install\nresolved 3 packages\nlinked node_modules/.bin/vite\n`,
      stderr: "",
      exitCode: 0
    };
  }
  if (action === "run dev" || action === "dev") {
    return { stdout: `${manager} run dev\nvite dev server ready at http://127.0.0.1:5173\n`, stderr: "", exitCode: 0 };
  }
  if (action === "run build" || action === "build") {
    return { stdout: `${manager} run build\nvite build completed\n`, stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: `${manager}: unsupported lab command: ${action}\n`, exitCode: 1 };
}

function viteCommand(args) {
  const action = args[0] || "dev";
  if (action === "dev") return { stdout: "vite dev server ready at http://127.0.0.1:5173\n", stderr: "", exitCode: 0 };
  if (action === "build") return { stdout: "vite build completed\n", stderr: "", exitCode: 0 };
  return { stdout: "", stderr: `vite: unsupported lab command: ${action}\n`, exitCode: 1 };
}

function cancellableDelay(signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ stdout: "done\n", stderr: "", exitCode: 0 });
    }, 30000);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: "cancelled\n", exitCode: 130 });
      },
      { once: true }
    );
  });
}

async function runTerminalCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return null;
  setTerminalStatus("running");
  appendTerminalOutput(`$ ${trimmed}\n`);
  terminalRunButton.disabled = true;
  terminalCancelButton.disabled = false;
  try {
    const result = await terminal.run(trimmed);
    setTerminalStatus(result.entry.status);
    renderTerminalTranscript();
    return result;
  } finally {
    terminalRunButton.disabled = false;
    terminalCancelButton.disabled = true;
  }
}

function cancelTerminalCommand() {
  const cancelled = terminal.cancel();
  if (cancelled) setTerminalStatus("cancelling");
  return cancelled;
}

function restartTerminal() {
  terminal.restart();
  setTerminalStatus("restarted");
  renderTerminalTranscript();
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

terminalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runTerminalCommand(terminalInput.value).catch((error) => {
    setTerminalStatus("failed");
    appendTerminalOutput(`${error.message}\n`);
    renderTerminalTranscript();
  });
});

terminalCancelButton.addEventListener("click", () => {
  cancelTerminalCommand();
});

terminalRestartButton.addEventListener("click", () => {
  restartTerminal();
});

globalThis.__runtimeLab = {
  boot,
  cancelTerminalCommand,
  runFsSmoke,
  runPreviewSmoke,
  runTerminalCommand,
  systemMetrics: () => container?.systemMetrics() || null,
  teardown,
  restartTerminal,
  status: () => statusEl.textContent,
  terminalHistory: () => terminal.history(),
  terminalOutput: () => terminalLogEl.textContent,
  terminalTranscript: () => terminal.transcript(),
  metrics: () => container?.metrics || null,
  log: () => logEl.textContent
};

setStatus(crossOriginIsolated ? "idle" : "isolation-missing");
