import { EventEmitter } from "./events.ts";

export class UnsupportedTcpSocketError extends Error {
  code = "ERR_BROWSER_TCP_UNSUPPORTED";

  constructor(message = "Direct TCP sockets are not available in the browser runtime") {
    super(message);
    this.name = "UnsupportedTcpSocketError";
  }
}

export interface TcpConnectOptions {
  host?: string;
  hostname?: string;
  port?: number;
  path?: string;
}

export class Socket extends EventEmitter {
  connecting = false;
  destroyed = false;
  readable = false;
  writable = false;

  connect(_options: TcpConnectOptions | number | string, _callback?: () => void): this {
    this.destroy(new UnsupportedTcpSocketError());
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close", !!error));
    return this;
  }

  end(): this {
    this.destroy();
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setTimeout(_timeout: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    return this;
  }

  write(_chunk: unknown, callback?: (error?: Error | null) => void): boolean {
    const error = new UnsupportedTcpSocketError();
    callback?.(error);
    this.destroy(error);
    return false;
  }
}

export function connect(options: TcpConnectOptions | number | string, callback?: () => void): Socket {
  return new Socket().connect(options, callback);
}

export const createConnection = connect;

export function isIP(input: string): 0 | 4 | 6 {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(input)) return 4;
  if (input.includes(":")) return 6;
  return 0;
}

export function isIPv4(input: string): boolean {
  return isIP(input) === 4;
}

export function isIPv6(input: string): boolean {
  return isIP(input) === 6;
}

export const netBuiltin = Object.freeze({
  Socket,
  connect,
  createConnection,
  isIP,
  isIPv4,
  isIPv6
});
