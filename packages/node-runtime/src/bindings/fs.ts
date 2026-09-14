import { OPCODES, STATUS } from "../../../protocol/src/generated.ts";
import { requestSync } from "../../../protocol/src/sync-client.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createFsBinding(channel, options = {}) {
  const pid = options.pid ?? 1;
  const generation = options.generation ?? 2;
  const timeoutMs = options.timeoutMs ?? 5000;
  let nextRequestId = options.firstRequestId ?? 1000;

  function syscall(opcode, payload = {}) {
    const response = requestSync(channel, {
      requestId: nextRequestId++,
      generation,
      pid,
      opcode,
      payload: JSON.stringify(payload)
    }, { timeoutMs });
    const text = decoder.decode(response.payload);
    const body = text ? JSON.parse(text) : {};
    if (response.status === STATUS.error) {
      const error = new Error(body.message || body.code || "fs syscall failed");
      error.code = body.code;
      throw error;
    }
    return body;
  }

  function openSync(path, flags = "r") {
    return syscall(OPCODES["fs.open"], { path, flags }).fd;
  }

  function closeSync(fd) {
    syscall(OPCODES["fs.close"], { fd });
  }

  function writeSync(fd, data) {
    const bytes = toBytes(data);
    return syscall(OPCODES["fs.write"], { fd, data: [...bytes] }).written;
  }

  function readSync(fd, len = 1024 * 1024) {
    return new Uint8Array(syscall(OPCODES["fs.read"], { fd, len }).data || []);
  }

  function writeFileSync(path, data) {
    const fd = openSync(path, "w");
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }

  function readFileSync(path, encoding) {
    const fd = openSync(path, "r");
    try {
      const bytes = readSync(fd);
      return encoding ? decoder.decode(bytes) : bytes;
    } finally {
      closeSync(fd);
    }
  }

  function mkdirSync(path) {
    syscall(OPCODES["fs.mkdir"], { path });
  }

  function statSync(path) {
    const metadata = syscall(OPCODES["fs.stat"], { path });
    return {
      size: metadata.len,
      isFile: () => metadata.fileType === "file",
      isDirectory: () => metadata.fileType === "directory"
    };
  }

  return {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
    writeFileSync,
    writeSync
  };
}

function toBytes(data) {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("fs data must be string or bytes");
}
