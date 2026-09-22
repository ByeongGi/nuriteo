import fs from "node:fs";
import path from "node:path";

import { ServiceBackendError } from "./errors.ts";
import {
  SERVICE_BACKEND_SCHEMA_VERSION,
  type AuthSession,
  type ProjectMetadata,
  type ProjectSnapshot,
  type ServiceBackendPersistenceState,
  type ShareLink,
  type UserAccount
} from "./types.ts";

export interface LocalFirstProjectStoreOptions {
  /** Optional JSON file path for durable local persistence between process restarts. */
  persistPath?: string;
  now?: () => number;
}

/**
 * Local-first project store. Primary source of truth is in-process memory.
 * Optional JSON file mirrors state for tests and single-node beta hosts.
 * Remote backup is handled separately via RemoteBackupAdapter.
 */
export class LocalFirstProjectStore {
  #users = new Map<string, UserAccount>();
  #usersByEmail = new Map<string, string>();
  #projects = new Map<string, ProjectMetadata>();
  #snapshots = new Map<string, ProjectSnapshot>();
  #shareLinks = new Map<string, ShareLink>();
  #shareByToken = new Map<string, string>();
  #sessions = new Map<string, AuthSession>();
  #persistPath: string | undefined;
  now: () => number;

  constructor(options: LocalFirstProjectStoreOptions = {}) {
    this.#persistPath = options.persistPath;
    this.now = options.now ?? Date.now;
    if (this.#persistPath) {
      this.#loadFromDisk();
    }
  }

  isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  putUser(user: UserAccount): void {
    this.#users.set(user.id, structuredClone(user));
    this.#usersByEmail.set(user.email.toLowerCase(), user.id);
    this.#persist();
  }

  getUser(userId: string): UserAccount | null {
    const user = this.#users.get(userId);
    return user ? structuredClone(user) : null;
  }

  getUserByEmail(email: string): UserAccount | null {
    const id = this.#usersByEmail.get(email.toLowerCase());
    return id ? this.getUser(id) : null;
  }

  putSession(session: AuthSession): void {
    this.#sessions.set(session.token, structuredClone(session));
    this.#persist();
  }

  getSession(token: string): AuthSession | null {
    const session = this.#sessions.get(token);
    return session ? structuredClone(session) : null;
  }

  putProject(project: ProjectMetadata): void {
    this.#projects.set(project.id, structuredClone(project));
    this.#persist();
  }

  getProject(projectId: string): ProjectMetadata | null {
    const project = this.#projects.get(projectId);
    return project ? structuredClone(project) : null;
  }

  deleteProject(projectId: string): void {
    this.#projects.delete(projectId);
    this.#snapshots.delete(projectId);
    for (const [shareId, link] of [...this.#shareLinks]) {
      if (link.projectId === projectId) {
        this.#shareLinks.delete(shareId);
        this.#shareByToken.delete(link.token);
      }
    }
    this.#persist();
  }

  listProjectsByOwner(ownerId: string): ProjectMetadata[] {
    return [...this.#projects.values()]
      .filter((project) => project.ownerId === ownerId)
      .map((project) => structuredClone(project))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  putSnapshot(snapshot: ProjectSnapshot): void {
    this.#snapshots.set(snapshot.projectId, structuredClone(snapshot));
    this.#persist();
  }

  getSnapshot(projectId: string): ProjectSnapshot | null {
    const snapshot = this.#snapshots.get(projectId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  putShareLink(link: ShareLink): void {
    this.#shareLinks.set(link.id, structuredClone(link));
    this.#shareByToken.set(link.token, link.id);
    this.#persist();
  }

  getShareLink(shareId: string): ShareLink | null {
    const link = this.#shareLinks.get(shareId);
    return link ? structuredClone(link) : null;
  }

  getShareLinkByToken(token: string): ShareLink | null {
    const id = this.#shareByToken.get(token);
    return id ? this.getShareLink(id) : null;
  }

  listShareLinksForProject(projectId: string): ShareLink[] {
    return [...this.#shareLinks.values()]
      .filter((link) => link.projectId === projectId)
      .map((link) => structuredClone(link));
  }

  dump(): ServiceBackendPersistenceState {
    return {
      schemaVersion: SERVICE_BACKEND_SCHEMA_VERSION,
      users: [...this.#users.values()].map((u) => structuredClone(u)),
      projects: [...this.#projects.values()].map((p) => structuredClone(p)),
      snapshots: [...this.#snapshots.values()].map((s) => structuredClone(s)),
      shareLinks: [...this.#shareLinks.values()].map((l) => structuredClone(l)),
      sessions: [...this.#sessions.values()].map((s) => structuredClone(s)),
      usageByUser: {}
    };
  }

  loadState(state: ServiceBackendPersistenceState): void {
    if (state.schemaVersion !== SERVICE_BACKEND_SCHEMA_VERSION) {
      throw new ServiceBackendError(
        `unsupported persistence schemaVersion ${state.schemaVersion}`,
        "EINVALID"
      );
    }
    this.#users.clear();
    this.#usersByEmail.clear();
    this.#projects.clear();
    this.#snapshots.clear();
    this.#shareLinks.clear();
    this.#shareByToken.clear();
    this.#sessions.clear();

    for (const user of state.users) this.putUser(user);
    for (const project of state.projects) this.putProject(project);
    for (const snapshot of state.snapshots) this.putSnapshot(snapshot);
    for (const link of state.shareLinks) this.putShareLink(link);
    for (const session of state.sessions) this.putSession(session);
  }

  #persist(): void {
    if (!this.#persistPath) return;
    const dir = path.dirname(this.#persistPath);
    fs.mkdirSync(dir, { recursive: true });
    const state = this.dump();
    fs.writeFileSync(this.#persistPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  #loadFromDisk(): void {
    if (!this.#persistPath || !fs.existsSync(this.#persistPath)) return;
    const raw = fs.readFileSync(this.#persistPath, "utf8");
    const state = JSON.parse(raw) as ServiceBackendPersistenceState;
    // Avoid re-writing during load.
    const persistPath = this.#persistPath;
    this.#persistPath = undefined;
    this.loadState(state);
    this.#persistPath = persistPath;
  }
}
