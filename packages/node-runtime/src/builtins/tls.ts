import { connect as netConnect, Socket, UnsupportedTcpSocketError, type TcpConnectOptions } from "./net.ts";

export interface TlsConnectOptions extends TcpConnectOptions {
  servername?: string;
}

export class TLSSocket extends Socket {
  encrypted = true;
  authorized = false;
  authorizationError = "ERR_BROWSER_TCP_UNSUPPORTED";
}

export function connect(options: TlsConnectOptions | number | string, callback?: () => void): TLSSocket {
  const socket = new TLSSocket();
  socket.connect(options, callback);
  return socket;
}

export function createSecureContext(): Record<string, never> {
  return Object.freeze({});
}

export const tlsBuiltin = Object.freeze({
  TLSSocket,
  Socket,
  connect,
  createSecureContext,
  rootCertificates: Object.freeze([]),
  UnsupportedTcpSocketError
});

export { netConnect };
