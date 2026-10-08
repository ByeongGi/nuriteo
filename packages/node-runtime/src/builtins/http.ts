import type { HostFetchOptions } from "../../../browser-host/src/io/index.ts";
import type { LoopbackNetwork, RuntimeHttpRequest, RuntimeHttpResponse, RuntimeWebSocket } from "../net/index.ts";
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
  #body: Uint8Array;
  #bodyStarted = false;
  headers: Record<string, string>;
  method: string;
  rawHeaders: string[];
  rawTrailers: string[] = [];
  socket?: RuntimeValue;
  statusCode: number;
  statusMessage: string;
  trailers: Record<string, string> = {};
  url: string;

  constructor(options: { body: Uint8Array; headers: Record<string, string>; method?: string; statusCode: number; statusMessage?: string; url: string }) {
    super();
    this.headers = options.headers;
    this.method = options.method || "GET";
    this.rawHeaders = Object.entries(options.headers).flatMap(([key, value]) => [key, value]);
    this.statusCode = options.statusCode;
    this.statusMessage = options.statusMessage || "";
    this.url = options.url;
    this.#body = options.body;
  }

  override async *[Symbol.asyncIterator](): AsyncIterableIterator<RuntimeValue> {
    this.#startBody();
    yield* super[Symbol.asyncIterator]();
  }

  override on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(eventName, listener);
    if (eventName === "data" || eventName === "readable") this.#startBody();
    return this;
  }

  #startBody(): void {
    if (this.#bodyStarted) return;
    this.#bodyStarted = true;
    queueMicrotask(() => {
      if (this.#body.byteLength > 0) this.push(BrowserBuffer.from(this.#body));
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
  _header: string | null = null;
  headersSent = false;
  statusCode = 200;
  statusMessage = "OK";
  private chunks: RuntimeValue[] = [];
  private headers: Record<string, string | number | readonly string[]> = {};

  constructor() {
    super({
      write: (chunk, _encoding, callback) => {
        this.chunks.push(chunk);
        callback();
      }
    });
  }

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers[normalizeHeaderName(name)];
  }

  appendHeader(name: string, value: string | readonly string[]): this {
    const key = normalizeHeaderName(name);
    const previous = this.headers[key];
    const appended = Array.isArray(value) ? value : [value];
    this.headers[key] = previous === undefined
      ? appended
      : [...(Array.isArray(previous) ? previous : [previous]), ...appended];
    return this;
  }

  getHeaderNames(): string[] {
    return Object.keys(this.headers);
  }

  getHeaders(): Record<string, string | number | readonly string[]> {
    return { ...this.headers };
  }

  hasHeader(name: string): boolean {
    return Object.hasOwn(this.headers, normalizeHeaderName(name));
  }

  removeHeader(name: string): void {
    delete this.headers[normalizeHeaderName(name)];
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[normalizeHeaderName(name)] = value;
    return this;
  }

  _implicitHeader(): void {
    if (!this.headersSent) this.writeHead(this.statusCode);
  }

  flushHeaders(): void {
    this._implicitHeader();
  }

  writeHead(statusCode: number, statusMessageOrHeaders?: string | Record<string, string | number | readonly string[]>, maybeHeaders?: Record<string, string | number | readonly string[]>): this {
    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === "string") this.statusMessage = statusMessageOrHeaders;
    const headers = typeof statusMessageOrHeaders === "object" ? statusMessageOrHeaders : maybeHeaders;
    for (const [key, value] of Object.entries(headers || {})) this.setHeader(key, value);
    this._header = `HTTP/1.1 ${statusCode} ${this.statusMessage}`;
    this.headersSent = true;
    return this;
  }

  toRuntimeHttpResponse(): RuntimeHttpResponse {
    const body = this.chunks.some((chunk) => chunk instanceof Uint8Array || chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk))
      ? concatBody(this.chunks)
      : this.chunks.map((chunk) => String(chunk)).join("");
    return {
      statusCode: this.statusCode,
      statusText: this.statusMessage,
      headers: normalizeHeaders(this.headers),
      body
    };
  }
}

export class Server extends EventEmitter {
  listening = false;
  keepAliveTimeout = 5000;
  headersTimeout = 60000;
  requestTimeout = 300000;
  timeout = 0;
  private hostname = "127.0.0.1";
  private listener: { port: number; close: () => void } | null = null;
  private network: LoopbackNetwork | null;
  private port = 0;

