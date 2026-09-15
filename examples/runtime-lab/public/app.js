import { createContainer } from "/packages/sdk/src/container.ts";
import {
  createProjectWorkspaceEditorBridge,
  createProjectWorkspaceStore
} from "/packages/browser-host/src/storage/index.ts";
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
const fileTreeEl = document.getElementById("file-tree");
const editorPathInput = document.getElementById("editor-path");
const editorTextArea = document.getElementById("editor-text");
const editorStatusEl = document.getElementById("editor-status");
const editorSaveButton = document.getElementById("editor-save");
const editorCreateButton = document.getElementById("editor-create");
const editorRenameButton = document.getElementById("editor-rename");
const editorDeleteButton = document.getElementById("editor-delete");
const editorSearchInput = document.getElementById("editor-search");
const editorSearchResultsEl = document.getElementById("editor-search-results");

let container = null;
let terminal = createLabTerminal();
const project = createProjectWorkspaceStore({
  projectId: "runtime-lab",
  root: "/workspace/app",
  metadata: {
    framework: "vite-react",
    name: "Runtime Lab",
    packageManager: "pnpm"
  }
});
project.writeText("package.json", "{\"scripts\":{\"dev\":\"vite --host 0.0.0.0\",\"build\":\"vite build\"}}\n");
project.writeText("src/main.jsx", "console.log(\"hello runtime lab\")\n");
project.writeText("src/App.jsx", "export function App() { return \"App\"; }\n");
const editor = createProjectWorkspaceEditorBridge(project);
let selectedEditorPath = "/workspace/app/src/main.jsx";

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

function setEditorStatus(status) {
  editorStatusEl.textContent = status;
}

function renderFileTree() {
  fileTreeEl.replaceChildren(...renderTreeNodes(editor.tree()));
}

function renderTreeNodes(nodes) {
  return nodes.map((node) => {
    const item = document.createElement("li");
    if (node.type === "directory") {
      item.textContent = node.name;
      item.className = "file-directory";
      const children = document.createElement("ol");
      children.replaceChildren(...renderTreeNodes(node.children || []));
      item.append(children);
      return item;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${node.name}${node.dirty ? " *" : ""}`;
    button.dataset.path = node.path;
    button.addEventListener("click", () => openEditorFile(node.path));
    if (node.path === selectedEditorPath) button.setAttribute("aria-current", "true");
    item.append(button);
    return item;
  });
}

function openEditorFile(path) {
  const file = editor.openFile(path);
  selectedEditorPath = file.path;
  editorPathInput.value = file.path;
  editorTextArea.value = file.data;
  setEditorStatus(file.dirty ? "dirty" : "saved");
  renderFileTree();
  renderSearchResults();
  return file;
}

function editCurrentFile(data = editorTextArea.value) {
  const file = editor.editText(selectedEditorPath, data);
  setEditorStatus("dirty");
  renderFileTree();
  renderSearchResults();
  return file;
}

function saveCurrentFile() {
  const file = editor.saveFile(selectedEditorPath);
  editorTextArea.value = file.data;
  setEditorStatus("saved");
  renderFileTree();
  renderSearchResults();
  return file;
}

function createEditorFile(path, data = "") {
  const file = editor.createFile(path, data);
  return openEditorFile(file.path);
}

function renameCurrentFile(path) {
  const file = editor.renameFile(selectedEditorPath, path);
  selectedEditorPath = file.path;
  editorPathInput.value = file.path;
  editorTextArea.value = file.data;
  setEditorStatus("saved");
  renderFileTree();
  renderSearchResults();
  return file;
}

function deleteCurrentFile() {
  editor.deleteFile(selectedEditorPath);
  const next = editor.tree().flatMap(flattenTree).find((node) => node.type === "file");
  selectedEditorPath = next?.path || "";
  if (selectedEditorPath) openEditorFile(selectedEditorPath);
  else {
    editorPathInput.value = "";
    editorTextArea.value = "";
    setEditorStatus("empty");
    renderFileTree();
    renderSearchResults();
  }
}

function renderSearchResults() {
  const query = editorSearchInput.value;
  const matches = editor.search(query);
  editorSearchResultsEl.replaceChildren(
    ...matches.map((match) => {
      const item = document.createElement("li");
      item.textContent = `${match.path}:${match.line}:${match.column} ${match.snippet}`;
      return item;
    })
  );
  return matches;
}

function flattenTree(node) {
  return node.type === "file" ? [node] : (node.children || []).flatMap(flattenTree);
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

editorTextArea.addEventListener("input", () => {
  editCurrentFile();
});

editorSaveButton.addEventListener("click", () => {
  saveCurrentFile();
});

editorCreateButton.addEventListener("click", () => {
  const path = editorPathInput.value.trim() || "src/new-file.js";
  createEditorFile(path, "");
});

editorRenameButton.addEventListener("click", () => {
  renameCurrentFile(editorPathInput.value.trim());
});

editorDeleteButton.addEventListener("click", () => {
  deleteCurrentFile();
});

editorSearchInput.addEventListener("input", () => {
  renderSearchResults();
});

globalThis.__runtimeLab = {
  boot,
  cancelTerminalCommand,
  createEditorFile,
  deleteCurrentFile,
  editCurrentFile,
  editorSearch: (query) => editor.search(query),
  editorTree: () => editor.tree(),
  openEditorFile,
  renameCurrentFile,
  runFsSmoke,
  runPreviewSmoke,
  runTerminalCommand,
  saveCurrentFile,
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
openEditorFile(selectedEditorPath);
