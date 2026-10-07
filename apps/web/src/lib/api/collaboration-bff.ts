import "server-only";

import { randomUUID } from "node:crypto";

import { selectForwardedHeaders, validateInternalApiUrl } from "./server-policy.ts";

const MAX_BODY_BYTES = 16_384;
const MAX_ALLOWED_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 15_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_HEADER = /^[\x20-\x7e]{1,512}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{16,128}$/u;
const STRONG_ETAG = /^"org-v[1-9]\d*"$/u;
const PROJECT_ETAG = /^"project-v([1-9]\d*)"$/u;
const SETTING_ETAG = /^"setting-v([1-9]\d*)"$/u;
const MAX_PROJECT_VERSION = 9_223_372_036_854_775_806n;
const SAFE_LOCATION = /^\/api\/v1\/organizations\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ORGANIZATION_INVITATION_EMAIL_MAX_CHARACTERS = 320;

type StreamFailure = "aborted" | "read_error" | "too_large";
type StreamResult = { bytes: Uint8Array; ok: true } | { ok: false; reason: StreamFailure };

interface RequestDeadline {
  readonly signal: AbortSignal;
  timedOut(): boolean;
}

export interface CollaborationForward {
  readonly commitOutcomeUnknown?: boolean;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly maxBodyBytes?: number;
  readonly path: `/api/v1/${string}`;
  readonly requireCsrf: boolean;
  readonly withBody: boolean;
  readonly withEtag?: boolean;
  readonly withIdempotencyKey?: boolean;
  readonly etagKind?: "organization" | "project" | "setting";
  readonly jsonBodyPolicy?: "organization-invitation-issue";
  readonly safeLocation?: (value: string) => boolean;
}

export function uuidPathSegment(value: string): string | undefined {
  return UUID_V7.test(value) ? value : undefined;
}

export function invalidCollaborationRoute(
  request: Request,
  instance = "/api/v1/collaboration"
): Response {
  cancel(request.body);
  return problem(
    400,
    "BFF_ROUTE_PARAMETER_REJECTED",
    requestIdFor(request),
    instance
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
  if (origin === undefined || (origin === null && spec.method !== "GET")) {
    cancel(request.body);
    return problem(403, "BFF_ORIGIN_REJECTED", requestId, spec.path);
  }

  const headers = selectForwardedHeaders(request.headers);
  if (origin !== null) headers.set("origin", origin);
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
    const validEtag = spec.etagKind === "project"
      ? isProjectEtag(etag)
      : spec.etagKind === "setting"
        ? isSettingEtag(etag)
        : etag !== null && STRONG_ETAG.test(etag);
    if (!validEtag || etag === null) {
      cancel(request.body);
      return problem(428, "BFF_PRECONDITION_REQUIRED", requestId, spec.path);
    }
    headers.set("if-match", etag);
  }
  if (spec.withIdempotencyKey) {
    const key = request.headers.get("idempotency-key");
    if (key === null || !IDEMPOTENCY_KEY.test(key)) {
      cancel(request.body);
      return problem(428, "BFF_IDEMPOTENCY_KEY_REQUIRED", requestId, spec.path);
    }
    headers.set("idempotency-key", key);
  }

  let body: Uint8Array | undefined;
  if (spec.withBody) {
    if (!isJson(request.headers.get("content-type"))) {
      cancel(request.body);
      return problem(415, "BFF_CONTENT_TYPE_REJECTED", requestId, spec.path);
    }
    const bodyMaximum = spec.maxBodyBytes ?? MAX_BODY_BYTES;
    if (!Number.isSafeInteger(bodyMaximum) || bodyMaximum < 1 || bodyMaximum > MAX_ALLOWED_BODY_BYTES) {
      cancel(request.body);
      return problem(500, "BFF_POLICY_INVALID", requestId, spec.path);
    }
    const bodyResult = await readBoundedBody(request, bodyMaximum, deadline.signal);
    if (!bodyResult.ok) {
      return bodyResult.reason === "too_large"
        ? problem(413, "BFF_BODY_REJECTED", requestId, spec.path)
        : streamFailureProblem(bodyResult.reason, deadline, requestId, spec.path, false);
    }
    body = bodyResult.bytes;
    if (spec.jsonBodyPolicy === "organization-invitation-issue") {
      const projected = projectOrganizationInvitationIssueBody(body);
      if (projected === undefined) {
        return problem(400, "BFF_BODY_REJECTED", requestId, spec.path);
      }
      body = projected;
    }
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
    if (spec.commitOutcomeUnknown) {
      return commitOutcomeUnknownProblem(requestId, spec.path);
    }
    return deadline.signal.aborted
      ? abortProblem(deadline, requestId, spec.path)
      : problem(502, "BFF_UPSTREAM_UNAVAILABLE", requestId, spec.path);
  }

  const responseBody = await readBoundedResponse(upstream, MAX_RESPONSE_BYTES, deadline.signal);
  if (!responseBody.ok) {
    if (spec.commitOutcomeUnknown) {
      return commitOutcomeUnknownProblem(requestId, spec.path);
    }
    return streamFailureProblem(responseBody.reason, deadline, requestId, spec.path, true);
  }
  const responseHeaders = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "etag", "x-request-id"] as const) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  const location = upstream.headers.get("location");
  const locationIsSafe = location !== null && (
    spec.safeLocation?.(location) ?? SAFE_LOCATION.test(location)
  );
  if (locationIsSafe) responseHeaders.set("location", location);
  return new Response(hasBody(upstream.status) ? copyBuffer(responseBody.bytes) : null, {
    headers: responseHeaders,
    status: upstream.status
  });
}

function projectOrganizationInvitationIssueBody(bytes: Uint8Array): Uint8Array | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (keys.length !== 2 || keys[0] !== "email" || keys[1] !== "role") return undefined;
  if (typeof record.email !== "string" || !validInvitationEmail(record.email)) return undefined;
  if (record.role !== "member" && record.role !== "owner") return undefined;

  return new TextEncoder().encode(JSON.stringify({ email: record.email, role: record.role }));
}

function validInvitationEmail(value: string): boolean {
  if (value.startsWith(" ") || value.endsWith(" ")) return false;
  let characters = 0;
  for (const character of value) {
    characters += 1;
    const codePoint = character.codePointAt(0);
    if (
      characters > ORGANIZATION_INVITATION_EMAIL_MAX_CHARACTERS ||
      /\p{Cc}/u.test(character) ||
      (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return false;
    }
  }
  return characters >= 3;
}

function commitOutcomeUnknownProblem(requestId: string, path: string): Response {
  return problem(503, "COMMIT_OUTCOME_UNKNOWN", requestId, path);
}

function isProjectEtag(value: string | null): value is string {
  if (value === null || value.length > 32) return false;
  const match = value.match(PROJECT_ETAG);
  if (match === null) return false;
  const version = BigInt(match[1] as string);
  return version <= MAX_PROJECT_VERSION && value === `"project-v${version}"`;
}

function isSettingEtag(value: string | null): value is string {
  if (value === null || value.length > 32) return false;
  const match = value.match(SETTING_ETAG);
  if (match === null) return false;
  const version = BigInt(match[1] as string);
  return version <= MAX_PROJECT_VERSION && value === `"setting-v${version}"`;
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

function sameOrigin(request: Request): string | null | undefined {
  const host = request.headers.get("host");
  const supplied = request.headers.get("origin");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  if (host === null || host.length > 255 || host.includes(",") || !/^(?:http|https)$/u.test(protocol)) return undefined;
  const expected = `${protocol}://${host}`;
  if (supplied === null) return null;
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
