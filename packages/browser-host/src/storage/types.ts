export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type StorageLeaseErrorCode = "ELEASEHELD" | "ELEASEMISSING" | (string & {});
export type SnapshotStoreErrorCode = "EINTEGRITY" | "ENOSNAPSHOT" | "ESNAPSHOTMISSING" | (string & {});
export type StorageQuotaErrorCode = "EOPFSQUOTA" | (string & {});

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

export interface ProjectWorkspaceFile {
  [key: string]: JsonValue;
  path: string;
  data: string;
}

export interface ProjectWorkspaceMetadata {
  [key: string]: JsonValue;
  name?: string;
  packageManager?: "npm" | "pnpm" | null;
  framework?: string | null;
}

export interface ProjectWorkspaceSnapshot {
  [key: string]: JsonValue;
  schemaVersion: 1;
  projectId: string;
  root: string;
  metadata: ProjectWorkspaceMetadata;
  files: ProjectWorkspaceFile[];
}

export interface ProjectWorkspaceArchive {
  [key: string]: JsonValue;
  schemaVersion: 1;
  format: "nuriteo-project-archive";
  exportedAt: number;
  integrity?: string;
  snapshot: ProjectWorkspaceSnapshot;
}

export interface ProjectWorkspaceStoreOptions extends SnapshotStoreOptions {
  projectId: string;
  root?: string;
  metadata?: ProjectWorkspaceMetadata;
}

export interface ProjectWorkspaceSaveOptions {
  owner: string;
  metadata?: ProjectWorkspaceMetadata;
}

export interface ProjectWorkspaceImportOptions {
  owner?: string;
  save?: boolean;
}

export interface StorageQuotaFileUsage {
  [key: string]: JsonValue;
  path: string;
  bytes: number;
  flushed: boolean;
}

export interface StorageQuotaUsage {
  [key: string]: JsonValue;
  quotaBytes: number;
  usedBytes: number;
  files: StorageQuotaFileUsage[];
}

export interface StorageEvictionOptions {
  requiredBytes?: number;
  prefixes?: string[];
}

export interface StorageEvictionResult {
  before: StorageQuotaUsage;
  after: StorageQuotaUsage;
  evicted: StorageQuotaFileUsage[];
  freedBytes: number;
  requiredBytes: number;
}

export interface StorageQuotaManagedOpfsOptions {
  opfs: OpfsLike;
  quotaBytes: number;
  evictionPrefixes?: string[];
  protectedPrefixes?: string[];
  estimateValueBytes?: (value: JsonValue) => number;
}
