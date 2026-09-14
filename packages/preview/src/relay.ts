export class PreviewRelayError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PreviewRelayError";
    this.code = code;
  }
}

export class PreviewRelay {
  constructor({ sessions, timeoutMs = 1000 }) {
    this.sessions = sessions;
    this.timeoutMs = timeoutMs;
  }

  async request({ sessionId, origin, projectId, path = "/", method = "GET", headers = {}, body = "" }) {
    const session = this.sessions.get(sessionId, { origin, projectId });
    if (!session) throw new PreviewRelayError("stale preview session", "ESTALESESSION");
    if (!session.container?.fetch) throw new PreviewRelayError("preview server unavailable", "ENOSERVER");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await session.container.fetch(`http://127.0.0.1:${session.port}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new PreviewRelayError("preview request timeout", "ETIMEOUT");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createPreviewRelay(options) {
  return new PreviewRelay(options);
}

