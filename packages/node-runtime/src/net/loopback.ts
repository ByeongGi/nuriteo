import { parseHttpRequest, parseHttpResponse, serializeHttpRequest, serializeHttpResponse } from "./http-parser.ts";

export class LoopbackNetworkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LoopbackNetworkError";
    this.code = code;
  }
}

export class LoopbackNetwork {
  constructor(options = {}) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.listeners = new Map();
  }

  listen(port, handler) {
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

  async fetch(url, options = {}) {
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
    const response = await listener.handler(request, { signal: options.signal });
    if (options.signal?.aborted) throw new LoopbackNetworkError("client aborted", "ECONNABORTED");

    const raw = serializeHttpResponse(response);
    if (raw.length > (options.maxBytes ?? this.maxBytes)) {
      throw new LoopbackNetworkError("response exceeded max bytes", "ETOOBIG");
    }
    return parseHttpResponse(raw);
  }
}

export function createLoopbackNetwork(options) {
  return new LoopbackNetwork(options);
}

