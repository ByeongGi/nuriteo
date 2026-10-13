import { IncrementalSha256 } from "../bundles/incremental-sha256.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_ETAG = /^"content-v([1-9]\d*)-([A-Za-z0-9_-]{43})"$/u;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/u;
const TAR_BLOCK_BYTES = 512;
const MAX_DESCRIPTOR_BYTES = 32 * 1024;
export const MAX_RESUME_FILE_BYTES = 1024 * 1024;
export const MAX_RESUME_LOGICAL_BYTES = 8 * 1024 * 1024;
export const MAX_RESUME_FILES = 256;
export const MAX_RESUME_PHYSICAL_BYTES = 16 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export type ProjectContentErrorCode =
  | "RESUME_ABORTED"
  | "RESUME_AUTHENTICATION_REQUIRED"
  | "RESUME_CONTENT_UNAVAILABLE"
  | "RESUME_DESCRIPTOR_INVALID"
  | "RESUME_DOWNLOAD_FAILED"
  | "RESUME_INTEGRITY_FAILED"
  | "RESUME_LIMIT_EXCEEDED"
  | "RESUME_NOT_SAVED";

export class ProjectContentError extends Error {
  readonly code: ProjectContentErrorCode;

  constructor(code: ProjectContentErrorCode, message: string) {
    super(message);
    this.name = "ProjectContentError";
    this.code = code;
  }
}

export interface ProjectContentIdentity {
  readonly ownerType: "organization" | "user";
  readonly ownerId: string;
  readonly projectId: string;
  readonly storageScopeId: string;
}

export interface ProjectContentDescriptor {
  readonly projectId: string;
  readonly projectVersion: number;
  readonly bundleId: string;
  readonly etag: string;
  readonly checksumAlgorithm: "sha-256";
  readonly checksum: string;
  readonly physicalBytes: number;
  readonly logicalBytes: number;
  readonly fileCount: number;
  readonly format: "project-bundle-v1";
  readonly downloadUrl: string;
}

export interface MaterializedProjectContent {
  readonly descriptor: ProjectContentDescriptor;
  readonly files: readonly ResumedProjectFile[];
}

export interface ResumedProjectFile {
  readonly path: string;
  readonly kind: "text" | "binary";
  readonly executable: boolean;
  readonly bytes: Uint8Array;
}

export interface ResumeProjectContentOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

/**
 * Downloads the current Working Head through the same-origin Core stream,
 * verifies both the descriptor digest and every canonical archive entry, and
 * only then returns a detached, bounded Runtime projection.
 */
export async function resumeProjectContent(
  identity: ProjectContentIdentity,
  options: ResumeProjectContentOptions = {}
): Promise<MaterializedProjectContent> {
  validateIdentity(identity);
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  let descriptor = await getDescriptor(request, identity, options.signal);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const bytes = await downloadBundle(request, descriptor, options.signal);
      return {
        descriptor,
        files: parseProjectBundleV1(bytes, descriptor, identity)
      };
    } catch (error) {
      if (attempt === 0 && isStaleDescriptor(error)) {
        descriptor = await getDescriptor(request, identity, options.signal);
        continue;
      }
      throw error;
    }
  }
  throw failure("RESUME_DOWNLOAD_FAILED", "Saved Project content could not be downloaded.");
}

async function getDescriptor(
  request: typeof globalThis.fetch,
  identity: ProjectContentIdentity,
  signal: AbortSignal | undefined
): Promise<ProjectContentDescriptor> {
  assertNotAborted(signal);
  const path = contentPath(identity);
  let response: Response;
  try {
    response = await request(path, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "GET",
      redirect: "error",
      ...(signal === undefined ? {} : { signal })
    });
  } catch {
    throw requestFailure(signal);
  }
  if (!response.ok) {
    cancel(response.body);
    throw responseFailure(response.status);
  }
  if (!isMediaType(response.headers.get("content-type"), "application/json")) {
    cancel(response.body);
    throw failure("RESUME_DESCRIPTOR_INVALID", "Saved Project metadata is malformed.");
  }
  const bytes = await readBounded(response.body, MAX_DESCRIPTOR_BYTES, signal);
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw failure("RESUME_DESCRIPTOR_INVALID", "Saved Project metadata is malformed.");
  }
  return parseDescriptor(value, identity);
}

