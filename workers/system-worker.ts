import { createFailedMessage, createReadyMessage } from "../packages/protocol/src/messages.ts";
import { OPCODES, STATUS } from "../packages/protocol/src/generated.ts";
import { handlePingRequest, respondErrorSync, respondSync, waitForRequest } from "../packages/protocol/src/sync-client.ts";

let processPort = null;
let syncChannel = null;
const fsState = createFsState();
const decoder = new TextDecoder();

self.addEventListener("message", (event) => {
  if (event.data?.type === "boot") {
    boot(event.data).catch((error) => {
      self.postMessage(createFailedMessage("system", error));
    });
  } else if (event.data?.type === "get-metrics") {
    self.postMessage({
      type: "metrics-result",
      requestId: event.data.requestId,
      metrics: systemMetrics()
    });
  }
});

async function boot(message) {
  if (message.fail) throw new Error("forced system boot failure");
  processPort = message.port;
  syncChannel = message.syncChannel;
  if (!processPort) throw new Error("missing process message port");
  if (!syncChannel) throw new Error("missing sync channel");
  processPort.start();

  const processReply = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("process worker ping timeout")), 1000);
    processPort.onmessage = (event) => {
      if (event.data?.type === "pong") {
        clearTimeout(timeout);
        resolve(event.data);
      }
    };
  });

  processPort.postMessage({ type: "ping", from: "system" });
  const pong = await processReply;
  const syscallResult = await runSyscallProbe();

  self.postMessage(createReadyMessage("system", {
    processSeen: pong.from === "process",
    syscall: syscallResult,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer
  }));
  setTimeout(serveSyscalls, 0);
}

async function runSyscallProbe() {
  const generation = 1;
  const syscallResult = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("process syscall result timeout")), 1000);
    processPort.onmessage = (event) => {
      if (event.data?.type === "syscall-result") {
        clearTimeout(timeout);
        resolve(event.data);
      }
    };
  });

  processPort.postMessage({ type: "run-syscall-ping", generation });
  const request = handlePingRequest(syncChannel, { timeoutMs: 1000 });
  const result = await syscallResult;
  return {
    ...result,
    requestId: request.requestId,
    generation: request.generation,
    pid: request.pid
  };
}

function serveSyscalls() {
  let request = null;
  try {
    request = waitForRequest(syncChannel, { timeoutMs: 25 });
    const payload = dispatchFs(request);
    respondSync(syncChannel, request, JSON.stringify(payload));
  } catch (error) {
    if (error.message !== "timed out waiting for request") {
      if (!request) throw error;
      respondErrorSync(syncChannel, request, JSON.stringify({
        code: error.code || "EIO",
        message: error.message
      }));
    }
  } finally {
    setTimeout(serveSyscalls, 0);
  }
}

function dispatchFs(request) {
  if (request.status !== STATUS.request) {
    throw Object.assign(new Error("expected request status"), { code: "EBADMSG" });
  }
  const body = request.payload.byteLength ? JSON.parse(decoder.decode(request.payload)) : {};
  if (request.opcode === OPCODES["fs.open"]) return fsOpen(body);
  if (request.opcode === OPCODES["fs.write"]) return fsWrite(body);
  if (request.opcode === OPCODES["fs.read"]) return fsRead(body);
  if (request.opcode === OPCODES["fs.close"]) return fsClose(body);
  if (request.opcode === OPCODES["fs.stat"]) return fsStat(body);
  if (request.opcode === OPCODES["fs.mkdir"]) return fsMkdir(body);
  throw Object.assign(new Error(`unsupported opcode ${request.opcode}`), { code: "ENOSYS" });
}

function createFsState() {
  return {
    files: new Map(),
    directories: new Set(["/", "/workspace"]),
    openFiles: new Map(),
    nextFd: 3
  };
}

function systemMetrics() {
  return {
    files: fsState.files.size,
    directories: fsState.directories.size,
    openFiles: fsState.openFiles.size,
    watchCount: 0,
    portCount: 0,
    pendingRequests: 0
  };
}

function fsOpen({ path, flags = "r" }) {
  assertAbsolutePath(path);
  if (fsState.directories.has(path)) {
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
  }
  if (!fsState.files.has(path)) {
    if (!flags.includes("w") && !flags.includes("a") && !flags.includes("+")) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
    }
    ensureParentDirectory(path);
    fsState.files.set(path, new Uint8Array());
  }
  if (flags.includes("w")) {
    fsState.files.set(path, new Uint8Array());
  }
  const fd = fsState.nextFd++;
  fsState.openFiles.set(fd, {
    path,
    offset: flags.includes("a") ? fsState.files.get(path).byteLength : 0,
    readable: flags.includes("r") || flags.includes("+"),
    writable: flags.includes("w") || flags.includes("a") || flags.includes("+")
  });
  return { fd };
}

function fsWrite({ fd, data }) {
  const openFile = getOpenFile(fd);
  if (!openFile.writable) throw Object.assign(new Error("EBADF: file not open for writing"), { code: "EBADF" });
  const input = new Uint8Array(data || []);
  const current = fsState.files.get(openFile.path);
  const end = openFile.offset + input.byteLength;
  const next = new Uint8Array(Math.max(current.byteLength, end));
  next.set(current);
  next.set(input, openFile.offset);
  fsState.files.set(openFile.path, next);
  openFile.offset = end;
  return { written: input.byteLength };
}

function fsRead({ fd, len }) {
  const openFile = getOpenFile(fd);
  if (!openFile.readable) throw Object.assign(new Error("EBADF: file not open for reading"), { code: "EBADF" });
  const current = fsState.files.get(openFile.path);
  const start = Math.min(openFile.offset, current.byteLength);
  const end = Math.min(start + len, current.byteLength);
  openFile.offset = end;
  return { data: [...current.slice(start, end)] };
}

function fsClose({ fd }) {
  if (!fsState.openFiles.delete(fd)) {
    throw Object.assign(new Error("EBADF: bad file descriptor"), { code: "EBADF" });
  }
  return {};
}

function fsStat({ path }) {
  assertAbsolutePath(path);
  if (fsState.files.has(path)) {
    return { fileType: "file", len: fsState.files.get(path).byteLength };
  }
  if (fsState.directories.has(path)) {
    return { fileType: "directory", len: 0 };
  }
  throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
}

function fsMkdir({ path }) {
  assertAbsolutePath(path);
  if (fsState.files.has(path) || fsState.directories.has(path)) {
    throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: "EEXIST" });
  }
  ensureParentDirectory(path);
  fsState.directories.add(path);
  return {};
}

function getOpenFile(fd) {
  const openFile = fsState.openFiles.get(fd);
  if (!openFile) throw Object.assign(new Error("EBADF: bad file descriptor"), { code: "EBADF" });
  return openFile;
}

function assertAbsolutePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || path.includes("..")) {
    throw Object.assign(new Error("EINVAL: invalid path"), { code: "EINVAL" });
  }
}

function ensureParentDirectory(path) {
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  if (!fsState.directories.has(parent)) {
    throw Object.assign(new Error(`ENOENT: no such directory '${parent}'`), { code: "ENOENT" });
  }
}
