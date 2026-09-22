import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ServiceBackendError } from "./errors.ts";
import type {
  AuditEvent,
  CloudProjectRecord,
  CloudProjectSnapshot,
  CloudShareRecord,
  IdentityPrincipal,
  ProductionBackendOptions,
  UsageEvent
} from "./production-types.ts";
import type { ProjectSnapshotFile, ShareAccessMode } from "./types.ts";

function bytes(files: ProjectSnapshotFile[]): number {
  return files.reduce((sum, file) => sum + Buffer.byteLength(file.path) + Buffer.byteLength(file.content), 0);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateFiles(files: ProjectSnapshotFile[]): void {
  if (!Array.isArray(files)) throw new ServiceBackendError("files must be an array", "EINVALID");
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new ServiceBackendError("snapshot files require string path and content", "EINVALID");
    }
    const normalized = file.path.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized || normalized.split("/").includes("..") || seen.has(normalized)) {
      throw new ServiceBackendError(`invalid or duplicate snapshot path: ${file.path}`, "EINVALID");
    }
    seen.add(normalized);
  }
}

function role(project: CloudProjectRecord, actorId: string): "owner" | "editor" | "viewer" | null {
  return project.permissions.find((entry) => entry.principalId === actorId)?.role ?? null;
}

export class ProductionServiceBackend {
  #options: ProductionBackendOptions;
  #now: () => number;

