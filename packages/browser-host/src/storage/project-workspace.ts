import { createSnapshotStore, digestSnapshot, type SnapshotStore } from "./snapshot.ts";
import type {
  JsonValue,
  ProjectWorkspaceArchive,
  ProjectWorkspaceFile,
  ProjectWorkspaceImportOptions,
  ProjectWorkspaceMetadata,
  ProjectWorkspaceSaveOptions,
  ProjectWorkspaceSnapshot,
  ProjectWorkspaceStoreOptions,
  SnapshotSaveResult
} from "./types.ts";

export class ProjectWorkspaceStore {
  readonly projectId: string;
  readonly root: string;
  readonly snapshots: SnapshotStore;
  metadata: ProjectWorkspaceMetadata;
  files: Map<string, string>;

  constructor(options: ProjectWorkspaceStoreOptions) {
    this.projectId = options.projectId;
    this.root = normalizeRoot(options.root || "/workspace");
    this.metadata = { ...(options.metadata || {}) };
    this.files = new Map();
    this.snapshots = createSnapshotStore({
      ...(options.opfs ? { opfs: options.opfs } : {}),
      ...(options.lease ? { lease: options.lease } : {}),
      root: `projects/${this.projectId}`
    });
  }

  acquireWriter(owner: string): ReturnType<SnapshotStore["acquireWriter"]> {
    return this.snapshots.acquireWriter(owner);
  }

  writeText(path: string, data: string): void {
    this.files.set(this.#projectPath(path), data);
  }

  readText(path: string): string {
    const data = this.files.get(this.#projectPath(path));
    if (data === undefined) throw Object.assign(new Error(`No such project file: ${path}`), { code: "ENOENT" });
    return data;
  }

  listFiles(): ProjectWorkspaceFile[] {
    return [...this.files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, data]) => ({ path, data }));
  }

  snapshot(metadata: ProjectWorkspaceMetadata = {}): ProjectWorkspaceSnapshot {
    return {
      schemaVersion: 1,
      projectId: this.projectId,
      root: this.root,
      metadata: { ...this.metadata, ...metadata },
      files: this.listFiles()
    };
  }

  save(options: ProjectWorkspaceSaveOptions): SnapshotSaveResult {
    if (options.metadata) this.metadata = { ...this.metadata, ...options.metadata };
    return this.snapshots.save(this.snapshot(), { owner: options.owner });
  }

  loadLatest(): ProjectWorkspaceSnapshot {
    const snapshot = this.snapshots.loadLatest();
    return this.#restore(snapshot);
  }

  recoverLatest(): ProjectWorkspaceSnapshot {
    const snapshot = this.snapshots.recoverLatest();
    return this.#restore(snapshot);
  }

  exportArchive(exportedAt = Date.now()): ProjectWorkspaceArchive {
    const snapshot = this.snapshot();
    return {
      schemaVersion: 1,
      format: "nuriteo-project-archive",
      exportedAt,
      integrity: digestSnapshot(snapshot),
      snapshot
    };
  }

  exportSnapshot(exportedAt = Date.now()): Uint8Array {
    return encodeProjectWorkspaceArchive(this.exportArchive(exportedAt));
  }

  importArchive(archive: JsonValue, options: ProjectWorkspaceImportOptions = {}): ProjectWorkspaceSnapshot {
    const imported = assertProjectWorkspaceArchive(archive);
    const snapshot = this.#restore(imported.snapshot);
    if (options.save) {
      if (!options.owner) throw new Error("Project archive import save requires an owner");
      this.snapshots.save(snapshot, { owner: options.owner });
    }
    return snapshot;
  }

  importSnapshot(
    snapshot: Uint8Array | ArrayBuffer | string,
    options: ProjectWorkspaceImportOptions = {}
  ): ProjectWorkspaceSnapshot {
    return this.importArchive(decodeProjectWorkspaceArchive(snapshot), options);
  }

  #restore(value: JsonValue): ProjectWorkspaceSnapshot {
    const snapshot = migrateProjectWorkspaceSnapshot(value);
    this.metadata = { ...snapshot.metadata };
    this.files = new Map(snapshot.files.map((file) => [file.path, file.data]));
    return snapshot;
  }

  #projectPath(path: string): string {
    const normalized = normalizeRoot(path);
    if (normalized === this.root || normalized.startsWith(`${this.root}/`)) return normalized;
    return `${this.root}/${normalized.replace(/^\/+/, "")}`;
  }
}

export function createProjectWorkspaceStore(options: ProjectWorkspaceStoreOptions): ProjectWorkspaceStore {
  return new ProjectWorkspaceStore(options);
}

