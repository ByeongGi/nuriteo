import { OPCODES, STATUS } from "../../../protocol/src/generated.ts";
import { requestSync } from "../../../protocol/src/sync-client.ts";
import type { Opcode } from "../../../protocol/src/index.ts";
import type { RuntimeFsBinding, RuntimeFsBindingOptions, RuntimeFsData } from "../types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type FsPayload = Record<string, unknown>;

interface FsSyscallResult {
  fd?: number;
  written?: number;
  data?: number[];
  len?: number;
  fileType?: "file" | "directory" | string;
  code?: string;
  message?: string;
}

type FsSyscallError = Error & { code: string | undefined };

export function createFsBinding(channel: SharedArrayBuffer, options: RuntimeFsBindingOptions = {}): RuntimeFsBinding {
  const pid = options.pid ?? 1;
  const generation = options.generation ?? 2;
  const timeoutMs = options.timeoutMs ?? 5000;
  let nextRequestId = options.firstRequestId ?? 1000;

  function syscall(opcode: Opcode, payload: FsPayload = {}): FsSyscallResult {
    const response = requestSync(channel, {
      requestId: nextRequestId++,
      generation,
      pid,
      opcode,
      payload: JSON.stringify(payload)
    }, { timeoutMs });
    const text = decoder.decode(response.payload);
    const body = (text ? JSON.parse(text) : {}) as FsSyscallResult;
    if (response.status === STATUS.error) {
      const error: FsSyscallError = Object.assign(new Error(body.message || body.code || "fs syscall failed"), {
        code: body.code
      });
      throw error;
    }
    return body;
  }

  function openSync(path: string, flags: string | number = "r"): number {
    const fd = syscall(OPCODES["fs.open"], { path, flags }).fd;
    if (typeof fd !== "number") throw new Error("fs.open syscall returned no fd");
    return fd;
  }

  function closeSync(fd: number): void {
    syscall(OPCODES["fs.close"], { fd });
  }

  function writeSync(fd: number, data: RuntimeFsData): number {
    const bytes = toBytes(data);
    return syscall(OPCODES["fs.write"], { fd, data: [...bytes] }).written ?? 0;
  }

  function readSync(fd: number, len = 1024 * 1024): Uint8Array {
    return new Uint8Array(syscall(OPCODES["fs.read"], { fd, len }).data || []);
  }

  function writeFileSync(path: string, data: RuntimeFsData): void {
    const fd = openSync(path, "w");
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }

  function readFileSync(path: string): Uint8Array;
  function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  function readFileSync(path: string, encoding?: "utf8" | "utf-8"): Uint8Array | string {
    const fd = openSync(path, "r");
    try {
      const bytes = readSync(fd);
      return encoding ? decoder.decode(bytes) : bytes;
    } finally {
      closeSync(fd);
    }
  }

  function mkdirSync(path: string): void {
    syscall(OPCODES["fs.mkdir"], { path });
  }

  function statSync(path: string): ReturnType<RuntimeFsBinding["statSync"]> {
    const metadata = syscall(OPCODES["fs.stat"], { path });
    return {
      size: metadata.len ?? 0,
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

function toBytes(data: RuntimeFsData): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("fs data must be string or bytes");
}
