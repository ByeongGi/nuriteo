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
  const nameBytes = encoder.encode(name);
  if (nameBytes.byteLength > 100) throw new RangeError("Canonical tar header name exceeds 100 bytes.");
  const contentBlocks = Math.ceil(content.byteLength / TAR_BLOCK_BYTES);
  const entry = new Uint8Array(TAR_BLOCK_BYTES + contentBlocks * TAR_BLOCK_BYTES);
  const header = entry.subarray(0, TAR_BLOCK_BYTES);

  header.set(nameBytes, 0);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeChecksum(header, checksum);
  entry.set(content, TAR_BLOCK_BYTES);
  return entry;
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
