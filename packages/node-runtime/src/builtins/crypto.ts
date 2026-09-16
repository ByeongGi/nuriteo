import { BrowserBuffer, type BufferEncoding } from "./buffer.ts";

export type BinaryLike = string | ArrayBuffer | ArrayBufferView | Iterable<number>;
export type BinaryToTextEncoding = "base64" | "base64url" | "hex";
export type HashEncoding = BinaryToTextEncoding | "binary" | "latin1";
export type HashAlgorithm = "sha1" | "sha256" | "sha512";

const hexDigits = "0123456789abcdef";
const sha256Initial = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);
const sha256RoundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const mask64 = (1n << 64n) - 1n;
const sha512Initial = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n
];
const sha512RoundConstants = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n
];

export class UnsupportedCryptoError extends Error {
  code = "ERR_BROWSER_CRYPTO_UNSUPPORTED";

  constructor(operation: string) {
    super(`The browser runtime crypto subset does not support ${operation}`);
    this.name = "UnsupportedCryptoError";
  }
}

export class Hash {
  readonly algorithm: HashAlgorithm;
  #chunks: Uint8Array[] = [];
  #digested = false;

  constructor(algorithm: string) {
    this.algorithm = normalizeHashAlgorithm(algorithm);
  }

  update(data: BinaryLike, inputEncoding?: BufferEncoding): this {
    if (this.#digested) throw new Error("Digest already called");
    this.#chunks.push(toBytes(data, inputEncoding));
    return this;
  }

  digest(): BrowserBuffer;
  digest(encoding: HashEncoding): string;
  digest(encoding?: HashEncoding): BrowserBuffer | string {
    if (this.#digested) throw new Error("Digest already called");
    this.#digested = true;
    const digest = hashBytes(this.algorithm, concatBytes(this.#chunks));
    if (!encoding) return BrowserBuffer.from(digest);
    if (encoding === "base64") return encodeBase64(digest);
    if (encoding === "base64url") return encodeBase64(digest).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    if (encoding === "hex") return encodeHex(digest);
    return String.fromCharCode(...digest);
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm);
}

export function hash(algorithm: string, data: BinaryLike, outputEncoding: HashEncoding = "hex"): string | BrowserBuffer {
  return createHash(algorithm).update(data).digest(outputEncoding);
}

export function getHashes(): string[] {
  return ["sha1", "sha256", "sha512"];
}

export function randomBytes(size: number): BrowserBuffer {
  if (!Number.isInteger(size) || size < 0) throw new RangeError("Invalid randomBytes size");
  const bytes = new Uint8Array(size);
  fillRandom(bytes);
  return BrowserBuffer.from(bytes);
}

export function randomFillSync<T extends ArrayBufferView<ArrayBufferLike>>(buffer: T): T {
  fillRandom(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  return buffer;
}

export function getRandomValues<T extends ArrayBufferView<ArrayBufferLike>>(array: T): T {
  fillRandom(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  return array;
}

export function randomUUID(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = encodeHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) throw new RangeError("Input buffers must have the same byte length");
  let diff = 0;
  for (let index = 0; index < a.byteLength; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

export function createHmac(): never {
  throw new UnsupportedCryptoError("createHmac");
}

export function createPrivateKey(): never {
  throw new UnsupportedCryptoError("createPrivateKey");
}

export function createPublicKey(): never {
  throw new UnsupportedCryptoError("createPublicKey");
}

export function generateKeyPairSync(): never {
  throw new UnsupportedCryptoError("generateKeyPairSync");
}

export function sign(): never {
  throw new UnsupportedCryptoError("sign");
}

export function verify(): never {
  throw new UnsupportedCryptoError("verify");
}

export const cryptoBuiltin = Object.freeze({
  Hash,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  getRandomValues,
  getHashes,
  hash,
  randomBytes,
  randomFillSync,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  webcrypto: Object.freeze({
    getRandomValues,
    randomUUID
  })
});

function normalizeHashAlgorithm(algorithm: string): HashAlgorithm {
  const normalized = algorithm.toLowerCase().replace("-", "");
  if (normalized === "sha1" || normalized === "sha256" || normalized === "sha512") return normalized;
  throw new Error(`Digest method not supported: ${algorithm}`);
}

function hashBytes(algorithm: HashAlgorithm, bytes: Uint8Array): Uint8Array {
  if (algorithm === "sha1") return sha1(bytes);
  if (algorithm === "sha256") return sha256(bytes);
  if (algorithm === "sha512") return sha512(bytes);
  throw new UnsupportedCryptoError(algorithm);
}

function toBytes(value: BinaryLike, encoding: BufferEncoding = "utf8"): Uint8Array {
  if (typeof value === "string") return BrowserBuffer.from(value, encoding);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return Uint8Array.from(value);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function sha1(input: Uint8Array): Uint8Array {
  const bytes = padSha256(input);
  const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const words = new Uint32Array(80);
  for (let offset = 0; offset < bytes.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = readUint32(bytes, offset + index * 4);
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft32((words[index - 3] ?? 0) ^ (words[index - 8] ?? 0) ^ (words[index - 14] ?? 0) ^ (words[index - 16] ?? 0), 1);
    }
    let a = u32At(state, 0);
    let b = u32At(state, 1);
    let c = u32At(state, 2);
    let d = u32At(state, 3);
    let e = u32At(state, 4);
    for (let index = 0; index < 80; index += 1) {
      const round = Math.floor(index / 20);
      const f = round === 0
        ? (b & c) | (~b & d)
        : round === 2
          ? (b & c) | (b & d) | (c & d)
          : b ^ c ^ d;
      const k = round === 0 ? 0x5a827999 : round === 1 ? 0x6ed9eba1 : round === 2 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (rotateLeft32(a, 5) + f + e + k + (words[index] ?? 0)) >>> 0;
      e = d; d = c; c = rotateLeft32(b, 30); b = a; a = temp;
    }
    state[0] = (u32At(state, 0) + a) >>> 0;
    state[1] = (u32At(state, 1) + b) >>> 0;
    state[2] = (u32At(state, 2) + c) >>> 0;
    state[3] = (u32At(state, 3) + d) >>> 0;
    state[4] = (u32At(state, 4) + e) >>> 0;
  }
  const output = new Uint8Array(20);
  for (let index = 0; index < state.length; index += 1) writeUint32(output, index * 4, state[index] ?? 0);
  return output;
}

function sha256(input: Uint8Array): Uint8Array {
  const bytes = padSha256(input);
  const state = Uint32Array.from(sha256Initial);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = readUint32(bytes, offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight32(words[index - 15] ?? 0, 7) ^ rotateRight32(words[index - 15] ?? 0, 18) ^ ((words[index - 15] ?? 0) >>> 3);
      const s1 = rotateRight32(words[index - 2] ?? 0, 17) ^ rotateRight32(words[index - 2] ?? 0, 19) ^ ((words[index - 2] ?? 0) >>> 10);
      words[index] = (((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0);
    }
    let a = u32At(state, 0);
    let b = u32At(state, 1);
    let c = u32At(state, 2);
    let d = u32At(state, 3);
    let e = u32At(state, 4);
    let f = u32At(state, 5);
    let g = u32At(state, 6);
    let h = u32At(state, 7);
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight32(e, 6) ^ rotateRight32(e, 11) ^ rotateRight32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (sha256RoundConstants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const s0 = rotateRight32(a, 2) ^ rotateRight32(a, 13) ^ rotateRight32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
  const output = new Uint8Array(32);
  for (let index = 0; index < state.length; index += 1) writeUint32(output, index * 4, state[index] ?? 0);
  return output;
}

function sha512(input: Uint8Array): Uint8Array {
  const bytes = padSha512(input);
  const state = [...sha512Initial];
  const words = new Array<bigint>(80).fill(0n);
  for (let offset = 0; offset < bytes.byteLength; offset += 128) {
    for (let index = 0; index < 16; index += 1) words[index] = readUint64(bytes, offset + index * 8);
    for (let index = 16; index < 80; index += 1) {
      const s0 = rotateRight64(words[index - 15] ?? 0n, 1n) ^ rotateRight64(words[index - 15] ?? 0n, 8n) ^ ((words[index - 15] ?? 0n) >> 7n);
      const s1 = rotateRight64(words[index - 2] ?? 0n, 19n) ^ rotateRight64(words[index - 2] ?? 0n, 61n) ^ ((words[index - 2] ?? 0n) >> 6n);
      words[index] = ((words[index - 16] ?? 0n) + s0 + (words[index - 7] ?? 0n) + s1) & mask64;
    }
    let a = u64At(state, 0);
    let b = u64At(state, 1);
    let c = u64At(state, 2);
    let d = u64At(state, 3);
    let e = u64At(state, 4);
    let f = u64At(state, 5);
    let g = u64At(state, 6);
    let h = u64At(state, 7);
    for (let index = 0; index < 80; index += 1) {
      const s1 = rotateRight64(e, 14n) ^ rotateRight64(e, 18n) ^ rotateRight64(e, 41n);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (sha512RoundConstants[index] ?? 0n) + (words[index] ?? 0n)) & mask64;
      const s0 = rotateRight64(a, 28n) ^ rotateRight64(a, 34n) ^ rotateRight64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) & mask64;
      h = g; g = f; f = e; e = (d + temp1) & mask64; d = c; c = b; b = a; a = (temp1 + temp2) & mask64;
    }
    state[0] = ((state[0] ?? 0n) + a) & mask64;
    state[1] = ((state[1] ?? 0n) + b) & mask64;
    state[2] = ((state[2] ?? 0n) + c) & mask64;
    state[3] = ((state[3] ?? 0n) + d) & mask64;
    state[4] = ((state[4] ?? 0n) + e) & mask64;
    state[5] = ((state[5] ?? 0n) + f) & mask64;
    state[6] = ((state[6] ?? 0n) + g) & mask64;
    state[7] = ((state[7] ?? 0n) + h) & mask64;
  }
  const output = new Uint8Array(64);
  for (let index = 0; index < state.length; index += 1) writeUint64(output, index * 8, state[index] ?? 0n);
  return output;
}

function padSha256(input: Uint8Array): Uint8Array {
  const bitLength = input.byteLength * 8;
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const output = new Uint8Array(paddedLength);
  output.set(input);
  output[input.byteLength] = 0x80;
  const view = new DataView(output.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  return output;
}

function padSha512(input: Uint8Array): Uint8Array {
  const bitLength = BigInt(input.byteLength) * 8n;
  const paddedLength = Math.ceil((input.byteLength + 17) / 128) * 128;
  const output = new Uint8Array(paddedLength);
  output.set(input);
  output[input.byteLength] = 0x80;
  writeUint64(output, paddedLength - 16, 0n);
  writeUint64(output, paddedLength - 8, bitLength);
  return output;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  return value;
}

function writeUint64(bytes: Uint8Array, offset: number, value: bigint): void {
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function rotateRight32(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function rotateLeft32(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function rotateRight64(value: bigint, shift: bigint): bigint {
  return ((value >> shift) | (value << (64n - shift))) & mask64;
}

function u32At(values: Uint32Array, index: number): number {
  return values[index] ?? 0;
}

function u64At(values: readonly bigint[], index: number): bigint {
  return values[index] ?? 0n;
}

function fillRandom(bytes: Uint8Array): void {
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
    return;
  }
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = Math.floor(Math.random() * 256);
}

function encodeHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += (hexDigits[byte >> 4] ?? "") + (hexDigits[byte & 0x0f] ?? "");
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
