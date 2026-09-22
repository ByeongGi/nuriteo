import type { ProjectSnapshot } from "./types.ts";

/**
 * Remote backup adapter. Private beta ships an in-memory stub only —
 * no network cloud service is invented here. Production can swap in a
 * real object-store/API implementation behind the same interface.
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

  async pushSnapshot(
    projectId: string,
    snapshot: ProjectSnapshot,
    ownerId?: string
  ): Promise<void> {
    this.#byProject.set(projectId, structuredClone(snapshot));
    if (ownerId) {
      const set = this.#ownerIndex.get(ownerId) ?? new Set<string>();
      set.add(projectId);
      this.#ownerIndex.set(ownerId, set);
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
    for (const set of this.#ownerIndex.values()) {
      set.delete(projectId);
    }
  }
}
