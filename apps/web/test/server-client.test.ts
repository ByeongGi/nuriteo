import assert from "node:assert/strict";

import {
  ApiConfigurationError,
  ApiResponseTooLargeError,
  ApiTimeoutError
} from "@nuriteo/api-client";

import {
  DEFAULT_SERVER_API_TIMEOUT_MS,
  createRequestScopedApiClient,
  selectForwardedHeaders,
  validateInternalApiUrl
} from "../src/lib/api/server-policy.ts";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

await testInternalApiUrlValidation();
testForwardedHeaderValidation();
await testStrictOutboundHeadersAndNoStore();
await testConcurrentRequestIsolation();
await testTypedTimeoutAndResponseBounds();

async function testInternalApiUrlValidation(): Promise<void> {
  assert.equal(DEFAULT_SERVER_API_TIMEOUT_MS, 15_000);
  assert.equal(validateInternalApiUrl(" https://core.example.test/internal/ "), "https://core.example.test/internal");

  for (const invalidValue of [
    undefined,
    "",
    "/relative",
    "ftp://core.example.test",
    "https://user:secret@core.example.test",
    "https://core.example.test?token=secret",
    "https://core.example.test#fragment"
  ]) {
    assert.throws(() => validateInternalApiUrl(invalidValue), ApiConfigurationError);
  }
}

function testForwardedHeaderValidation(): void {
  const valid = selectForwardedHeaders(
    new Headers({
      authorization: "Bearer do-not-forward",
      cookie: "session=request-a",
      host: "attacker.example",
      traceparent: VALID_TRACEPARENT,
      "x-forwarded-for": "203.0.113.10",
      "x-request-id": "edge:request-01"
    })
  );
  assert.deepEqual([...valid.entries()], [
    ["cookie", "session=request-a"],
    ["traceparent", VALID_TRACEPARENT],
    ["x-request-id", "edge:request-01"]
  ]);

  for (const [name, value] of [
    ["x-request-id", "contains a space"],
    ["x-request-id", "x".repeat(129)],
    ["traceparent", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
    ["traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
    ["traceparent", VALID_TRACEPARENT.toUpperCase()]
  ] as const) {
    const forwarded = selectForwardedHeaders(new Headers({ [name]: value }));
    assert.equal(forwarded.has(name), false, `${name} accepted an invalid value`);
  }

  const unsafeCookieHeaders = {
    get(name: string) {
      return name === "cookie" ? "session=unsafe\nvalue" : null;
    }
  };
  assert.equal(selectForwardedHeaders(unsafeCookieHeaders).has("cookie"), false);
  assert.equal(
    selectForwardedHeaders(new Headers({ cookie: `session=${"x".repeat(8_193)}` })).has("cookie"),
    false
  );
}

async function testStrictOutboundHeadersAndNoStore(): Promise<void> {
  let receivedUrl: string | undefined;
  let receivedInit: RequestInit | undefined;
  const client = createRequestScopedApiClient({
    fetch: async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return Response.json({ ok: true });
    },
    incomingHeaders: new Headers({
      authorization: "Bearer inbound-secret",
      cookie: "session=trusted-request",
      traceparent: VALID_TRACEPARENT,
      "x-forwarded-host": "attacker.example",
      "x-request-id": "trusted-request-id"
    }),
    internalApiUrl: "http://core-api:8080"
  });

  await client.post(
    "/projects",
    { name: "Example" },
    {
      headers: {
        authorization: "Bearer caller-secret",
        cookie: "session=wrong-request",
        host: "attacker.example",
        traceparent: "invalid",
        "x-arbitrary": "do-not-forward",
        "x-forwarded-for": "203.0.113.10",
        "x-request-id": "wrong-request-id"
      }
    }
  );

  assert.equal(receivedUrl, "http://core-api:8080/api/v1/projects");
  assert.equal(receivedInit?.cache, "no-store");
  assert.equal(receivedInit?.credentials, "omit");
  const headers = new Headers(receivedInit?.headers);
  assert.deepEqual([...headers.entries()], [
    ["accept", "application/json, application/problem+json, text/plain"],
    ["content-type", "application/json"],
    ["cookie", "session=trusted-request"],
    ["traceparent", VALID_TRACEPARENT],
    ["x-request-id", "trusted-request-id"]
  ]);
}

async function testConcurrentRequestIsolation(): Promise<void> {
  const receivedContexts: Array<{ cookie: string; requestId: string }> = [];
  let releaseFirstRequest = () => {};
  const firstRequestBlocked = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });

  const createFetch = (shouldWait: boolean): typeof globalThis.fetch =>
    async (_input, init) => {
      if (shouldWait) {
        await firstRequestBlocked;
      }
      const headers = new Headers(init?.headers);
      receivedContexts.push({
        cookie: headers.get("cookie") ?? "missing",
        requestId: headers.get("x-request-id") ?? "missing"
      });
      return Response.json({ ok: true });
    };

  const firstClient = createRequestScopedApiClient({
    fetch: createFetch(true),
    incomingHeaders: new Headers({ cookie: "session=first", "x-request-id": "first-id" }),
    internalApiUrl: "http://core-api:8080"
  });
  const secondClient = createRequestScopedApiClient({
    fetch: createFetch(false),
    incomingHeaders: new Headers({ cookie: "session=second", "x-request-id": "second-id" }),
    internalApiUrl: "http://core-api:8080"
  });

  const firstRequest = firstClient.get("/version");
  const secondRequest = secondClient.get("/version");
  await secondRequest;
  releaseFirstRequest();
  await firstRequest;

  assert.deepEqual(receivedContexts, [
    { cookie: "session=second", requestId: "second-id" },
    { cookie: "session=first", requestId: "first-id" }
  ]);
}

async function testTypedTimeoutAndResponseBounds(): Promise<void> {
  const timeoutClient = createRequestScopedApiClient({
    fetch: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret cause")), {
          once: true
        });
      }),
    incomingHeaders: new Headers({ cookie: "session=do-not-leak" }),
    internalApiUrl: "http://core-api:8080",
    timeoutMs: 5
  });
  const timeoutError = await captureError(timeoutClient.get("/version"));
  assert.ok(timeoutError instanceof ApiTimeoutError);
  assert.doesNotMatch(String(timeoutError), /secret|session|do-not-leak/u);

  const boundedClient = createRequestScopedApiClient({
    fetch: async () => new Response("oversized-response"),
    incomingHeaders: new Headers({ cookie: "session=do-not-leak" }),
    internalApiUrl: "http://core-api:8080",
    maxResponseBytes: 4
  });
  const boundedError = await captureError(boundedClient.get("/version"));
  assert.ok(boundedError instanceof ApiResponseTooLargeError);
  assert.doesNotMatch(JSON.stringify(boundedError), /session|do-not-leak|oversized/u);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected the promise to reject");
}