  constructor(listener?: HttpRequestListener, network?: LoopbackNetwork) {
    super();
    this.network = network || null;
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
    this.listener?.close();
    this.listener = null;
    this.listening = false;
    queueMicrotask(() => {
      callback?.();
      this.emit("close");
    });
    return this;
  }

  listen(
    portOrCallback?: number | string | { host?: string; hostname?: string; port?: number | string } | (() => void),
    hostnameOrCallback?: string | (() => void),
    callback?: () => void
  ): this {
    if (typeof portOrCallback === "function") {
      callback = portOrCallback;
    } else if (portOrCallback && typeof portOrCallback === "object") {
      if (portOrCallback.port !== undefined) this.port = Number(portOrCallback.port);
      this.hostname = portOrCallback.host || portOrCallback.hostname || this.hostname;
    } else if (portOrCallback !== undefined) {
      this.port = Number(portOrCallback);
    }
    if (typeof hostnameOrCallback === "function") callback = hostnameOrCallback;
    else if (hostnameOrCallback) this.hostname = hostnameOrCallback;
    if (this.network) {
      this.listener?.close();
      this.listener = this.network.listen(this.port, (request) => this.handleLoopbackRequest(request), {
        websocket: (socket, request) => this.handleLoopbackUpgrade(socket, request)
      });
    }
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

  private async handleLoopbackRequest(request: RuntimeHttpRequest): Promise<RuntimeHttpResponse> {
    const incoming = new IncomingMessage({
      body: new TextEncoder().encode(request.body || ""),
      headers: request.headers,
      method: request.method,
      statusCode: 0,
      url: request.path
    });
    const response = new ServerResponse();
    const finished = new Promise<RuntimeHttpResponse>((resolve) => {
      response.once("finish", () => resolve(response.toRuntimeHttpResponse()));
      response.once("close", () => {
        if (!response.writableEnded) resolve(response.toRuntimeHttpResponse());
      });
    });
    if (!this.emit("request", incoming, response)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
    }
    return finished;
  }

  private handleLoopbackUpgrade(socket: RuntimeWebSocket, request: RuntimeHttpRequest): void {
    const incoming = new IncomingMessage({
      body: new Uint8Array(),
      headers: request.headers,
      method: request.method,
      statusCode: 0,
      url: request.path
    });
    const rawSocket = new LoopbackUpgradeSocket(socket);
    incoming.socket = rawSocket;
    const handled = this.emit("upgrade", incoming, rawSocket, BrowserBuffer.alloc(0));
    if (!handled) socket.close();
  }
}

class LoopbackUpgradeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  authorized = false;
  encrypted = false;
  readable = true;
  writable = true;
  destroyed = false;
  bytesWritten = 0;
  private runtimeSocket: RuntimeWebSocket;
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(runtimeSocket: RuntimeWebSocket) {
    super();
    this.runtimeSocket = runtimeSocket;
    this.runtimeSocket.onmessage = (event) => {
      this.emit("data", encodeClientTextFrame(event.data));
    };
    this.runtimeSocket.onclose = () => {
      this.destroyed = true;
      this.readable = false;
      this.writable = false;
      this.emit("end");
      this.emit("close");
    };
  }

  cork(): void {}

  uncork(): void {}

  pause(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  setNoDelay(_noDelay = true): this {
    return this;
  }

  setTimeout(_timeout: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    return this;
  }

  write(chunk: RuntimeValue, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed) return false;
    const bytes = toUint8Array(chunk);
    this.bytesWritten += bytes.byteLength;
    if (!looksLikeHttpUpgradeResponse(bytes)) this.forwardServerFrames(bytes);
    callback?.();
    return true;
  }

  end(chunk?: RuntimeValue, callback?: () => void): this {
    if (chunk !== undefined) this.write(chunk);
    this.destroy();
    callback?.();
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    if (error) this.emit("error", error);
    this.runtimeSocket.close();
    this.emit("close", !!error);
    return this;
  }

  close(): void {
    this.destroy();
  }

  ping(callback?: (error?: Error) => void): void {
    callback?.();
    queueMicrotask(() => this.emit("pong"));
  }

  send(data: string): void {
    if (!this.destroyed) this.runtimeSocket.send(data);
  }

