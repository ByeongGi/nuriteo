import { EventEmitter } from "./events.ts";

export class UnsupportedHttp2Error extends Error {
  code = "ERR_BROWSER_HTTP2_UNSUPPORTED";

  constructor(authority: string | URL) {
    super(`Direct HTTP/2 sessions are not available in the browser runtime: ${String(authority)}`);
    this.name = "UnsupportedHttp2Error";
  }
}

export interface Http2ConnectOptions {
  createConnection?: (...args: unknown[]) => unknown;
  maxDeflateDynamicTableSize?: number;
  maxSessionMemory?: number;
  maxHeaderListPairs?: number;
  settings?: Record<string, unknown>;
}

export class ClientHttp2Session extends EventEmitter {
  readonly authority: string | URL;
  closed = false;
  destroyed = false;

  constructor(authority: string | URL) {
    super();
    this.authority = authority;
  }

  close(callback?: () => void): void {
    if (this.closed) return;
    this.closed = true;
    callback?.();
    this.emit("close");
  }

  destroy(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.close());
  }

  request(): never {
    throw new UnsupportedHttp2Error(this.authority);
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export function connect(authority: string | URL, _options?: Http2ConnectOptions, listener?: () => void): ClientHttp2Session {
  const session = new ClientHttp2Session(authority);
  if (listener) session.once("connect", listener);
  queueMicrotask(() => session.destroy(new UnsupportedHttp2Error(authority)));
  return session;
}

export function createServer(): never {
  throw new UnsupportedHttp2Error("server");
}

export function createSecureServer(): never {
  throw new UnsupportedHttp2Error("secure-server");
}

export const constants = Object.freeze({
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_PATH: ":path",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_CONTENT_TYPE: "content-type",
  HTTP2_HEADER_LOCATION: "location",
  HTTP2_HEADER_USER_AGENT: "user-agent",
  HTTP2_METHOD_CONNECT: "CONNECT",
  HTTP2_METHOD_DELETE: "DELETE",
  HTTP2_METHOD_GET: "GET",
  HTTP2_METHOD_HEAD: "HEAD",
  HTTP2_METHOD_OPTIONS: "OPTIONS",
  HTTP2_METHOD_PATCH: "PATCH",
  HTTP2_METHOD_POST: "POST",
  HTTP2_METHOD_PUT: "PUT",
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
  HTTP_STATUS_REQUEST_TIMEOUT: 408,
  HTTP_STATUS_TOO_MANY_REQUESTS: 429
});

export const http2Builtin = Object.freeze({
  ClientHttp2Session,
  connect,
  constants,
  createSecureServer,
  createServer
});
