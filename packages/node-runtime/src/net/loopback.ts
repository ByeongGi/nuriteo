import { parseHttpRequest, parseHttpResponse, serializeHttpRequest, serializeHttpResponse } from "./http-parser.ts";
import type { LoopbackErrorCode, LoopbackFetchOptions, LoopbackHandler, LoopbackListener, LoopbackNetworkOptions, RuntimeHttpResponse } from "./types.ts";

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

  listen(port: number, handler: LoopbackHandler): { port: number; close: () => void } {
    if (this.listeners.has(port)) throw new LoopbackNetworkError(`port in use: ${port}`, "EADDRINUSE");
    const listener = { port, handler, closed: false };
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
}

export function createLoopbackNetwork(options: LoopbackNetworkOptions = {}): LoopbackNetwork {
  return new LoopbackNetwork(options);
}
