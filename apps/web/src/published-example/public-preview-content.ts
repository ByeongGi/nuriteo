import { IncrementalSha256 } from "../bundles/incremental-sha256.ts";
import type { RuntimeBundleFile } from "../runtime/runtime-adapter.ts";

const CONTENT_ETAG = /^"published-content-v([1-9]\d*)-([A-Za-z0-9_-]{43})"$/u;
const PUBLIC_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const TAR_BLOCK_BYTES = 512;
const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_PUBLIC_PREVIEW_FILE_BYTES = 1024 * 1024;
export const MAX_PUBLIC_PREVIEW_LOGICAL_BYTES = 8 * 1024 * 1024;
export const MAX_PUBLIC_PREVIEW_FILES = 256;
export const MAX_PUBLIC_PREVIEW_PHYSICAL_BYTES = 16 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export type PublicPreviewContentErrorCode =
  | "PUBLIC_PREVIEW_ABORTED"
  | "PUBLIC_PREVIEW_CONTENT_UNAVAILABLE"
  | "PUBLIC_PREVIEW_DOWNLOAD_FAILED"
  | "PUBLIC_PREVIEW_INTEGRITY_FAILED"
  | "PUBLIC_PREVIEW_LIMIT_EXCEEDED";

export class PublicPreviewContentError extends Error {
  readonly code: PublicPreviewContentErrorCode;

  constructor(code: PublicPreviewContentErrorCode, message: string) {
    super(message);
    this.name = "PublicPreviewContentError";
    this.code = code;
  }
}

export interface PublicPreviewContentIdentity {
  readonly publicId: string;
  readonly versionNumber: number;
}

export interface PublicPreviewContent {
  readonly etag: string;
  readonly files: readonly RuntimeBundleFile[];
}