  terminate(): void {
    this.destroy();
  }

  private forwardServerFrames(bytes: Uint8Array): void {
    this.pending = concatUint8Arrays([this.pending, bytes]) as Uint8Array;
    while (this.pending.byteLength >= 2) {
      const frame = decodeServerFrame(this.pending);
      if (!frame) return;
      this.pending = this.pending.slice(frame.frameLength);
      if (frame.opcode === 1) this.runtimeSocket.send(new TextDecoder().decode(frame.payload));
      else if (frame.opcode === 8) this.runtimeSocket.close();
    }
  }
}

function looksLikeHttpUpgradeResponse(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 32))).startsWith("HTTP/1.1 101");
}

function decodeServerFrame(bytes: Uint8Array): { frameLength: number; opcode: number; payload: Uint8Array } | null {
  if (bytes.byteLength < 2) return null;
  const opcode = (bytes[0] ?? 0) & 0x0f;
  let offset = 2;
  let length = (bytes[1] ?? 0) & 0x7f;
  if (length === 126) {
    if (bytes.byteLength < 4) return null;
    length = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    offset = 4;
  } else if (length === 127) {
    if (bytes.byteLength < 10) return null;
    const high = readUint32(bytes, 2);
    const low = readUint32(bytes, 6);
    if (high !== 0) throw new Error("EWSFRAMETOOLARGE: loopback WebSocket frame exceeds supported size");
    length = low;
    offset = 10;
  }
  const masked = ((bytes[1] ?? 0) & 0x80) !== 0;
  const maskOffset = offset;
  if (masked) offset += 4;
  const frameLength = offset + length;
  if (bytes.byteLength < frameLength) return null;
  const payload = bytes.slice(offset, frameLength);
  if (!masked) return { frameLength, opcode, payload };
  const mask = bytes.slice(maskOffset, maskOffset + 4);
  return {
    frameLength,
    opcode,
    payload: payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0))
  };
}

function encodeClientTextFrame(data: string): Uint8Array {
  const payload = new TextEncoder().encode(data);
  const headerLength = payload.byteLength < 126 ? 2 : payload.byteLength <= 0xffff ? 4 : 10;
  const header = new Uint8Array(headerLength + 4);
  header[0] = 0x81;
  if (payload.byteLength < 126) {
    header[1] = 0x80 | payload.byteLength;
  } else if (payload.byteLength <= 0xffff) {
    header[1] = 0x80 | 126;
    header[2] = (payload.byteLength >> 8) & 0xff;
    header[3] = payload.byteLength & 0xff;
  } else {
    header[1] = 0x80 | 127;
    writeUint32(header, 2, 0);
    writeUint32(header, 6, payload.byteLength);
  }
  const maskOffset = headerLength;
  header.set([0x12, 0x34, 0x56, 0x78], maskOffset);
  const output = new Uint8Array(header.byteLength + payload.byteLength);
  output.set(header, 0);
  for (let index = 0; index < payload.byteLength; index++) {
    output[header.byteLength + index] = (payload[index] ?? 0) ^ (header[maskOffset + (index % 4)] ?? 0);
  }
  return output;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))
  ) >>> 0;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function toUint8Array(value: RuntimeValue): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new TextEncoder().encode(String(value));
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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
  createServer(options: Record<string, unknown>, listener?: HttpRequestListener): Server;
  get(options: string | URL | HttpRequestOptions, callback?: HttpRequestCallback): ClientRequest;
  get(url: string | URL, options: HttpRequestOptions, callback?: HttpRequestCallback): ClientRequest;
  request(options: string | URL | HttpRequestOptions, callback?: HttpRequestCallback): ClientRequest;
  request(url: string | URL, options: HttpRequestOptions, callback?: HttpRequestCallback): ClientRequest;
}

export function createHttpBuiltin(clientOrFetcher?: RuntimeHttpClient | RuntimeFetcher, defaultProtocol = "http:", serverNetwork?: LoopbackNetwork): HttpBuiltin {
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
    createServer: (optionsOrListener?: Record<string, unknown> | HttpRequestListener, listener?: HttpRequestListener) => new Server(
      typeof optionsOrListener === "function" ? optionsOrListener : listener,
      serverNetwork
    ),
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
      const response = await fetch(input, {
        ...options,
        credentials: "omit",
        referrerPolicy: "no-referrer"
      });
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
