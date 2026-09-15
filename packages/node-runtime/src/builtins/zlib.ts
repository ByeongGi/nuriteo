import { PassThrough } from "./stream.ts";
import type { RuntimeValue } from "../types.ts";

export const Z_SYNC_FLUSH = 2;

export class ZlibPassThrough extends PassThrough {
  _handle: ZlibNativeHandle;

  constructor(_options: Record<string, RuntimeValue> = {}) {
    super();
    this._handle = {
      close() {},
      reset() {},
      _handle: {
        close() {}
      },
      _processChunk(chunk: Uint8Array): Uint8Array[] {
        return [chunk];
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
}

export class BrotliCompress extends ZlibPassThrough {}
export class BrotliDecompress extends ZlibPassThrough {}
export class DeflateRaw extends ZlibPassThrough {}
export class Gzip extends ZlibPassThrough {}
export class Inflate extends ZlibPassThrough {}
export class InflateRaw extends ZlibPassThrough {}
export class Unzip extends ZlibPassThrough {}

export function createBrotliDecompress(options?: Record<string, RuntimeValue>): BrotliDecompress {
  return new BrotliDecompress(options);
}

export function createDeflateRaw(options?: Record<string, RuntimeValue>): DeflateRaw {
  return new DeflateRaw(options);
}

export function createGunzip(options?: Record<string, RuntimeValue>): Gzip {
  return new Gzip(options);
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
  return bytes;
}

export function inflateRawSync(bytes: Uint8Array): Uint8Array {
  return bytes;
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
    inflateRawSync
  },
  deflateRawSync,
  inflateRawSync
});
