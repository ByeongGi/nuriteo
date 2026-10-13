import { ERROR_CODES, OPCODES } from "../../../protocol/src/index.ts";
import type { HostProcessResize, HostProcessTerminalMode } from "./types.ts";
import { SystemWasmClient, SystemWasmError } from "./system-wasm-client.ts";

const DEFAULT_BUFFER_BYTES = 64 * 1024;
const DEFAULT_EVENT_CAPACITY = 64;
const READ_CHUNK_BYTES = 16 * 1024;
const SIGNAL_INTERRUPT = 1;

export interface VirtualPtyWriteResult {
  echo: string;
  eof: boolean;
  input: string;
  interrupt: boolean;
}

export interface VirtualPtyOutputResult {
  output: string;
}

export class SystemWasmVirtualPty {
  readonly #client: SystemWasmClient;
  readonly #guestPid: number;
  readonly #hostPid: number;
  readonly #masterFd: number;
  readonly #ptyId: number;
  readonly #slaveFd: number;

  constructor(client: SystemWasmClient, mode: HostProcessTerminalMode, size: HostProcessResize) {
    this.#client = client;
    client.reset();
    this.#hostPid = registerProcess(client, 0);
    this.#guestPid = registerProcess(client, this.#hostPid);
    const opened = client.request({
      generation: 1,
      opcode: OPCODES["pty.open"],
      pid: this.#hostPid,
      payload: words(this.#guestPid, DEFAULT_BUFFER_BYTES, DEFAULT_BUFFER_BYTES, DEFAULT_EVENT_CAPACITY)
    });
    assertLength(opened, 12, "PTY open response");
    this.#ptyId = readU32(opened, 0);
    this.#masterFd = readU32(opened, 4);
    this.#slaveFd = readU32(opened, 8);
    client.request({ generation: 1, opcode: OPCODES["pty.attach"], pid: this.#hostPid, payload: words(this.#ptyId) });
    this.#setMode(mode);
    this.resize(size);
  }

  write(data: string): VirtualPtyWriteResult {
    const bytes = new TextEncoder().encode(data);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const payload = new Uint8Array(4 + bytes.byteLength - offset);
      new DataView(payload.buffer).setUint32(0, this.#masterFd, true);
      payload.set(bytes.subarray(offset), 4);
      const response = this.#client.request({ generation: 1, opcode: OPCODES["pty.write"], pid: this.#hostPid, payload });
      assertLength(response, 4, "PTY write response");
      const written = readU32(response, 0);
      if (written === 0) throw new SystemWasmError(ERROR_CODES.EAGAIN, "PTY write made no progress");
      offset += written;
    }
    this.#dispatchEvents();
    const echo = this.#readAvailable(this.#hostPid, this.#masterFd);
    const input = this.#readAvailable(this.#guestPid, this.#slaveFd);
    return {
      echo: new TextDecoder().decode(echo.data),
      eof: input.eof,
      input: new TextDecoder().decode(input.data),
      interrupt: this.#takeSignal() === SIGNAL_INTERRUPT
    };
  }

  writeOutput(data: string): VirtualPtyOutputResult {
    const bytes = new TextEncoder().encode(data);
    const output: Uint8Array[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      const payload = new Uint8Array(4 + bytes.byteLength - offset);
      new DataView(payload.buffer).setUint32(0, this.#slaveFd, true);
      payload.set(bytes.subarray(offset), 4);
      const response = this.#client.request({ generation: 1, opcode: OPCODES["pty.write"], pid: this.#guestPid, payload });
      assertLength(response, 4, "PTY output write response");
      const written = readU32(response, 0);
      if (written === 0) throw new SystemWasmError(ERROR_CODES.EAGAIN, "PTY output write made no progress");
      offset += written;
      output.push(this.#readAvailable(this.#hostPid, this.#masterFd).data);
    }
    output.push(this.#readAvailable(this.#hostPid, this.#masterFd).data);
    return { output: new TextDecoder().decode(concatBytes(output)) };
  }

  resize(size: HostProcessResize): void {
    const payload = new Uint8Array(9);
    const view = new DataView(payload.buffer);
    view.setUint32(0, this.#masterFd, true);
    payload[4] = 3;
    view.setUint16(5, size.cols, true);
    view.setUint16(7, size.rows, true);
    this.#client.request({ generation: 1, opcode: OPCODES["pty.ioctl"], pid: this.#hostPid, payload });
    this.#dispatchEvents();
    this.#takeSignal();
  }

  close(exitCode = 0): void {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setInt32(0, exitCode, true);
    this.#client.request({
      generation: 1,
      opcode: OPCODES["process.exit"],
      pid: this.#guestPid,
      payload
    });
  }

  #setMode(mode: HostProcessTerminalMode): void {
    const flags = Number(mode.canonical) | (Number(mode.echo) << 1) | (Number(mode.signals) << 2) | 8;
    const payload = new Uint8Array([...words(this.#slaveFd), 1, flags, 0x7f, 0x15, 0x04, 0x03]);
    this.#client.request({ generation: 1, opcode: OPCODES["pty.ioctl"], pid: this.#guestPid, payload });
  }

  #readAvailable(pid: number, fd: number): { data: Uint8Array; eof: boolean } {
    const chunks: Uint8Array[] = [];
    let eof = false;
    while (true) {
      try {
        const response = this.#client.request({
          generation: 1,
          opcode: OPCODES["pty.read"],
          pid,
          payload: words(fd, READ_CHUNK_BYTES)
        });
        if (response.byteLength < 1) break;
        eof ||= response[0] === 1;
        if (response.byteLength === 1) break;
        chunks.push(response.subarray(1));
        if (response.byteLength - 1 < READ_CHUNK_BYTES) break;
      } catch (error) {
        if (error instanceof SystemWasmError && error.code === ERROR_CODES.EAGAIN) break;
        throw error;
      }
    }
    return { data: concatBytes(chunks), eof };
  }

  #dispatchEvents(): void {
    while (this.#pollPriority()) {
      this.#client.request({
        generation: 1,
        opcode: OPCODES["pty.dispatchEvent"],
        pid: this.#hostPid,
        payload: words(this.#ptyId)
      });
    }
  }

  #pollPriority(): boolean {
    const response = this.#client.request({
      generation: 1,
      opcode: OPCODES["pty.poll"],
      pid: this.#guestPid,
      payload: words(this.#slaveFd)
    });
    return ((response[0] ?? 0) & 8) !== 0;
  }

  #takeSignal(): number {
    const response = this.#client.request({
      generation: 1,
      opcode: OPCODES["process.signal.take"],
      pid: this.#guestPid
    });
    return response[0] ?? 0;
  }
}

function registerProcess(client: SystemWasmClient, parent: number): number {
  const cwd = new TextEncoder().encode("/workspace");
  const payload = new Uint8Array(4 + cwd.byteLength);
  new DataView(payload.buffer).setUint32(0, parent, true);
  payload.set(cwd, 4);
  const response = client.request({ generation: 1, opcode: OPCODES["process.register"], pid: 0, payload });
  assertLength(response, 16, "process registration response");
  return readU32(response, 0);
}

function words(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function assertLength(bytes: Uint8Array, expected: number, name: string): void {
  if (bytes.byteLength !== expected) throw new SystemWasmError(ERROR_CODES.EBADMSG, `${name} has invalid length`);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
