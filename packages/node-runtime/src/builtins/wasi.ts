export interface WasiOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
  version?: "preview1" | string;
}

export class WASI {
  readonly args: string[];
  readonly env: Record<string, string | undefined>;
  readonly preopens: Record<string, string>;
  readonly returnOnExit: boolean;
  readonly version: string;
  readonly wasiImport: Record<string, unknown>;
  #exitCode = 0;
  #memory: WebAssembly.Memory | null = null;

  constructor(options: WasiOptions = {}) {
    this.args = [...(options.args || [])];
    this.env = { ...(options.env || {}) };
    this.preopens = { ...(options.preopens || {}) };
    this.returnOnExit = options.returnOnExit ?? false;
    this.version = options.version || "preview1";
    this.wasiImport = createWasiPreview1Import(this);
  }

  getImportObject(): { wasi_snapshot_preview1: Record<string, unknown> } {
    return { wasi_snapshot_preview1: this.wasiImport };
  }

  initialize(instance: WebAssembly.Instance): void {
    this.#bindMemory(instance);
  }

  start(instance: WebAssembly.Instance): number | undefined {
    this.#bindMemory(instance);
    return this.returnOnExit ? this.#exitCode : undefined;
  }

  _randomGet(buf: number, bufLen: number): number {
    const bytes = this.#heapU8(buf, bufLen);
    fillRandom(bytes);
    return 0;
  }

  _argsSizesGet(argc: number, argvBufSize: number): number {
    return this.#writeSizes(argc, argvBufSize, this.args);
  }

  _argsGet(argv: number, argvBuf: number): number {
    return this.#writeStringVector(argv, argvBuf, this.args);
  }

  _environSizesGet(environCount: number, environBufSize: number): number {
    return this.#writeSizes(environCount, environBufSize, envPairs(this.env));
  }

  _environGet(environ: number, environBuf: number): number {
    return this.#writeStringVector(environ, environBuf, envPairs(this.env));
  }

  _clockTimeGet(_clockId: number, _precision: bigint | number, result: number): number {
    this.#view().setBigUint64(result, BigInt(Date.now()) * 1_000_000n, true);
    return 0;
  }

  _procExit(code: number): number {
    this.#exitCode = Number(code);
    if (this.returnOnExit) return 0;
    throw Object.assign(new Error(`WASI proc_exit(${this.#exitCode})`), { code: this.#exitCode });
  }

  _writeUint32(offset: number, value: number): number {
    try {
      this.#view().setUint32(Number(offset), value, true);
      return 0;
    } catch {
      return 0;
    }
  }

  _writeBigUint64(offset: number, value: bigint): number {
    try {
      this.#view().setBigUint64(Number(offset), value, true);
      return 0;
    } catch {
      return 0;
    }
  }

  #bindMemory(instance: WebAssembly.Instance): void {
    const memory = (instance.exports as { memory?: unknown } | undefined)?.memory;
    if (memory instanceof WebAssembly.Memory) this.#memory = memory;
  }

  #heapU8(offset: number, length?: number): Uint8Array {
    if (!this.#memory) throw new Error("WASI memory is not initialized");
    return new Uint8Array(this.#memory.buffer, Number(offset), length === undefined ? undefined : Number(length));
  }

  #view(): DataView {
    if (!this.#memory) throw new Error("WASI memory is not initialized");
    return new DataView(this.#memory.buffer);
  }

  #writeSizes(countPtr: number, sizePtr: number, values: string[]): number {
    const encodedSize = values.reduce((total, value) => total + new TextEncoder().encode(value).length + 1, 0);
    const view = this.#view();
    view.setUint32(Number(countPtr), values.length, true);
    view.setUint32(Number(sizePtr), encodedSize, true);
    return 0;
  }

  #writeStringVector(vectorPtr: number, bufferPtr: number, values: string[]): number {
    const heap = this.#heapU8(0);
    const view = this.#view();
    let cursor = Number(bufferPtr);
    values.forEach((value, index) => {
      const encoded = new TextEncoder().encode(value);
      view.setUint32(Number(vectorPtr) + index * 4, cursor, true);
      heap.set(encoded, cursor);
      heap[cursor + encoded.length] = 0;
      cursor += encoded.length + 1;
    });
    return 0;
  }
}

function createWasiPreview1Import(wasi: WASI): Record<string, unknown> {
  const imports: Record<string, (...args: number[]) => number> = {
    args_get: (argv, argvBuf) => wasi._argsGet(argv, argvBuf),
    args_sizes_get: (argc, argvBufSize) => wasi._argsSizesGet(argc, argvBufSize),
    clock_res_get: (_clockId, result) => wasi._writeBigUint64(result, 1_000_000n),
    clock_time_get: (clockId, precision, result) => wasi._clockTimeGet(clockId, precision, result),
    environ_get: (environ, environBuf) => wasi._environGet(environ, environBuf),
    environ_sizes_get: (environCount, environBufSize) => wasi._environSizesGet(environCount, environBufSize),
    fd_close: () => 0,
    fd_fdstat_get: () => 0,
    fd_fdstat_set_flags: () => 0,
    fd_filestat_get: () => 8,
    fd_prestat_get: () => 8,
    fd_prestat_dir_name: () => 8,
    fd_read: () => 0,
    fd_seek: () => 0,
    fd_write: (_fd, _iovs, _iovsLen, written) => wasi._writeUint32(written, 0),
    path_open: () => 8,
    poll_oneoff: () => 8,
    proc_exit: (code) => wasi._procExit(code),
    random_get: (buf, bufLen) => wasi._randomGet(buf, bufLen),
    sched_yield: () => 0
  };
  return new Proxy(imports, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property);
      return target[property] || (() => 8);
    }
  }) as Record<string, unknown>;
}

function fillRandom(bytes: Uint8Array): void {
  const cryptoLike = globalThis.crypto;
  if (cryptoLike && typeof cryptoLike.getRandomValues === "function") {
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      cryptoLike.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)) as Uint8Array<ArrayBuffer>);
    }
    return;
  }
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}

function envPairs(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
}

export const wasiBuiltin = Object.freeze({
  WASI
});
