import assert from "node:assert/strict";

import {
  ApiAbortError,
  ApiClientError,
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  ApiResponseTooLargeError,
  ApiTimeoutError,
  ApiTransportError,
  createApiClient,
  getVersion
} from "../src/index.ts";
import type { ProblemDetails } from "../src/index.ts";

await testUrlHeadersJsonBodyAndRequestId();
await testResponseParsing();
await testProblemDetailsAndSafeErrors();
await testBoundedResponseBodies();
await testTimeoutAndExternalAbort();
await testTimerAndListenerCleanup();
await testConfigurationBoundaries();
await testVersionContract();

async function testUrlHeadersJsonBodyAndRequestId(): Promise<void> {
  let receivedUrl: string | undefined;
  let receivedInit: RequestInit | undefined;
  const client = createApiClient({
    baseUrl: "https://api.example.test/nuriteo/",
    credentials: "include",
    defaultHeaders: { authorization: "Bearer test-credential", "x-default": "default" },
    fetch: async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return Response.json(
        { id: "project-1" },
        { status: 201, headers: { "x-request-id": "request-123" } }
      );
    }
  });

  const result = await client.post<{ id: string }, { name: string }>(
    "/projects?ownerType=user",
    { name: "Example" },
    { headers: { "x-default": "request", "x-extra": "value" } }
  );

  assert.equal(receivedUrl, "https://api.example.test/nuriteo/api/v1/projects?ownerType=user");
  assert.equal(receivedInit?.method, "POST");
  assert.equal(receivedInit?.credentials, "include");
  assert.equal(receivedInit?.body, JSON.stringify({ name: "Example" }));
  const headers = new Headers(receivedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-credential");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-default"), "request");
  assert.equal(headers.get("x-extra"), "value");
  assert.deepEqual(result.data, { id: "project-1" });
  assert.equal(result.status, 201);
  assert.equal(result.requestId, "request-123");
}

async function testResponseParsing(): Promise<void> {
  const noContent = createApiClient({
    fetch: async () => new Response(null, { status: 204 })
  });
  assert.equal((await noContent.delete<void>("/session")).data, undefined);

  const text = createApiClient({
    fetch: async () => new Response("ready", { headers: { "content-type": "text/plain" } })
  });
  assert.equal((await text.get<string>("/health")).data, "ready");

  const invalidJson = createApiClient({
    fetch: async () => new Response("not-json", { headers: { "content-type": "application/json" } })
  });
  await assert.rejects(
    invalidJson.get("/version"),
    (error) => error instanceof ApiInvalidResponseError && error.status === 200
  );
}

async function testProblemDetailsAndSafeErrors(): Promise<void> {
  const problem: ProblemDetails = {
    type: "/docs/problems/validation-failed",
    title: "Validation failed",
    status: 422,
    detail: "One or more fields are invalid.",
    instance: "/api/v1/projects",
    code: "VALIDATION_FAILED",
    request_id: "problem-request-id",
    errors: [{ path: "name", code: "INVALID", detail: "The field is invalid." }]
  };
  const client = createApiClient({
    defaultHeaders: { cookie: "session=do-not-leak" },
    fetch: async () =>
      Response.json(problem, {
        status: 422,
        headers: {
          "content-type": "application/problem+json",
          "x-request-id": "header-request-id"
        }
      })
  });

  const error = await captureError(
    client.post("/projects", { credential: "payload-do-not-leak" })
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 422);
  assert.equal(error.code, "VALIDATION_FAILED");
  assert.equal(error.requestId, "header-request-id");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.fieldErrors, problem.errors);
  assert.doesNotMatch(String(error), /session|do-not-leak|credential|payload/u);
  assert.doesNotMatch(JSON.stringify(error), /session|do-not-leak|credential|payload/u);

  const textErrorClient = createApiClient({
    fetch: async () =>
      new Response("database password is do-not-log", {
        status: 503,
        headers: { "content-type": "text/plain", "x-request-id": "text-error-id" }
      })
  });
  const textError = await captureError(textErrorClient.get("/projects"));
  assert.ok(textError instanceof ApiError);
  assert.equal(textError.code, "HTTP_ERROR");
  assert.equal(textError.requestId, "text-error-id");
  assert.equal(textError.retryable, true);
  assert.doesNotMatch(String(textError), /database|password|do-not-log/u);

  const transportClient = createApiClient({
    fetch: async () => {
      throw new Error("Bearer transport-secret");
    }
  });
  const transportError = await captureError(transportClient.get("/projects"));
  assert.ok(transportError instanceof ApiTransportError);
  assert.doesNotMatch(String(transportError), /Bearer|transport-secret/u);
}

