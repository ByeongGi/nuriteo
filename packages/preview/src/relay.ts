import type { PreviewErrorCode, PreviewRelayRequest, PreviewTraceSink } from "./types.ts";
import type { PreviewSessionRegistry } from "./session.ts";

export interface PreviewRelayOptions {
  sessions: PreviewSessionRegistry;
  timeoutMs?: number;
  trace?: PreviewTraceSink;
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
  trace: PreviewTraceSink | null;

  constructor({ sessions, timeoutMs = 1000, trace }: PreviewRelayOptions) {
    this.sessions = sessions;
    this.timeoutMs = timeoutMs;
    this.trace = trace || null;
  }

  async request({ sessionId, origin, projectId, path = "/", method = "GET", headers = {}, body = "" }: PreviewRelayRequest): Promise<Response> {
    const span = this.trace?.startSpan({
      category: "preview",
      name: "preview-relay.request",
      requestId: sessionId,
      attributes: { origin, projectId, path, method }
    });
    const session = this.sessions.get(sessionId, { origin, projectId });
    if (!session) {
      const error = new PreviewRelayError("stale preview session", "ESTALESESSION");
      span?.end({ status: "error", errorCode: error.code });
      throw error;
    }
    if (!session.container?.fetch) {
      const error = new PreviewRelayError("preview server unavailable", "ENOSERVER");
      span?.end({ status: "error", errorCode: error.code });
      throw error;
    }

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
      span?.end({ attributes: { status: response.status } });
      return response;
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new PreviewRelayError("preview request timeout", "ETIMEOUT");
        span?.end({ status: "error", errorCode: timeoutError.code });
        throw timeoutError;
      }
      if (isConnectionRefused(error)) {
        this.sessions.replace(sessionId, { serverState: "stopped", lastErrorCode: "ENOSERVER" });
        const serverError = new PreviewRelayError("preview server unavailable", "ENOSERVER");
        span?.end({ status: "error", errorCode: serverError.code });
        throw serverError;
      }
      span?.end({ status: "error", errorCode: errorCode(error) });
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

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EUNKNOWN";
}
