import type { PreviewSession, PreviewSessionCreateInput, PreviewSessionLookup, PreviewSessionRegistryOptions } from "./types.ts";

export class PreviewSessionRegistry {
  now: () => number;
  ttlMs: number;
  sessions: Map<string, PreviewSession>;

  constructor(options: PreviewSessionRegistryOptions = {}) {
    this.now = options.now || (() => Date.now());
    this.ttlMs = options.ttlMs ?? 30000;
    this.sessions = new Map();
  }

  create({ origin, projectId, port, container }: PreviewSessionCreateInput): PreviewSession {
    const sessionId = randomId();
    const session = {
      sessionId,
      origin,
      projectId,
      port,
      baseUrl: createPreviewBaseUrl(origin, projectId, port),
      serverState: "running" as const,
      lastErrorCode: null,
      container,
      createdAt: this.now(),
      touchedAt: this.now()
    };
    this.sessions.set(sessionId, session);
    return { ...session };
  }

  get(sessionId: string, lookup: PreviewSessionLookup = {}): PreviewSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.#isExpired(session)) {
      this.sessions.delete(sessionId);
      return null;
    }
    const { origin, projectId, port } = lookup;
    if (origin && session.origin !== origin) return null;
    if (projectId && session.projectId !== projectId) return null;
    if (port !== undefined && session.port !== port) return null;
    session.touchedAt = this.now();
    return { ...session };
  }

  replace(sessionId: string, patch: Partial<PreviewSession> = {}): PreviewSession | null {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    if (this.#isExpired(current)) {
      this.sessions.delete(sessionId);
      return null;
    }
    const merged = { ...current, ...patch };
    const next = {
      ...merged,
      baseUrl: createPreviewBaseUrl(merged.origin, merged.projectId, merged.port),
      touchedAt: this.now()
    };
    this.sessions.set(sessionId, next);
    return { ...next };
  }

  find(lookup: PreviewSessionLookup = {}): PreviewSession | null {
    return this.list(lookup)[0] || null;
  }

  list(lookup: PreviewSessionLookup = {}): PreviewSession[] {
    const active: PreviewSession[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (this.#isExpired(session)) {
        this.sessions.delete(sessionId);
        continue;
      }
      if (!matchesLookup(session, lookup)) continue;
      active.push({ ...session });
    }
    active.sort((left, right) => right.touchedAt - left.touchedAt || right.createdAt - left.createdAt);
    return active;
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  #isExpired(session: PreviewSession): boolean {
    return this.now() - session.touchedAt > this.ttlMs;
  }
}

export function createPreviewSessionRegistry(options: PreviewSessionRegistryOptions = {}): PreviewSessionRegistry {
  return new PreviewSessionRegistry(options);
}

export function createPreviewBaseUrl(origin: string, projectId: string, port: number): string {
  return `${origin.replace(/\/+$/, "")}/__preview/${encodeURIComponent(projectId)}/${port}/`;
}

export function createPreviewUrl(session: Pick<PreviewSession, "baseUrl">, path = "/"): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalizedPath, session.baseUrl).toString();
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function matchesLookup(session: PreviewSession, { origin, projectId, port }: PreviewSessionLookup): boolean {
  if (origin && session.origin !== origin) return false;
  if (projectId && session.projectId !== projectId) return false;
  if (port !== undefined && session.port !== port) return false;
  return true;
}
