export const API_PREFIX = "/api/v1";
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_RESPONSE_BYTES = 16_777_216;
export const REQUEST_ID_HEADER = "x-request-id";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FieldViolation {
  readonly path: string;
  readonly code: string;
  readonly detail: string;
}

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly request_id: string;
  readonly errors: readonly FieldViolation[];
}

export interface ApiResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly headers: Headers;
}

export interface ApiRequestOptions<TBody = unknown> {
  readonly body?: TBody | undefined;
  readonly headers?: HeadersInit;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type BodylessRequestOptions = Omit<ApiRequestOptions<never>, "body">;

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly credentials?: RequestCredentials;
  readonly defaultHeaders?: HeadersInit;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export interface ApiClient {
  request<TResponse, TBody = unknown>(
    method: HttpMethod,
    path: `/${string}`,
    options?: ApiRequestOptions<TBody>
  ): Promise<ApiResponse<TResponse>>;
  get<TResponse>(
    path: `/${string}`,
    options?: BodylessRequestOptions
  ): Promise<ApiResponse<TResponse>>;
  post<TResponse, TBody = unknown>(
    path: `/${string}`,
    body?: TBody,
    options?: Omit<ApiRequestOptions<TBody>, "body">
  ): Promise<ApiResponse<TResponse>>;
  put<TResponse, TBody = unknown>(
    path: `/${string}`,
    body?: TBody,
    options?: Omit<ApiRequestOptions<TBody>, "body">
  ): Promise<ApiResponse<TResponse>>;
  patch<TResponse, TBody = unknown>(
    path: `/${string}`,
    body?: TBody,
    options?: Omit<ApiRequestOptions<TBody>, "body">
  ): Promise<ApiResponse<TResponse>>;
  delete<TResponse>(
    path: `/${string}`,
    options?: BodylessRequestOptions
  ): Promise<ApiResponse<TResponse>>;
}
