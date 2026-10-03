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
const SAFE_LOCATION = /^\/api\/v1\/organizations\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type StreamFailure = "aborted" | "read_error" | "too_large";
type StreamResult = { bytes: Uint8Array; ok: true } | { ok: false; reason: StreamFailure };

interface RequestDeadline {
  readonly signal: AbortSignal;
  timedOut(): boolean;
}

export interface CollaborationForward {
  readonly method: "DELETE" | "PATCH" | "POST";
  readonly path: `/api/v1/${string}`;
  readonly requireCsrf: boolean;
  readonly withBody: boolean;
  readonly withEtag?: boolean;
}

export function uuidPathSegment(value: string): string | undefined {
  return UUID_V7.test(value) ? value : undefined;
}

export function invalidCollaborationRoute(request: Request): Response {
  cancel(request.body);
  return problem(
    400,
    "BFF_ROUTE_PARAMETER_REJECTED",
    requestIdFor(request),
    "/api/v1/collaboration"
  );
}

export async function forwardCollaborationMutation(
  request: Request,
  spec: CollaborationForward,
  timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
): Promise<Response> {
  const requestId = requestIdFor(request);
  const deadline = requestDeadline(request.signal, timeoutSignal);
  if (request.method !== spec.method) {
    cancel(request.body);
    return problem(405, "BFF_REQUEST_REJECTED", requestId, spec.path);
  }
  if (deadline.signal.aborted) {
    cancel(request.body);
    return abortProblem(deadline, requestId, spec.path);
  }

  const origin = sameOrigin(request);
  if (origin === undefined) {
    cancel(request.body);
    return problem(403, "BFF_ORIGIN_REJECTED", requestId, spec.path);
  }

  const headers = selectForwardedHeaders(request.headers);
  headers.set("origin", origin);
  if (spec.requireCsrf) {
    const csrf = request.headers.get("x-csrf-token");
    if (csrf === null || !SAFE_HEADER.test(csrf)) {
      cancel(request.body);
      return problem(403, "BFF_CSRF_REJECTED", requestId, spec.path);
    }
    headers.set("x-csrf-token", csrf);
  }
  if (spec.withEtag) {
    const etag = request.headers.get("if-match");
    if (etag === null || !STRONG_ETAG.test(etag)) {
      cancel(request.body);
      return problem(428, "BFF_PRECONDITION_REQUIRED", requestId, spec.path);
    }
    headers.set("if-match", etag);
  }

  let body: Uint8Array | undefined;
  if (spec.withBody) {
    if (!isJson(request.headers.get("content-type"))) {
      cancel(request.body);
      return problem(415, "BFF_CONTENT_TYPE_REJECTED", requestId, spec.path);
    }
    const bodyResult = await readBoundedBody(request, MAX_BODY_BYTES, deadline.signal);
    if (!bodyResult.ok) {
      return bodyResult.reason === "too_large"
        ? problem(413, "BFF_BODY_REJECTED", requestId, spec.path)
        : streamFailureProblem(bodyResult.reason, deadline, requestId, spec.path, false);
    }
    body = bodyResult.bytes;
    headers.set("content-type", "application/json");
  } else {
    cancel(request.body);
  }

  let baseUrl: string;
  try {
    baseUrl = validateInternalApiUrl(process.env.NURITEO_INTERNAL_API_URL);
  } catch {
    return problem(503, "BFF_NOT_CONFIGURED", requestId, spec.path);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}${spec.path}`, {
      ...(body === undefined ? {} : { body: copyBuffer(body) }),
      cache: "no-store",
      credentials: "omit",
      headers,
      method: spec.method,
      redirect: "error",
      signal: deadline.signal
    });
  } catch {
    return deadline.signal.aborted
      ? abortProblem(deadline, requestId, spec.path)
      : problem(502, "BFF_UPSTREAM_UNAVAILABLE", requestId, spec.path);
  }

  const responseBody = await readBoundedResponse(upstream, MAX_RESPONSE_BYTES, deadline.signal);
  if (!responseBody.ok) {
    return streamFailureProblem(responseBody.reason, deadline, requestId, spec.path, true);
  }
  const responseHeaders = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "etag", "x-request-id"] as const) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  const location = upstream.headers.get("location");
  if (location !== null && SAFE_LOCATION.test(location)) responseHeaders.set("location", location);
  return new Response(hasBody(upstream.status) ? copyBuffer(responseBody.bytes) : null, {
    headers: responseHeaders,
    status: upstream.status
  });
}

async function readBoundedBody(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<StreamResult> {
  if (exceedsDeclaredLength(request.headers.get("content-length"), maximum)) {
    cancel(request.body);
    return { ok: false, reason: "too_large" };
  }
  return readBoundedStream(request.body, maximum, signal);
}

async function readBoundedResponse(
  response: Response,
  maximum: number,
  signal: AbortSignal
): Promise<StreamResult> {
  if (exceedsDeclaredLength(response.headers.get("content-length"), maximum)) {
    cancel(response.body);
    return { ok: false, reason: "too_large" };
  }
  return readBoundedStream(response.body, maximum, signal);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal
): Promise<StreamResult> {
  if (stream === null) return { bytes: new Uint8Array(), ok: true };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abortRead = () => cancelReader(reader);
  signal.addEventListener("abort", abortRead, { once: true });
  try {
    if (signal.aborted) return { ok: false, reason: "aborted" };
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { ok: false, reason: "aborted" };
      if (done) break;
      length += value.byteLength;
      if (length > maximum) return { ok: false, reason: "too_large" };
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: signal.aborted ? "aborted" : "read_error" };
  } finally {
    signal.removeEventListener("abort", abortRead);
    if (signal.aborted || length > maximum) cancelReader(reader);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: result, ok: true };
}

function sameOrigin(request: Request): string | undefined {
  const host = request.headers.get("host");
  const supplied = request.headers.get("origin");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  if (host === null || host.length > 255 || host.includes(",") || !/^(?:http|https)$/u.test(protocol)) return undefined;
  const expected = `${protocol}://${host}`;
  if (supplied === null) return expected;
  if (supplied.length > 512 || supplied.includes(",")) return undefined;
  try {
    return new URL(supplied).origin === supplied && supplied === expected ? supplied : undefined;
  } catch {
    return undefined;
  }
}