export function migrateProjectWorkspaceSnapshot(value: JsonValue): ProjectWorkspaceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project workspace snapshot");
  }
  const snapshot = value as Partial<ProjectWorkspaceSnapshot> & {
    schemaVersion?: number;
    files?: ProjectWorkspaceFile[] | Record<string, string>;
  };
  if (snapshot.schemaVersion === 1) return assertProjectWorkspaceSnapshot(value);
  if (snapshot.schemaVersion === 0 || snapshot.schemaVersion === undefined) return migrateLegacyProjectWorkspaceSnapshot(snapshot);
  throw new Error(`Unsupported project workspace snapshot schema: ${snapshot.schemaVersion}`);
}

export function encodeProjectWorkspaceArchive(archive: JsonValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(assertProjectWorkspaceArchive(archive)));
}

export function decodeProjectWorkspaceArchive(
  value: Uint8Array | ArrayBuffer | string
): ProjectWorkspaceArchive {
  let text: string;
  try {
    text = typeof value === "string"
      ? value
      : new TextDecoder("utf-8", { fatal: true }).decode(
        value instanceof Uint8Array ? value : new Uint8Array(value)
      );
  } catch {
    throw new Error("Invalid project workspace snapshot encoding");
  }

  let archive: JsonValue;
  try {
    archive = JSON.parse(text) as JsonValue;
  } catch {
    throw new Error("Invalid project workspace snapshot JSON");
  }
  return assertProjectWorkspaceArchive(archive);
}

function assertProjectWorkspaceSnapshot(value: JsonValue): ProjectWorkspaceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project workspace snapshot");
  }
  const snapshot = value as Partial<ProjectWorkspaceSnapshot>;
  if (snapshot.schemaVersion !== 1 || typeof snapshot.projectId !== "string" || typeof snapshot.root !== "string") {
    throw new Error("Invalid project workspace snapshot header");
  }
  if (!snapshot.metadata || typeof snapshot.metadata !== "object" || Array.isArray(snapshot.metadata)) {
    throw new Error("Invalid project workspace metadata");
  }
  if (!Array.isArray(snapshot.files)) throw new Error("Invalid project workspace files");
  for (const file of snapshot.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.data !== "string") {
      throw new Error("Invalid project workspace file");
    }
  }
  return snapshot as ProjectWorkspaceSnapshot;
}

function assertProjectWorkspaceArchive(value: JsonValue): ProjectWorkspaceArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project workspace archive");
  }
  const archive = value as Partial<ProjectWorkspaceArchive>;
  if (archive.schemaVersion !== 1 || archive.format !== "nuriteo-project-archive") {
    throw new Error("Invalid project workspace archive header");
  }
  const snapshot = migrateProjectWorkspaceSnapshot(archive.snapshot || null);
  if (archive.integrity !== undefined) {
    if (typeof archive.integrity !== "string" || archive.integrity !== digestSnapshot(snapshot)) {
      throw new Error("Project workspace snapshot integrity mismatch");
    }
  }
  return {
    schemaVersion: 1,
    format: "nuriteo-project-archive",
    exportedAt: typeof archive.exportedAt === "number" ? archive.exportedAt : 0,
    ...(typeof archive.integrity === "string" ? { integrity: archive.integrity } : {}),
    snapshot
  };
}

function migrateLegacyProjectWorkspaceSnapshot(
  snapshot: Partial<ProjectWorkspaceSnapshot> & { files?: ProjectWorkspaceFile[] | Record<string, string> }
): ProjectWorkspaceSnapshot {
  if (typeof snapshot.projectId !== "string" || typeof snapshot.root !== "string") {
    throw new Error("Invalid legacy project workspace snapshot header");
  }
  const files = normalizeLegacyFiles(snapshot.files);
  return assertProjectWorkspaceSnapshot({
    schemaVersion: 1,
    projectId: snapshot.projectId,
    root: normalizeRoot(snapshot.root),
    metadata: snapshot.metadata && typeof snapshot.metadata === "object" && !Array.isArray(snapshot.metadata)
      ? snapshot.metadata
      : {},
    files
  });
}

function normalizeLegacyFiles(files: ProjectWorkspaceFile[] | Record<string, string> | undefined): ProjectWorkspaceFile[] {
  if (Array.isArray(files)) return files;
  return Object.entries(files || {}).map(([path, data]) => {
    if (typeof data !== "string") throw new Error("Invalid legacy project workspace file");
    return { path, data };
  });
}

function normalizeRoot(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (normalized === "") return "/";
  if (normalized === "/") return "/";
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