  constructor(options: ProductionBackendOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async authenticate(token: string | null | undefined): Promise<IdentityPrincipal> {
    if (!token) throw new ServiceBackendError("authentication required", "EAUTH");
    const principal = await this.#options.identity.verifySession(token);
    if (!principal) throw new ServiceBackendError("invalid or expired session", "EAUTH");
    return principal;
  }

  async createProject(actor: IdentityPrincipal, name: string): Promise<CloudProjectRecord> {
    const cleanName = name.trim();
    if (!cleanName) throw new ServiceBackendError("project name required", "EINVALID");
    const at = this.#isoNow();
    const project: CloudProjectRecord = {
      id: `proj_${randomUUID()}`,
      tenantId: actor.tenantId,
      ownerId: actor.subject,
      name: cleanName,
      generation: 0,
      snapshotKey: null,
      permissions: [{ principalId: actor.subject, role: "owner" }],
      createdAt: at,
      updatedAt: at
    };
    await this.#options.database.putProject(project);
    await this.#audit(actor, "project.create", "project", project.id);
    return project;
  }

  listProjects(actor: IdentityPrincipal): Promise<CloudProjectRecord[]> {
    return this.#options.database.listProjects(actor.tenantId, actor.subject);
  }

  async grantProjectAccess(
    actor: IdentityPrincipal,
    projectId: string,
    principalId: string,
    nextRole: "editor" | "viewer"
  ): Promise<CloudProjectRecord> {
    const project = await this.#requireProject(actor, projectId, "owner");
    project.permissions = project.permissions.filter((item) => item.principalId !== principalId);
    project.permissions.push({ principalId, role: nextRole });
    project.updatedAt = this.#isoNow();
    await this.#options.database.putProject(project);
    await this.#audit(actor, "project.acl.grant", "project", project.id, { principalId, role: nextRole });
    return project;
  }

  async saveProject(
    actor: IdentityPrincipal,
    projectId: string,
    files: ProjectSnapshotFile[]
  ): Promise<CloudProjectSnapshot> {
    validateFiles(files);
    const project = await this.#requireProject(actor, projectId, "editor");
    const generation = project.generation + 1;
    const savedAt = this.#isoNow();
    const snapshot: CloudProjectSnapshot = {
      projectId,
      generation,
      files: files.map((file) => ({ path: file.path, content: file.content })),
      savedAt,
      byteSize: bytes(files)
    };
    const key = `${actor.tenantId}/${projectId}/snapshots/${generation}.json`;
    await this.#options.objects.putObject(key, Buffer.from(JSON.stringify(snapshot)));
    project.generation = generation;
    project.snapshotKey = key;
    project.updatedAt = savedAt;
    await this.#options.database.putProject(project);
    await this.#options.database.ingestUsage({
      id: `snapshot:${projectId}:${generation}`,
      tenantId: actor.tenantId,
      actorId: actor.subject,
      kind: "storage_bytes",
      quantity: snapshot.byteSize,
      occurredAt: savedAt
    });
    await this.#audit(actor, "project.save", "project", project.id, { generation, byteSize: snapshot.byteSize });
    return snapshot;
  }

  async resumeProject(actor: IdentityPrincipal, projectId: string): Promise<{ project: CloudProjectRecord; snapshot: CloudProjectSnapshot }> {
    const project = await this.#requireProject(actor, projectId, "viewer");
    if (!project.snapshotKey) throw new ServiceBackendError("snapshot not found", "ENOTFOUND");
    const stored = await this.#options.objects.getObject(project.snapshotKey);
    if (!stored) throw new ServiceBackendError("snapshot object missing", "ENOTFOUND");
    const snapshot = JSON.parse(Buffer.from(stored).toString("utf8")) as CloudProjectSnapshot;
    if (snapshot.projectId !== project.id || snapshot.generation !== project.generation) {
      throw new ServiceBackendError("snapshot metadata mismatch", "EINVALID");
    }
    await this.#audit(actor, "project.resume", "project", project.id, { generation: snapshot.generation });
    return { project, snapshot };
  }

  async createShare(actor: IdentityPrincipal, projectId: string, accessMode: ShareAccessMode): Promise<{ share: CloudShareRecord; token: string }> {
    if (accessMode !== "read_only" && accessMode !== "forkable") throw new ServiceBackendError("invalid share mode", "EINVALID");
    await this.#requireProject(actor, projectId, "owner");
    const token = randomBytes(32).toString("base64url");
    const share: CloudShareRecord = {
      id: `share_${randomUUID()}`,
      tenantId: actor.tenantId,
      projectId,
      tokenHash: tokenHash(token),
      accessMode,
      createdBy: actor.subject,
      createdAt: this.#isoNow(),
      revokedAt: null,
      rotatedToId: null
    };
    await this.#options.database.putShare(share);
    await this.#audit(actor, "share.create", "share", share.id, { projectId, accessMode });
    return { share, token };
  }

  async openShare(token: string): Promise<{ share: CloudShareRecord; project: CloudProjectRecord; snapshot: CloudProjectSnapshot | null }> {
    const share = await this.#options.database.getShareByTokenHash(tokenHash(token));
    if (!share) throw new ServiceBackendError("share link not found", "ENOTFOUND");
    if (share.revokedAt) throw new ServiceBackendError("share link revoked", "EREVOKED");
    const project = await this.#options.database.getProject(share.tenantId, share.projectId);
    if (!project) throw new ServiceBackendError("shared project not found", "ENOTFOUND");
    let snapshot: CloudProjectSnapshot | null = null;
    if (project.snapshotKey) {
      const value = await this.#options.objects.getObject(project.snapshotKey);
      if (value) snapshot = JSON.parse(Buffer.from(value).toString("utf8")) as CloudProjectSnapshot;
    }
    return { share, project, snapshot };
  }

  async rotateShare(actor: IdentityPrincipal, shareId: string): Promise<{ share: CloudShareRecord; token: string }> {
    const current = await this.#requireShareOwner(actor, shareId);
    if (current.revokedAt) throw new ServiceBackendError("share link revoked", "EREVOKED");
    const replacement = await this.createShare(actor, current.projectId, current.accessMode);
    current.revokedAt = this.#isoNow();
    current.rotatedToId = replacement.share.id;
    await this.#options.database.putShare(current);
    await this.#audit(actor, "share.rotate", "share", current.id, { replacementId: replacement.share.id });
    return replacement;
  }

  async revokeShare(actor: IdentityPrincipal, shareId: string): Promise<CloudShareRecord> {
    const share = await this.#requireShareOwner(actor, shareId);
    if (!share.revokedAt) {
      share.revokedAt = this.#isoNow();
      await this.#options.database.putShare(share);
      await this.#audit(actor, "share.revoke", "share", share.id);
    }
    return share;
  }

  async forkShare(actor: IdentityPrincipal, token: string, name?: string): Promise<CloudProjectRecord> {
    const source = await this.openShare(token);
    if (source.share.accessMode !== "forkable") throw new ServiceBackendError("share is read-only", "EFORBIDDEN");
    const project = await this.createProject(actor, name?.trim() || `${source.project.name} fork`);
    if (source.snapshot) await this.saveProject(actor, project.id, source.snapshot.files);
    await this.#audit(actor, "project.fork", "project", project.id, { sourceProjectId: source.project.id });
    return (await this.#options.database.getProject(actor.tenantId, project.id)) as CloudProjectRecord;
  }

  async ingestUsage(actor: IdentityPrincipal, event: Omit<UsageEvent, "tenantId" | "actorId">): Promise<boolean> {
    if (!event.id || !Number.isFinite(event.quantity) || event.quantity < 0) throw new ServiceBackendError("invalid usage event", "EINVALID");
    const inserted = await this.#options.database.ingestUsage({ ...event, tenantId: actor.tenantId, actorId: actor.subject });
    if (inserted) await this.#audit(actor, "usage.ingest", "usage", event.id, { kind: event.kind, quantity: event.quantity });
    return inserted;
  }

  async usageSummary(actor: IdentityPrincipal): Promise<{ storageBytes: number; installCount: number; runtimeMinutes: number }> {
    const events = await this.#options.database.listUsage(actor.tenantId, actor.subject);
    return {
      storageBytes: events.filter((item) => item.kind === "storage_bytes").reduce((sum, item) => sum + item.quantity, 0),
      installCount: events.filter((item) => item.kind === "install").reduce((sum, item) => sum + item.quantity, 0),
      runtimeMinutes: events.filter((item) => item.kind === "runtime_minutes").reduce((sum, item) => sum + item.quantity, 0)
    };
  }

  async listAudit(actor: IdentityPrincipal, resourceId?: string): Promise<AuditEvent[]> {
    const events = await this.#options.database.listAudit(actor.tenantId, resourceId);
    if (!resourceId) return events.filter((event) => event.actorId === actor.subject);
    const project = await this.#options.database.getProject(actor.tenantId, resourceId);
    if (project && role(project, actor.subject)) return events;
    return events.filter((event) => event.actorId === actor.subject);
  }

  async #requireProject(actor: IdentityPrincipal, projectId: string, required: "owner" | "editor" | "viewer"): Promise<CloudProjectRecord> {
    const project = await this.#options.database.getProject(actor.tenantId, projectId);
    if (!project) throw new ServiceBackendError("project not found", "ENOTFOUND");
    const actual = role(project, actor.subject);
    const allowed = required === "viewer" ? Boolean(actual) : required === "editor" ? actual === "owner" || actual === "editor" : actual === "owner";
    if (!allowed) throw new ServiceBackendError("project access denied", "EFORBIDDEN");
    return project;
  }

  async #requireShareOwner(actor: IdentityPrincipal, shareId: string): Promise<CloudShareRecord> {
    const share = await this.#options.database.getShareById(actor.tenantId, shareId);
    if (!share) throw new ServiceBackendError("share link not found", "ENOTFOUND");
    await this.#requireProject(actor, share.projectId, "owner");
    return share;
  }

  async #audit(actor: IdentityPrincipal, action: string, resourceType: AuditEvent["resourceType"], resourceId: string, detail?: AuditEvent["detail"]): Promise<void> {
    await this.#options.database.appendAudit({
      id: `audit_${randomUUID()}`,
      tenantId: actor.tenantId,
      actorId: actor.subject,
      action,
      resourceType,
      resourceId,
      at: this.#isoNow(),
      ...(detail ? { detail } : {})
    });
  }

  #isoNow(): string { return new Date(this.#now()).toISOString(); }
}