async function testTimeoutAndExternalAbort(): Promise<void> {
  const pendingFetch: typeof globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
        once: true
      });
    });

  const timeoutClient = createApiClient({ fetch: pendingFetch, timeoutMs: 5 });
  const timeoutError = await captureError(timeoutClient.get("/projects"));
  assert.ok(timeoutError instanceof ApiTimeoutError);
  assert.equal(timeoutError.timeoutMs, 5);

  const controller = new AbortController();
  const externalClient = createApiClient({ fetch: pendingFetch, timeoutMs: 1_000 });
  const request = externalClient.get("/projects", { signal: controller.signal });
  controller.abort("credential-like abort reason");
  const abortError = await captureError(request);
  assert.ok(abortError instanceof ApiAbortError);
  assert.doesNotMatch(String(abortError), /credential-like|reason/u);
}

async function testBoundedResponseBodies(): Promise<void> {
  let contentLengthBodyCancelled = false;
  const declaredOversizedBody = new ReadableStream<Uint8Array>({
    cancel() {
      contentLengthBodyCancelled = true;
    }
  });
  const declaredOversizedClient = createApiClient({
    maxResponseBytes: 4,
    fetch: async () =>
      new Response(declaredOversizedBody, {
        headers: { "content-length": "5", "x-request-id": "declared-large" }
      })
  });
  const declaredError = await captureError(declaredOversizedClient.get("/projects"));
  assert.ok(declaredError instanceof ApiResponseTooLargeError);
  assert.equal(declaredError.maxResponseBytes, 4);
  assert.equal(declaredError.requestId, "declared-large");
  assert.equal(contentLengthBodyCancelled, true);

  let streamedBodyCancelled = false;
  const streamedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
    },
    cancel() {
      streamedBodyCancelled = true;
    }
  });
  const streamedClient = createApiClient({
    fetch: async () => new Response(streamedBody)
  });
  const streamedError = await captureError(
    streamedClient.get("/projects?credential=do-not-leak", { maxResponseBytes: 4 })
  );
  assert.ok(streamedError instanceof ApiResponseTooLargeError);
  assert.equal(streamedError.maxResponseBytes, 4);
  assert.equal(streamedBodyCancelled, true);
  assert.doesNotMatch(String(streamedError), /credential|do-not-leak|projects/u);
}

async function testTimerAndListenerCleanup(): Promise<void> {
  const externalController = new AbortController();
  let internalSignal: AbortSignal | undefined;
  const client = createApiClient({
    timeoutMs: 5,
    fetch: async (_input, init) => {
      internalSignal = init?.signal ?? undefined;
      return Response.json({ ok: true });
    }
  });

  await client.get("/version", { signal: externalController.signal });
  externalController.abort();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(internalSignal?.aborted, false);
}

async function testConfigurationBoundaries(): Promise<void> {
  assert.throws(
    () => createApiClient({ baseUrl: "https://user:secret@example.test" }),
    ApiConfigurationError
  );
  assert.throws(() => createApiClient({ timeoutMs: 0 }), ApiConfigurationError);
  assert.throws(
    () => createApiClient({ maxResponseBytes: 16_777_217 }),
    ApiConfigurationError
  );

  const client = createApiClient({ fetch: async () => Response.json({}) });
  await assert.rejects(
    client.get("/../private"),
    (error) => error instanceof ApiConfigurationError
  );
  await assert.rejects(
    client.post("/projects", 1n),
    (error) => error instanceof ApiClientError && error.kind === "serialization"
  );
}

async function testVersionContract(): Promise<void> {
  let receivedUrl: string | undefined;
  const client = createApiClient({
    fetch: async (input) => {
      receivedUrl = String(input);
      return Response.json({ version: "0.1.0" });
    }
  });
  const response = await getVersion(client);
  assert.equal(receivedUrl, "/api/v1/version");
  assert.deepEqual(response.data, { version: "0.1.0" });
}

async function captureError(request: Promise<unknown>): Promise<unknown> {
  try {
    await request;
  } catch (error) {
    return error;
  }
  assert.fail("expected request to reject");
}