async function downloadBundle(
  request: typeof globalThis.fetch,
  descriptor: ProjectContentDescriptor,
  signal: AbortSignal | undefined
): Promise<Uint8Array> {
  assertNotAborted(signal);
  let response: Response;
  try {
    response = await request(descriptor.downloadUrl, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/octet-stream", "if-match": descriptor.etag },
      method: "GET",
      redirect: "error",
      ...(signal === undefined ? {} : { signal })
    });
  } catch {
    throw requestFailure(signal);
  }
  if (!response.ok) {
    cancel(response.body);
    if (response.status === 412) throw staleDescriptor();
    throw responseFailure(response.status);
  }
  const declaredLength = parseDecimalHeader(response.headers.get("content-length"));
  if (
    declaredLength !== descriptor.physicalBytes
    || response.headers.get("etag") !== descriptor.etag
    || !isMediaType(response.headers.get("content-type"), "application/octet-stream")
    || response.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff"
    || !hasNoStore(response.headers.get("cache-control"))
  ) {
    cancel(response.body);
    throw failure("RESUME_INTEGRITY_FAILED", "Saved Project content did not pass integrity checks.");
  }

  const digest = new IncrementalSha256();
  try {
    const bytes = await readBounded(response.body, descriptor.physicalBytes, signal, (chunk) => digest.update(chunk));
    if (bytes.byteLength !== descriptor.physicalBytes || hexToBase64Url(digest.finishHex()) !== descriptor.checksum) {
      throw failure("RESUME_INTEGRITY_FAILED", "Saved Project content did not pass integrity checks.");
    }
    return bytes;
  } finally {
    digest.dispose();
  }
}

function parseDescriptor(value: unknown, identity: ProjectContentIdentity): ProjectContentDescriptor {
  const record = exactRecord(value, [
    "bundleId", "checksum", "checksumAlgorithm", "downloadUrl", "etag", "fileCount", "format",
    "logicalBytes", "physicalBytes", "projectId", "projectVersion"
  ], "RESUME_DESCRIPTOR_INVALID");
  const descriptor = record as unknown as ProjectContentDescriptor;
  const etag = typeof descriptor.etag === "string" ? descriptor.etag.match(CONTENT_ETAG) : null;
  if (
    descriptor.projectId !== identity.projectId
    || typeof descriptor.bundleId !== "string"
    || !UUID_V7.test(descriptor.bundleId)
    || descriptor.checksumAlgorithm !== "sha-256"
    || typeof descriptor.checksum !== "string"
    || !BASE64URL_SHA256.test(descriptor.checksum)
    || etag === null
    || etag[2] !== descriptor.checksum
    || !isPositiveSafeInteger(descriptor.projectVersion)
    || etag[1] !== String(descriptor.projectVersion)
    || !isPositiveSafeInteger(descriptor.physicalBytes)
    || !isNonNegativeSafeInteger(descriptor.logicalBytes)
    || !isNonNegativeSafeInteger(descriptor.fileCount)
    || descriptor.format !== "project-bundle-v1"
    || descriptor.downloadUrl !== `${contentPath(identity)}/${descriptor.bundleId}`
  ) {
    throw failure("RESUME_DESCRIPTOR_INVALID", "Saved Project metadata is malformed.");
  }
  if (
    descriptor.physicalBytes > MAX_RESUME_PHYSICAL_BYTES
    || descriptor.logicalBytes > MAX_RESUME_LOGICAL_BYTES
    || descriptor.fileCount > MAX_RESUME_FILES
  ) {
    throw failure("RESUME_LIMIT_EXCEEDED", "Saved Project content exceeds this browser workspace limit.");
  }
  return Object.freeze({ ...descriptor });
}