export async function loadPublicPreviewContent(
  identity: PublicPreviewContentIdentity,
  options: { readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal } = {}
): Promise<PublicPreviewContent> {
  validateIdentity(identity);
  assertNotAborted(options.signal);
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await request(contentPath(identity), {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/vnd.nuriteo.published-project-bundle" },
      method: "GET",
      redirect: "error",
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  } catch {
    throw requestFailure(options.signal);
  }
  if (!response.ok) {
    cancel(response.body);
    throw failure(
      response.status === 404
        ? "PUBLIC_PREVIEW_CONTENT_UNAVAILABLE"
        : "PUBLIC_PREVIEW_DOWNLOAD_FAILED",
      response.status === 404
        ? "This published version is no longer available."
        : "Published Preview content could not be downloaded."
    );
  }

  const physicalBytes = parseDecimalHeader(response.headers.get("content-length"));
  const etag = response.headers.get("etag");
  const etagMatch = etag?.match(CONTENT_ETAG) ?? null;
  if (
    physicalBytes === undefined
    || physicalBytes < 1
    || physicalBytes > MAX_PUBLIC_PREVIEW_PHYSICAL_BYTES
    || etagMatch === null
    || etagMatch[1] !== String(identity.versionNumber)
    || mediaType(response.headers.get("content-type")) !== "application/vnd.nuriteo.published-project-bundle"
    || response.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff"
    || response.headers.get("cross-origin-resource-policy")?.toLowerCase() !== "same-origin"
    || !hasNoStore(response.headers.get("cache-control"))
    || response.body === null
  ) {
    cancel(response.body);
    throw failure(
      physicalBytes !== undefined && physicalBytes > MAX_PUBLIC_PREVIEW_PHYSICAL_BYTES
        ? "PUBLIC_PREVIEW_LIMIT_EXCEEDED"
        : "PUBLIC_PREVIEW_INTEGRITY_FAILED",
      physicalBytes !== undefined && physicalBytes > MAX_PUBLIC_PREVIEW_PHYSICAL_BYTES
        ? "This example is too large to run safely in the browser."
        : "Published Preview content did not pass integrity checks."
    );
  }

  const digest = new IncrementalSha256();
  try {
    const bytes = await readBounded(
      response.body,
      physicalBytes,
      options.signal,
      (chunk) => digest.update(chunk)
    );
    const checksum = hexToBase64Url(digest.finishHex());
    if (bytes.byteLength !== physicalBytes || checksum !== etagMatch[2]) integrityFailure();
    return Object.freeze({ etag: etag as string, files: parsePublicBundle(bytes) });
  } finally {
    digest.dispose();
  }
}

interface ManifestFile {
  readonly kind: "binary" | "text";
  readonly mode: "0644" | "0755";
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

function parsePublicBundle(bytes: Uint8Array): readonly RuntimeBundleFile[] {
  const reader = new TarReader(bytes);
  const manifestEntry = reader.readEntry();
  if (
    manifestEntry === null
    || manifestEntry.name !== "manifest.json"
    || manifestEntry.type !== "0"
    || manifestEntry.mode !== 0o644
    || manifestEntry.bytes.byteLength > MAX_MANIFEST_BYTES
  ) integrityFailure();
  const manifest = parseManifest(manifestEntry.bytes);
  const files: RuntimeBundleFile[] = [];
  for (const [index, manifestFile] of manifest.files.entries()) {
    const sequence = index.toString().padStart(8, "0");
    const pax = reader.readEntry();
    const entry = reader.readEntry();
    if (
      pax === null
      || pax.name !== `PaxHeaders/${sequence}`
      || pax.type !== "x"
      || pax.mode !== 0o644
      || decodePaxPath(pax.bytes) !== `files/${manifestFile.path}`
      || entry === null
      || entry.name !== `files/${sequence}`
      || entry.type !== "0"
      || entry.mode !== Number.parseInt(manifestFile.mode, 8)
      || entry.bytes.byteLength !== manifestFile.sizeBytes
    ) integrityFailure();
    const digest = new IncrementalSha256();
    try {
      digest.update(entry.bytes);
      if (digest.finishHex() !== manifestFile.sha256) integrityFailure();
    } finally {
      digest.dispose();
    }
    if (manifestFile.kind === "text") {
      try {
        decoder.decode(entry.bytes);
      } catch {
        integrityFailure();
      }
    }
    files.push(Object.freeze({
      bytes: Uint8Array.from(entry.bytes),
      kind: manifestFile.kind,
      path: manifestFile.path
    }));
  }
  reader.finish();
  return Object.freeze(files);
}

function parseManifest(bytes: Uint8Array): { readonly files: readonly ManifestFile[] } {
  let value: unknown;
  try {
    const text = decoder.decode(bytes);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) integrityFailure();
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof PublicPreviewContentError) throw error;
    integrityFailure();
  }
  const record = exactRecord(value, ["fileCount", "files", "format", "logicalBytes", "schemaVersion"]);
  if (
    record.format !== "nuriteo-published-bundle-v1"
    || record.schemaVersion !== 1
    || !isNonNegativeSafeInteger(record.fileCount)
    || record.fileCount > MAX_PUBLIC_PREVIEW_FILES
    || !isNonNegativeSafeInteger(record.logicalBytes)
    || record.logicalBytes > MAX_PUBLIC_PREVIEW_LOGICAL_BYTES
    || !Array.isArray(record.files)
    || record.files.length !== record.fileCount
  ) limitOrIntegrityFailure(record);

  const files: ManifestFile[] = [];
  let logicalBytes = 0;
  let previousPath: string | undefined;
  for (const input of record.files) {
    const file = exactRecord(input, ["kind", "mode", "path", "sha256", "sizeBytes"]);
    if (
      typeof file.path !== "string"
      || !isSafePath(file.path)
      || (file.kind !== "text" && file.kind !== "binary")
      || (file.mode !== "0644" && file.mode !== "0755")
      || !isNonNegativeSafeInteger(file.sizeBytes)
      || file.sizeBytes > MAX_PUBLIC_PREVIEW_FILE_BYTES
      || typeof file.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(file.sha256)
      || (previousPath !== undefined && compareUtf8(previousPath, file.path) >= 0)
    ) {
      if (typeof file.sizeBytes === "number" && file.sizeBytes > MAX_PUBLIC_PREVIEW_FILE_BYTES) {
        throw limitFailure();
      }
      integrityFailure();
    }
    logicalBytes = checkedAdd(logicalBytes, file.sizeBytes);
    if (logicalBytes > MAX_PUBLIC_PREVIEW_LOGICAL_BYTES) throw limitFailure();
    previousPath = file.path;
    files.push(file as unknown as ManifestFile);
  }
  if (logicalBytes !== record.logicalBytes) integrityFailure();
  return { files };
}

