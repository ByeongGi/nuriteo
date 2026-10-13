import "server-only";

import { randomUUID } from "node:crypto";

import { isCanonicalCsrfCredential } from "./csrf-credential.ts";
import { selectForwardedHeaders, validateInternalApiUrl } from "./server-policy.ts";
import { forwardProjectRequest, hasNoProjectQuery, invalidProjectRoute, projectSaveSessionPath } from "./project-bff.ts";

const BUNDLE_CONTENT_TYPE = "application/vnd.nuriteo.project-bundle";
const MAX_RELAY_BODY_BYTES = 64 * 1024 * 1024;
const MAX_RELAY_RESPONSE_BYTES = 64 * 1024;
const RELAY_DEADLINE_MS = 45_000;
const STREAM_CANCEL_WAIT_MS = 250;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CANONICAL_LENGTH = /^(?:[1-9]\d{0,7})$/u;
const CANONICAL_PART = /^(?:[1-9]\d{0,4})$/u;

export interface SaveRouteContext {
  readonly ownerType: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly sessionId?: string;
}

export interface SaveUploadRouteContext extends SaveRouteContext {
  readonly partNumber?: string;
}

export function forwardSaveSessionRequest(
  request: Request,
  context: SaveRouteContext,
  action: "create" | "parts" | "receipts" | "complete" | "reconcile" | "abort"
): Promise<Response> | Response {
  const session = projectSaveSessionPath(
    context.ownerType,
    context.ownerId,
    context.projectId,
    context.sessionId
  );
  if (session === undefined || !hasNoProjectQuery(request)) return invalidProjectRoute(request);
  const suffix = action === "parts" ? "/parts"
    : action === "receipts" ? "/parts/receipts"
      : action === "complete" || action === "reconcile" ? `/${action}` : "";
  const method = action === "abort" ? "DELETE" : "POST";
  if (request.method !== method) return invalidProjectRoute(request);
  return forwardProjectRequest(request, {
    method,
    path: `${session}${suffix}` as `/api/v1/workspaces/${string}`,
    withBody: action === "create" || action === "parts" || action === "receipts" || action === "complete",
    ...(action === "create" ? { maxBodyBytes: 65_536 } : {}),
    withEtag: action === "create",
    withIdempotencyKey: action === "create"
  });
}


/**
 * Streams a same-origin Browser relay upload to Core exactly once. This path
 * intentionally does not share the bounded JSON mutation forwarder because a
 * Project Bundle must never be materialized in the Next.js process.
 */
