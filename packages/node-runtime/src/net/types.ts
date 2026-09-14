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
  body?: string;
}

export type LoopbackErrorCode = "EADDRINUSE" | "ECONNABORTED" | "ECONNREFUSED" | "ETOOBIG" | (string & {});

export type LoopbackHandler = (
  request: RuntimeHttpRequest,
  context: { signal?: AbortSignal }
) => RuntimeHttpResponse | Promise<RuntimeHttpResponse>;

export interface LoopbackListener {
  port: number;
  handler: LoopbackHandler;
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
