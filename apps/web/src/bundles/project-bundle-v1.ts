import { IncrementalSha256 } from "./incremental-sha256.ts";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BLOCKS = 2;
const FILE_MODE = 0o644;
const EXECUTABLE_FILE_MODE = 0o755;

const encoder = new TextEncoder();
declare const validatedProjection: unique symbol;

export interface ProjectBundleV1SourceFile {
  readonly path: string;
  readonly kind: "text" | "binary";
  readonly executable: boolean;
  readonly bytes: Uint8Array;
}

/**
 * A detached projection of the RT workspace. It intentionally contains no
 * controller, credential, cache, host path, or clock-derived state.
 *
 * BND-002 owns path, ignore, and resource-limit validation. Callers must pass
 * that validated projection before this writer is connected to Save.
 */
export interface ValidatedProjectBundleV1Projection {
  readonly [validatedProjection]: true;
  readonly projectId: string;
  readonly storageScopeId: string;
  readonly files: readonly ProjectBundleV1SourceFile[];
}

export interface ProjectBundleV1ManifestFile {
  readonly path: string;
  readonly kind: "text" | "binary";
  readonly mode: "0644" | "0755";
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ProjectBundleV1Manifest {
  readonly format: "project-bundle-v1";
  readonly schemaVersion: 1;
  readonly project: {
    readonly id: string;
    readonly storageScopeId: string;
  };
  readonly fileCount: number;
  readonly logicalBytes: number;
  readonly files: readonly ProjectBundleV1ManifestFile[];
}

export interface ProjectBundleV1 {
  readonly bytes: Uint8Array;
  readonly manifest: ProjectBundleV1Manifest;
}

/**
 * Produces the canonical, uncompressed POSIX pax archive for a validated
 * workspace projection. This in-memory BND-001 boundary is replaced by the
 * streaming sink in BND-003 without changing the manifest or tar contract.
 */
export async function writeValidatedProjectBundleV1(
  source: ValidatedProjectBundleV1Projection
): Promise<ProjectBundleV1> {
  const files = source.files
    .map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const manifestFiles: ProjectBundleV1ManifestFile[] = [];
  let logicalBytes = 0;

  for (const [index, file] of files.entries()) {
    assertUnambiguousPath(file.path);
    if (index > 0 && files[index - 1]?.path === file.path) {
      throw new RangeError("Project Bundle contains a duplicate path.");
    }
    logicalBytes = checkedAdd(logicalBytes, file.bytes.byteLength);
    manifestFiles.push({
      path: file.path,
      kind: file.kind,
      mode: file.executable ? "0755" : "0644",
      sizeBytes: file.bytes.byteLength,
      sha256: await sha256Hex(file.bytes)
    });
  }

  const manifest: ProjectBundleV1Manifest = {
    format: "project-bundle-v1",
    schemaVersion: 1,
    project: { id: source.projectId, storageScopeId: source.storageScopeId },
    fileCount: manifestFiles.length,
    logicalBytes,
    files: manifestFiles
  };
  const manifestBytes = encoder.encode(`${JSON.stringify(manifest)}\n`);
  const chunks: Uint8Array[] = [tarEntry("manifest.json", manifestBytes, FILE_MODE, "0")];

  for (const [index, file] of files.entries()) {
    const archivePath = `files/${file.path}`;
    const paxBytes = encoder.encode(paxRecord("path", archivePath));
    const sequence = index.toString().padStart(8, "0");
    chunks.push(tarEntry(`PaxHeaders/${sequence}`, paxBytes, FILE_MODE, "x"));
    chunks.push(tarEntry(`files/${sequence}`, file.bytes, file.executable ? EXECUTABLE_FILE_MODE : FILE_MODE, "0"));
  }

  chunks.push(new Uint8Array(TAR_BLOCK_BYTES * TAR_END_BLOCKS));
  return { bytes: concatenate(chunks), manifest };
}

function assertUnambiguousPath(path: string): void {
  if (!path || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new RangeError("Project Bundle path is empty or contains a control character.");
  }
  for (let index = 0; index < path.length; index += 1) {
    const codeUnit = path.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = path.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        throw new RangeError("Project Bundle path contains an unpaired UTF-16 surrogate.");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new RangeError("Project Bundle path contains an unpaired UTF-16 surrogate.");
    }
  }
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new RangeError("Project Bundle logical byte count is not a safe integer.");
  return sum;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = encoder.encode(body).byteLength + 2;
  while (true) {
    const record = `${length} ${body}`;
    const actualLength = encoder.encode(record).byteLength;
    if (actualLength === length) return record;
    length = actualLength;
  }
}

