import fs from "node:fs";
import path from "node:path";

import { ServiceBackendError } from "./errors.ts";
import { SERVICE_BACKEND_SCHEMA_VERSION } from "./types.ts";
import type { ProjectSnapshot } from "./types.ts";

/**
 * Backup adapter boundary. The built-in implementations are local-only;
 * production can swap in a real object-store/API implementation behind the
 * same interface.
 */
export interface RemoteBackupAdapter {
  pushSnapshot(
    projectId: string,
    snapshot: ProjectSnapshot,
    ownerId?: string
  ): Promise<void>;
  pullSnapshot(projectId: string): Promise<ProjectSnapshot | null>;
  listRemoteProjectIds(ownerId: string): Promise<string[]>;
  deleteProject(projectId: string): Promise<void>;
}

export class InMemoryRemoteBackup implements RemoteBackupAdapter {
  #byProject = new Map<string, ProjectSnapshot>();
  #ownerIndex = new Map<string, Set<string>>();
  #ownerByProject = new Map<string, string>();

  async pushSnapshot(
    projectId: string,
    snapshot: ProjectSnapshot,
    ownerId?: string
  ): Promise<void> {
    this.#byProject.set(projectId, structuredClone(snapshot));
    if (ownerId) {
      const previousOwnerId = this.#ownerByProject.get(projectId);
      if (previousOwnerId && previousOwnerId !== ownerId) {
        this.#ownerIndex.get(previousOwnerId)?.delete(projectId);
      }
      const set = this.#ownerIndex.get(ownerId) ?? new Set<string>();
      set.add(projectId);
      this.#ownerIndex.set(ownerId, set);
      this.#ownerByProject.set(projectId, ownerId);
    }
  }

  async pullSnapshot(projectId: string): Promise<ProjectSnapshot | null> {
    const snapshot = this.#byProject.get(projectId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async listRemoteProjectIds(ownerId: string): Promise<string[]> {
    const set = this.#ownerIndex.get(ownerId);
    return set ? [...set] : [];
  }

  async deleteProject(projectId: string): Promise<void> {
    this.#byProject.delete(projectId);
    const ownerId = this.#ownerByProject.get(projectId);
    if (ownerId) {
      this.#ownerIndex.get(ownerId)?.delete(projectId);
      this.#ownerByProject.delete(projectId);
    }
  }
}

export const FILE_REMOTE_BACKUP_SCHEMA_VERSION = 1 as const;

export interface FileRemoteBackupOptions {
  /** JSON file used by this single-node/local adapter. */
  persistPath: string;
}

interface FileRemoteBackupEntry {
  projectId: string;
  ownerId: string | null;
  snapshot: ProjectSnapshot;
}

interface FileRemoteBackupState {
  schemaVersion: typeof FILE_REMOTE_BACKUP_SCHEMA_VERSION;
  kind: "nuriteo.remote-backup";
  entries: FileRemoteBackupEntry[];
}

/**
 * Durable, single-node implementation of RemoteBackupAdapter.
 *
 * This is a local filesystem backup, not a cloud or multi-node service. Each
 * mutation is written to a sibling temporary file and atomically renamed over
 * the destination where the host filesystem supports atomic rename.
 */
export class FileRemoteBackup implements RemoteBackupAdapter {
  #byProject = new Map<string, ProjectSnapshot>();
  #ownerByProject = new Map<string, string>();
  #ownerIndex = new Map<string, Set<string>>();
  #persistPath: string;
  #writeSequence = 0;

  constructor(options: FileRemoteBackupOptions) {
    if (!options.persistPath) {
      throw new ServiceBackendError(
        "file remote backup persistPath must not be empty",
        "EINVALID"
      );
    }
    this.#persistPath = options.persistPath;
    this.#loadFromDisk();
  }

