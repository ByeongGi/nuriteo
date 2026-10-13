import { createPreviewErrorDiagnostic } from "./error-overlay.ts";
import type { PreviewDiagnostic, PreviewErrorCode, PreviewOverlayMessage, PreviewOverlayState, PreviewRelayLike } from "./types.ts";

export interface PreviewServiceWorkerOptions {
  relay: PreviewRelayLike;
  now?: () => number;
}

type PreviewClient = {
  clientId: string;
  sessionId: string;
  origin: string;
  projectId: string;
  port?: PreviewMessagePort;
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
    code?: PreviewErrorCode;
    column?: number;
    file?: string;
    line?: number;
    level?: PreviewDiagnostic["level"];
    message?: string;
    recoveryActions?: PreviewDiagnostic["recoveryActions"];
    source?: "build" | "hmr" | "runtime";
    stack?: string;
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
  clientPorts: Map<string, PreviewMessagePort>;
  diagnostics: PreviewDiagnostic[];

  constructor({ relay, now }: PreviewServiceWorkerOptions) {
    this.relay = relay;
    this.now = now || (() => Date.now());
    this.clients = new Map();
    this.clientPorts = new Map();
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
        projectId: data.projectId,
        ...(event.port ? { port: event.port } : {})
      });
      if (event.port) this.clientPorts.set(data.clientId, event.port);
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

    if (data.type === "preview:error-diagnostic") {
      if (!data.message || !isPreviewErrorSource(data.source)) return this.#error("EBADMESSAGE", data.clientId);
      this.#record(createPreviewErrorDiagnostic({
        source: data.source,
        message: data.message,
        ...(data.clientId ? { clientId: data.clientId } : {}),
        ...(data.code ? { code: data.code } : {}),
        ...(data.column !== undefined ? { column: data.column } : {}),
        ...(data.file ? { file: data.file } : {}),
        ...(data.line !== undefined ? { line: data.line } : {}),
        ...(data.recoveryActions ? { recoveryActions: data.recoveryActions } : {}),
        ...(data.stack ? { stack: data.stack } : {})
      }, this.now()));
      return readyResponse(data.clientId);
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

  #record(diagnostic: Omit<PreviewDiagnostic, "at"> | PreviewDiagnostic): void {
    const entry = "at" in diagnostic ? diagnostic : {
      at: this.now(),
      ...diagnostic
    };
    this.diagnostics.push(entry);
    this.#emitOverlay(entry);
  }

  #emitOverlay(diagnostic: PreviewDiagnostic): void {
    if (diagnostic.clientId) {
      const port = this.clients.get(diagnostic.clientId)?.port || this.clientPorts.get(diagnostic.clientId);
      port?.postMessage?.(this.#overlayMessage(diagnostic, diagnostic.clientId));
      return;
    }
    for (const [clientId, port] of this.clientPorts) {
      port.postMessage?.(this.#overlayMessage(diagnostic, clientId));
    }
  }

  #overlayMessage(diagnostic: PreviewDiagnostic, clientId?: string): PreviewOverlayMessage {
    return {
      type: "preview:overlay",
      ...(clientId ? { clientId } : {}),
      state: this.overlayState(clientId),
      diagnostic
    };
  }
}

export function createPreviewServiceWorker(options: PreviewServiceWorkerOptions): PreviewServiceWorker {
  return new PreviewServiceWorker(options);
}

function errorCode(error: unknown): PreviewErrorCode {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EUNKNOWN";
}

function isPreviewErrorSource(source: unknown): source is "build" | "hmr" | "runtime" {
  return source === "build" || source === "hmr" || source === "runtime";
}

function readyResponse(clientId?: string): PreviewServiceWorkerResponse {
  return {
    type: "preview:ready",
    ...(clientId ? { clientId } : {})
  };
}
