import { createMemoryOpfs } from "./opfs.ts";
import { createStorageLease } from "./lease.ts";
import type { JsonValue, OpfsLike, SnapshotMarker, SnapshotRecord, SnapshotSaveOptions, SnapshotSaveResult, SnapshotStoreErrorCode, SnapshotStoreOptions } from "./types.ts";

export class SnapshotStoreError extends Error {
  code: SnapshotStoreErrorCode;

  constructor(message: string, code: SnapshotStoreErrorCode) {
    super(message);
    this.name = "SnapshotStoreError";
    this.code = code;
  }
}

export class SnapshotStore {
  opfs: OpfsLike;
  lease: ReturnType<typeof createStorageLease>;
  root: string;
  generation: number;

  constructor(options: SnapshotStoreOptions = {}) {
    this.opfs = options.opfs || createMemoryOpfs();
    this.lease = options.lease || createStorageLease({});
    this.root = options.root || "runtime";
    this.generation = 0;
  }

  acquireWriter(owner: string): ReturnType<SnapshotStore["lease"]["acquire"]> {
    return this.lease.acquire(owner);
  }

  save(snapshot: JsonValue, { owner }: SnapshotSaveOptions): SnapshotSaveResult {
    this.lease.assert(owner);
    const generation = this.generation + 1;
    const tempPath = this.#path(`${generation}.tmp`);
    const finalPath = this.#path(`${generation}.snapshot`);
    const markerPath = this.#path("CURRENT");
    const record: SnapshotRecord = {
      schemaVersion: 1,
      generation,
      snapshot,
      integrity: digestSnapshot(snapshot)
    };

    this.opfs.writeFile(tempPath, record);
    this.opfs.flush(tempPath);
    this.opfs.writeFile(finalPath, record);
    this.opfs.flush(finalPath);
    this.opfs.writeFile(markerPath, { generation, path: finalPath, completed: true });
    this.opfs.flush(markerPath);
    this.opfs.deleteFile(tempPath);
    this.generation = generation;
    return { generation, path: finalPath, flushed: this.opfs.isFlushed(markerPath) };
  }

  loadLatest(): JsonValue {
    const marker = this.opfs.readFile(this.#path("CURRENT")) as SnapshotMarker | null;
    if (!marker?.completed) throw new SnapshotStoreError("no completed snapshot generation", "ENOSNAPSHOT");
    const record = this.#readVerifiedRecord(marker.path);
    this.generation = marker.generation;
    return structuredClone(record.snapshot);
  }

  recoverLatest(): JsonValue {
    const files = this.opfs.listFiles(this.#path(""));
    const candidates = files
      .map((file) => file.match(/\/(\d+)\.snapshot$/)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a: number, b: number) => b - a);

    for (const generation of candidates) {
      const path = this.#path(`${generation}.snapshot`);
      try {
        const record = this.#readVerifiedRecord(path);
        this.opfs.writeFile(this.#path("CURRENT"), { generation, path, completed: true });
        this.opfs.flush(this.#path("CURRENT"));
        this.generation = generation;
        return structuredClone(record.snapshot);
      } catch {
        continue;
      }
    }

    throw new SnapshotStoreError("no recoverable snapshot generation", "ENOSNAPSHOT");
  }

  #readVerifiedRecord(path: string): SnapshotRecord {
    const record = this.opfs.readFile(path) as SnapshotRecord | null;
    if (!record) throw new SnapshotStoreError("snapshot record missing", "ESNAPSHOTMISSING");
    if (record.integrity !== digestSnapshot(record.snapshot)) {
      throw new SnapshotStoreError("snapshot integrity mismatch", "EINTEGRITY");
    }
    return record;
  }

  #path(name: string): string {
    return `${this.root}/${name}`;
  }
}

export function createSnapshotStore(options: SnapshotStoreOptions = {}): SnapshotStore {
  return new SnapshotStore(options);
}

export function digestSnapshot(value: JsonValue): string {
  const text = JSON.stringify(canonical(value));
  let hash = 0xcbf29ce484222325n;
  for (const char of text) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key] ?? null)]));
}