  async pushSnapshot(
    projectId: string,
    snapshot: ProjectSnapshot,
    ownerId?: string
  ): Promise<void> {
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new ServiceBackendError("projectId must not be empty", "EINVALID");
    }
    validateSnapshot(snapshot, projectId, "snapshot");
    if (
      ownerId !== undefined &&
      (typeof ownerId !== "string" || ownerId.length === 0)
    ) {
      throw new ServiceBackendError("ownerId must be a non-empty string", "EINVALID");
    }
    const previousSnapshot = this.#byProject.get(projectId);
    const previousOwnerId = this.#ownerByProject.get(projectId);
    if (ownerId && previousOwnerId && previousOwnerId !== ownerId) {
      this.#ownerIndex.get(previousOwnerId)?.delete(projectId);
    }

    this.#byProject.set(projectId, structuredClone(snapshot));
    if (ownerId) {
      this.#ownerByProject.set(projectId, ownerId);
      const projectIds = this.#ownerIndex.get(ownerId) ?? new Set<string>();
      projectIds.add(projectId);
      this.#ownerIndex.set(ownerId, projectIds);
    }
    try {
      this.#persist();
    } catch (error) {
      this.#restoreProject(projectId, previousSnapshot, previousOwnerId);
      throw error;
    }
  }

  async pullSnapshot(projectId: string): Promise<ProjectSnapshot | null> {
    const snapshot = this.#byProject.get(projectId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async listRemoteProjectIds(ownerId: string): Promise<string[]> {
    return [...(this.#ownerIndex.get(ownerId) ?? [])].sort();
  }

  async deleteProject(projectId: string): Promise<void> {
    const previousSnapshot = this.#byProject.get(projectId);
    const previousOwnerId = this.#ownerByProject.get(projectId);
    this.#byProject.delete(projectId);
    if (previousOwnerId) {
      this.#ownerIndex.get(previousOwnerId)?.delete(projectId);
      this.#ownerByProject.delete(projectId);
    }
    try {
      this.#persist();
    } catch (error) {
      this.#restoreProject(projectId, previousSnapshot, previousOwnerId);
      throw error;
    }
  }

  #dump(): FileRemoteBackupState {
    return {
      schemaVersion: FILE_REMOTE_BACKUP_SCHEMA_VERSION,
      kind: "nuriteo.remote-backup",
      entries: [...this.#byProject.entries()]
        .map(([projectId, snapshot]) => ({
          projectId,
          ownerId: this.#ownerByProject.get(projectId) ?? null,
          snapshot: structuredClone(snapshot)
        }))
        .sort((left, right) => left.projectId.localeCompare(right.projectId))
    };
  }

  #loadFromDisk(): void {
    if (!fs.existsSync(this.#persistPath)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#persistPath, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ServiceBackendError(
        `invalid file remote backup at ${this.#persistPath}: ${detail}`,
        "EINVALID"
      );
    }

    const state = validateState(parsed, this.#persistPath);
    for (const entry of state.entries) {
      this.#byProject.set(entry.projectId, structuredClone(entry.snapshot));
      if (entry.ownerId) {
        this.#ownerByProject.set(entry.projectId, entry.ownerId);
        const projectIds =
          this.#ownerIndex.get(entry.ownerId) ?? new Set<string>();
        projectIds.add(entry.projectId);
        this.#ownerIndex.set(entry.ownerId, projectIds);
      }
    }
  }

  #persist(): void {
    const directory = path.dirname(this.#persistPath);
    fs.mkdirSync(directory, { recursive: true });
    this.#writeSequence += 1;
    const temporaryPath = `${this.#persistPath}.${process.pid}.${this.#writeSequence}.tmp`;
    try {
      fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify(this.#dump(), null, 2)}\n`,
        {
          encoding: "utf8",
          flag: "wx"
        }
      );
      fs.renameSync(temporaryPath, this.#persistPath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The write may have failed before the temporary file was created.
      }
      throw error;
    }
  }

  #restoreProject(
    projectId: string,
    snapshot: ProjectSnapshot | undefined,
    ownerId: string | undefined
  ): void {
    this.#byProject.delete(projectId);
    for (const projectIds of this.#ownerIndex.values()) {
      projectIds.delete(projectId);
    }
    this.#ownerByProject.delete(projectId);
    if (snapshot) this.#byProject.set(projectId, snapshot);
    if (ownerId) {
      this.#ownerByProject.set(projectId, ownerId);
      const projectIds = this.#ownerIndex.get(ownerId) ?? new Set<string>();
      projectIds.add(projectId);
      this.#ownerIndex.set(ownerId, projectIds);
    }
  }
}

