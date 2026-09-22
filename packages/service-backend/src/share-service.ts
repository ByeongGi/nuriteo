import { ServiceBackendError } from "./errors.ts";
import { createId, createToken } from "./ids.ts";
import type { ProjectService } from "./project-service.ts";
import type { LocalFirstProjectStore } from "./store.ts";
import {
  SERVICE_BACKEND_SCHEMA_VERSION,
  type ProjectMetadata,
  type ProjectSnapshot,
  type ShareAccessMode,
  type ShareLink,
  type UserAccount
} from "./types.ts";

export interface ShareServiceOptions {
  store: LocalFirstProjectStore;
  projects: ProjectService;
}

export interface ResolvedShare {
  link: ShareLink;
  project: ProjectMetadata;
  snapshot: ProjectSnapshot | null;
  accessMode: ShareAccessMode;
}

export class ShareService {
  #store: LocalFirstProjectStore;
  #projects: ProjectService;

  constructor(options: ShareServiceOptions) {
    this.#store = options.store;
    this.#projects = options.projects;
  }

  createShareLink(
    actor: UserAccount,
    projectId: string,
    accessMode: ShareAccessMode
  ): ShareLink {
    if (accessMode !== "read_only" && accessMode !== "forkable") {
      throw new ServiceBackendError("accessMode must be read_only or forkable", "EINVALID");
    }
    this.#projects.get(actor, projectId);
    const link: ShareLink = {
      schemaVersion: SERVICE_BACKEND_SCHEMA_VERSION,
      id: createId("share", this.#store.now),
      token: createToken(this.#store.now),
      projectId,
      accessMode,
      createdBy: actor.id,
      createdAt: this.#store.isoNow(),
      revokedAt: null,
      extensions: {}
    };
    this.#store.putShareLink(link);
    return link;
  }

  resolveShareLink(token: string): ResolvedShare {
    const link = this.#store.getShareLinkByToken(token);
    if (!link) throw new ServiceBackendError("share link not found", "ENOTFOUND");
    if (link.revokedAt) {
      throw new ServiceBackendError("share link revoked", "EREVOKED");
    }
    const project = this.#projects.peekForShare(link.projectId);
    const snapshot = this.#store.getSnapshot(link.projectId);
    return {
      link,
      project,
      snapshot,
      accessMode: link.accessMode
    };
  }

  /**
   * Read-only preview: returns project + snapshot without requiring auth.
   * Does not create a new project.
   */
  openReadOnlyPreview(token: string): ResolvedShare {
    const resolved = this.resolveShareLink(token);
    if (resolved.accessMode !== "read_only") {
      throw new ServiceBackendError("share link is not read_only", "EFORBIDDEN");
    }
    return resolved;
  }

  /**
   * Forkable share: authenticated user gets a duplicated owned project.
   */
  forkFromShare(
    actor: UserAccount,
    token: string,
    name?: string
  ): { source: ResolvedShare; forked: ProjectMetadata } {
    const resolved = this.resolveShareLink(token);
    if (resolved.accessMode !== "forkable") {
      throw new ServiceBackendError("share link is not forkable", "EFORBIDDEN");
    }
    const forked = this.#projects.create(actor, {
      name: name?.trim() || `${resolved.project.name} fork`
    });
    if (resolved.snapshot) {
      this.#projects.saveSnapshot(actor, forked.id, {
        files: resolved.snapshot.files
      });
    }
    return {
      source: resolved,
      forked: this.#store.getProject(forked.id) as ProjectMetadata
    };
  }

  revoke(actor: UserAccount, shareId: string): ShareLink {
    const link = this.#store.getShareLink(shareId);
    if (!link) throw new ServiceBackendError("share link not found", "ENOTFOUND");
    this.#projects.get(actor, link.projectId);
    const revoked: ShareLink = {
      ...link,
      revokedAt: this.#store.isoNow()
    };
    this.#store.putShareLink(revoked);
    return revoked;
  }
}
