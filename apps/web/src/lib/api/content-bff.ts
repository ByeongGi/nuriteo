import "server-only";

import { randomUUID } from "node:crypto";

import { selectForwardedHeaders, validateInternalApiUrl } from "./server-policy.ts";

const MAX_RESUME_PHYSICAL_BYTES = 16 * 1024 * 1024;
const RESPONSE_HEADER_TIMEOUT_MS = 15_000;
const CONTENT_ETAG = /^"content-v[1-9]\d*-[A-Za-z0-9_-]{43}"$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export async function forwardProjectContentDownload(
  request: Request,
  path: `/api/v1/workspaces/${string}`,
  headerTimeout: AbortSignal = AbortSignal.timeout(RESPONSE_HEADER_TIMEOUT_MS)
): Promise<Response> {
  const requestId = requestIdFor(request);
  const etag = request.headers.get("if-match");
  const origin = sameOrigin(request);
  if (request.method !== "GET" || etag === null || !CONTENT_ETAG.test(etag)) {
    cancel(request.body);
    return problem(428, "BFF_PRECONDITION_REQUIRED", requestId, path);
  }
  if (origin === undefined) {
    cancel(request.body);
    return problem(403, "BFF_ORIGIN_REJECTED", requestId, path);
  }
  cancel(request.body);

  let baseUrl: string;
  try {
    baseUrl = validateInternalApiUrl(process.env.NURITEO_INTERNAL_API_URL);
  } catch {
    return problem(503, "BFF_NOT_CONFIGURED", requestId, path);
  }

  const headers = selectForwardedHeaders(request.headers);
  headers.set("accept", "application/octet-stream");
  headers.set("if-match", etag);
  headers.set("origin", origin);
  const headerController = new AbortController();
  let deadlineExpired = false;
  const abortForDeadline = () => {
    deadlineExpired = true;
    headerController.abort(headerTimeout.reason);
  };
  const abortForRequest = () => headerController.abort(request.signal.reason);
  headerTimeout.addEventListener("abort", abortForDeadline, { once: true });
  request.signal.addEventListener("abort", abortForRequest, { once: true });
  if (headerTimeout.aborted) abortForDeadline();
  else if (request.signal.aborted) abortForRequest();
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}${path}`, {
      cache: "no-store",
      credentials: "omit",
      headers,
      method: "GET",
      redirect: "error",
      signal: headerController.signal
    });
  } catch {
    const aborted = deadlineExpired || request.signal.aborted;
    return problem(aborted ? 504 : 502, aborted ? "BFF_DEADLINE_EXCEEDED" : "BFF_UPSTREAM_UNAVAILABLE", requestId, path);
  } finally {
    headerTimeout.removeEventListener("abort", abortForDeadline);
    request.signal.removeEventListener("abort", abortForRequest);
  }
  if (!upstream.ok) {
    cancel(upstream.body);
    return problem(upstream.status, "PROJECT_CONTENT_UNAVAILABLE", requestId, path);
  }

  const declaredLength = decimalHeader(upstream.headers.get("content-length"));
  const upstreamEtag = upstream.headers.get("etag");
  if (
    declaredLength === undefined
    || declaredLength < 1
    || declaredLength > MAX_RESUME_PHYSICAL_BYTES
    || upstreamEtag !== etag
    || mediaType(upstream.headers.get("content-type")) !== "application/octet-stream"
    || upstream.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff"
    || upstream.body === null
  ) {
    cancel(upstream.body);
    return problem(502, "BFF_UPSTREAM_RESPONSE_REJECTED", requestId, path);
  }

  const body = boundedStream(upstream.body, declaredLength, request.signal);
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": "attachment; filename=\"nuriteo-project-bundle.tar\"",
      "content-length": String(declaredLength),
      "content-type": "application/octet-stream",
      etag: upstreamEtag,
      "x-content-type-options": "nosniff",
      "x-request-id": safeRequestId(upstream.headers.get("x-request-id")) ?? requestId
    },
    status: 200
  });
}

function boundedStream(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  requestSignal: AbortSignal
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let received = 0;
  let closed = false;
  const release = () => {
    requestSignal.removeEventListener("abort", abortForRequest);
    reader.releaseLock();
  };
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abortForRequest = () => {
    if (closed) return;
    closed = true;
    void reader.cancel(requestSignal.reason).finally(release);
    streamController?.error(new DOMException("The request was aborted.", "AbortError"));
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      requestSignal.addEventListener("abort", abortForRequest, { once: true });
      if (requestSignal.aborted) abortForRequest();
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (closed) return;
        if (result.done) {
          closed = true;
          release();
          if (received !== expectedBytes) {
            controller.error(new Error("Upstream Project content length mismatch."));
          } else {
            controller.close();
          }
          return;
        }
        received += result.value.byteLength;
        if (received > expectedBytes) {
          await reader.cancel();
          closed = true;
          release();
          controller.error(new Error("Upstream Project content exceeded its declared length."));
          return;
        }
        controller.enqueue(result.value);
      } catch {
        if (closed) return;
        closed = true;
        release();
        controller.error(new Error("Upstream Project content stream failed."));
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      await reader.cancel(reason).catch(() => undefined);
      release();
    }
  });
}

function sameOrigin(request: Request): string | undefined {
  const host = request.headers.get("host");
  const supplied = request.headers.get("origin");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  if (host === null || host.length > 255 || host.includes(",") || !/^(?:http|https)$/u.test(protocol)) return undefined;
  const expected = `${protocol}://${host}`;
  if (supplied === null) return expected;
  if (supplied.length > 512 || supplied.includes(",")) return undefined;
  try { return new URL(supplied).origin === supplied && supplied === expected ? supplied : undefined; } catch { return undefined; }
}

function problem(status: number, code: string, requestId: string, instance: string): Response {
  return Response.json({
    type: "about:blank",
    title: "Request rejected",
    status,
    detail: "The request could not be completed.",
    instance,
    code,
    request_id: requestId,
    errors: []
  }, {
    headers: { "cache-control": "no-store", "content-type": "application/problem+json" },
    status
  });
}

function requestIdFor(request: Request): string {
  return safeRequestId(request.headers.get("x-request-id")) ?? randomUUID();
}

function safeRequestId(value: string | null): string | undefined {
  return value !== null && REQUEST_ID.test(value) ? value : undefined;
}

function decimalHeader(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function mediaType(value: string | null): string | undefined {
  return value === null || value.includes(",") ? undefined : value.split(";", 1)[0]?.trim().toLowerCase();
}

function cancel(stream: ReadableStream<Uint8Array> | null): void { void stream?.cancel().catch(() => undefined); }