function validateState(value: unknown, persistPath: string): FileRemoteBackupState {
  if (!isRecord(value)) {
    throw invalidBackup(persistPath, "root must be an object");
  }
  if (value.schemaVersion !== FILE_REMOTE_BACKUP_SCHEMA_VERSION) {
    throw invalidBackup(
      persistPath,
      `unsupported schemaVersion ${String(value.schemaVersion)}`
    );
  }
  if (value.kind !== "nuriteo.remote-backup") {
    throw invalidBackup(persistPath, "kind must be nuriteo.remote-backup");
  }
  if (!Array.isArray(value.entries)) {
    throw invalidBackup(persistPath, "entries must be an array");
  }

  const seenProjectIds = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    if (!isRecord(entry)) {
      throw invalidBackup(persistPath, `entries[${index}] must be an object`);
    }
    if (typeof entry.projectId !== "string" || entry.projectId.length === 0) {
      throw invalidBackup(
        persistPath,
        `entries[${index}].projectId must be a string`
      );
    }
    if (seenProjectIds.has(entry.projectId)) {
      throw invalidBackup(persistPath, `duplicate projectId ${entry.projectId}`);
    }
    seenProjectIds.add(entry.projectId);
    if (
      entry.ownerId !== null &&
      (typeof entry.ownerId !== "string" || entry.ownerId.length === 0)
    ) {
      throw invalidBackup(
        persistPath,
        `entries[${index}].ownerId must be a non-empty string or null`
      );
    }
    validateSnapshot(
      entry.snapshot,
      entry.projectId,
      `entries[${index}].snapshot`,
      persistPath
    );
  }

  return value as unknown as FileRemoteBackupState;
}

function validateSnapshot(
  value: unknown,
  projectId: string,
  label: string,
  persistPath?: string
): asserts value is ProjectSnapshot {
  const reject = (detail: string): never => {
    if (persistPath) throw invalidBackup(persistPath, `${label} ${detail}`);
    throw new ServiceBackendError(`${label} ${detail}`, "EINVALID");
  };

  if (!isRecord(value)) {
    if (persistPath) {
      throw invalidBackup(persistPath, `${label} must be an object`);
    }
    throw new ServiceBackendError(`${label} must be an object`, "EINVALID");
  }
  if (value.schemaVersion !== SERVICE_BACKEND_SCHEMA_VERSION) {
    reject(`has unsupported schemaVersion ${String(value.schemaVersion)}`);
  }
  if (value.projectId !== projectId) reject("projectId does not match its key");
  if (!Number.isInteger(value.generation) || Number(value.generation) < 0) {
    reject("generation must be a non-negative integer");
  }
  if (typeof value.savedAt !== "string") reject("savedAt must be a string");
  if (
    typeof value.byteSize !== "number" ||
    !Number.isFinite(value.byteSize) ||
    value.byteSize < 0
  ) {
    reject("byteSize must be a non-negative finite number");
  }
  const files = Array.isArray(value.files)
    ? value.files
    : reject("files must be an array");
  for (const [index, file] of files.entries()) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      typeof file.content !== "string"
    ) {
      reject(`files[${index}] must contain string path and content`);
    }
  }
  if (value.extensions !== undefined && !isRecord(value.extensions)) {
    reject("extensions must be an object when present");
  }
}

function invalidBackup(persistPath: string, detail: string): ServiceBackendError {
  return new ServiceBackendError(
    `invalid file remote backup at ${persistPath}: ${detail}`,
    "EINVALID"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