function limitOrIntegrityFailure(record: Record<string, unknown>): never {
  if (
    (typeof record.fileCount === "number" && record.fileCount > MAX_PUBLIC_PREVIEW_FILES)
    || (typeof record.logicalBytes === "number" && record.logicalBytes > MAX_PUBLIC_PREVIEW_LOGICAL_BYTES)
  ) throw limitFailure();
  integrityFailure();
}

interface TarEntry {
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly name: string;
  readonly type: "0" | "x";
}

class TarReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  readEntry(): TarEntry | null {
    if (this.#offset + TAR_BLOCK_BYTES > this.#bytes.byteLength) integrityFailure();
    const header = this.#bytes.subarray(this.#offset, this.#offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) return null;
    const name = readString(header.subarray(0, 100));
    const mode = readOctal(header.subarray(100, 108));
    const size = readOctal(header.subarray(124, 136));
    const typeCode = header[156];
    if (!isNonNegativeSafeInteger(size) || (typeCode !== 0x30 && typeCode !== 0x78)) integrityFailure();
    const type = typeCode === 0x30 ? "0" : "x";
    if (!equalBytes(header, canonicalTarHeader(name, size, mode, type))) integrityFailure();
    const contentOffset = this.#offset + TAR_BLOCK_BYTES;
    const paddedBytes = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const nextOffset = checkedAdd(contentOffset, paddedBytes);
    if (nextOffset > this.#bytes.byteLength) integrityFailure();
    const content = this.#bytes.subarray(contentOffset, contentOffset + size);
    if (!this.#bytes.subarray(contentOffset + size, nextOffset).every((byte) => byte === 0)) {
      integrityFailure();
    }
    this.#offset = nextOffset;
    return { bytes: content, mode, name, type };
  }

  finish(): void {
    if (
      this.#bytes.byteLength - this.#offset !== TAR_BLOCK_BYTES * 2
      || !this.#bytes.subarray(this.#offset).every((byte) => byte === 0)
    ) integrityFailure();
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal | undefined,
  observe: (chunk: Uint8Array) => void
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      assertNotAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      length = checkedAdd(length, result.value.byteLength);
      if (length > maximum) {
        await reader.cancel();
        integrityFailure();
      }
      observe(result.value);
      chunks.push(Uint8Array.from(result.value));
    }
  } catch (error) {
    if (error instanceof PublicPreviewContentError) throw error;
    throw requestFailure(signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateIdentity(identity: PublicPreviewContentIdentity): void {
  if (
    !PUBLIC_ID.test(identity.publicId)
    || !Number.isSafeInteger(identity.versionNumber)
    || identity.versionNumber < 1
  ) integrityFailure();
}

function contentPath(identity: PublicPreviewContentIdentity): string {
  return `/api/v1/published-examples/${identity.publicId}/versions/${identity.versionNumber}/content`;
}

function isSafePath(path: string): boolean {
  if (
    path.length === 0
    || path !== path.normalize("NFC")
    || path.startsWith("/")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || encoder.encode(path).byteLength > 512
  ) return false;
  const segments = path.split("/");
  return segments.length <= 32 && segments.every((segment) =>
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && encoder.encode(segment).byteLength <= 255
  );
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) integrityFailure();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    integrityFailure();
  }
  return value as Record<string, unknown>;
}

function requestFailure(signal: AbortSignal | undefined): PublicPreviewContentError {
  return signal?.aborted
    ? failure("PUBLIC_PREVIEW_ABORTED", "Published Preview startup was cancelled.")
    : failure("PUBLIC_PREVIEW_DOWNLOAD_FAILED", "Published Preview content could not be downloaded.");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw requestFailure(signal);
}

function integrityFailure(): never {
  throw failure(
    "PUBLIC_PREVIEW_INTEGRITY_FAILED",
    "Published Preview content did not pass integrity checks."
  );
}

function limitFailure(): PublicPreviewContentError {
  return failure(
    "PUBLIC_PREVIEW_LIMIT_EXCEEDED",
    "This example is too large to run safely in the browser."
  );
}

function failure(code: PublicPreviewContentErrorCode, message: string): PublicPreviewContentError {
  return new PublicPreviewContentError(code, message);
}

function cancel(stream: ReadableStream<Uint8Array> | null): void {
  void stream?.cancel().catch(() => undefined);
}

function parseDecimalHeader(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function mediaType(value: string | null): string | undefined {
  if (value === null || value.includes(",")) return undefined;
  return value.split(";", 1)[0]?.trim().toLowerCase();
}

function hasNoStore(value: string | null): boolean {
  return value !== null
    && value.toLowerCase().split(",").some((directive) => directive.trim() === "no-store");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) integrityFailure();
  return sum;
}

function readString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  try {
    return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
  } catch {
    integrityFailure();
  }
}

