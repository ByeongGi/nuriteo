import {
  ApiAbortError,
  ApiClientError,
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  ApiSerializationError,
  ApiTimeoutError,
  ApiTransportError
} from "./errors.ts";
import {
  API_PREFIX,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  REQUEST_ID_HEADER
} from "./types.ts";
import type {
  ApiClient,
  ApiClientOptions,
  ApiRequestOptions,
  ApiResponse,
  BodylessRequestOptions,
  FieldViolation,
  HttpMethod,
  ProblemDetails
} from "./types.ts";

type AbortSource = "external" | "timeout";

interface PreparedClientOptions {
  readonly baseUrl: string;
  readonly credentials: RequestCredentials | undefined;
  readonly defaultHeaders: HeadersInit | undefined;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const clientOptions = prepareClientOptions(options);

  const request = <TResponse, TBody = unknown>(
    method: HttpMethod,
    path: `/${string}`,
    requestOptions: ApiRequestOptions<TBody> = {}
  ) => requestApi<TResponse, TBody>(clientOptions, method, path, requestOptions);

  return {
    request,
    get: <TResponse>(path: `/${string}`, requestOptions?: BodylessRequestOptions) =>
      request<TResponse>("GET", path, requestOptions),
    post: <TResponse, TBody = unknown>(
      path: `/${string}`,
      body?: TBody,
      requestOptions?: Omit<ApiRequestOptions<TBody>, "body">
    ) => request<TResponse, TBody>("POST", path, { ...requestOptions, body }),
    put: <TResponse, TBody = unknown>(
      path: `/${string}`,
      body?: TBody,
      requestOptions?: Omit<ApiRequestOptions<TBody>, "body">
    ) => request<TResponse, TBody>("PUT", path, { ...requestOptions, body }),
    patch: <TResponse, TBody = unknown>(
      path: `/${string}`,
      body?: TBody,
      requestOptions?: Omit<ApiRequestOptions<TBody>, "body">
    ) => request<TResponse, TBody>("PATCH", path, { ...requestOptions, body }),
    delete: <TResponse>(path: `/${string}`, requestOptions?: BodylessRequestOptions) =>
      request<TResponse>("DELETE", path, requestOptions)
  };
}

async function requestApi<TResponse, TBody>(
  clientOptions: PreparedClientOptions,
  method: HttpMethod,
  path: `/${string}`,
  requestOptions: ApiRequestOptions<TBody>
): Promise<ApiResponse<TResponse>> {
  const timeoutMs = normalizeTimeout(requestOptions.timeoutMs ?? clientOptions.timeoutMs);
  const externalSignal = requestOptions.signal;
  if (externalSignal?.aborted) {
    throw new ApiAbortError();
  }

  const controller = new AbortController();
  let abortSource: AbortSource | undefined;
  const abortFromExternalSignal = () => {
    if (abortSource === undefined) {
      abortSource = "external";
      controller.abort();
    }
  };
  externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  const timeout = setTimeout(() => {
    if (abortSource === undefined) {
      abortSource = "timeout";
      controller.abort();
    }
  }, timeoutMs);

  try {
    const body = serializeBody(requestOptions.body);
    const response = await clientOptions.fetch(createRequestUrl(clientOptions.baseUrl, path), {
      method,
      headers: createHeaders(
        clientOptions.defaultHeaders,
        requestOptions.headers,
        body !== undefined
      ),
      ...(body === undefined ? {} : { body }),
      ...(clientOptions.credentials === undefined
        ? {}
        : { credentials: clientOptions.credentials }),
      signal: controller.signal
    });

    if (abortSource !== undefined) {
      throw createAbortError(abortSource, timeoutMs);
    }
    return await parseResponse<TResponse>(response);
  } catch (error) {
    if (abortSource !== undefined) {
      throw createAbortError(abortSource, timeoutMs);
    }
    if (error instanceof ApiClientError) {
      throw error;
    }
    throw new ApiTransportError();
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

function prepareClientOptions(options: ApiClientOptions): PreparedClientOptions {
  return {
    baseUrl: normalizeBaseUrl(options.baseUrl),
    credentials: options.credentials,
    defaultHeaders: options.defaultHeaders,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: normalizeTimeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl === "") {
    return "";
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ApiConfigurationError("The API base URL must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ApiConfigurationError("The API base URL must be an absolute HTTP(S) URL.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeTimeout(timeoutMs: number): number {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new ApiConfigurationError(
      `The API timeout must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`
    );
  }
  return timeoutMs;
}

function createRequestUrl(baseUrl: string, path: string): string {
  validateRequestPath(path);
  return `${baseUrl}${API_PREFIX}${path}`;
}

function validateRequestPath(path: string): void {
  const pathname = path.split("?", 1)[0] ?? "";
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new ApiConfigurationError("The API request path is invalid.");
  }

  try {
    const hasTraversal = pathname
      .split("/")
      .some((segment) => [".", ".."].includes(decodeURIComponent(segment)));
    if (hasTraversal) {
      throw new ApiConfigurationError("The API request path is invalid.");
    }
  } catch (error) {
    if (error instanceof ApiConfigurationError) {
      throw error;
    }
    throw new ApiConfigurationError("The API request path is invalid.");
  }
}

function createHeaders(
  defaultHeaders: HeadersInit | undefined,
  requestHeaders: HeadersInit | undefined,
  hasBody: boolean
): Headers {
  const headers = new Headers(defaultHeaders);
  new Headers(requestHeaders).forEach((value, name) => headers.set(name, value));
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json, application/problem+json, text/plain");
  }
  return headers;
}

function serializeBody(body: unknown): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined) {
      throw new ApiSerializationError();
    }
    return serialized;
  } catch {
    throw new ApiSerializationError();
  }
}