function parseProjectBundleV1(
  bytes: Uint8Array,
  descriptor: ProjectContentDescriptor,
  identity: ProjectContentIdentity
): readonly ResumedProjectFile[] {
  const reader = new TarReader(bytes);
  const manifestEntry = reader.readEntry();
  if (
    manifestEntry === null
    || manifestEntry.name !== "manifest.json"
    || manifestEntry.type !== "0"
    || manifestEntry.mode !== 0o644
    || manifestEntry.bytes.byteLength > MAX_DESCRIPTOR_BYTES
  ) integrityFailure();
  const manifest = parseManifest(manifestEntry.bytes, descriptor, identity);
  const files: ResumedProjectFile[] = [];
  for (const [index, manifestFile] of manifest.files.entries()) {
    const sequence = index.toString().padStart(8, "0");
    const pax = reader.readEntry();
    const entry = reader.readEntry();
    const expectedArchivePath = `files/${manifestFile.path}`;
    if (
      pax === null
      || pax.name !== `PaxHeaders/${sequence}`
      || pax.type !== "x"
      || pax.mode !== 0o644
      || decodePaxPath(pax.bytes) !== expectedArchivePath
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
      try { decoder.decode(entry.bytes); } catch { integrityFailure(); }
    }
    files.push(Object.freeze({
      path: manifestFile.path,
      kind: manifestFile.kind,
      executable: manifestFile.mode === "0755",
      bytes: Uint8Array.from(entry.bytes)
    }));
  }
  reader.finish();
  return Object.freeze(files);
}

interface ManifestFile {
  readonly path: string;
  readonly kind: "binary" | "text";
  readonly mode: "0644" | "0755";
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface ParsedManifest { readonly files: readonly ManifestFile[] }

function parseManifest(
  bytes: Uint8Array,
  descriptor: ProjectContentDescriptor,
  identity: ProjectContentIdentity
): ParsedManifest {
  let value: unknown;
  try {
    const text = decoder.decode(bytes);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) integrityFailure();
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ProjectContentError) throw error;
    integrityFailure();
  }
  const record = exactRecord(value, ["fileCount", "files", "format", "logicalBytes", "project", "schemaVersion"], "RESUME_INTEGRITY_FAILED");
  const project = exactRecord(record.project, ["id", "storageScopeId"], "RESUME_INTEGRITY_FAILED");
  if (
    record.format !== "project-bundle-v1"
    || record.schemaVersion !== 1
    || record.fileCount !== descriptor.fileCount
    || record.logicalBytes !== descriptor.logicalBytes
    || project.id !== identity.projectId
    || project.storageScopeId !== identity.storageScopeId
    || !Array.isArray(record.files)
    || record.files.length !== descriptor.fileCount
  ) integrityFailure();
  const files: ManifestFile[] = [];
  let logicalBytes = 0;
  let previousPath: string | undefined;
  for (const input of record.files) {
    const file = exactRecord(input, ["kind", "mode", "path", "sha256", "sizeBytes"], "RESUME_INTEGRITY_FAILED");
    if (
      typeof file.path !== "string"
      || !isSafeResumePath(file.path)
      || (file.kind !== "text" && file.kind !== "binary")
      || (file.mode !== "0644" && file.mode !== "0755")
      || !isNonNegativeSafeInteger(file.sizeBytes)
      || file.sizeBytes > MAX_RESUME_FILE_BYTES
      || typeof file.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(file.sha256)
      || (previousPath !== undefined && compareUtf8(previousPath, file.path) >= 0)
    ) integrityFailure();
    logicalBytes = checkedAdd(logicalBytes, file.sizeBytes);
    previousPath = file.path;
    files.push(file as unknown as ManifestFile);
  }
  if (logicalBytes !== descriptor.logicalBytes) integrityFailure();
  return { files };
}