function readOctal(bytes: Uint8Array): number {
  const value = readString(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) integrityFailure();
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) integrityFailure();
  return parsed;
}

function canonicalTarHeader(name: string, size: number, mode: number, type: "0" | "x"): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  const nameBytes = encoder.encode(name);
  if (nameBytes.byteLength > 100) integrityFailure();
  header.set(nameBytes, 0);
  writeCanonicalOctal(header, 100, 8, mode);
  writeCanonicalOctal(header, 108, 8, 0);
  writeCanonicalOctal(header, 116, 8, 0);
  writeCanonicalOctal(header, 124, 12, size);
  writeCanonicalOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const digits = checksum.toString(8).padStart(6, "0");
  if (digits.length !== 6) integrityFailure();
  header.set(encoder.encode(digits), 148);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeCanonicalOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length !== length - 1) integrityFailure();
  target.set(encoder.encode(digits), offset);
  target[offset + length - 1] = 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

function decodePaxPath(bytes: Uint8Array): string {
  let record: string;
  try {
    record = decoder.decode(bytes);
  } catch {
    integrityFailure();
  }
  const separator = record.indexOf(" ");
  if (separator < 1 || !/^[1-9]\d*$/u.test(record.slice(0, separator))) integrityFailure();
  if (Number(record.slice(0, separator)) !== bytes.byteLength) integrityFailure();
  const body = record.slice(separator + 1);
  if (!body.startsWith("path=") || !body.endsWith("\n") || body.slice(0, -1).includes("\n")) {
    integrityFailure();
  }
  return body.slice(5, -1);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function hexToBase64Url(hex: string): string {
  let result = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let index = 0; index < hex.length; index += 6) {
    const chunk = hex.slice(index, index + 6);
    const value = Number.parseInt(chunk.padEnd(6, "0"), 16);
    const bytes = Math.ceil(chunk.length / 2);
    result += alphabet[(value >>> 18) & 63];
    result += alphabet[(value >>> 12) & 63];
    if (bytes > 1) result += alphabet[(value >>> 6) & 63];
    if (bytes > 2) result += alphabet[value & 63];
  }
  return result;
}
