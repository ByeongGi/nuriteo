import type { PreviewErrorCode, PreviewRelayRequest } from "./types.ts";
import type { PreviewSessionRegistry } from "./session.ts";

export interface PreviewRelayOptions {
  sessions: PreviewSessionRegistry;
  timeoutMs?: number;
}

export class PreviewRelayError extends Error {
  code: PreviewErrorCode;

  constructor(message: string, code: PreviewErrorCode) {
    super(message);
    this.name = "PreviewRelayError";
    this.code = code;
  }
}

export class PreviewRelay {
  sessions: PreviewSessionRegistry;
  timeoutMs: number;

  constructor({ sessions, timeoutMs = 1000 }: PreviewRelayOptions) {
    this.sessions = sessions;
    this.timeoutMs = timeoutMs;
  }

  async request({ sessionId, origin, projectId, path = "/", method = "GET", headers = {}, body = "" }: PreviewRelayRequest): Promise<Response> {
    const session = this.sessions.get(sessionId, { origin, projectId });
    if (!session) throw new PreviewRelayError("stale preview session", "ESTALESESSION");
    if (!session.container?.fetch) throw new PreviewRelayError("preview server unavailable", "ENOSERVER");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await session.container.fetch(`http://127.0.0.1:${session.port}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal
      });
      this.sessions.replace(sessionId, { serverState: "running", lastErrorCode: null });
      return response;
    } catch (error) {
      if (controller.signal.aborted) throw new PreviewRelayError("preview request timeout", "ETIMEOUT");
      if (isConnectionRefused(error)) {
        this.sessions.replace(sessionId, { serverState: "stopped", lastErrorCode: "ENOSERVER" });
        throw new PreviewRelayError("preview server unavailable", "ENOSERVER");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createPreviewRelay(options: PreviewRelayOptions): PreviewRelay {
  return new PreviewRelay(options);
}

function isConnectionRefused(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ECONNREFUSED";
}
