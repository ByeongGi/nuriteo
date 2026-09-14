import type { RuntimeValue } from "../types.ts";

export type BufferEncoding = "utf8" | "utf-8" | "hex" | "base64";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const hexDigits = "0123456789abcdef";

export class BrowserBuffer extends Uint8Array {
  static from(value: string | ArrayBuffer | ArrayBufferView | ArrayLike<number> | Iterable<number>, encodingOrMap?: BufferEncoding | ((value: number, index: number) => number), thisArg?: unknown): BrowserBuffer {
    const encoding = typeof encodingOrMap === "string" ? encodingOrMap : "utf8";
    if (typeof value === "string") return new BrowserBuffer(decodeString(value, encoding));
    if (value instanceof ArrayBuffer) return new BrowserBuffer(value.slice(0));
    if (ArrayBuffer.isView(value)) {
      return new BrowserBuffer(copyViewBytes(value));
    }
    const source = value as ArrayLike<number> | Iterable<number>;
    if (isIterable(source)) {
      const bytes = typeof encodingOrMap === "function" ? Uint8Array.from(source, encodingOrMap, thisArg) : Uint8Array.from(source);
      return new BrowserBuffer(bytes);
    }
    const bytes = typeof encodingOrMap === "function" ? Uint8Array.from(source, encodingOrMap, thisArg) : Uint8Array.from(source);
    return new BrowserBuffer(bytes);
  }

  static alloc(size: number, fill: number | string = 0, encoding: BufferEncoding = "utf8"): BrowserBuffer {
    const buffer = new BrowserBuffer(assertSize(size));
    if (fill !== 0) buffer.fillValue(fill, encoding);
    return buffer;
  }

  static allocUnsafe(size: number): BrowserBuffer {
    return new BrowserBuffer(assertSize(size));
  }

  static byteLength(value: string | ArrayBuffer | ArrayBufferView, encoding: BufferEncoding = "utf8"): number {
    if (typeof value === "string") return decodeString(value, encoding).byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    return value.byteLength;
  }

  static concat(list: Array<Uint8Array | BrowserBuffer>, totalLength = list.reduce((sum, item) => sum + item.byteLength, 0)): BrowserBuffer {
    const output = new BrowserBuffer(assertSize(totalLength));
    let offset = 0;
    for (const item of list) {
      output.set(item.subarray(0, Math.max(0, totalLength - offset)), offset);
      offset += item.byteLength;
      if (offset >= totalLength) break;
    }
    return output;
  }

  static isBuffer(value: RuntimeValue): value is BrowserBuffer {
    return value instanceof BrowserBuffer;
  }

  toString(encoding: BufferEncoding = "utf8", start = 0, end = this.byteLength): string {
    const view = this.subarray(start, end);
    if (encoding === "hex") return encodeHex(view);
    if (encoding === "base64") return encodeBase64(view);
    return textDecoder.decode(view);
  }

  slice(start?: number, end?: number): BrowserBuffer {
    const [offset, length] = normalizeRange(this.byteLength, start, end);
    return new BrowserBuffer(this.buffer as ArrayBuffer, this.byteOffset + offset, length);
  }

  subarray(start?: number, end?: number): BrowserBuffer {
    const view = super.subarray(start, end);
    return new BrowserBuffer(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.byteLength): number {
    const source = this.subarray(sourceStart, sourceEnd);
    const available = Math.max(0, target.byteLength - targetStart);
    const count = Math.min(source.byteLength, available);
    target.set(source.subarray(0, count), targetStart);
    return count;
  }

  equals(other: Uint8Array): boolean {
    if (this.byteLength !== other.byteLength) return false;
    return this.every((byte, index) => byte === other[index]);
  }

  fillValue(value: number | string, encoding: BufferEncoding = "utf8"): BrowserBuffer {
    if (typeof value === "number") {
      this.fill(value & 0xff);
      return this;
    }
    const pattern = decodeString(value, encoding);
    if (pattern.byteLength === 0) return this;
    for (let index = 0; index < this.byteLength; index += 1) {
      this[index] = pattern[index % pattern.byteLength] ?? 0;
    }
    return this;
  }
}

Object.defineProperty(BrowserBuffer, Symbol.species, { value: Uint8Array });

export const Buffer = BrowserBuffer;
export const kMaxLength = 0x7fffffff;

export const bufferBuiltin = Object.freeze({
  Buffer,
  kMaxLength,
  constants: Object.freeze({ MAX_LENGTH: kMaxLength })
});

function assertSize(size: number): number {
  if (!Number.isInteger(size) || size < 0 || size > kMaxLength) {
    throw new RangeError("Invalid buffer size");
  }
  return size;
}

function decodeString(value: string, encoding: BufferEncoding): Uint8Array {
  if (encoding === "hex") return decodeHex(value);
  if (encoding === "base64") return decodeBase64(value);
  return textEncoder.encode(value);
}

function normalizeRange(length: number, start = 0, end = length): [number, number] {
  const from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
  const to = end < 0 ? Math.max(length + end, 0) : Math.min(end, length);
  return [from, Math.max(to - from, 0)];
}

function encodeHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += (hexDigits[byte >> 4] ?? "") + (hexDigits[byte & 0x0f] ?? "");
  return output;
}

function copyViewBytes(value: ArrayBufferView): Uint8Array {
  const bytes = new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(bytes);
}

function isIterable(value: ArrayLike<number> | Iterable<number>): value is Iterable<number> {
  return typeof (value as Iterable<number>)[Symbol.iterator] === "function";
}

function decodeHex(value: string): Uint8Array {
  const output = new Uint8Array(Math.floor(value.length / 2));
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return globalThis.Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  return new Uint8Array(globalThis.Buffer.from(value, "base64"));
}
