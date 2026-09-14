import type { PreviewErrorCode, PreviewRelayLike } from "./types.ts";

export interface PreviewServiceWorkerOptions {
  relay: PreviewRelayLike;
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
  };
  port?: PreviewMessagePort;
};

type PreviewServiceWorkerResponse =
  | { type: "preview:ready"; clientId?: string }
  | { type: "preview:response"; response: Response }
  | { type: "preview:error"; code: PreviewErrorCode; message?: string };

export class PreviewServiceWorker {
  relay: PreviewRelayLike;
  clients: Map<string, PreviewClient>;

  constructor({ relay }: PreviewServiceWorkerOptions) {
    this.relay = relay;
    this.clients = new Map();
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

    if (data.type === "preview:fetch") {
      if (!data.clientId) return { type: "preview:error", code: "EBADMESSAGE" };
      const client = this.clients.get(data.clientId);
      if (!client) return { type: "preview:error", code: "ENOCLIENT" };
      try {
        const request = { ...client };
        if (data.path !== undefined) Object.assign(request, { path: data.path });
        if (data.method !== undefined) Object.assign(request, { method: data.method });
        if (data.headers !== undefined) Object.assign(request, { headers: data.headers });
        if (data.body !== undefined) Object.assign(request, { body: data.body });
        const response = await this.relay.request(request);
        return { type: "preview:response", response };
      } catch (error) {
        return {
          type: "preview:error",
          code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EUNKNOWN",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }

    return { type: "preview:error", code: "EBADMESSAGE" };
  }

  restart(): void {
    this.clients.clear();
  }
}

export function createPreviewServiceWorker(options: PreviewServiceWorkerOptions): PreviewServiceWorker {
  return new PreviewServiceWorker(options);
}
