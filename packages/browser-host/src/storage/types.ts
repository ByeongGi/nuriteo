export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type StorageLeaseErrorCode = "ELEASEHELD" | "ELEASEMISSING" | (string & {});
export type SnapshotStoreErrorCode = "EINTEGRITY" | "ENOSNAPSHOT" | "ESNAPSHOTMISSING" | (string & {});

export interface StorageLeaseOptions {
  now?: () => number;
  ttlMs?: number;
}

export interface StorageLeaseHandle {
  owner: string;
  expiresAt: number;
}

export interface OpfsLike {
  writeFile(path: string, value: JsonValue): void;
  readFile(path: string): JsonValue | null;
  deleteFile(path: string): void;
  flush(path: string): boolean;
  isFlushed(path: string): boolean;
  listFiles(prefix?: string): string[];
}

export interface SnapshotStoreOptions {
  opfs?: OpfsLike;
  lease?: import("./lease.ts").StorageLease;
  root?: string;
}

export interface SnapshotSaveOptions {
  owner: string;
}

export interface SnapshotSaveResult {
  generation: number;
  path: string;
  flushed: boolean;
}

export interface SnapshotMarker {
  [key: string]: JsonValue;
  generation: number;
  path: string;
  completed: boolean;
}

export interface SnapshotRecord {
  [key: string]: JsonValue;
  schemaVersion: 1;
  generation: number;
  snapshot: JsonValue;
  integrity: string;
}
