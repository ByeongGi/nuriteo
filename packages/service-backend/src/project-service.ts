import { ServiceBackendError } from "./errors.ts";
import { createId } from "./ids.ts";
import type { RemoteBackupAdapter } from "./remote-backup.ts";
import type { LocalFirstProjectStore } from "./store.ts";
import type { UsageMeter } from "./usage-meter.ts";
import {
  SERVICE_BACKEND_SCHEMA_VERSION,
  type ProjectExportBundle,
  type ProjectMetadata,
  type ProjectSnapshot,
  type ProjectSnapshotFile,
  type UserAccount
} from "./types.ts";

export interface ProjectServiceOptions {
  store: LocalFirstProjectStore;
  remoteBackup?: RemoteBackupAdapter;
  usageMeter?: UsageMeter;
  /** When true (default), push snapshots to remote backup after local save. */
  enableRemoteBackup?: boolean;
}

function measureFiles(files: ProjectSnapshotFile[]): number {
  let bytes = 0;
  for (const file of files) {
    bytes += file.path.length + file.content.length;
  }
  return bytes;
}

export class ProjectService {
  #store: LocalFirstProjectStore;
  #remoteBackup: RemoteBackupAdapter | null;
  #usageMeter: UsageMeter | null;
  #enableRemoteBackup: boolean;

  constructor(options: ProjectServiceOptions) {
    this.#store = options.store;
    this.#remoteBackup = options.remoteBackup ?? null;
    this.#usageMeter = options.usageMeter ?? null;
    this.#enableRemoteBackup = options.enableRemoteBackup ?? true;
  }