export async function forwardSaveUploadRequest(
  request: Request,
  context: SaveUploadRouteContext,
  timeoutSignal = AbortSignal.timeout(RELAY_DEADLINE_MS)
): Promise<Response> {
  const path = saveUploadPath(context);
  const requestId = requestIdFor(request);
  if (path === undefined || request.method !== "PUT" || !hasNoProjectQuery(request)) {
    cancel(request.body);
    return problem(400, "BFF_ROUTE_PARAMETER_REJECTED", requestId, "/api/v1/workspaces/projects/save-upload");
  }

  const origin = sameOrigin(request);
  if (origin === undefined) {
    cancel(request.body);
    return problem(403, "BFF_ORIGIN_REJECTED", requestId, path);
  }

  const metadata = relayMetadata(request.headers);
  if (metadata === undefined) {
    cancel(request.body);
    return problem(422, "BFF_UPLOAD_METADATA_REJECTED", requestId, path);
  }
  if (request.body === null) {
    return problem(400, "BFF_BODY_REJECTED", requestId, path);
  }
  if (request.signal.aborted || timeoutSignal.aborted) {
    cancel(request.body);
    return abortProblem(request.signal, timeoutSignal, requestId, path);
  }

  let baseUrl: string;
  try {
    baseUrl = validateInternalApiUrl(process.env.NURITEO_INTERNAL_API_URL);
  } catch {
    cancel(request.body);
    return problem(503, "BFF_NOT_CONFIGURED", requestId, path);
  }

  const headers = selectForwardedHeaders(request.headers);
  headers.set("content-length", metadata.length);
  headers.set("content-type", BUNDLE_CONTENT_TYPE);
  headers.set("origin", origin);
  headers.set("x-csrf-token", metadata.csrf);
  headers.set("x-nuriteo-content-sha256", metadata.checksum);
  const dispatchController = new AbortController();
  const deadline = AbortSignal.any([request.signal, timeoutSignal, dispatchController.signal]);
  const uploadBody = streamRelayBody(request.body, Number(metadata.length), deadline);
  const requestInit: RequestInit & { duplex: "half" } = {
    body: uploadBody.stream,
    cache: "no-store",
    credentials: "omit",
    duplex: "half",
    headers,
    method: "PUT",
    redirect: "error",
    signal: deadline
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}${path}`, requestInit);
  } catch {
    const wasAborted = deadline.aborted;
    const timedOut = timeoutSignal.aborted && deadline.reason === timeoutSignal.reason;
    dispatchController.abort(new DOMException("Relay upload dispatch failed.", "AbortError"));
    await uploadBody.stop(dispatchController.signal.reason);
    if (wasAborted) {
      return timedOut
        ? problem(504, "BFF_DEADLINE_EXCEEDED", requestId, path)
        : abortProblem(request.signal, timeoutSignal, requestId, path);
    }
    return problem(502, "BFF_UPSTREAM_UNAVAILABLE", requestId, path);
  }

  if (upstream.status === 204) {
    cancel(upstream.body);
    if (!await uploadBody.drained) {
      dispatchController.abort(new DOMException("Relay upload body was not fully consumed.", "AbortError"));
      await uploadBody.stop(dispatchController.signal.reason);
      if (request.signal.aborted || timeoutSignal.aborted) {
        return abortProblem(request.signal, timeoutSignal, requestId, path);
      }
      return problem(502, "BFF_UPSTREAM_RESPONSE_REJECTED", requestId, path);
    }
    return new Response(null, {
      headers: {
        "cache-control": "no-store",
        "x-request-id": safeRequestId(upstream.headers.get("x-request-id")) ?? requestId
      },
      status: 204
    });
  }

  const responseDeadline = AbortSignal.any([request.signal, timeoutSignal]);
  const body = await readBoundedResponse(upstream.body, responseDeadline);
  dispatchController.abort(new DOMException("Core rejected the relay upload.", "AbortError"));
  await uploadBody.stop(dispatchController.signal.reason);
  if (body === undefined) {
    if (request.signal.aborted || timeoutSignal.aborted) {
      return abortProblem(request.signal, timeoutSignal, requestId, path);
    }
    return problem(502, "BFF_UPSTREAM_RESPONSE_REJECTED", requestId, path);
  }
  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "x-request-id": safeRequestId(upstream.headers.get("x-request-id")) ?? requestId
  });
  const contentType = upstream.headers.get("content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/problem+json") {
    responseHeaders.set("content-type", contentType);
  }
  return new Response(copyBuffer(body), { headers: responseHeaders, status: upstream.status });
}

interface RelayBodyStream {
  readonly drained: Promise<boolean>;
  readonly stream: ReadableStream<Uint8Array>;
  stop(reason: unknown): Promise<void>;
}

function streamRelayBody(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  signal: AbortSignal
): RelayBodyStream {
  const reader = source.getReader();
  let receivedBytes = 0;
  let settled = false;
  let settleDrained!: (value: boolean) => void;
  const drained = new Promise<boolean>((resolve) => { settleDrained = resolve; });
  const settle = (value: boolean) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", abort);
    settleDrained(value);
  };
  const cancelReader = (reason: unknown) => reader.cancel(reason).catch(() => undefined);
  const abort = () => {
    void cancelReader(signal.reason).finally(() => settle(false));
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          const exact = receivedBytes === expectedBytes;
          settle(exact);
          if (exact) controller.close();
          else controller.error(new Error("Relay upload body length mismatch."));
          return;
        }
        receivedBytes += result.value.byteLength;
        if (receivedBytes > expectedBytes) {
          await cancelReader(new Error("Relay upload body exceeded its declared length."));
          settle(false);
          controller.error(new Error("Relay upload body exceeded its declared length."));
          return;
        }
        controller.enqueue(result.value);
      } catch {
        settle(false);
        controller.error(new Error("Relay upload body stream failed."));
      }
    },
    async cancel(reason) {
      await cancelReader(reason);
      settle(false);
    }
  });

  return {
    drained,
    stream,
    async stop(reason) {
      if (!settled) {
        await Promise.race([
          cancelReader(reason),
          new Promise<void>((resolve) => setTimeout(resolve, STREAM_CANCEL_WAIT_MS))
        ]);
        settle(false);
      }
    }
  };
}

function saveUploadPath(context: SaveUploadRouteContext): `/api/v1/workspaces/${string}` | undefined {
  const session = projectSaveSessionPath(
    context.ownerType,
    context.ownerId,
    context.projectId,
    context.sessionId
  );
  if (session === undefined || context.sessionId === undefined) return undefined;
  if (context.partNumber === undefined) return `${session}/upload`;
  if (!CANONICAL_PART.test(context.partNumber)) return undefined;
  const partNumber = Number(context.partNumber);
  if (partNumber > 65_535) return undefined;
  return `${session}/upload/parts/${partNumber}`;
}

function relayMetadata(headers: Headers): { checksum: string; csrf: string; length: string } | undefined {
  if (
    headers.get("content-type") !== BUNDLE_CONTENT_TYPE ||
    headers.has("content-encoding") ||
    headers.has("transfer-encoding")
  ) return undefined;
  const length = headers.get("content-length");
  const checksum = headers.get("x-nuriteo-content-sha256");
  const csrf = headers.get("x-csrf-token");
  if (
    length === null || !CANONICAL_LENGTH.test(length) || Number(length) > MAX_RELAY_BODY_BYTES ||
    checksum === null || !isCanonicalSha256(checksum) ||
    !isCanonicalCsrfCredential(csrf)
  ) return undefined;
  return { checksum, csrf, length };
}

function isCanonicalSha256(value: string): boolean {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === 32 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function sameOrigin(request: Request): string | undefined {
  const host = request.headers.get("host");
  const supplied = request.headers.get("origin");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  if (
    host === null || host.length > 255 || host.includes(",") ||
    supplied === null || supplied.length > 512 || supplied.includes(",") ||
    !/^(?:http|https)$/u.test(protocol)
  ) return undefined;
  const expected = `${protocol}://${host}`;
  try {
    return new URL(supplied).origin === supplied && supplied === expected ? supplied : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedResponse(
  stream: ReadableStream<Uint8Array> | null,
  signal: AbortSignal
): Promise<Uint8Array | undefined> {
  if (stream === null) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RELAY_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(result.value);
    }
    if (signal.aborted) return undefined;
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requestIdFor(request: Request): string {
  const value = request.headers.get("x-request-id");
  return value !== null && REQUEST_ID.test(value) ? value : `bff-${randomUUID()}`;
}

function safeRequestId(value: string | null): string | undefined {
  return value !== null && REQUEST_ID.test(value) ? value : undefined;
}

function abortProblem(
  requestSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  requestId: string,
  path: string
): Response {
  return timeoutSignal.aborted && !requestSignal.aborted
    ? problem(504, "BFF_DEADLINE_EXCEEDED", requestId, path)
    : problem(408, "BFF_REQUEST_ABORTED", requestId, path);
}

function cancel(stream: ReadableStream<Uint8Array> | null): void {
  void stream?.cancel().catch(() => undefined);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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