function tarEntry(name: string, content: Uint8Array, mode: number, type: "0" | "x"): Uint8Array {
  const header = tarHeader(name, content.byteLength, mode, type);
  const contentBlocks = Math.ceil(content.byteLength / TAR_BLOCK_BYTES);
  const entry = new Uint8Array(TAR_BLOCK_BYTES + contentBlocks * TAR_BLOCK_BYTES);
  entry.set(header, 0);
  entry.set(content, TAR_BLOCK_BYTES);
  return entry;
}

function tarHeader(name: string, contentBytes: number, mode: number, type: "0" | "x"): Uint8Array {
  const nameBytes = encoder.encode(name);
  if (nameBytes.byteLength > 100) throw new RangeError("Canonical tar header name exceeds 100 bytes.");
  const header = new Uint8Array(TAR_BLOCK_BYTES);

  header.set(nameBytes, 0);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contentBytes);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeChecksum(header, checksum);
  return header;
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length !== length - 1) throw new RangeError("Canonical tar numeric field overflow.");
  target.set(encoder.encode(digits), offset);
  target[offset + length - 1] = 0;
}

function writeChecksum(target: Uint8Array, checksum: number): void {
  const digits = checksum.toString(8).padStart(6, "0");
  if (digits.length !== 6) throw new RangeError("Canonical tar checksum field overflow.");
  target.set(encoder.encode(digits), 148);
  target[154] = 0;
  target[155] = 0x20;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => checkedAdd(sum, chunk.byteLength), 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export const PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
export const PROJECT_BUNDLE_MULTIPART_MAX_PART_BYTES = 64 * 1024 * 1024;
export const PROJECT_BUNDLE_MULTIPART_MAX_PARTS = 128;
export const PROJECT_BUNDLE_MULTIPART_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const PROJECT_BUNDLE_SINGLE_PUT_MAX_BYTES = 256 * 1024 * 1024;

const DEFAULT_STREAM_CHUNK_BYTES = 64 * 1024;
const BLOB_SEGMENT_BYTES = 64 * 1024;

export interface ProjectBundleV1StreamMetadata {
  readonly manifest: ProjectBundleV1Manifest;
  readonly archiveSha256: string;
  readonly physicalBytes: number;
  readonly logicalBytes: number;
}

/**
 * A sink owns all bytes after each awaited write returns. Implementations must
 * not retain the borrowed view passed to write without copying it, and must
 * settle an in-flight write when the supplied signal aborts. The writer calls
 * abort only after that write has settled, so borrowed storage is never zeroed
 * or reused while an upload still owns it.
 */
export interface ProjectBundleV1Sink<Result> {
  write(bytes: Uint8Array, signal: AbortSignal | undefined): Promise<void>;
  complete(metadata: ProjectBundleV1StreamMetadata, signal: AbortSignal | undefined): Promise<Result>;
  abort(reason: unknown): Promise<void>;
}

export interface ProjectBundleV1StreamResult<Result> extends ProjectBundleV1StreamMetadata {
  readonly sinkResult: Result;
  readonly peakChunkBytes: number;
}

export interface ProjectBundleV1StreamOptions {
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
}

export interface BoundedBlobResult {
  readonly blob: Blob;
  readonly peakBufferedBytes: number;
}

/** A bounded whole-body sink for the configured single-PUT path. */
export class BoundedProjectBundleBlobSink implements ProjectBundleV1Sink<BoundedBlobResult> {
  readonly #maximumBytes: number;
  readonly #contentType: string;
  #chunks: ArrayBuffer[] = [];
  #pending = new Uint8Array(BLOB_SEGMENT_BYTES);
  #pendingBytes = 0;
  #bufferedBytes = 0;
  #peakBufferedBytes = 0;
  #finished = false;

  constructor(maximumBytes: number, contentType = "application/vnd.nuriteo.project-bundle") {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > PROJECT_BUNDLE_SINGLE_PUT_MAX_BYTES) {
      throw new RangeError("Project Bundle Blob limit is outside the supported single-PUT range.");
    }
    this.#maximumBytes = maximumBytes;
    this.#contentType = contentType;
  }

  async write(bytes: Uint8Array, signal: AbortSignal | undefined): Promise<void> {
    this.#assertOpen();
    assertNotAborted(signal);
    const nextBytes = checkedAdd(this.#bufferedBytes, bytes.byteLength);
    if (nextBytes > this.#maximumBytes) {
      throw new RangeError("Project Bundle exceeds the configured single-PUT byte limit.");
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const copied = Math.min(BLOB_SEGMENT_BYTES - this.#pendingBytes, bytes.byteLength - offset);
      this.#pending.set(bytes.subarray(offset, offset + copied), this.#pendingBytes);
      this.#pendingBytes += copied;
      offset += copied;
      if (this.#pendingBytes === BLOB_SEGMENT_BYTES) {
        this.#chunks.push(this.#pending.buffer);
        this.#pending = new Uint8Array(BLOB_SEGMENT_BYTES);
        this.#pendingBytes = 0;
      }
    }
    this.#bufferedBytes = nextBytes;
    this.#peakBufferedBytes = Math.max(this.#peakBufferedBytes, nextBytes);
  }

  async complete(
    metadata: ProjectBundleV1StreamMetadata,
    signal: AbortSignal | undefined
  ): Promise<BoundedBlobResult> {
    this.#assertOpen();
    assertNotAborted(signal);
    if (metadata.physicalBytes !== this.#bufferedBytes) {
      throw new Error("Project Bundle sink byte count does not match the streamed archive.");
    }
    const parts = [...this.#chunks];
    if (this.#pendingBytes > 0) {
      const finalSegment = new Uint8Array(this.#pendingBytes);
      finalSegment.set(this.#pending.subarray(0, this.#pendingBytes));
      parts.push(finalSegment.buffer);
    }
    const blob = new Blob(parts, { type: this.#contentType });
    this.#finished = true;
    for (const chunk of this.#chunks) new Uint8Array(chunk).fill(0);
    this.#pending.fill(0);
    this.#chunks = [];
    this.#pendingBytes = 0;
    this.#bufferedBytes = 0;
    return { blob, peakBufferedBytes: this.#peakBufferedBytes };
  }

  async abort(_reason: unknown): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    for (const chunk of this.#chunks) new Uint8Array(chunk).fill(0);
    this.#pending.fill(0);
    this.#chunks = [];
    this.#pendingBytes = 0;
    this.#bufferedBytes = 0;
  }

  #assertOpen(): void {
    if (this.#finished) throw new Error("Project Bundle sink is already closed.");
  }
}

export interface ProjectBundleMultipartPart {
  readonly number: number;
  /** Borrowed only until the returned upload promise settles. */
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Upload implementations must reject promptly when this signal aborts. */
  readonly signal: AbortSignal | undefined;
}

export interface ProjectBundleMultipartPartResult<Receipt> {
  readonly number: number;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly receipt: Receipt;
}

export interface ProjectBundleMultipartResult<Receipt> {
  readonly parts: readonly ProjectBundleMultipartPartResult<Receipt>[];
  readonly peakBufferedBytes: number;
}

export interface ProjectBundleMultipartPlan {
  readonly partCount: number;
  readonly finalPartBytes: number;
}

export function planProjectBundleMultipart(
  physicalBytes: number,
  partSizeBytes: number
): ProjectBundleMultipartPlan {
  assertMultipartPartSize(partSizeBytes);
  if (!Number.isSafeInteger(physicalBytes) || physicalBytes < 1) {
    throw new RangeError("Project Bundle multipart payload size is invalid.");
  }
  const partCount = Math.ceil(physicalBytes / partSizeBytes);
  if (physicalBytes > PROJECT_BUNDLE_MULTIPART_MAX_BYTES || partCount > PROJECT_BUNDLE_MULTIPART_MAX_PARTS) {
    throw new RangeError("Project Bundle multipart stream exceeds the SAVE-004 payload or 128-part limit.");
  }
  const precedingBytes = (partCount - 1) * partSizeBytes;
  return { partCount, finalPartBytes: physicalBytes - precedingBytes };
}

/**
 * Slices the archive byte stream independently of file boundaries. Full parts
 * are exactly partSizeBytes; only the final part may be smaller than 5 MiB.
 */
export class ProjectBundleMultipartSink<Receipt>
  implements ProjectBundleV1Sink<ProjectBundleMultipartResult<Receipt>> {
  readonly #partSizeBytes: number;
  readonly #upload: (part: ProjectBundleMultipartPart) => Promise<Receipt>;
  readonly #abortUpload: (reason: unknown) => Promise<void>;
  readonly #buffer: Uint8Array;
  readonly #parts: ProjectBundleMultipartPartResult<Receipt>[] = [];
  #bufferedBytes = 0;
  #physicalBytes = 0;
  #finished = false;

  constructor(
    partSizeBytes: number,
    upload: (part: ProjectBundleMultipartPart) => Promise<Receipt>,
    abortUpload: (reason: unknown) => Promise<void>
  ) {
    assertMultipartPartSize(partSizeBytes);
    this.#partSizeBytes = partSizeBytes;
    this.#upload = upload;
    this.#abortUpload = abortUpload;
    this.#buffer = new Uint8Array(partSizeBytes);
  }

  async write(bytes: Uint8Array, signal: AbortSignal | undefined): Promise<void> {
    this.#assertOpen();
    assertNotAborted(signal);
    const nextPhysicalBytes = checkedAdd(this.#physicalBytes, bytes.byteLength);
    if (
      nextPhysicalBytes > PROJECT_BUNDLE_MULTIPART_MAX_BYTES ||
      nextPhysicalBytes > this.#partSizeBytes * PROJECT_BUNDLE_MULTIPART_MAX_PARTS
    ) {
      throw new RangeError("Project Bundle multipart stream exceeds the SAVE-004 payload or 128-part limit.");
    }
    this.#physicalBytes = nextPhysicalBytes;
    let offset = 0;
    while (offset < bytes.byteLength) {
      assertNotAborted(signal);
      const copied = Math.min(this.#partSizeBytes - this.#bufferedBytes, bytes.byteLength - offset);
      this.#buffer.set(bytes.subarray(offset, offset + copied), this.#bufferedBytes);
      this.#bufferedBytes += copied;
      offset += copied;
      if (this.#bufferedBytes === this.#partSizeBytes) await this.#flushPart(signal);
    }
  }

  async complete(
    metadata: ProjectBundleV1StreamMetadata,
    signal: AbortSignal | undefined
  ): Promise<ProjectBundleMultipartResult<Receipt>> {
    this.#assertOpen();
    assertNotAborted(signal);
    if (metadata.physicalBytes !== this.#physicalBytes) {
      throw new Error("Project Bundle sink byte count does not match the streamed archive.");
    }
    if (this.#bufferedBytes > 0) await this.#flushPart(signal);
    if (this.#parts.length === 0) throw new Error("Project Bundle multipart stream is empty.");
    this.#finished = true;
    this.#buffer.fill(0);
    return { parts: [...this.#parts], peakBufferedBytes: this.#partSizeBytes };
  }

  async abort(reason: unknown): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    this.#buffer.fill(0);
    this.#bufferedBytes = 0;
    this.#parts.length = 0;
    await this.#abortUpload(reason);
  }

  async #flushPart(signal: AbortSignal | undefined): Promise<void> {
    const number = this.#parts.length + 1;
    if (number > PROJECT_BUNDLE_MULTIPART_MAX_PARTS) {
      throw new RangeError("Project Bundle multipart stream exceeds the SAVE-004 payload or 128-part limit.");
    }
    const bytes = this.#buffer.subarray(0, this.#bufferedBytes);
    const sha256 = incrementalSha256Hex(bytes);
    const sizeBytes = bytes.byteLength;
    const receipt = await this.#upload({ number, bytes, sizeBytes, sha256, signal });
    assertNotAborted(signal);
    this.#parts.push({ number, sizeBytes, sha256, receipt });
    this.#buffer.fill(0, 0, this.#bufferedBytes);
    this.#bufferedBytes = 0;
  }

  #assertOpen(): void {
    if (this.#finished) throw new Error("Project Bundle sink is already closed.");
  }
}

function assertMultipartPartSize(partSizeBytes: number): void {
  if (
    !Number.isSafeInteger(partSizeBytes) ||
    partSizeBytes < PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES ||
    partSizeBytes > PROJECT_BUNDLE_MULTIPART_MAX_PART_BYTES
  ) {
    throw new RangeError("Project Bundle multipart part size is outside the supported range.");
  }
}

/**
 * Emits the BND-001 canonical bytes while retaining at most one configured
 * source view plus the sink's explicit buffer. A changed source fails closed
 * after its streamed digest is compared with the manifest digest.
 */
export async function streamValidatedProjectBundleV1<Result>(
  source: ValidatedProjectBundleV1Projection,
  sink: ProjectBundleV1Sink<Result>,
  options: ProjectBundleV1StreamOptions = {}
): Promise<ProjectBundleV1StreamResult<Result>> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_STREAM_CHUNK_BYTES;
  let archiveDigest: IncrementalSha256 | undefined;
  let completed = false;
  try {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES) {
      throw new RangeError("Project Bundle stream chunk size is outside the supported range.");
    }
    assertNotAborted(options.signal);
    const files = [...source.files].sort((left, right) => compareUtf8(left.path, right.path));
    const manifestFiles: ProjectBundleV1ManifestFile[] = [];
    let logicalBytes = 0;
    for (const [index, file] of files.entries()) {
      assertUnambiguousPath(file.path);
      if (index > 0 && files[index - 1]?.path === file.path) {
        throw new RangeError("Project Bundle contains a duplicate path.");
      }
      logicalBytes = checkedAdd(logicalBytes, file.bytes.byteLength);
      manifestFiles.push({
        path: file.path,
        kind: file.kind,
        mode: file.executable ? "0755" : "0644",
        sizeBytes: file.bytes.byteLength,
        sha256: incrementalSha256Hex(file.bytes)
      });
      assertNotAborted(options.signal);
    }

    const manifest: ProjectBundleV1Manifest = {
      format: "project-bundle-v1",
      schemaVersion: 1,
      project: { id: source.projectId, storageScopeId: source.storageScopeId },
      fileCount: manifestFiles.length,
      logicalBytes,
      files: manifestFiles
    };
    const manifestBytes = encoder.encode(`${JSON.stringify(manifest)}\n`);
    archiveDigest = new IncrementalSha256();
    let physicalBytes = 0;
    let peakChunkBytes = 0;

    const emit = async (bytes: Uint8Array): Promise<void> => {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
        assertNotAborted(options.signal);
        const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength));
        physicalBytes = checkedAdd(physicalBytes, chunk.byteLength);
        peakChunkBytes = Math.max(peakChunkBytes, chunk.byteLength);
        archiveDigest?.update(chunk);
        await sink.write(chunk, options.signal);
      }
    };
    const emitEntry = async (
      name: string,
      content: Uint8Array,
      mode: number,
      type: "0" | "x",
      expectedSha256?: string
    ): Promise<void> => {
      await emit(tarHeader(name, content.byteLength, mode, type));
      const contentDigest = expectedSha256 === undefined ? undefined : new IncrementalSha256();
      try {
        for (let offset = 0; offset < content.byteLength; offset += chunkBytes) {
          const chunk = content.subarray(offset, Math.min(offset + chunkBytes, content.byteLength));
          contentDigest?.update(chunk);
          await emit(chunk);
        }
        if (contentDigest !== undefined && contentDigest.finishHex() !== expectedSha256) {
          throw new Error("Project Bundle source changed while the archive was streaming.");
        }
      } finally {
        contentDigest?.dispose();
      }
      const paddingBytes = (TAR_BLOCK_BYTES - (content.byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (paddingBytes > 0) await emit(new Uint8Array(paddingBytes));
    };

    await emitEntry("manifest.json", manifestBytes, FILE_MODE, "0");
    for (const [index, file] of files.entries()) {
      const archivePath = `files/${file.path}`;
      const paxBytes = encoder.encode(paxRecord("path", archivePath));
      const sequence = index.toString().padStart(8, "0");
      await emitEntry(`PaxHeaders/${sequence}`, paxBytes, FILE_MODE, "x");
      await emitEntry(
        `files/${sequence}`,
        file.bytes,
        file.executable ? EXECUTABLE_FILE_MODE : FILE_MODE,
        "0",
        manifestFiles[index]?.sha256
      );
    }
    await emit(new Uint8Array(TAR_BLOCK_BYTES * TAR_END_BLOCKS));
    const archiveSha256 = archiveDigest.finishHex();
    const metadata = { manifest, archiveSha256, physicalBytes, logicalBytes };
    const sinkResult = await sink.complete(metadata, options.signal);
    completed = true;
    return { ...metadata, sinkResult, peakChunkBytes };
  } catch (error) {
    try {
      await sink.abort(error);
    } catch (abortError) {
      throw new AggregateError([error, abortError], "Project Bundle streaming and sink abort both failed.");
    }
    throw error;
  } finally {
    archiveDigest?.dispose();
    if (!completed) archiveDigest = undefined;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Project Bundle streaming was aborted.");
}

function incrementalSha256Hex(bytes: Uint8Array): string {
  const digest = new IncrementalSha256();
  try {
    digest.update(bytes);
    return digest.finishHex();
  } finally {
    digest.dispose();
  }
}
