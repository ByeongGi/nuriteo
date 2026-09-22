import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  AuditEvent,
  CloudProjectRecord,
  CloudShareRecord,
  IdentityPrincipal,
  IdentityProviderAdapter,
  ProductionDatabaseAdapter,
  ProductionObjectStorageAdapter,
  UsageEvent
} from "./production-types.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** Self-hosted signed-session provider. OIDC/Auth0/etc. can implement the same adapter. */
export class HmacSessionIdentityProvider implements IdentityProviderAdapter {
  #secret: string;
  #now: () => number;

  constructor(options: { secret: string; now?: () => number }) {
    if (Buffer.byteLength(options.secret) < 32) {
      throw new Error("session secret must be at least 32 bytes");
    }
    this.#secret = options.secret;
    this.#now = options.now ?? Date.now;
  }

  issueSession(principal: IdentityPrincipal, ttlSeconds = 3600): string {
    const body = encode(JSON.stringify({ ...principal, exp: Math.floor(this.#now() / 1000) + ttlSeconds }));
    return `${body}.${this.#sign(body)}`;
  }

  async verifySession(token: string): Promise<IdentityPrincipal | null> {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return null;
    const expected = Buffer.from(this.#sign(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try {
      const value = JSON.parse(decode(body)) as IdentityPrincipal & { exp: number };
      if (!value.tenantId || !value.subject || !value.email || value.exp <= this.#now() / 1000) return null;
      return {
        tenantId: value.tenantId,
        subject: value.subject,
        email: value.email,
        displayName: value.displayName || value.email
      };
    } catch {
      return null;
    }
  }

  #sign(body: string): string {
    return createHmac("sha256", this.#secret).update(body).digest("base64url");
  }
}

interface DatabaseState {
  schemaVersion: 1;
  projects: CloudProjectRecord[];
  shares: CloudShareRecord[];
  audit: AuditEvent[];
  usage: UsageEvent[];
}

function emptyState(): DatabaseState {
  return { schemaVersion: 1, projects: [], shares: [], audit: [], usage: [] };
}

/**
 * Durable adapter for self-hosted deployments and provider contract tests.
 * Every operation reloads the file, so separate service instances observe one another.
 * Managed multi-node deployments should inject a transactional SQL adapter.
 */
export class FileProductionDatabase implements ProductionDatabaseAdapter {
  #path: string;
  constructor(options: { persistPath: string }) {
    this.#path = options.persistPath;
  }

  async getProject(tenantId: string, projectId: string): Promise<CloudProjectRecord | null> {
    const found = this.#read().projects.find((item) => item.tenantId === tenantId && item.id === projectId);
    return found ? clone(found) : null;
  }

  async putProject(project: CloudProjectRecord): Promise<void> {
    this.#mutate((state) => {
      state.projects = state.projects.filter((item) => !(item.tenantId === project.tenantId && item.id === project.id));
      state.projects.push(clone(project));
    });
  }

  async listProjects(tenantId: string, principalId: string): Promise<CloudProjectRecord[]> {
    return this.#read().projects
      .filter((item) => item.tenantId === tenantId && item.permissions.some((entry) => entry.principalId === principalId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async putShare(share: CloudShareRecord): Promise<void> {
    this.#mutate((state) => {
      state.shares = state.shares.filter((item) => item.id !== share.id);
      state.shares.push(clone(share));
    });
  }

  async getShareById(tenantId: string, shareId: string): Promise<CloudShareRecord | null> {
    const found = this.#read().shares.find((item) => item.tenantId === tenantId && item.id === shareId);
    return found ? clone(found) : null;
  }

  async getShareByTokenHash(tokenHash: string): Promise<CloudShareRecord | null> {
    const found = this.#read().shares.find((item) => item.tokenHash === tokenHash);
    return found ? clone(found) : null;
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.#mutate((state) => { state.audit.push(clone(event)); });
  }

  async listAudit(tenantId: string, resourceId?: string): Promise<AuditEvent[]> {
    return this.#read().audit
      .filter((item) => item.tenantId === tenantId && (!resourceId || item.resourceId === resourceId))
      .map(clone);
  }

  async ingestUsage(event: UsageEvent): Promise<boolean> {
    let inserted = false;
    this.#mutate((state) => {
      if (state.usage.some((item) => item.tenantId === event.tenantId && item.id === event.id)) return;
      state.usage.push(clone(event));
      inserted = true;
    });
    return inserted;
  }

  async listUsage(tenantId: string, actorId: string): Promise<UsageEvent[]> {
    return this.#read().usage.filter((item) => item.tenantId === tenantId && item.actorId === actorId).map(clone);
  }

  #read(): DatabaseState {
    if (!fs.existsSync(this.#path)) return emptyState();
    const value = JSON.parse(fs.readFileSync(this.#path, "utf8")) as DatabaseState;
    if (value.schemaVersion !== 1 || !Array.isArray(value.projects) || !Array.isArray(value.shares)) {
      throw new Error("invalid production database state");
    }
    value.audit ??= [];
    value.usage ??= [];
    return value;
  }

  #mutate(update: (state: DatabaseState) => void): void {
    const state = this.#read();
    update(state);
    fs.mkdirSync(path.dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, this.#path);
  }
}

export class FileProductionObjectStorage implements ProductionObjectStorageAdapter {
  #root: string;
  constructor(options: { root: string }) { this.#root = path.resolve(options.root); }
  async putObject(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.#target(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, target);
  }
  async getObject(key: string): Promise<Uint8Array | null> {
    const target = this.#target(key);
    return fs.existsSync(target) ? new Uint8Array(fs.readFileSync(target)) : null;
  }
  async deleteObject(key: string): Promise<void> {
    try { fs.unlinkSync(this.#target(key)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  #target(key: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes("..")) throw new Error("invalid object key");
    const target = path.resolve(this.#root, key);
    if (!target.startsWith(`${this.#root}${path.sep}`)) throw new Error("object key escapes root");
    return target;
  }
}
