import {
  decompressSync,
  deflateSync as fflateDeflateSync,
  gunzipSync as fflateGunzipSync,
  gzipSync as fflateGzipSync,
  inflateSync as fflateInflateSync
} from "fflate";

import type { RuntimeValue } from "../types.ts";
import { BrowserBuffer } from "./buffer.ts";
import { PassThrough } from "./stream.ts";

export const Z_SYNC_FLUSH = 2;

export class ZlibPassThrough extends PassThrough {
  _handle: ZlibNativeHandle;

  constructor(options: Record<string, RuntimeValue> = {}) {
    super();
    const processChunk = createProcessChunk(options.mode);
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
    this._handle.reset();
  }

  _processChunk(chunk: Uint8Array, flushFlag?: number): Uint8Array[] {
    return this._handle._processChunk(chunk, flushFlag);
  }
}

export class BrotliCompress extends ZlibPassThrough {}
export class BrotliDecompress extends ZlibPassThrough {}
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
  if (mode === "deflate" || mode === "deflateRaw") return (chunk) => processNonEmpty(chunk, fflateDeflateSync);
  if (mode === "inflate" || mode === "inflateRaw") return (chunk) => processNonEmpty(chunk, fflateInflateSync);
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
  DeflateRaw,
  Gunzip,
  Gzip,
  Inflate,
  InflateRaw,
  Unzip,
  Z_SYNC_FLUSH,
  createBrotliDecompress,
  createDeflateRaw,
  createGunzip,
  createGzip,
  createInflate,
  createInflateRaw,
  createUnzip,
  default: {
    Z_SYNC_FLUSH,
    createBrotliDecompress,
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