async function parseResponse<TResponse>(response: Response): Promise<ApiResponse<TResponse>> {
  const requestId = readRequestId(response.headers);
  if (response.status === 204) {
    return createResponse(undefined as TResponse, response, requestId);
  }

  const text = await response.text();
  const isJson = isJsonContentType(response.headers.get("content-type"));
  if (!response.ok) {
    const problem = isJson ? parseProblemDetails(text, response.status) : undefined;
    throw new ApiError(response.status, requestId ?? problem?.request_id, problem);
  }

  if (!isJson) {
    return createResponse(text as TResponse, response, requestId);
  }
  try {
    return createResponse(JSON.parse(text) as TResponse, response, requestId);
  } catch {
    throw new ApiInvalidResponseError(response.status, requestId);
  }
}

function createResponse<TResponse>(
  data: TResponse,
  response: Response,
  requestId: string | undefined
): ApiResponse<TResponse> {
  return {
    data,
    status: response.status,
    requestId,
    headers: response.headers
  };
}

function readRequestId(headers: Headers): string | undefined {
  const value = headers.get(REQUEST_ID_HEADER)?.trim();
  return value === "" ? undefined : value;
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function parseProblemDetails(text: string, responseStatus: number): ProblemDetails | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const type = readString(value, "type");
  const title = readString(value, "title");
  const detail = readString(value, "detail");
  const instance = readString(value, "instance");
  const code = readString(value, "code");
  const requestId = readString(value, "request_id");
  if (
    type === undefined ||
    title === undefined ||
    detail === undefined ||
    instance === undefined ||
    code === undefined ||
    requestId === undefined
  ) {
    return undefined;
  }
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) {
    return undefined;
  }

  return {
    type,
    title,
    status: responseStatus,
    detail,
    instance,
    code,
    request_id: requestId,
    errors: parseFieldViolations(value.errors)
  };
}

function parseFieldViolations(value: unknown): readonly FieldViolation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 32).flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const path = readString(item, "path");
    const code = readString(item, "code");
    const detail = readString(item, "detail");
    return path === undefined || code === undefined || detail === undefined
      ? []
      : [{ path, code, detail }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function createAbortError(source: AbortSource, timeoutMs: number): ApiClientError {
  return source === "timeout" ? new ApiTimeoutError(timeoutMs) : new ApiAbortError();
}
