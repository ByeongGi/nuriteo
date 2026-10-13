import "server-only";

import {
  ApiConfigurationError,
  createApiClient
} from "@nuriteo/api-client";
import type { ApiClient } from "@nuriteo/api-client";

const COOKIE_HEADER = "cookie";
const REQUEST_ID_HEADER = "x-request-id";
const TRACEPARENT_HEADER = "traceparent";
const COOKIE_MAX_LENGTH = 8_192;
const COOKIE_PATTERN = /^[\x20-\x7e]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_PARENT_ID = "0".repeat(16);

export const DEFAULT_SERVER_API_TIMEOUT_MS = 15_000;

export interface IncomingRequestHeaders {
  get(name: string): string | null;
}

export interface RequestScopedApiClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly incomingHeaders: IncomingRequestHeaders;
  readonly internalApiUrl: string | undefined;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export function createRequestScopedApiClient(
  options: RequestScopedApiClientOptions
): ApiClient {
  const forwardedHeaders = selectForwardedHeaders(options.incomingHeaders);
  const serverFetch = createServerFetch(options.fetch ?? globalThis.fetch, forwardedHeaders);

  return createApiClient({
    baseUrl: validateInternalApiUrl(options.internalApiUrl),
    credentials: "omit",
    fetch: serverFetch,
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    timeoutMs: options.timeoutMs ?? DEFAULT_SERVER_API_TIMEOUT_MS
  });
}

export function validateInternalApiUrl(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) {
    throw new ApiConfigurationError("The internal API URL is not configured.");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ApiConfigurationError("The internal API URL must be an absolute HTTP(S) URL.");
  }

  const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  const hasUnsafeComponents =
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "";
  if (!isHttp || hasUnsafeComponents) {
    throw new ApiConfigurationError("The internal API URL must be an absolute HTTP(S) URL.");
  }

  return parsed.toString().replace(/\/$/u, "");
}

export function selectForwardedHeaders(incomingHeaders: IncomingRequestHeaders): Headers {
  const forwardedHeaders = new Headers();

  const cookie = incomingHeaders.get(COOKIE_HEADER);
  if (isSafeCookieHeader(cookie)) {
    forwardedHeaders.set(COOKIE_HEADER, cookie);
  }

  const requestId = incomingHeaders.get(REQUEST_ID_HEADER);
  if (requestId !== null && REQUEST_ID_PATTERN.test(requestId)) {
    forwardedHeaders.set(REQUEST_ID_HEADER, requestId);
  }

  const traceparent = incomingHeaders.get(TRACEPARENT_HEADER);
  if (traceparent !== null && isValidTraceparent(traceparent)) {
    forwardedHeaders.set(TRACEPARENT_HEADER, traceparent);
  }

  return forwardedHeaders;
}

function createServerFetch(
  fetchImplementation: typeof globalThis.fetch,
  forwardedHeaders: Headers
): typeof globalThis.fetch {
  return async (input, init) => {
    const requestedHeaders = new Headers(init?.headers);
    const outgoingHeaders = new Headers();
    copyHeaderIfPresent(requestedHeaders, outgoingHeaders, "accept");
    copyHeaderIfPresent(requestedHeaders, outgoingHeaders, "content-type");
    forwardedHeaders.forEach((value, name) => outgoingHeaders.set(name, value));

    return fetchImplementation(input, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      headers: outgoingHeaders
    });
  };
}

function copyHeaderIfPresent(source: Headers, destination: Headers, name: string): void {
  const value = source.get(name);
  if (value !== null) {
    destination.set(name, value);
  }
}

function isSafeCookieHeader(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= COOKIE_MAX_LENGTH &&
    COOKIE_PATTERN.test(value)
  );
}

function isValidTraceparent(value: string): boolean {
  const match = TRACEPARENT_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  return match[1] !== ZERO_TRACE_ID && match[2] !== ZERO_PARENT_ID;
}
