import type { PreviewDiagnostic, PreviewErrorCode, PreviewOverlayState, PreviewRelayLike } from "./types.ts";

export interface PreviewServiceWorkerOptions {
  relay: PreviewRelayLike;
  now?: () => number;
}

type PreviewClient = {
  clientId: string;
  sessionId: string;
  origin: string;
  projectId: string;
};

type PreviewMessagePort = {
  postMessage?: (message: unknown) => void;
};

type PreviewMessageEvent = {
  data?: Partial<PreviewClient> & {
    type?: string;
    path?: string;
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    level?: PreviewDiagnostic["level"];
    message?: string;
  };
  port?: PreviewMessagePort;
};

type PreviewServiceWorkerResponse =
  | { type: "preview:ready"; clientId?: string }
  | { type: "preview:response"; response: Response }
  | { type: "preview:error"; code: PreviewErrorCode; message?: string };

export class PreviewServiceWorker {
  relay: PreviewRelayLike;
  now: () => number;
  clients: Map<string, PreviewClient>;
  diagnostics: PreviewDiagnostic[];

  constructor({ relay, now }: PreviewServiceWorkerOptions) {
    this.relay = relay;
    this.now = now || (() => Date.now());
    this.clients = new Map();
    this.diagnostics = [];
  }

  async handleMessage(event: PreviewMessageEvent): Promise<PreviewServiceWorkerResponse> {
    const data = event.data || {};
    if (data.type === "preview:handshake") {
      if (!data.clientId || !data.sessionId || !data.origin || !data.projectId) {
        return { type: "preview:error", code: "EBADMESSAGE" };
      }
      this.clients.set(data.clientId, {
        clientId: data.clientId,
        sessionId: data.sessionId,
        origin: data.origin,
        projectId: data.projectId
      });
      event.port?.postMessage?.({ type: "preview:ready", clientId: data.clientId });
      return { type: "preview:ready", clientId: data.clientId };
    }

    if (data.type === "preview:console") {
      if (!data.clientId || !data.message) return this.#error("EBADMESSAGE", data.clientId);
      const level = data.level || "log";
      this.#record({
        source: "console",
        level,
        message: data.message,
        clientId: data.clientId
      });
      return { type: "preview:ready", clientId: data.clientId };
    }

    if (data.type === "preview:fetch") {
      if (!data.clientId) return this.#error("EBADMESSAGE");
      const client = this.clients.get(data.clientId);
      if (!client) return this.#error("ENOCLIENT", data.clientId);
      try {
        const request = { ...client };
        if (data.path !== undefined) Object.assign(request, { path: data.path });
        if (data.method !== undefined) Object.assign(request, { method: data.method });
        if (data.headers !== undefined) Object.assign(request, { headers: data.headers });
        if (data.body !== undefined) Object.assign(request, { body: data.body });
        const response = await this.relay.request(request);
        return { type: "preview:response", response };
      } catch (error) {
        return this.#error(errorCode(error), data.clientId, error instanceof Error ? error.message : String(error), "relay");
      }
    }

    return this.#error("EBADMESSAGE", data.clientId);
  }

  restart(): void {
    this.clients.clear();
  }

  overlayState(clientId?: string): PreviewOverlayState {
    const diagnostics = clientId
      ? this.diagnostics.filter((entry) => entry.clientId === clientId)
      : [...this.diagnostics];
    return {
      diagnostics,
      lastError: diagnostics.findLast((entry) => entry.level === "error") || null
    };
  }

  #error(code: PreviewErrorCode, clientId?: string, message = code, source: PreviewDiagnostic["source"] = "service-worker"): PreviewServiceWorkerResponse {
    this.#record({
      source,
      level: "error",
      message,
      ...(clientId ? { clientId } : {}),
      code
    });
    return { type: "preview:error", code, message };
  }

  #record(diagnostic: Omit<PreviewDiagnostic, "at">): void {
    this.diagnostics.push({
      at: this.now(),
      ...diagnostic
    });
  }
}

export function createPreviewServiceWorker(options: PreviewServiceWorkerOptions): PreviewServiceWorker {
  return new PreviewServiceWorker(options);
}

function errorCode(error: unknown): PreviewErrorCode {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EUNKNOWN";
}
