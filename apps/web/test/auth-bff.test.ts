import assert from "node:assert/strict";

import {
  forwardCreateSession,
  forwardCurrentUser
} from "../src/lib/api/auth-bff.ts";

const originalFetch = globalThis.fetch;
const originalInternalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  await testExactLoginForwarding();
  await testOriginAndBodyRejection();
  await testCurrentUserCookieAllowlist();
  await testBoundedSafeUpstreamFailure();
  await testLoginDeadlineCancelsNeverYieldingBody();
  await testRequestAbortCancelsSlowLoginBody();
  await testRemainingDeadlineReachesUpstreamFetch();
  await testRequestAbortCancelsUpstreamResponse();
} finally {
  globalThis.fetch = originalFetch;
  if (originalInternalUrl === undefined) {
    delete process.env.NURITEO_INTERNAL_API_URL;
  } else {
    process.env.NURITEO_INTERNAL_API_URL = originalInternalUrl;
  }
}

async function testExactLoginForwarding(): Promise<void> {
  let receivedUrl: string | undefined;
  let receivedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    receivedUrl = String(input);
    receivedInit = init;
    return new Response(null, {
      headers: [
        ["set-cookie", "nrt_session=opaque; Path=/; HttpOnly; SameSite=Lax"],
        ["set-cookie", "nrt_csrf=opaque; Path=/; SameSite=Lax"],
        ["x-request-id", "core-login-request"]
      ],
      status: 204
    });
  };

  const response = await forwardCreateSession(new Request(
    "https://nuriteo.example.test/api/v1/auth/sessions",
    {
      body: JSON.stringify({ email: "admin@example.test", password: "do-not-log" }),
      headers: {
        authorization: "Bearer do-not-forward",
        "content-type": "application/json",
        cookie: "session=do-not-forward",
        host: "nuriteo.example.test",
        origin: "https://nuriteo.example.test",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "x-forwarded-for": "203.0.113.1",
        "x-forwarded-host": "attacker.example.test",
        "x-request-id": "edge-login-request"
      },
      method: "POST"
    }
  ));

  assert.equal(receivedUrl, "http://core.internal:8080/api/v1/auth/sessions");
  assert.equal(receivedInit?.method, "POST");
  assert.equal(receivedInit?.redirect, "error");
  const headers = new Headers(receivedInit?.headers);
  assert.deepEqual([...headers.entries()], [
    ["content-type", "application/json"],
    ["origin", "https://nuriteo.example.test"],
    ["traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["x-request-id", "edge-login-request"]
  ]);
  assert.equal(response.status, 204);
  assert.deepEqual(response.headers.getSetCookie(), [
    "nrt_session=opaque; Path=/; HttpOnly; SameSite=Lax",
    "nrt_csrf=opaque; Path=/; SameSite=Lax"
  ]);
}

async function testOriginAndBodyRejection(): Promise<void> {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response();
  };

  const crossOrigin = await forwardCreateSession(new Request(
    "https://nuriteo.example.test/api/v1/auth/sessions",
    {
      body: "{}",
      headers: {
        "content-type": "application/json",
        host: "nuriteo.example.test",
        origin: "https://attacker.example.test"
      },
      method: "POST"
    }
  ));
  assert.equal(crossOrigin.status, 403);

  const oversized = await forwardCreateSession(new Request(
    "https://nuriteo.example.test/api/v1/auth/sessions",
    {
      body: "x".repeat(4_097),
      headers: {
        "content-type": "application/json",
        host: "nuriteo.example.test",
        origin: "https://nuriteo.example.test"
      },
      method: "POST"
    }
  ));
  assert.equal(oversized.status, 413);
  assert.equal(called, false);
}