  create(actor: UserAccount, input: { name: string }): ProjectMetadata {
    const name = input.name.trim();
    if (!name) throw new ServiceBackendError("project name required", "EINVALID");
    const now = this.#store.isoNow();
    const project: ProjectMetadata = {
      schemaVersion: SERVICE_BACKEND_SCHEMA_VERSION,
      id: createId("proj", this.#store.now),
      ownerId: actor.id,
      name,
      createdAt: now,
      updatedAt: now,
      teamId: null,
      permissions: [{ principalId: actor.id, role: "owner" }],
      extensions: {}
    };
    this.#store.putProject(project);
    return project;
  }

  rename(actor: UserAccount, projectId: string, name: string): ProjectMetadata {
    const project = this.#requireOwned(actor, projectId);
    const nextName = name.trim();
    if (!nextName) throw new ServiceBackendError("project name required", "EINVALID");
    const updated: ProjectMetadata = {
      ...project,
      name: nextName,
      updatedAt: this.#store.isoNow()
    };
    this.#store.putProject(updated);
    return updated;
  }

  delete(actor: UserAccount, projectId: string): void {
    this.#requireOwned(actor, projectId);
    this.#store.deleteProject(projectId);
    void this.#remoteBackup?.deleteProject(projectId);
  }

  duplicate(actor: UserAccount, projectId: string, name?: string): ProjectMetadata {
    const source = this.#requireOwned(actor, projectId);
    const copy = this.create(actor, {
      name: name?.trim() || `${source.name} copy`
    });
    const snapshot = this.#store.getSnapshot(projectId);
    if (snapshot) {
      const clonedFiles = snapshot.files.map((file) => ({
        path: file.path,
        content: file.content
      }));
      this.saveSnapshot(actor, copy.id, { files: clonedFiles });
    }
    return this.#store.getProject(copy.id) as ProjectMetadata;
  }

  list(actor: UserAccount): ProjectMetadata[] {
    return this.#store.listProjectsByOwner(actor.id);
  }

  get(actor: UserAccount, projectId: string): ProjectMetadata {
    return this.#requireOwned(actor, projectId);
  }

  /**
   * Private project access without auth must fail.
   * ShareService uses peekForShare for token-gated reads.
   */
  getPrivate(actor: UserAccount | null, projectId: string): ProjectMetadata {
    if (!actor) {
      throw new ServiceBackendError("private project requires authentication", "EFORBIDDEN");
    }
    return this.#requireOwned(actor, projectId);
  }

  peekForShare(projectId: string): ProjectMetadata {
    const project = this.#store.getProject(projectId);
    if (!project) throw new ServiceBackendError("project not found", "ENOTFOUND");
    return project;
  }

  saveSnapshot(
    actor: UserAccount,
    projectId: string,
    input: { files: ProjectSnapshotFile[] }
  ): ProjectSnapshot {
    const project = this.#requireOwned(actor, projectId);
    const previous = this.#store.getSnapshot(projectId);
    const files = input.files.map((file) => ({
      path: file.path,
      content: file.content
    }));
    const snapshot: ProjectSnapshot = {
      schemaVersion: SERVICE_BACKEND_SCHEMA_VERSION,
      projectId,
      generation: (previous?.generation ?? 0) + 1,
      files,
      savedAt: this.#store.isoNow(),
      byteSize: measureFiles(files),
      extensions: {}
    };
    this.#store.putSnapshot(snapshot);
    this.#store.putProject({
      ...project,
      updatedAt: snapshot.savedAt
    });
    this.#usageMeter?.recordStorageBytes(actor.id, this.#totalStorageForOwner(actor.id));
    if (this.#enableRemoteBackup && this.#remoteBackup) {
      void this.#remoteBackup.pushSnapshot(projectId, snapshot, actor.id);
    }
    return snapshot;
  }

  loadSnapshot(actor: UserAccount, projectId: string): ProjectSnapshot {
    this.#requireOwned(actor, projectId);
    const local = this.#store.getSnapshot(projectId);
    if (local) return local;
    throw new ServiceBackendError("snapshot not found", "ENOTFOUND");
  }

  /**
   * Resume path: prefer local snapshot; if missing, pull remote backup.
   * Documents local-first with remote fallback for cross-browser restore.
   */
  async resumeSnapshot(actor: UserAccount, projectId: string): Promise<ProjectSnapshot> {
    this.#requireOwned(actor, projectId);
    const local = this.#store.getSnapshot(projectId);
    if (local) return local;
    if (this.#remoteBackup) {
      const remote = await this.#remoteBackup.pullSnapshot(projectId);
      if (remote) {
        this.#store.putSnapshot(remote);
        return remote;
      }
    }
    throw new ServiceBackendError("snapshot not found locally or remotely", "ENOTFOUND");
  }

  export(actor: UserAccount, projectId: string): ProjectExportBundle {
    const metadata = this.#requireOwned(actor, projectId);
    return {
      schemaVersion: SERVICE_BACKEND_SCHEMA_VERSION,
      kind: "cargo-container.project-export",
      exportedAt: this.#store.isoNow(),
      metadata,
      snapshot: this.#store.getSnapshot(projectId)
    };
  }

  import(
    actor: UserAccount,
    bundle: ProjectExportBundle,
    options: { name?: string } = {}
  ): { metadata: ProjectMetadata; snapshot: ProjectSnapshot | null } {
    if (bundle.kind !== "cargo-container.project-export") {
      throw new ServiceBackendError("invalid export bundle kind", "EINVALID");
    }
    if (bundle.schemaVersion !== SERVICE_BACKEND_SCHEMA_VERSION) {
      throw new ServiceBackendError("unsupported export schemaVersion", "EINVALID");
    }
    const metadata = this.create(actor, {
      name: options.name?.trim() || bundle.metadata.name
    });
    let snapshot: ProjectSnapshot | null = null;
    if (bundle.snapshot) {
      snapshot = this.saveSnapshot(actor, metadata.id, {
        files: bundle.snapshot.files
      });
    }
    return { metadata: this.#store.getProject(metadata.id) as ProjectMetadata, snapshot };
  }

  #requireOwned(actor: UserAccount, projectId: string): ProjectMetadata {
    const project = this.#store.getProject(projectId);
    if (!project) throw new ServiceBackendError("project not found", "ENOTFOUND");
    if (project.ownerId !== actor.id) {
      throw new ServiceBackendError("project access denied", "EFORBIDDEN");
    }
    return project;
  }

  #totalStorageForOwner(ownerId: string): number {
    let total = 0;
    for (const project of this.#store.listProjectsByOwner(ownerId)) {
      const snapshot = this.#store.getSnapshot(project.id);
      if (snapshot) total += snapshot.byteSize;
    }
    return total;
  }
}
