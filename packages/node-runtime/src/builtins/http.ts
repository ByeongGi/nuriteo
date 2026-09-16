import type { HostFetchOptions } from "../../../browser-host/src/io/index.ts";
import type { RuntimeFetcher, RuntimeHttpClient } from "../network/http-client.ts";
import type { RuntimeValue } from "../types.ts";
import { BrowserBuffer } from "./buffer.ts";
import { EventEmitter } from "./events.ts";
import { Readable, Writable } from "./stream.ts";

export interface HttpRequestOptions {
  protocol?: string;
  hostname?: string;
  host?: string;
  port?: number | string;
  path?: string;
  pathname?: string;
  href?: string;
  method?: string;
  headers?: Record<string, string | number | readonly string[]>;
  signal?: AbortSignal;
}

export type HttpRequestCallback = (response: IncomingMessage) => void;

export class Agent extends EventEmitter {
  static defaultMaxSockets = Infinity;
  keepAlive: boolean;
  maxSockets: number;
  options: Record<string, unknown>;

  constructor(options: { keepAlive?: boolean; maxSockets?: number } = {}) {
    super();
    this.keepAlive = !!options.keepAlive;
    this.maxSockets = options.maxSockets ?? Agent.defaultMaxSockets;
    this.options = { ...options };
  }

  addRequest(): void {
    // Browser fetch owns connection scheduling; package managers only need Node's Agent shape.
  }

  destroy(): void {
    this.removeAllListeners();
  }
}

export class IncomingMessage extends Readable {
  headers: Record<string, string>;
  rawHeaders: string[];
  rawTrailers: string[] = [];
  statusCode: number;
  statusMessage: string;
  trailers: Record<string, string> = {};
  url: string;

  constructor(options: { body: Uint8Array; headers: Record<string, string>; statusCode: number; statusMessage?: string; url: string }) {
    super();
    this.headers = options.headers;
    this.rawHeaders = Object.entries(options.headers).flatMap(([key, value]) => [key, value]);
    this.statusCode = options.statusCode;
    this.statusMessage = options.statusMessage || "";
    this.url = options.url;

    queueMicrotask(() => {
      this.push(BrowserBuffer.from(options.body));
      this.push(null);
    });
  }
}

export class ClientRequest extends Writable {
  private chunks: RuntimeValue[] = [];
  private ended = false;
  private options: HttpRequestOptions;
  private callback: HttpRequestCallback | undefined;
  private fetcher: RuntimeFetcher;
  private headers: Record<string, string | number | readonly string[]>;

  constructor(fetcher: RuntimeFetcher, options: string | URL | HttpRequestOptions, callback?: HttpRequestCallback) {
    super();
    this.fetcher = fetcher;
    this.options = normalizeRequestOptions(options);
    this.callback = callback;
    this.headers = { ...(this.options.headers || {}) };
    this.options.headers = this.headers;
  }

  override write(chunk: RuntimeValue, encodingOrCallback?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }

  abort(): this {
    this.destroy();
    this.emit("abort");
    return this;
  }

  flushHeaders(): void {
    // Headers are dispatched with the body in the browser-backed fetch path.
  }

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers[normalizeHeaderName(name)];
  }

  removeHeader(name: string): void {
    delete this.headers[normalizeHeaderName(name)];
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[normalizeHeaderName(name)] = value;
    return this;
  }

  setNoDelay(_noDelay = true): this {
    return this;
  }

  setTimeout(_timeout: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    return this;
  }

  override end(
    chunkOrCallback?: RuntimeValue | ((error?: Error | null) => void),
    _encodingOrCallback?: string | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): this {
    if (typeof chunkOrCallback !== "function" && chunkOrCallback !== undefined) this.chunks.push(chunkOrCallback);
    const done = typeof chunkOrCallback === "function" ? chunkOrCallback : callback;
    if (this.ended) return this;
    this.ended = true;
    void this.dispatch().then(() => done?.(), (error) => {
      this.emit("error", error);
      done?.(error);
    });
    return this;
  }

  private async dispatch(): Promise<void> {
    const url = requestUrl(this.options);
    const requestOptions: HostFetchOptions = {
      headers: normalizeHeaders(this.options.headers),
      method: this.options.method || "GET"
    };
    if (this.options.signal instanceof AbortSignal) requestOptions.signal = this.options.signal;
    if (this.chunks.length > 0) requestOptions.body = toArrayBuffer(concatBody(this.chunks));
    const result = await this.fetcher.download(url, requestOptions);
    const response = new IncomingMessage({
      body: result.body,
      headers: result.headers,
      statusCode: result.status,
      url: result.url
    });
    this.callback?.(response);
    this.emit("response", response);
    this.emit("finish");
    this.emit("close");
  }
}

export type HttpRequestListener = (request: IncomingMessage, response: ServerResponse) => void;

export class ServerResponse extends Writable {
  headersSent = false;
  statusCode = 200;
  statusMessage = "OK";
  private headers: Record<string, string | number | readonly string[]> = {};

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers[normalizeHeaderName(name)];
  }

  removeHeader(name: string): void {
    delete this.headers[normalizeHeaderName(name)];
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[normalizeHeaderName(name)] = value;
    return this;
  }

  writeHead(statusCode: number, statusMessageOrHeaders?: string | Record<string, string | number | readonly string[]>, maybeHeaders?: Record<string, string | number | readonly string[]>): this {
    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === "string") this.statusMessage = statusMessageOrHeaders;
    const headers = typeof statusMessageOrHeaders === "object" ? statusMessageOrHeaders : maybeHeaders;
    for (const [key, value] of Object.entries(headers || {})) this.setHeader(key, value);
    this.headersSent = true;
    return this;
  }
}

