const RUNTIME_ID = /^[a-z2-7]{45}$/u;
const SIGNING_KEY = /^[A-Za-z0-9_-]{43}$/u;
const DEFAULT_TTL_MS = 5_000;

export interface SignedPreviewBinding {
  readonly expiresAt: number;
  readonly runtimeId: string;
}

export function validPreviewSigningKey(value: string | undefined): value is string {
  return value !== undefined && SIGNING_KEY.test(value);
}

export async function issueSignedPreviewBinding(
  signingKey: string,
  port: number,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS
): Promise<SignedPreviewBinding> {
  assertPort(port);
  if (!validPreviewSigningKey(signingKey) || !Number.isSafeInteger(now) || ttlMs < 1_000 || ttlMs > 30_000) throw new Error("invalid Preview signing input");
  const expiresAt = now + ttlMs;
  const expirySeconds = Math.ceil(expiresAt / 1_000);
  if (expirySeconds > 0xffff_ffff) throw new Error("invalid Preview expiry");
  const payload = new Uint8Array(16);
  new DataView(payload.buffer).setUint32(0, expirySeconds, false);
  crypto.getRandomValues(payload.subarray(4));
  const signature = await sign(signingKey, payload, port);
  const runtimeId = encodeBase32(concatenate(payload, signature));
  return { expiresAt: expirySeconds * 1_000, runtimeId };
}

export async function verifySignedPreviewBinding(
  signingKey: string,
  runtimeId: string,
  port: number,
  now = Date.now()
): Promise<"expired" | "invalid" | "valid"> {
  if (!validPreviewSigningKey(signingKey) || !RUNTIME_ID.test(runtimeId) || !validPort(port) || !Number.isSafeInteger(now)) return "invalid";
  const decoded = decodeBase32(runtimeId);
  if (!decoded || decoded.byteLength !== 28) return "invalid";
  const payload = decoded.slice(0, 16);
  const expected = await sign(signingKey, payload, port);
  if (!constantTimeEqual(expected, decoded.slice(16))) return "invalid";
  const expiresAt = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false) * 1_000;
  return now >= expiresAt ? "expired" : "valid";
}

function assertPort(port: number): void {
  if (!validPort(port)) throw new Error("invalid Preview port");
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

async function sign(signingKey: string, payload: Uint8Array, port: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(signingKey), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const value = new Uint8Array(payload.byteLength + 2);
  value.set(payload);
  new DataView(value.buffer).setUint16(payload.byteLength, port, false);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
  return signature.slice(0, 12);
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${normalized}=`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeBase32(value: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let buffer = 0;
  let result = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function decodeBase32(value: string): Uint8Array | null {
  if (!RUNTIME_ID.test(value)) return null;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  const result = Uint8Array.from(bytes);
  return encodeBase32(result) === value ? result : null;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
