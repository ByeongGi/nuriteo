import {
  decompressSync,
  deflateSync as fflateDeflateSync,
  gunzipSync as fflateGunzipSync,
  gzipSync as fflateGzipSync,
  inflateSync as fflateInflateSync,
  unzlibSync as fflateUnzlibSync,
  zlibSync as fflateZlibSync
} from "fflate";

import type { RuntimeValue } from "../types.ts";
import { BrowserBuffer } from "./buffer.ts";
import { PassThrough } from "./stream.ts";

export const Z_SYNC_FLUSH = 2;
export const Z_BEST_SPEED = 1;
const MAX_STREAM_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_OUTPUT_BYTES = 128 * 1024 * 1024;

export class ZlibPassThrough extends PassThrough {
  _handle: ZlibNativeHandle;
  #chunks: Uint8Array[] = [];
  #inputBytes = 0;
  #processChunk: (chunk: Uint8Array) => Uint8Array;

  constructor(options: Record<string, RuntimeValue> = {}) {
    super();
    const processChunk = createProcessChunk(options.mode);
    this.#processChunk = processChunk;
    this._handle = {
      close() {},
      reset() {},
      _handle: {
        close() {}
      },
      _processChunk(chunk: Uint8Array): Uint8Array[] {
        if (chunk.byteLength === 0) return [];
        return [BrowserBuffer.from(processChunk(chunk))];
      }
    };
  }

  close(): void {
    this._handle.close();
    this.emit("close");
  }

  reset(): void {
    this.#chunks = [];
    this.#inputBytes = 0;
    this._handle.reset();
  }

  _processChunk(chunk: Uint8Array, flushFlag?: number): Uint8Array[] {
    return this._handle._processChunk(chunk, flushFlag);
  }

  protected override _transform(chunk: RuntimeValue, encoding: string, callback: (error?: Error | null) => void): void {
    const bytes = typeof chunk === "string" ? BrowserBuffer.from(chunk, encoding as "utf8") : BrowserBuffer.from(chunk as Uint8Array);
    if (this.#inputBytes + bytes.byteLength > MAX_STREAM_INPUT_BYTES) {
      callback(new Error("zlib stream input exceeds 32 MiB"));
      return;
    }
    this.#chunks.push(bytes);
    this.#inputBytes += bytes.byteLength;
    callback();
  }

