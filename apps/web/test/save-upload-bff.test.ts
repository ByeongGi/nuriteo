import assert from "node:assert/strict";
import http from "node:http";

import { forwardSaveUploadRequest } from "../src/lib/api/save-bff.ts";

const OWNER_ID = "0199ee6c-c777-7000-8000-000000009001";
const PROJECT_ID = "0199ee6c-c777-7000-8000-000000009002";
const SESSION_ID = "0199ee6c-c777-7000-8000-000000009003";
const PATH = `/api/v1/workspaces/users/${OWNER_ID}/projects/${PROJECT_ID}/save-sessions/${SESSION_ID}/upload`;
const ORIGIN = "https://nuriteo.test";
const CHECKSUM = Buffer.alloc(32).toString("base64");
const CSRF = `nrt_csrf_${"s".repeat(43)}`;
const CONTEXT = { ownerType: "users", ownerId: OWNER_ID, projectId: PROJECT_ID, sessionId: SESSION_ID };
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  await streamsWithoutBufferingOrAmbientHeaders();
  await forwardsACanonicalMultipartPart();
  await filtersInvalidCorrelationHeaders();
  await rejectsBeforeReadingTheBody();
  await rejectsLengthViolations();
  await cancelsAnEarlyRejectedUpload();
  await preservesAnActualEarlyHttpProblem();
  await classifiesAnUpstreamConnectionFailure();
  await classifiesAbortAndTimeoutWithoutRetry();
  await boundsAnOversizedCoreError();
  await boundsAFalseSuccessWithoutBodyDrain();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function filtersInvalidCorrelationHeaders(): Promise<void> {
  let forwarded = new Headers();
  globalThis.fetch = async (_input, init) => {
    forwarded = new Headers(init?.headers);
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.read();
    return new Response(null, { status: 204 });
  };
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(1)); controller.close(); } });
  const response = await forwardSaveUploadRequest(uploadRequest(body, "1", {
    traceparent: "00-invalid",
    "x-request-id": "invalid request id"
  }), CONTEXT);
  assert.equal(response.status, 204);
  assert.equal(forwarded.get("traceparent"), null);
  assert.equal(forwarded.get("x-request-id"), null);
}

async function forwardsACanonicalMultipartPart(): Promise<void> {
  const partPath = `${PATH}/parts/7`;
  let receivedPath = "";
  globalThis.fetch = async (input, init) => {
    receivedPath = String(input);
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    assert.deepEqual([...((await reader.read()).value ?? [])], [7]);
    assert.equal((await reader.read()).done, true);
    return new Response(null, { status: 204 });
  };
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(7)); controller.close(); } });
  const response = await forwardSaveUploadRequest(
    uploadRequest(body, "1", {}, partPath),
    { ...CONTEXT, partNumber: "7" }
  );
  assert.equal(response.status, 204);
  assert.equal(receivedPath, `http://core.internal:8080${partPath}`);
}

async function streamsWithoutBufferingOrAmbientHeaders(): Promise<void> {
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) { sourceController = controller; }
  });
  sourceController.enqueue(Uint8Array.of(1));
  let firstChunk!: () => void;
  const receivedFirstChunk = new Promise<void>((resolve) => { firstChunk = resolve; });
  let forwardedInit: (RequestInit & { duplex?: string }) | undefined;
  globalThis.fetch = async (_input, init) => {
    forwardedInit = init;
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    assert.deepEqual([...first.value ?? []], [1]);
    firstChunk();
    const second = await reader.read();
    assert.deepEqual([...second.value ?? []], [2, 3]);
    assert.equal((await reader.read()).done, true);
    return new Response(null, { status: 204, headers: { "x-request-id": "core-upload" } });
  };

  const responsePromise = forwardSaveUploadRequest(uploadRequest(source, "3", {
    authorization: "Bearer must-not-forward",
    expect: "100-continue",
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    "x-request-id": "browser-upload",
    "x-not-forwarded": "private"
  }), CONTEXT);
  await receivedFirstChunk;
  assert.equal(forwardedInit?.duplex, "half");
  const headers = new Headers(forwardedInit?.headers);
  assert.equal(headers.get("content-length"), "3");
  assert.equal(headers.get("content-type"), "application/vnd.nuriteo.project-bundle");
  assert.equal(headers.get("origin"), ORIGIN);
  assert.equal(headers.get("x-csrf-token"), CSRF);
  assert.equal(headers.get("x-nuriteo-content-sha256"), CHECKSUM);
  assert.equal(headers.get("cookie"), "nuriteo_dev_session=opaque");
  assert.equal(headers.get("traceparent"), "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
  assert.equal(headers.get("x-request-id"), "browser-upload");
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("expect"), null);
  assert.equal(headers.get("connection"), null);
  assert.equal(headers.get("transfer-encoding"), null);
  assert.equal(headers.get("x-not-forwarded"), null);
  sourceController.enqueue(Uint8Array.of(2, 3));
  sourceController.close();
  const response = await responsePromise;
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("x-request-id"), "core-upload");
}

