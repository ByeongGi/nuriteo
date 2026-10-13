import type { RuntimeValue } from "../types.ts";

export type BufferEncoding = "utf8" | "utf-8" | "hex" | "base64" | "ascii" | "binary" | "latin1";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const hexDigits = "0123456789abcdef";

export class BrowserBuffer extends Uint8Array {
  static from(value: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | ArrayLike<number> | Iterable<number>, encodingOrMap?: BufferEncoding | number | ((value: number, index: number) => number), lengthOrThisArg?: number | unknown): BrowserBuffer {
    const encoding = typeof encodingOrMap === "string" ? encodingOrMap : "utf8";
    if (typeof value === "string") return new BrowserBuffer(decodeString(value, encoding));
    if ((value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) && typeof encodingOrMap === "number") {
      const offset = Math.max(0, encodingOrMap);
      const available = Math.max(0, value.byteLength - offset);
      const length = typeof lengthOrThisArg === "number" ? Math.min(available, Math.max(0, lengthOrThisArg)) : available;
      return new BrowserBuffer(value as ArrayBuffer, offset, length);
    }
    if (value instanceof ArrayBuffer) return new BrowserBuffer(value.slice(0));
    if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
      return new BrowserBuffer(Uint8Array.from(new Uint8Array(value)));
    }
    if (ArrayBuffer.isView(value)) {
      return new BrowserBuffer(copyViewBytes(value));
    }
    const source = value as ArrayLike<number> | Iterable<number>;
    if (isIterable(source)) {
      const bytes = typeof encodingOrMap === "function" ? Uint8Array.from(source, encodingOrMap, lengthOrThisArg) : Uint8Array.from(source);
      return new BrowserBuffer(bytes);
    }
    const bytes = typeof encodingOrMap === "function" ? Uint8Array.from(source, encodingOrMap, lengthOrThisArg) : Uint8Array.from(source);
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

  static allocUnsafeSlow(size: number): BrowserBuffer {
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

  static isEncoding(encoding: string): encoding is BufferEncoding {
    return ["utf8", "utf-8", "hex", "base64", "ascii", "binary", "latin1"].includes(encoding.toLowerCase());
  }

  toString(encoding: BufferEncoding = "utf8", start = 0, end = this.byteLength): string {
    const view = this.subarray(start, end);
    if (encoding === "hex") return encodeHex(view);
    if (encoding === "base64") return encodeBase64(view);
    if (encoding === "ascii" || encoding === "binary" || encoding === "latin1") {
      return encodeLatin1(view);
    }
    return textDecoder.decode(view);
  }

  write(value: string, offset = 0, lengthOrEncoding?: number | BufferEncoding, maybeEncoding: BufferEncoding = "utf8"): number {
    const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : this.byteLength - offset;
    const encoding = typeof lengthOrEncoding === "string" ? lengthOrEncoding : maybeEncoding;
    const bytes = decodeString(value, encoding);
    const count = Math.min(Math.max(0, length), bytes.byteLength, Math.max(0, this.byteLength - offset));
    this.set(bytes.subarray(0, count), offset);
    return count;
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

  readUInt8(offset = 0): number {
    return this[offset] ?? 0;
  }

  readUInt16LE(offset = 0): number {
    return this.#dataView().getUint16(offset, true);
  }

  readUInt32LE(offset = 0): number {
    return this.#dataView().getUint32(offset, true);
  }

  readUInt32BE(offset = 0): number {
    return this.#dataView().getUint32(offset, false);
  }

  readInt8(offset = 0): number {
    return this.#dataView().getInt8(offset);
  }

  readInt32LE(offset = 0): number {
    return this.#dataView().getInt32(offset, true);
  }

  readDoubleLE(offset = 0): number {
    return this.#dataView().getFloat64(offset, true);
  }

  readBigUInt64LE(offset = 0): bigint {
    return this.#dataView().getBigUint64(offset, true);
  }

  writeUInt8(value: number, offset = 0): number {
    this.#dataView().setUint8(offset, value);
    return offset + 1;
  }

  writeUInt16LE(value: number, offset = 0): number {
    this.#dataView().setUint16(offset, value, true);
    return offset + 2;
  }

  writeUInt32LE(value: number, offset = 0): number {
    this.#dataView().setUint32(offset, value, true);
    return offset + 4;
  }

  writeInt8(value: number, offset = 0): number {
    this.#dataView().setInt8(offset, value);
    return offset + 1;
  }

  writeInt32LE(value: number, offset = 0): number {
    this.#dataView().setInt32(offset, value, true);
    return offset + 4;
  }

  writeDoubleLE(value: number, offset = 0): number {
    this.#dataView().setFloat64(offset, value, true);
    return offset + 8;
  }

  writeBigUInt64LE(value: bigint, offset = 0): number {
    this.#dataView().setBigUint64(offset, value, true);
    return offset + 8;
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

  #dataView(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }
}

Object.defineProperty(BrowserBuffer, Symbol.species, { value: Uint8Array });

export type BufferConstructor = typeof BrowserBuffer & {
  (value: number | string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | ArrayLike<number> | Iterable<number>, encodingOrOffset?: BufferEncoding | number, length?: number): BrowserBuffer;
};

const BufferFacade = function Buffer(value: number | string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | ArrayLike<number> | Iterable<number>, encodingOrOffset?: BufferEncoding | number, length?: number): BrowserBuffer {
  if (typeof value === "number") return BrowserBuffer.alloc(value);
  if (value instanceof ArrayBuffer && typeof encodingOrOffset === "number") {
    const offset = Math.max(0, encodingOrOffset);
    const byteLength = typeof length === "number" ? Math.min(value.byteLength - offset, Math.max(0, length)) : value.byteLength - offset;
    return new BrowserBuffer(value, offset, byteLength);
  }
  return BrowserBuffer.from(value, typeof encodingOrOffset === "string" ? encodingOrOffset : undefined);
};

Object.setPrototypeOf(BufferFacade, BrowserBuffer);
Object.defineProperty(BufferFacade, "prototype", { value: BrowserBuffer.prototype });

export const Buffer = BufferFacade as unknown as BufferConstructor;
export const kMaxLength = 0x7fffffff;

export const bufferBuiltin = Object.freeze({
  Blob,
  Buffer,
  File,
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
  if (encoding === "ascii" || encoding === "binary" || encoding === "latin1") {
    return Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff);
  }
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

function encodeLatin1(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 24_576) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 24_576)));
  }
  return chunks.join("");
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
  const nativeBuffer = globalThis.Buffer as unknown;
  if (nativeBuffer && nativeBuffer !== BrowserBuffer && nativeBuffer !== Buffer) {
    return globalThis.Buffer.from(bytes).toString("base64");
  }
  const encoded: string[] = [];
  const chunkSize = 24_576;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    encoded.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))));
  }
  return encoded.join("");
}

function decodeBase64(value: string): Uint8Array {
  const nativeBuffer = globalThis.Buffer as unknown;
  if (nativeBuffer && nativeBuffer !== BrowserBuffer && nativeBuffer !== Buffer) {
    return new Uint8Array(globalThis.Buffer.from(value, "base64"));
  }
  const alphabet = value.replaceAll("-", "+").replaceAll("_", "/").replace(/[^A-Za-z0-9+/]/g, "");
  const normalized = alphabet.length % 4 === 1 ? alphabet.slice(0, -1) : alphabet;
  const binary = atob(normalized);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}