  protected override _flush(callback: (error?: Error | null, data?: RuntimeValue) => void): void {
    try {
      if (this.#inputBytes === 0) {
        callback();
        return;
      }
      const output = this.#processChunk(BrowserBuffer.concat(this.#chunks, this.#inputBytes));
      if (output.byteLength > MAX_STREAM_OUTPUT_BYTES) throw new Error("zlib stream output exceeds 128 MiB");
      this.#chunks = [];
      this.#inputBytes = 0;
      callback(null, BrowserBuffer.from(output));
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export class BrotliCompress extends ZlibPassThrough {}
export class BrotliDecompress extends ZlibPassThrough {}
export class Deflate extends ZlibPassThrough {
  constructor(options: Record<string, RuntimeValue> = {}) {
    super({ ...options, mode: "deflate" });
  }
}
export class DeflateRaw extends ZlibPassThrough {
  constructor(options: Record<string, RuntimeValue> = {}) {
    super({ ...options, mode: "deflateRaw" });
  }
}
export class Gunzip extends ZlibPassThrough {
  constructor(options: Record<string, RuntimeValue> = {}) {
    super({ ...options, mode: "gunzip" });
  }
}
export class Gzip extends ZlibPassThrough {
  constructor(options: Record<string, RuntimeValue> = {}) {
    super({ ...options, mode: "gzip" });
  }
}
export class Inflate extends ZlibPassThrough {
  constructor(options: Record<string, RuntimeValue> = {}) {
    super({ ...options, mode: "inflate" });
  }
}
export class InflateRaw extends ZlibPassThrough {
  constructor(options: Record<string, RuntimeValue> = {}) {
    super({ ...options, mode: "inflateRaw" });
  }
}
export class Unzip extends ZlibPassThrough {
  constructor(options: Record<string, RuntimeValue> = {}) {
    super({ ...options, mode: "unzip" });
  }
}

export function createBrotliDecompress(options?: Record<string, RuntimeValue>): BrotliDecompress {
  return new BrotliDecompress(options);
}

export function createBrotliCompress(options?: Record<string, RuntimeValue>): BrotliCompress {
  return new BrotliCompress(options);
}

export function createDeflate(options?: Record<string, RuntimeValue>): Deflate {
  return new Deflate(options);
}

export function createDeflateRaw(options?: Record<string, RuntimeValue>): DeflateRaw {
  return new DeflateRaw(options);
}

export function createGunzip(options?: Record<string, RuntimeValue>): Gunzip {
  return new Gunzip(options);
}

export function createGzip(options?: Record<string, RuntimeValue>): Gzip {
  return new Gzip(options);
}

export function createInflate(options?: Record<string, RuntimeValue>): Inflate {
  return new Inflate(options);
}

export function createInflateRaw(options?: Record<string, RuntimeValue>): InflateRaw {
  return new InflateRaw(options);
}

export function createUnzip(options?: Record<string, RuntimeValue>): Unzip {
  return new Unzip(options);
}

export function deflateRawSync(bytes: Uint8Array): Uint8Array {
  return BrowserBuffer.from(fflateDeflateSync(bytes));
}

export function inflateRawSync(bytes: Uint8Array): Uint8Array {
  return BrowserBuffer.from(fflateInflateSync(bytes));
}

export function gunzipSync(bytes: Uint8Array): Uint8Array {
  return BrowserBuffer.from(fflateGunzipSync(bytes));
}

export function gzipSync(bytes: Uint8Array): Uint8Array {
  return BrowserBuffer.from(fflateGzipSync(bytes));
}

function createProcessChunk(mode: RuntimeValue): (chunk: Uint8Array) => Uint8Array {
  if (mode === "unzip") return (chunk) => processNonEmpty(chunk, decompressSync);
  if (mode === "gunzip") return (chunk) => processNonEmpty(chunk, fflateGunzipSync);
  if (mode === "gzip") return (chunk) => processNonEmpty(chunk, fflateGzipSync);
  if (mode === "deflate") return (chunk) => processNonEmpty(chunk, fflateZlibSync);
  if (mode === "deflateRaw") return (chunk) => processNonEmpty(chunk, fflateDeflateSync);
  if (mode === "inflate") return (chunk) => processNonEmpty(chunk, fflateUnzlibSync);
  if (mode === "inflateRaw") return (chunk) => processNonEmpty(chunk, fflateInflateSync);
  return (chunk) => chunk;
}

function processNonEmpty(chunk: Uint8Array, process: (chunk: Uint8Array) => Uint8Array): Uint8Array {
  return process(chunk);
}

export interface ZlibNativeHandle {
  _handle: {
    close(): void;
  };
  close(): void;
  reset(): void;
  _processChunk(chunk: Uint8Array, flushFlag?: number): Uint8Array[];
}

export const zlibBuiltin = Object.freeze({
  BrotliCompress,
  BrotliDecompress,
  Deflate,
  DeflateRaw,
  Gunzip,
  Gzip,
  Inflate,
  InflateRaw,
  Unzip,
  Z_BEST_SPEED,
  Z_SYNC_FLUSH,
  constants: Object.freeze({ Z_BEST_SPEED, Z_SYNC_FLUSH }),
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createDeflateRaw,
  createGunzip,
  createGzip,
  createInflate,
  createInflateRaw,
  createUnzip,
  default: {
    Z_BEST_SPEED,
    Z_SYNC_FLUSH,
    constants: Object.freeze({ Z_BEST_SPEED, Z_SYNC_FLUSH }),
    createBrotliCompress,
    createBrotliDecompress,
    createDeflate,
    createDeflateRaw,
    createGunzip,
    createGzip,
    createInflate,
    createInflateRaw,
    createUnzip,
    deflateRawSync,
    gunzipSync,
    gzipSync,
    inflateRawSync
  },
  deflateRawSync,
  gunzipSync,
  gzipSync,
  inflateRawSync
});
