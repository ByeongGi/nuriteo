import "server-only";

import { randomUUID } from "node:crypto";

import { selectForwardedHeaders, validateInternalApiUrl } from "./server-policy.ts";

const MAX_BODY_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 15_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_HEADER = /^[\x20-\x7e]{1,512}$/u;
const STRONG_ETAG = /^"org-v[1-9]\d*"$/u;

export interface CollaborationForward {
  readonly method: "DELETE" | "PATCH" | "POST";
  readonly path: `/api/v1/${string}`;
  readonly requireCsrf: boolean;
  readonly withBody: boolean;
  readonly withEtag?: boolean;
}

export function uuidPathSegment(value: string): string {
  if (!UUID_V7.test(value)) {
    throw new Error("invalid route identifier");
  }
  return value;
}

export async function forwardCollaborationMutation(
  request: Request,
  spec: CollaborationForward
): Promise<Response> {
  const requestId = requestIdFor(request);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, timeout]);
  if (request.method !== spec.method || signal.aborted) {
    return problem(signal.aborted ? 408 : 405, "BFF_REQUEST_REJECTED", requestId, spec.path);
  }

  const origin = sameOrigin(request);
  if (origin === undefined) {
    return problem(403, "BFF_ORIGIN_REJECTED", requestId, spec.path);
  }

  const headers = selectForwardedHeaders(request.headers);
  headers.set("origin", origin);
  if (spec.requireCsrf) {
    const csrf = request.headers.get("x-csrf-token");
    if (csrf === null || !SAFE_HEADER.test(csrf)) {
      return problem(403, "BFF_CSRF_REJECTED", requestId, spec.path);
    }
    headers.set("x-csrf-token", csrf);
  }
  if (spec.withEtag) {
    const etag = request.headers.get("if-match");
    if (etag === null || !STRONG_ETAG.test(etag)) {
      return problem(428, "BFF_PRECONDITION_REQUIRED", requestId, spec.path);
    }
    headers.set("if-match", etag);
  }

  let body: Uint8Array | undefined;
  if (spec.withBody) {
    if (!isJson(request.headers.get("content-type"))) {
      return problem(415, "BFF_CONTENT_TYPE_REJECTED", requestId, spec.path);
    }
    if (exceedsDeclaredLength(request.headers.get("content-length"), MAX_BODY_BYTES)) {
      return problem(413, "BFF_BODY_REJECTED", requestId, spec.path);
    }
    body = await readBounded(request.body, MAX_BODY_BYTES, signal);
    if (body === undefined) {
      return problem(signal.aborted ? 408 : 413, "BFF_BODY_REJECTED", requestId, spec.path);
    }
    headers.set("content-type", "application/json");
  }

  let baseUrl: string;
  try {
    baseUrl = validateInternalApiUrl(process.env.NURITEO_INTERNAL_API_URL);
  } catch {
    return problem(503, "BFF_NOT_CONFIGURED", requestId, spec.path);
  }

  try {
    const upstream = await fetch(`${baseUrl}${spec.path}`, {
      ...(body === undefined ? {} : { body: copyBuffer(body) }),
      cache: "no-store",
      credentials: "omit",
      headers,
      method: spec.method,
      redirect: "error",
      signal
    });
    if (exceedsDeclaredLength(upstream.headers.get("content-length"), MAX_RESPONSE_BYTES)) {
      await upstream.body?.cancel().catch(() => undefined);
      return problem(502, "BFF_UPSTREAM_RESPONSE_REJECTED", requestId, spec.path);
    }
    const responseBody = await readBounded(upstream.body, MAX_RESPONSE_BYTES, signal);
    if (responseBody === undefined) {
      return problem(signal.aborted ? 408 : 502, "BFF_UPSTREAM_RESPONSE_REJECTED", requestId, spec.path);
    }
    const responseHeaders = new Headers({ "cache-control": "no-store" });
    for (const name of ["content-type", "etag", "location", "x-request-id"] as const) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    return new Response(hasBody(upstream.status) ? copyBuffer(responseBody) : null, {
      headers: responseHeaders,
      status: upstream.status
    });
  } catch {
    return problem(signal.aborted ? 408 : 502, "BFF_UPSTREAM_UNAVAILABLE", requestId, spec.path);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal
): Promise<Uint8Array | undefined> {
  if (stream === null) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) return undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return undefined;
      if (done) break;
      length += value.byteLength;
      if (length > maximum) return undefined;
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (signal.aborted || length > maximum) cancel();
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

function sameOrigin(request: Request): string | undefined {
  const host = request.headers.get("host");
  const supplied = request.headers.get("origin");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  if (host === null || host.length > 255 || host.includes(",") || !/^(?:http|https)$/u.test(protocol)) {
    return undefined;
  }
  const expected = `${protocol}://${host}`;
  if (supplied === null) return expected;
  if (supplied.length > 512 || supplied.includes(",")) return undefined;
  try {
    return new URL(supplied).origin === supplied && supplied === expected ? supplied : undefined;
  } catch {
    return undefined;
  }
}

function exceedsDeclaredLength(value: string | null, maximum: number): boolean {
  if (value === null) return false;
  return !/^\d+$/u.test(value) || Number(value) > maximum;
}

function isJson(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function requestIdFor(request: Request): string {
  const value = request.headers.get("x-request-id");
  return value !== null && REQUEST_ID.test(value) ? value : `bff-${randomUUID()}`;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function hasBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

function problem(status: number, code: string, requestId: string, instance: string): Response {
  return Response.json({
    type: "about:blank",
    title: "Request could not be completed",
    status,
    detail: "The request could not be completed safely.",
    instance,
    code,
    request_id: requestId,
    errors: []
  }, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/problem+json",
      "x-request-id": requestId
    },
    status
  });
}