export class Server extends EventEmitter {
  listening = false;
  keepAliveTimeout = 5000;
  headersTimeout = 60000;
  requestTimeout = 300000;
  timeout = 0;
  private hostname = "127.0.0.1";
  private port = 0;

  constructor(listener?: HttpRequestListener) {
    super();
    if (listener) this.on("request", listener as (...args: unknown[]) => void);
  }

  address(): { address: string; family: string; port: number } | null {
    if (!this.listening) return null;
    return {
      address: this.hostname,
      family: "IPv4",
      port: this.port
    };
  }

  close(callback?: (error?: Error) => void): this {
    this.listening = false;
    queueMicrotask(() => {
      callback?.();
      this.emit("close");
    });
    return this;
  }

  listen(portOrCallback?: number | string | (() => void), hostnameOrCallback?: string | (() => void), callback?: () => void): this {
    if (typeof portOrCallback === "function") {
      callback = portOrCallback;
    } else if (portOrCallback !== undefined) {
      this.port = Number(portOrCallback);
    }
    if (typeof hostnameOrCallback === "function") callback = hostnameOrCallback;
    else if (hostnameOrCallback) this.hostname = hostnameOrCallback;
    this.listening = true;
    queueMicrotask(() => {
      callback?.();
      this.emit("listening");
    });
    return this;
  }

  setTimeout(timeout: number, callback?: () => void): this {
    this.timeout = timeout;
    if (callback) this.on("timeout", callback);
    return this;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface HttpBuiltin {
  Agent: typeof Agent;
  ClientRequest: typeof ClientRequest;
  IncomingMessage: typeof IncomingMessage;
  Server: typeof Server;
  ServerResponse: typeof ServerResponse;
  STATUS_CODES: Record<number, string>;
  createServer(listener?: HttpRequestListener): Server;
  get(options: string | URL | HttpRequestOptions, callback?: HttpRequestCallback): ClientRequest;
  get(url: string | URL, options: HttpRequestOptions, callback?: HttpRequestCallback): ClientRequest;
  request(options: string | URL | HttpRequestOptions, callback?: HttpRequestCallback): ClientRequest;
  request(url: string | URL, options: HttpRequestOptions, callback?: HttpRequestCallback): ClientRequest;
}

export function createHttpBuiltin(clientOrFetcher?: RuntimeHttpClient | RuntimeFetcher, defaultProtocol = "http:"): HttpBuiltin {
  const fetcher = clientOrFetcher && "download" in clientOrFetcher
    ? clientOrFetcher
    : clientOrFetcher?.fetcher || createGlobalFetcher();
  const withProtocol = (options: string | URL | HttpRequestOptions): string | URL | HttpRequestOptions =>
    typeof options === "object" && !(options instanceof URL) && !("href" in options)
      ? { protocol: defaultProtocol, ...options }
      : options;

  const request = (
    options: string | URL | HttpRequestOptions,
    optionsOrCallback?: HttpRequestOptions | HttpRequestCallback,
    maybeCallback?: HttpRequestCallback
  ) => {
    const requestOptions = mergeRequestOptions(options, optionsOrCallback);
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    return new ClientRequest(fetcher, withProtocol(requestOptions), callback);
  };
  const get = (
    options: string | URL | HttpRequestOptions,
    optionsOrCallback?: HttpRequestOptions | HttpRequestCallback,
    maybeCallback?: HttpRequestCallback
  ) => {
    const requestInstance = request(options, optionsOrCallback, maybeCallback);
    requestInstance.end();
    return requestInstance;
  };

  return Object.freeze({
    Agent,
    ClientRequest,
    IncomingMessage,
    Server,
    ServerResponse,
    STATUS_CODES,
    createServer: (listener?: HttpRequestListener) => new Server(listener),
    get,
    request
  });
}

export const STATUS_CODES = Object.freeze({
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout"
});

export function createHttpsBuiltin(clientOrFetcher?: RuntimeHttpClient | RuntimeFetcher): HttpBuiltin {
  return createHttpBuiltin(clientOrFetcher, "https:");
}

function normalizeRequestOptions(options: string | URL | HttpRequestOptions): HttpRequestOptions {
  if (typeof options === "string" || options instanceof URL) return { href: String(options) };
  return options;
}

function mergeRequestOptions(options: string | URL | HttpRequestOptions, optionsOrCallback?: HttpRequestOptions | HttpRequestCallback): HttpRequestOptions {
  const base = normalizeRequestOptions(options);
  if (!optionsOrCallback || typeof optionsOrCallback === "function") return base;
  return { ...base, ...optionsOrCallback };
}

function requestUrl(options: HttpRequestOptions): string {
  if (options.href) return options.href;
  const protocol = options.protocol || "http:";
  const host = options.hostname || options.host || "localhost";
  const port = options.port ? `:${options.port}` : "";
  const path = options.path || options.pathname || "/";
  return `${protocol}//${host}${port}${path}`;
}

function normalizeHeaders(headers: HttpRequestOptions["headers"] = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)])
  );
}

function normalizeHeaderName(name: string): string {
  return name.toLowerCase();
}

function concatBody(chunks: RuntimeValue[]): Uint8Array {
  const encoded = chunks.map((chunk) => {
    if (typeof chunk === "string") return new TextEncoder().encode(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return new TextEncoder().encode(String(chunk));
  });
  const length = encoded.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of encoded) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function createGlobalFetcher(): RuntimeFetcher {
  return {
    async download(input, options = {}) {
      const response = await fetch(input, options);
      return {
        body: new Uint8Array(await response.arrayBuffer()),
        headers: Object.fromEntries(response.headers.entries()),
        ok: response.ok,
        redirected: response.redirected,
        redirects: [],
        sha256: "",
        status: response.status,
        url: response.url
      };
    }
  };
}