function isJson(value: string | null): boolean {
  return value !== null && !value.includes(",") && value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function exceedsDeclaredLength(value: string | null, maximum: number): boolean {
  return value !== null && (!/^\d+$/u.test(value) || Number(value) > maximum);
}

function requestDeadline(requestSignal: AbortSignal, timeoutSignal: AbortSignal): RequestDeadline {
  const signal = AbortSignal.any([requestSignal, timeoutSignal]);
  return { signal, timedOut: () => timeoutSignal.aborted && signal.reason === timeoutSignal.reason };
}

function abortProblem(deadline: RequestDeadline, requestId: string, path: string): Response {
  return deadline.timedOut()
    ? problem(504, "BFF_DEADLINE_EXCEEDED", requestId, path)
    : problem(408, "BFF_REQUEST_ABORTED", requestId, path);
}

function streamFailureProblem(
  reason: StreamFailure,
  deadline: RequestDeadline,
  requestId: string,
  path: string,
  upstream: boolean
): Response {
  if (reason === "aborted") return abortProblem(deadline, requestId, path);
  return problem(
    upstream ? 502 : 400,
    upstream ? "BFF_UPSTREAM_RESPONSE_REJECTED" : "BFF_BODY_REJECTED",
    requestId,
    path
  );
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

function cancel(stream: ReadableStream<Uint8Array> | null): void {
  void stream?.cancel().catch(() => undefined);
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
