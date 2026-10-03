import "server-only";

import { randomUUID } from "node:crypto";

import {
  selectForwardedHeaders,
  validateInternalApiUrl
} from "./server-policy.ts";

const LOGIN_PATH = "/api/v1/auth/sessions";
const ME_PATH = "/api/v1/me";
const MAX_LOGIN_BODY_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 1_048_576;
const UPSTREAM_TIMEOUT_MS = 15_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

type AuthBffPath = typeof LOGIN_PATH | typeof ME_PATH;

export async function forwardCreateSession(request: Request): Promise<Response> {
  const requestId = requestIdFor(request);
  const origin = sameOriginHeader(request);
  if (origin === undefined) {
    return problem(403, "BFF_ORIGIN_REJECTED", requestId, LOGIN_PATH);
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return problem(415, "BFF_CONTENT_TYPE_REJECTED", requestId, LOGIN_PATH);
  }

  const body = await readBoundedBody(request, MAX_LOGIN_BODY_BYTES);
  if (body === undefined) {
    return problem(413, "BFF_BODY_TOO_LARGE", requestId, LOGIN_PATH);
  }

  const headers = correlationHeaders(request);
  headers.set("content-type", "application/json");
  headers.set("origin", origin);
  return forward(LOGIN_PATH, {
    body: toArrayBuffer(body),
    headers,
    method: "POST"
  }, requestId, true);
}

export async function forwardCurrentUser(request: Request): Promise<Response> {
  return forward(
    ME_PATH,
    {
      headers: selectForwardedHeaders(request.headers),
      method: "GET"
    },
    requestIdFor(request),
    false
  );
}

async function forward(
  path: AuthBffPath,
  init: RequestInit,
  requestId: string,
  forwardSetCookie: boolean
): Promise<Response> {
  let internalApiUrl: string;
  try {
    internalApiUrl = validateInternalApiUrl(process.env.NURITEO_INTERNAL_API_URL);
  } catch {
    return problem(503, "BFF_NOT_CONFIGURED", requestId, path);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${internalApiUrl}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch {
    return problem(502, "BFF_UPSTREAM_UNAVAILABLE", requestId, path);
  }

  const body = await readBoundedResponse(upstream, MAX_RESPONSE_BYTES);
  if (body === undefined) {
    return problem(502, "BFF_UPSTREAM_RESPONSE_REJECTED", requestId, path);
  }

  const headers = new Headers({ "cache-control": "no-store" });
  copyResponseHeader(upstream.headers, headers, "content-type");
  copyResponseHeader(upstream.headers, headers, "x-request-id");
  if (forwardSetCookie) {
    for (const cookie of upstream.headers.getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
  }

  return new Response(hasResponseBody(upstream.status) ? toArrayBuffer(body) : null, {
    headers,
    status: upstream.status
  });
}

function correlationHeaders(request: Request): Headers {
  const selected = selectForwardedHeaders(request.headers);
  selected.delete("cookie");
  return selected;
}

function sameOriginHeader(request: Request): string | undefined {
  const origin = request.headers.get("origin");
  if (origin !== null && (origin.length > 2_048 || origin.includes(","))) {
    return undefined;
  }

  const requestOrigin = publicRequestOrigin(request);
  if (requestOrigin === undefined) {
    return undefined;
  }
  if (origin === null) {
    return requestOrigin;
  }
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.origin === requestOrigin
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}

function publicRequestOrigin(request: Request): string | undefined {
  const host = request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  if (host === null || host.length > 255 || host.includes(",")) {
    return undefined;
  }
  const protocol = forwardedProtocol ?? new URL(request.url).protocol.slice(0, -1);
  if (!/^(?:http|https)$/u.test(protocol)) {
    return undefined;
  }
  try {
    const origin = new URL(`${protocol}://${host}`);
    return origin.host === host && origin.origin === `${protocol}://${host}`
      ? origin.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null || value.includes(",")) {
    return false;
  }
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBoundedBody(
  request: Request,
  maximum: number
): Promise<Uint8Array | undefined> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximum)
  ) {
    await cancel(request.body);
    return undefined;
  }
  return readBoundedStream(request.body, maximum);
}

async function readBoundedResponse(
  response: Response,
  maximum: number
): Promise<Uint8Array | undefined> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximum)
  ) {
    await cancel(response.body);
    return undefined;
  }
  return readBoundedStream(response.body, maximum);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number
): Promise<Uint8Array | undefined> {
  if (stream === null) {
    return new Uint8Array();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The bounded safe response remains authoritative.
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function cancel(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await stream?.cancel();
  } catch {
    // The bounded safe response remains authoritative.
  }
}

function copyResponseHeader(source: Headers, destination: Headers, name: string): void {
  const value = source.get(name);
  if (value !== null) {
    destination.set(name, value);
  }
}

function hasResponseBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function requestIdFor(request: Request): string {
  const incoming = request.headers.get("x-request-id");
  return incoming !== null && REQUEST_ID_PATTERN.test(incoming)
    ? incoming
    : `bff-${randomUUID()}`;
}

function problem(status: number, code: string, requestId: string, path: string): Response {
  return Response.json(
    {
      type: "about:blank",
      title: "Request could not be completed",
      status,
      detail: "The request could not be completed safely.",
      instance: path,
      code,
      request_id: requestId,
      errors: []
    },
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/problem+json",
        "x-request-id": requestId
      },
      status
    }
  );
}
