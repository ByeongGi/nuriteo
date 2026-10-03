import type { FieldViolation, ProblemDetails } from "./types.ts";

export type ApiClientErrorKind =
  | "aborted"
  | "configuration"
  | "http"
  | "invalid-response"
  | "response-too-large"
  | "serialization"
  | "timeout"
  | "transport";

export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind;

  constructor(kind: ApiClientErrorKind, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.kind = kind;
  }
}

export class ApiConfigurationError extends ApiClientError {
  constructor(message = "The API client configuration is invalid.") {
    super("configuration", message);
    this.name = "ApiConfigurationError";
  }
}

export class ApiSerializationError extends ApiClientError {
  constructor() {
    super("serialization", "The API request body could not be serialized.");
    this.name = "ApiSerializationError";
  }
}

export class ApiInvalidResponseError extends ApiClientError {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(status: number, requestId: string | undefined) {
    super("invalid-response", "The API returned an invalid JSON response.");
    this.name = "ApiInvalidResponseError";
    this.status = status;
    this.requestId = requestId;
  }
}

export class ApiResponseTooLargeError extends ApiClientError {
  readonly maxResponseBytes: number;
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(status: number, requestId: string | undefined, maxResponseBytes: number) {
    super("response-too-large", "The API response exceeded the configured size limit.");
    this.name = "ApiResponseTooLargeError";
    this.maxResponseBytes = maxResponseBytes;
    this.status = status;
    this.requestId = requestId;
  }
}

export class ApiTimeoutError extends ApiClientError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("timeout", "The API request timed out.");
    this.name = "ApiTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ApiAbortError extends ApiClientError {
  constructor() {
    super("aborted", "The API request was cancelled.");
    this.name = "ApiAbortError";
  }
}

export class ApiTransportError extends ApiClientError {
  constructor() {
    super("transport", "The API request could not be completed.");
    this.name = "ApiTransportError";
  }
}

export class ApiError extends ApiClientError {
  readonly #problem: ProblemDetails | undefined;
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(
    status: number,
    requestId: string | undefined,
    problem: ProblemDetails | undefined
  ) {
    const code = problem?.code ?? "HTTP_ERROR";
    super("http", `The API request failed with status ${status}.`);
    this.name = "ApiError";
    this.#problem = problem;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = isRetryableStatus(status);
  }

  get problem(): ProblemDetails | undefined {
    return this.#problem;
  }

  get fieldErrors(): readonly FieldViolation[] {
    return this.problem?.errors ?? [];
  }
}

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}
