import { parseHttpRequest, parseHttpResponse, serializeHttpRequest, serializeHttpResponse } from "./http-parser.ts";
import type { LoopbackErrorCode, LoopbackFetchOptions, LoopbackHandler, LoopbackListener, LoopbackNetworkOptions, LoopbackWebSocketHandler, LoopbackWebSocketOptions, RuntimeHttpResponse, RuntimeWebSocket } from "./types.ts";

export class LoopbackNetworkError extends Error {
  code: LoopbackErrorCode;

  constructor(message: string, code: LoopbackErrorCode) {
    super(message);
    this.name = "LoopbackNetworkError";
    this.code = code;
  }
}

export class LoopbackNetwork {
  maxBytes: number;
  listeners: Map<number, LoopbackListener>;

  constructor(options: LoopbackNetworkOptions = {}) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.listeners = new Map();
  }

  listen(port: number, handler: LoopbackHandler, options: { websocket?: LoopbackWebSocketHandler } = {}): { port: number; close: () => void } {
    if (this.listeners.has(port)) throw new LoopbackNetworkError(`port in use: ${port}`, "EADDRINUSE");
    const listener = { port, handler, ...(options.websocket ? { websocketHandler: options.websocket } : {}), closed: false };
    this.listeners.set(port, listener);
    return {
      port,
      close: () => {
        listener.closed = true;
        this.listeners.delete(port);
      }
    };
  }

  async fetch(url: string | URL, options: LoopbackFetchOptions = {}): Promise<RuntimeHttpResponse> {
    const parsed = new URL(url);
    const port = Number(parsed.port || 80);
    const listener = this.listeners.get(port);
    if (!listener || listener.closed) throw new LoopbackNetworkError(`connection refused: ${port}`, "ECONNREFUSED");

    const requestRaw = serializeHttpRequest({
      method: options.method || "GET",
      path: `${parsed.pathname}${parsed.search}`,
      headers: { host: parsed.host, ...(options.headers || {}) },
      body: options.body || ""
    });
    const request = parseHttpRequest(requestRaw);

    if (options.signal?.aborted) throw new LoopbackNetworkError("client aborted", "ECONNABORTED");
    const context: { signal?: AbortSignal } = {};
    if (options.signal) context.signal = options.signal;
    const response = await listener.handler(request, context);
    if (options.signal?.aborted) throw new LoopbackNetworkError("client aborted", "ECONNABORTED");

    const raw = serializeHttpResponse(response);
    if (raw.length > (options.maxBytes ?? this.maxBytes)) {
      throw new LoopbackNetworkError("response exceeded max bytes", "ETOOBIG");
    }
    return parseHttpResponse(raw);
  }

  connectWebSocket(url: string | URL, options: LoopbackWebSocketOptions = {}): RuntimeWebSocket {
    const parsed = new URL(url);
    const port = Number(parsed.port || 80);
    const listener = this.listeners.get(port);
    if (!listener || listener.closed) throw new LoopbackNetworkError(`connection refused: ${port}`, "ECONNREFUSED");
    if (!listener.websocketHandler) throw new LoopbackNetworkError(`websocket upgrade unavailable: ${port}`, "ENOUPGRADE");

    const protocol = options.protocol || "";
    const [clientSocket, serverSocket] = createLoopbackWebSocketPair(protocol);
    const requestRaw = serializeHttpRequest({
      method: "GET",
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        connection: "Upgrade",
        host: parsed.host,
        upgrade: "websocket",
        ...(protocol ? { "sec-websocket-protocol": protocol } : {}),
        ...(options.headers || {})
      }
    });
    const request = parseHttpRequest(requestRaw);
    void listener.websocketHandler(serverSocket, request, { protocol });
    return clientSocket;
  }
}

export function createLoopbackNetwork(options: LoopbackNetworkOptions = {}): LoopbackNetwork {
  return new LoopbackNetwork(options);
}

function createLoopbackWebSocketPair(protocol: string): [RuntimeWebSocket, RuntimeWebSocket] {
  let clientClosed = false;
  let serverClosed = false;
  const client: RuntimeWebSocket = {
    protocol,
    close() {
      if (clientClosed) return;
      clientClosed = true;
      serverClosed = true;
      queueMicrotask(() => {
        server.onclose?.();
        client.onclose?.();
      });
    },
    send(data) {
      if (clientClosed || serverClosed) return;
      queueMicrotask(() => server.onmessage?.({ data }));
    }
  };
  const server: RuntimeWebSocket = {
    protocol,
    close() {
      if (serverClosed) return;
      serverClosed = true;
      clientClosed = true;
      queueMicrotask(() => {
        client.onclose?.();
        server.onclose?.();
      });
    },
    send(data) {
      if (clientClosed || serverClosed) return;
      queueMicrotask(() => client.onmessage?.({ data }));
    }
  };
  return [client, server];
}