async function testCurrentUserCookieAllowlist(): Promise<void> {
  let receivedHeaders = new Headers();
  globalThis.fetch = async (_input, init) => {
    receivedHeaders = new Headers(init?.headers);
    return Response.json({ ok: true }, {
      headers: {
        "cache-control": "private",
        "set-cookie": "must-not-forward=secret",
        "x-request-id": "core-me-request"
      }
    });
  };

  const response = await forwardCurrentUser(new Request(
    "https://nuriteo.example.test/api/v1/me",
    {
      headers: {
        authorization: "Bearer do-not-forward",
        cookie: "nrt_session=opaque; nrt_csrf=opaque",
        host: "attacker.example.test",
        "x-forwarded-host": "attacker.example.test",
        "x-request-id": "edge-me-request"
      }
    }
  ));

  assert.deepEqual([...receivedHeaders.entries()], [
    ["cookie", "nrt_session=opaque; nrt_csrf=opaque"],
    ["x-request-id", "edge-me-request"]
  ]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(response.headers.get("x-request-id"), "core-me-request");
}

async function testBoundedSafeUpstreamFailure(): Promise<void> {
  globalThis.fetch = async () => new Response("secret-response-body", {
    headers: { "content-length": "2000000" },
    status: 500
  });
  const response = await forwardCurrentUser(new Request(
    "https://nuriteo.example.test/api/v1/me",
    { headers: { cookie: "nrt_session=do-not-log" } }
  ));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /secret|do-not-log|core\.internal/u);
}

async function testLoginDeadlineCancelsNeverYieldingBody(): Promise<void> {
  const timeout = new AbortController();
  let cancelled = false;
  let fetchCalled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull() {
      timeout.abort();
      return new Promise<void>(() => undefined);
    }
  });
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response();
  };

  const response = await forwardCreateSession(streamingLoginRequest(body), timeout.signal);

  assert.equal(response.status, 504);
  assert.equal(cancelled, true);
  assert.equal(fetchCalled, false);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  assert.doesNotMatch(await response.text(), /password|core\.internal/u);
}

async function testRequestAbortCancelsSlowLoginBody(): Promise<void> {
  const requestAbort = new AbortController();
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new TextEncoder().encode("{"));
        return;
      }
      requestAbort.abort();
      return new Promise<void>(() => undefined);
    }
  });

  const response = await forwardCreateSession(
    streamingLoginRequest(body, requestAbort.signal),
    new AbortController().signal
  );

  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
}

async function testRemainingDeadlineReachesUpstreamFetch(): Promise<void> {
  const timeout = new AbortController();
  let forwardedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    forwardedSignal = init?.signal;
    timeout.abort();
    throw timeout.signal.reason;
  };

  const response = await forwardCreateSession(new Request(
    "https://nuriteo.example.test/api/v1/auth/sessions",
    {
      body: "{}",
      headers: {
        "content-type": "application/json",
        host: "nuriteo.example.test",
        origin: "https://nuriteo.example.test"
      },
      method: "POST"
    }
  ), timeout.signal);

  assert.equal(response.status, 504);
  assert.equal(forwardedSignal?.aborted, true);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
}

async function testRequestAbortCancelsUpstreamResponse(): Promise<void> {
  const requestAbort = new AbortController();
  let cancelled = false;
  let forwardedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    forwardedSignal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull() {
        requestAbort.abort();
        return new Promise<void>(() => undefined);
      }
    }));
  };

  const response = await forwardCurrentUser(new Request(
    "https://nuriteo.example.test/api/v1/me",
    {
      headers: { cookie: "nrt_session=do-not-log" },
      signal: requestAbort.signal
    }
  ), new AbortController().signal);

  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
  assert.equal(forwardedSignal?.aborted, true);
  assert.doesNotMatch(await response.text(), /do-not-log|core\.internal/u);
}

function streamingLoginRequest(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Request {
  return new Request("https://nuriteo.example.test/api/v1/auth/sessions", {
    body,
    duplex: "half",
    headers: {
      "content-type": "application/json",
      host: "nuriteo.example.test",
      origin: "https://nuriteo.example.test"
    },
    method: "POST",
    signal
  } as RequestInit & { duplex: "half" });
}