async function rejectsBeforeReadingTheBody(): Promise<void> {
  let reads = 0;
  let dispatched = false;
  globalThis.fetch = async () => {
    dispatched = true;
    return new Response(null, { status: 204 });
  };
  const unread = () => new ReadableStream<Uint8Array>(
    { pull() { reads += 1; } },
    { highWaterMark: 0 }
  );
  const cases = [
    uploadRequest(unread(), "03"),
    uploadRequest(unread(), "3", { origin: "https://attacker.test" }),
    uploadRequest(unread(), "3", { "x-csrf-token": "" }),
    uploadRequest(unread(), "3", { "x-csrf-token": "csrf-safe" }),
    uploadRequest(unread(), "3", { "content-type": "application/octet-stream" }),
    uploadRequest(unread(), "3", { "x-nuriteo-content-sha256": "not-base64" }),
    uploadRequest(unread(), "3", { "content-encoding": "gzip" }),
    uploadRequest(unread(), "3", { "transfer-encoding": "chunked" }),
    uploadRequest(unread(), "3", {}, `${PATH}?unexpected=true`)
  ];
  for (const request of cases) assert.ok((await forwardSaveUploadRequest(request, CONTEXT)).status >= 400);
  assert.equal(dispatched, false);
  assert.equal(reads, 0);

  const invalidPart = await forwardSaveUploadRequest(
    uploadRequest(unread(), "3", {}, `${PATH}/parts/01`),
    { ...CONTEXT, partNumber: "01" }
  );
  assert.equal(invalidPart.status, 400);
  assert.equal(reads, 0);

  const wrongMethod = new Request(`${ORIGIN}${PATH}`, {
    body: unread(),
    duplex: "half",
    headers: uploadHeaders("3"),
    method: "POST"
  } as RequestInit & { duplex: "half" });
  assert.equal((await forwardSaveUploadRequest(wrongMethod, CONTEXT)).status, 400);
  const noBody = new Request(`${ORIGIN}${PATH}`, { headers: uploadHeaders("3"), method: "PUT" });
  assert.equal((await forwardSaveUploadRequest(noBody, CONTEXT)).status, 400);
  assert.equal(dispatched, false);
}

async function rejectsLengthViolations(): Promise<void> {
  let dispatched = 0;
  globalThis.fetch = async (_input, init) => {
    dispatched += 1;
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    while (!(await reader.read()).done) { /* drain without buffering */ }
    return new Response(null, { status: 204 });
  };
  const short = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(1, 2)); controller.close(); } });
  const long = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3, 4)); controller.close(); } });
  assert.equal((await forwardSaveUploadRequest(uploadRequest(short, "3"), CONTEXT)).status, 502);
  assert.equal((await forwardSaveUploadRequest(uploadRequest(long, "3"), CONTEXT)).status, 502);
  assert.equal(dispatched, 2);

  let reads = 0;
  const oversized = new ReadableStream<Uint8Array>({ pull() { reads += 1; } }, { highWaterMark: 0 });
  assert.equal((await forwardSaveUploadRequest(uploadRequest(oversized, String(64 * 1024 * 1024 + 1)), CONTEXT)).status, 422);
  assert.equal(reads, 0);
  assert.equal(dispatched, 2);
}

async function cancelsAnEarlyRejectedUpload(): Promise<void> {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(Uint8Array.of(1)); },
    cancel() { cancelled = true; }
  });
  globalThis.fetch = async (_input, init) => {
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    return Response.json({ code: "REJECTED" }, {
      status: 403,
      headers: { "content-type": "application/problem+json" }
    });
  };
  const response = await forwardSaveUploadRequest(uploadRequest(source, "3"), CONTEXT);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { code: "REJECTED" });
  assert.equal(cancelled, true);
}

