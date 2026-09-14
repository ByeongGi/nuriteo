export class PreviewServiceWorker {
  constructor({ relay }) {
    this.relay = relay;
    this.clients = new Map();
  }

  async handleMessage(event) {
    const data = event.data || {};
    if (data.type === "preview:handshake") {
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
      const client = this.clients.get(data.clientId);
      if (!client) return { type: "preview:error", code: "ENOCLIENT" };
      try {
        const response = await this.relay.request({
          ...client,
          path: data.path,
          method: data.method,
          headers: data.headers,
          body: data.body
        });
        return { type: "preview:response", response };
      } catch (error) {
        return { type: "preview:error", code: error.code || "EUNKNOWN", message: error.message };
      }
    }

    return { type: "preview:error", code: "EBADMESSAGE" };
  }

  restart() {
    this.clients.clear();
  }
}

export function createPreviewServiceWorker(options) {
  return new PreviewServiceWorker(options);
}

