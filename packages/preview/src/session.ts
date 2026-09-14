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
      container,
      createdAt: this.now(),
      touchedAt: this.now()
    };
    this.sessions.set(sessionId, session);
    return { ...session };
  }

  get(sessionId: string, { origin, projectId }: PreviewSessionLookup = {}): PreviewSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (this.now() - session.touchedAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    if (origin && session.origin !== origin) return null;
    if (projectId && session.projectId !== projectId) return null;
    session.touchedAt = this.now();
    return { ...session };
  }

  replace(sessionId: string, patch: Partial<PreviewSession> = {}): PreviewSession | null {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const next = { ...current, ...patch, touchedAt: this.now() };
    this.sessions.set(sessionId, next);
    return { ...next };
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }
}

export function createPreviewSessionRegistry(options: PreviewSessionRegistryOptions = {}): PreviewSessionRegistry {
  return new PreviewSessionRegistry(options);
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
