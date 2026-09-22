export type RuntimeHeaders = Record<string, string>;

export interface RuntimeHttpRequest {
  method: string;
  path: string;
  version?: string;
  headers: RuntimeHeaders;
  body?: string;
}

export interface RuntimeHttpResponse {
  version?: string;
  statusCode: number;
  statusText?: string;
  headers?: RuntimeHeaders;
  body?: string | Uint8Array;
}

export interface RuntimeWebSocket {
  readonly protocol: string;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  close(): void;
  send(data: string): void;
}

export type LoopbackErrorCode = "EADDRINUSE" | "ECONNABORTED" | "ECONNREFUSED" | "ENOUPGRADE" | "ETOOBIG" | (string & {});

export type LoopbackHandler = (
  request: RuntimeHttpRequest,
  context: { signal?: AbortSignal }
) => RuntimeHttpResponse | Promise<RuntimeHttpResponse>;

export type LoopbackWebSocketHandler = (
  socket: RuntimeWebSocket,
  request: RuntimeHttpRequest,
  context: { protocol: string }
) => void | Promise<void>;

export interface LoopbackListener {
  port: number;
  handler: LoopbackHandler;
  websocketHandler?: LoopbackWebSocketHandler;
  closed: boolean;
}

export interface LoopbackNetworkOptions {
  maxBytes?: number;
}

export interface LoopbackFetchOptions {
  method?: string;
  headers?: RuntimeHeaders;
  body?: string;
  signal?: AbortSignal;
  maxBytes?: number;
}

export interface LoopbackWebSocketOptions {
  headers?: RuntimeHeaders;
  protocol?: string;
}
