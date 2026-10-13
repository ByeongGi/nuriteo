import type {
  JsonValue,
  OpfsLike,
  StorageEvictionOptions,
  StorageEvictionResult,
  StorageQuotaErrorCode,
  StorageQuotaManagedOpfsOptions,
  StorageQuotaUsage
} from "./types.ts";

export class StorageQuotaError extends Error {
  code: StorageQuotaErrorCode;
  usage: StorageQuotaUsage;
  requiredBytes: number;

  constructor(message: string, code: StorageQuotaErrorCode, usage: StorageQuotaUsage, requiredBytes: number) {
    super(message);
    this.name = "StorageQuotaError";
    this.code = code;
    this.usage = usage;
    this.requiredBytes = requiredBytes;
  }
}

export class QuotaManagedOpfs implements OpfsLike {
  readonly opfs: OpfsLike;
  readonly quotaBytes: number;
  readonly evictionPrefixes: string[];
  readonly protectedPrefixes: string[];
  readonly estimateValueBytes: (value: JsonValue) => number;

  constructor(options: StorageQuotaManagedOpfsOptions) {
    this.opfs = options.opfs;
    this.quotaBytes = options.quotaBytes;
    this.evictionPrefixes = [...(options.evictionPrefixes || [])].sort();
    this.protectedPrefixes = [...(options.protectedPrefixes || [])].sort();
    this.estimateValueBytes = options.estimateValueBytes || estimateJsonBytes;
  }

  writeFile(path: string, value: JsonValue): void {
    this.#ensureCapacity(path, value);
    this.opfs.writeFile(path, value);
  }

  readFile(path: string): JsonValue | null {
    return this.opfs.readFile(path);
  }

  deleteFile(path: string): void {
    this.opfs.deleteFile(path);
  }

  flush(path: string): boolean {
    return this.opfs.flush(path);
  }

  isFlushed(path: string): boolean {
    return this.opfs.isFlushed(path);
  }

  listFiles(prefix = ""): string[] {
    return this.opfs.listFiles(prefix);
  }

  usage(prefix = ""): StorageQuotaUsage {
    const files = this.opfs.listFiles(prefix).map((path) => ({
      path,
      bytes: this.#fileBytes(path),
      flushed: this.opfs.isFlushed(path)
    }));
    return {
      quotaBytes: this.quotaBytes,
      usedBytes: files.reduce((total, file) => total + file.bytes, 0),
      files
    };
  }

  evict(options: StorageEvictionOptions = {}): StorageEvictionResult {
    const prefixes = options.prefixes || this.evictionPrefixes;
    const requiredBytes = options.requiredBytes || 0;
    const before = this.usage();
    const evicted: StorageEvictionResult["evicted"] = [];

    for (const file of before.files) {
      if (!matchesAnyPrefix(file.path, prefixes)) continue;
      if (matchesAnyPrefix(file.path, this.protectedPrefixes)) continue;
      this.opfs.deleteFile(file.path);
      evicted.push(file);
      if (this.usage().usedBytes + requiredBytes <= this.quotaBytes) break;
    }

    const after = this.usage();
    return {
      before,
      after,
      evicted,
      freedBytes: before.usedBytes - after.usedBytes,
      requiredBytes
    };
  }

  #ensureCapacity(path: string, value: JsonValue): void {
    const usage = this.usage();
    const currentBytes = this.opfs.readFile(path) === null ? 0 : this.#fileBytes(path);
    const nextBytes = this.estimateValueBytes(value);
    const requiredBytes = Math.max(0, usage.usedBytes - currentBytes + nextBytes - this.quotaBytes);
    if (requiredBytes === 0) return;

    const eviction = this.evict({ requiredBytes, prefixes: this.evictionPrefixes });
    const postEviction = this.usage();
    const postCurrentBytes = this.opfs.readFile(path) === null ? 0 : this.#fileBytes(path);
    if (postEviction.usedBytes - postCurrentBytes + nextBytes <= this.quotaBytes) return;

    throw new StorageQuotaError(
      `OPFS quota exceeded: needs ${requiredBytes} bytes after eviction`,
      "EOPFSQUOTA",
      eviction.after,
      requiredBytes
    );
  }

  #fileBytes(path: string): number {
    const value = this.opfs.readFile(path);
    return value === null ? 0 : this.estimateValueBytes(value);
  }
}

export function createQuotaManagedOpfs(options: StorageQuotaManagedOpfsOptions): QuotaManagedOpfs {
  return new QuotaManagedOpfs(options);
}

function estimateJsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function matchesAnyPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}