function isSafeResumePath(path: string): boolean {
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

interface TarEntry { readonly bytes: Uint8Array; readonly mode: number; readonly name: string; readonly type: "0" | "x" }

class TarReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) { this.#bytes = bytes; }

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
    if (!this.#bytes.subarray(contentOffset + size, nextOffset).every((byte) => byte === 0)) integrityFailure();
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
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal | undefined,
  observe?: (chunk: Uint8Array) => void
): Promise<Uint8Array> {
  if (stream === null) throw failure("RESUME_DOWNLOAD_FAILED", "Saved Project content could not be downloaded.");
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
        throw failure("RESUME_LIMIT_EXCEEDED", "Saved Project content exceeds this browser workspace limit.");
      }
      observe?.(result.value);
      chunks.push(Uint8Array.from(result.value));
    }
  } catch (error) {
    if (error instanceof ProjectContentError) throw error;
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

function exactRecord(value: unknown, keys: readonly string[], code: ProjectContentErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw failure(code, "Saved Project content did not pass integrity checks.");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw failure(code, "Saved Project content did not pass integrity checks.");
  }
  return value as Record<string, unknown>;
}

function validateIdentity(identity: ProjectContentIdentity): void {
  if (
    (identity.ownerType !== "organization" && identity.ownerType !== "user")
    || !UUID_V7.test(identity.ownerId)
    || !UUID_V7.test(identity.projectId)
    || !UUID_V7.test(identity.storageScopeId)
  ) throw failure("RESUME_DESCRIPTOR_INVALID", "Project identity is malformed.");
}

function contentPath(identity: ProjectContentIdentity): string {
  const segment = identity.ownerType === "user" ? "users" : "organizations";
  return `/api/v1/workspaces/${segment}/${identity.ownerId}/projects/${identity.projectId}/content`;
}

function responseFailure(status: number): ProjectContentError {
  if (status === 401) return failure("RESUME_AUTHENTICATION_REQUIRED", "Sign in again before resuming this Project.");
  if (status === 409) return failure("RESUME_NOT_SAVED", "This Project does not have a current Server Save.");
  if (status === 404) return failure("RESUME_CONTENT_UNAVAILABLE", "Saved Project content is no longer available.");
  return failure("RESUME_DOWNLOAD_FAILED", "Saved Project content could not be downloaded.");
}

function requestFailure(signal: AbortSignal | undefined): ProjectContentError {
  return signal?.aborted
    ? failure("RESUME_ABORTED", "Saved Project resume was cancelled.")
    : failure("RESUME_DOWNLOAD_FAILED", "Saved Project content could not be downloaded.");
}

function staleDescriptor(): ProjectContentError {
  return failure("RESUME_DOWNLOAD_FAILED", "The saved Project changed while it was being resumed.");
}

function isStaleDescriptor(error: unknown): boolean {
  return error instanceof ProjectContentError && error.message === "The saved Project changed while it was being resumed.";
}

function integrityFailure(): never {
  throw failure("RESUME_INTEGRITY_FAILED", "Saved Project content did not pass integrity checks.");
}

function failure(code: ProjectContentErrorCode, message: string): ProjectContentError {
  return new ProjectContentError(code, message);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw failure("RESUME_ABORTED", "Saved Project resume was cancelled.");
}

function cancel(stream: ReadableStream<Uint8Array> | null): void { void stream?.cancel().catch(() => undefined); }

function isMediaType(value: string | null, expected: string): boolean {
  return value !== null && !value.includes(",") && value.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function hasNoStore(value: string | null): boolean {
  return value !== null && value.toLowerCase().split(",").some((directive) => directive.trim() === "no-store");
}

function parseDecimalHeader(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
  try { return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end)); } catch { integrityFailure(); }
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
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function decodePaxPath(bytes: Uint8Array): string {
  let record: string;
  try { record = decoder.decode(bytes); } catch { integrityFailure(); }
  const separator = record.indexOf(" ");
  if (separator < 1 || !/^[1-9]\d*$/u.test(record.slice(0, separator))) integrityFailure();
  if (Number(record.slice(0, separator)) !== bytes.byteLength) integrityFailure();
  const body = record.slice(separator + 1);
  if (!body.startsWith("path=") || !body.endsWith("\n") || body.slice(0, -1).includes("\n")) integrityFailure();
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