async function preservesAnActualEarlyHttpProblem(): Promise<void> {
  const problemBody = JSON.stringify({ code: "ACTUAL_EARLY_REJECTION" });
  const server = http.createServer((request, response) => {
    request.once("data", () => {
      response.writeHead(403, {
        "content-length": String(Buffer.byteLength(problemBody)),
        "content-type": "application/problem+json"
      });
      response.end(problemBody);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.NURITEO_INTERNAL_API_URL = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = originalFetch;
  let cancelled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancelled = true; }
  });
  controller.enqueue(Uint8Array.of(1));
  try {
    const response = await forwardSaveUploadRequest(uploadRequest(source, "3"), CONTEXT);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: "ACTUAL_EARLY_REJECTION" });
    assert.equal(cancelled, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  }
}

async function classifiesAnUpstreamConnectionFailure(): Promise<void> {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  globalThis.fetch = async () => { throw new TypeError("connection refused"); };
  const response = await forwardSaveUploadRequest(uploadRequest(source, "3"), CONTEXT);
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { code: string }).code, "BFF_UPSTREAM_UNAVAILABLE");
  assert.equal(cancelled, true);
}

async function classifiesAbortAndTimeoutWithoutRetry(): Promise<void> {
  let dispatches = 0;
  globalThis.fetch = async (_input, init) => {
    dispatches += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const preAborted = await forwardSaveUploadRequest(
    uploadRequest(new ReadableStream(), "3", {}, PATH, alreadyAborted.signal),
    CONTEXT
  );
  assert.equal(preAborted.status, 408);
  assert.equal(dispatches, 0);

  const client = new AbortController();
  const clientResponse = forwardSaveUploadRequest(
    uploadRequest(new ReadableStream(), "3", {}, PATH, client.signal),
    CONTEXT
  );
  client.abort();
  assert.equal((await clientResponse).status, 408);

  const timeout = new AbortController();
  const timeoutResponse = forwardSaveUploadRequest(uploadRequest(new ReadableStream(), "3"), CONTEXT, timeout.signal);
  timeout.abort();
  assert.equal((await timeoutResponse).status, 504);
  assert.equal(dispatches, 2, "aborted uploads are never retried");
}

async function boundsAnOversizedCoreError(): Promise<void> {
  globalThis.fetch = async () => new Response(new Uint8Array(64 * 1024 + 1), {
    status: 503,
    headers: { "content-type": "application/problem+json" }
  });
  const source = new ReadableStream<Uint8Array>();
  const response = await forwardSaveUploadRequest(uploadRequest(source, "3"), CONTEXT);
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { code: string }).code, "BFF_UPSTREAM_RESPONSE_REJECTED");
}

async function boundsAFalseSuccessWithoutBodyDrain(): Promise<void> {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const deadline = new AbortController();
  const responsePromise = forwardSaveUploadRequest(uploadRequest(source, "3"), CONTEXT, deadline.signal);
  deadline.abort(new DOMException("fixture deadline", "TimeoutError"));
  const response = await responsePromise;
  assert.equal(response.status, 504);
  assert.equal(cancelled, true);
}

function uploadRequest(
  body: ReadableStream<Uint8Array>,
  contentLength: string,
  overrides: Record<string, string> = {},
  path = PATH,
  signal?: AbortSignal
): Request {
  const headers = uploadHeaders(contentLength, overrides);
  return new Request(`${ORIGIN}${path}`, {
    body,
    duplex: "half",
    headers,
    method: "PUT",
    ...(signal === undefined ? {} : { signal })
  } as RequestInit & { duplex: "half" });
}

function uploadHeaders(contentLength: string, overrides: Record<string, string> = {}): Headers {
  return new Headers({
    cookie: "nuriteo_dev_session=opaque",
    "content-length": contentLength,
    "content-type": "application/vnd.nuriteo.project-bundle",
    host: "nuriteo.test",
    origin: ORIGIN,
    "x-csrf-token": CSRF,
    "x-nuriteo-content-sha256": CHECKSUM,
    ...overrides
  });
}
