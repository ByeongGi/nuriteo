const COOKIE_NAME = "nuriteo_preview_client";
const CLIENT_BYTES = 16;
const SIGNATURE_BYTES = 16;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/u;

export interface PublicPreviewClientIdentity {
  readonly abuseKey: string;
  readonly abuseProof: string;
  readonly setCookie: string | undefined;
}

export async function publicPreviewClientIdentity(
  signingKey: string,
  cookieHeaders: readonly string[],
  publicId: string,
  versionNumber: number,
  secure: boolean
): Promise<PublicPreviewClientIdentity> {
  const existing = readCookie(cookieHeaders);
  const clientId = existing === undefined
    ? crypto.getRandomValues(new Uint8Array(CLIENT_BYTES))
    : await verifiedClientId(signingKey, existing);
  const effectiveClientId = clientId ?? crypto.getRandomValues(new Uint8Array(CLIENT_BYTES));
  const cookieValue = existing !== undefined && clientId !== null
    ? existing
    : await signedCookieValue(signingKey, effectiveClientId);
  const digest = await hmac(signingKey, framed("public-preview-rate-v1", effectiveClientId, publicId));
  const abuseKey = uuid(digest.subarray(0, 16));
  const proof = await hmac(
    signingKey,
    new TextEncoder().encode(`public-preview-admission-v1\0${abuseKey}\0${publicId}\0${versionNumber}`)
  );
  return {
    abuseKey,
    abuseProof: encodeBase64Url(proof),
    setCookie: cookieValue === existing
      ? undefined
      : `${COOKIE_NAME}=${cookieValue}; HttpOnly; Max-Age=2592000; Path=/; SameSite=Strict${secure ? "; Secure" : ""}`
  };
}

async function signedCookieValue(signingKey: string, clientId: Uint8Array): Promise<string> {
  const signature = await hmac(signingKey, framed("public-preview-client-v1", clientId));
  return encodeBase64Url(concatenate(clientId, signature.subarray(0, SIGNATURE_BYTES)));
}

async function verifiedClientId(signingKey: string, value: string): Promise<Uint8Array | null> {
  if (!COOKIE_VALUE.test(value)) return null;
  const decoded = decodeBase64Url(value);
  if (decoded === null || decoded.byteLength !== CLIENT_BYTES + SIGNATURE_BYTES) return null;
  const clientId = decoded.subarray(0, CLIENT_BYTES);
  const expected = await signedCookieValue(signingKey, clientId);
  return constantTimeEqual(value, expected) ? clientId : null;
}

async function hmac(signingKey: string, value: Uint8Array): Promise<Uint8Array> {
  const rawKey = Uint8Array.from(decodeBase64Url(signingKey)!);
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey.buffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(value).buffer));
}

function readCookie(headers: readonly string[]): string | undefined {
  const values: string[] = [];
  for (const header of headers) {
    for (const pair of header.split(";")) {
      const separator = pair.indexOf("=");
      if (separator < 0 || pair.slice(0, separator).trim() !== COOKIE_NAME) continue;
      values.push(pair.slice(separator + 1).trim());
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function framed(label: string, bytes: Uint8Array, text = ""): Uint8Array {
  const labelBytes = new TextEncoder().encode(`${label}\0`);
  const textBytes = new TextEncoder().encode(text);
  const result = new Uint8Array(labelBytes.byteLength + bytes.byteLength + 1 + textBytes.byteLength);
  result.set(labelBytes);
  result.set(bytes, labelBytes.byteLength);
  result[labelBytes.byteLength + bytes.byteLength] = 0;
  result.set(textBytes, labelBytes.byteLength + bytes.byteLength + 1);
  return result;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(Buffer.from(value, "base64url"));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function uuid(bytes: Uint8Array): string {
  const copy = Uint8Array.from(bytes);
  copy[6] = (copy[6]! & 0x0f) | 0x40;
  copy[8] = (copy[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(copy).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
