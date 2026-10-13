import assert from "node:assert/strict";

import {
  ApiAbortError,
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  createApiClient,
  createSession,
  deleteSession,
  getCurrentUser,
  getCurrentWorkspaces
} from "../src/index.ts";
import type { ProblemDetails } from "../src/index.ts";

const USER_ID = "018f22c4-3cb2-7cc8-98d8-b4f7f753f7bb";
const SESSION_ID = "018f22c4-3cb3-7b55-a959-a4142b2b7261";
const SCOPE_ID = "018f22c4-3cb4-70c0-8f01-7252dd5c2d61";

await testSessionRequestContracts();
await testCurrentUserContract();
await testWorkspaceContract();
await testInvalidPayloadsFailClosed();
await testTransportErrorsPassThroughSafely();

async function testSessionRequestContracts(): Promise<void> {
  const password = "correct horse battery staple";
  const calls: Array<{ init: RequestInit | undefined; url: string }> = [];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, {
        status: 204,
        headers: [
          ["set-cookie", "nuriteo_session=must-not-escape; HttpOnly"],
          ["set-cookie", "nuriteo_csrf=must-not-escape"]
        ]
      });
    }
  });

  const login = await createSession(client, {
    email: "admin@example.test",
    password
  });
  assert.deepEqual(login, { status: 204, requestId: undefined });
  assert.equal(calls[0]?.url, "/api/v1/auth/sessions");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(
    calls[0]?.init?.body,
    JSON.stringify({ email: "admin@example.test", password })
  );
  assert.equal(new Headers(calls[0]?.init?.headers).get("content-type"), "application/json");
  assert.doesNotMatch(JSON.stringify(login), /must-not-escape|set-cookie/u);

  const csrfToken = "nrt_csrf_fixture-token";
  const logout = await deleteSession(client, { csrfToken });
  assert.deepEqual(logout, { status: 204, requestId: undefined });
  assert.equal(calls[1]?.url, "/api/v1/auth/session");
  assert.equal(calls[1]?.init?.method, "DELETE");
  const logoutHeaders = new Headers(calls[1]?.init?.headers);
  assert.deepEqual([...logoutHeaders.keys()].filter((name) => name === "x-csrf-token"), [
    "x-csrf-token"
  ]);
  assert.equal(logoutHeaders.get("x-csrf-token"), csrfToken);
  assert.equal(logoutHeaders.has("cookie"), false);
  assert.equal(logoutHeaders.has("origin"), false);
  assert.doesNotMatch(JSON.stringify(logout), /fixture-token|must-not-escape/u);

  await assert.rejects(
    deleteSession(client, { csrfToken: "line\nbreak" }),
    (error) =>
      error instanceof ApiConfigurationError &&
      !String(error).includes("line") &&
      !JSON.stringify(error).includes("line")
  );

  const wrongStatus = createApiClient({ fetch: async () => Response.json({ ok: true }) });
  await assert.rejects(createSession(wrongStatus, { email: "x", password }), (error) => {
    assert.ok(error instanceof ApiInvalidResponseError);
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /battery|password/u);
    return true;
  });
}

async function testCurrentUserContract(): Promise<void> {
  let url: string | undefined;
  let method: string | undefined;
  const client = createApiClient({
    fetch: async (input, init) => {
      url = String(input);
      method = init?.method;
      return Response.json(validMe(), { headers: { "x-request-id": "request-me" } });
    }
  });

  const result = await getCurrentUser(client);
  assert.equal(url, "/api/v1/me");
  assert.equal(method, "GET");
  assert.equal(result.status, 200);
  assert.equal(result.requestId, "request-me");
  assert.deepEqual(result.data, validMe());
  assert.deepEqual(Object.keys(result).toSorted(), ["data", "requestId", "status"]);
}

async function testWorkspaceContract(): Promise<void> {
  let url: string | undefined;
  const client = createApiClient({
    fetch: async (input) => {
      url = String(input);
      return Response.json({
        workspaces: [
          {
            ownerType: "user",
            ownerId: USER_ID,
            displayLabel: "Personal Workspace",
            storageScopeId: SCOPE_ID
          },
          {
            ownerType: "organization",
            ownerId: "018f22c4-3cb5-7ac7-b464-8214f90ad21a",
            displayLabel: "Platform Team",
            storageScopeId: "018f22c4-3cb6-7819-a58e-a5831700f999"
          }
        ]
      });
    }
  });

  const result = await getCurrentWorkspaces(client);
  assert.equal(url, "/api/v1/me/workspaces");
  assert.equal(result.data.workspaces[0]?.ownerType, "user");
  assert.equal(result.data.workspaces[1]?.ownerType, "organization");
}

async function testInvalidPayloadsFailClosed(): Promise<void> {
  const invalidMeValues: unknown[] = [
    { ...validMe(), extra: true },
    { ...validMe(), user: { ...validMe().user, id: "not-a-uuid" } },
    { ...validMe(), user: { ...validMe().user, display_name: "x".repeat(201) } },
    { ...validMe(), session: { ...validMe().session, last_seen_at: "not-a-time" } },
    {
      ...validMe(),
      session: {
        ...validMe().session,
        idle_expires_at: "2026-10-04T01:00:00Z",
        absolute_expires_at: "2026-10-04T00:30:00Z"
      }
    }
  ];
  for (const value of invalidMeValues) {
    const client = createApiClient({ fetch: async () => Response.json(value) });
    await assert.rejects(getCurrentUser(client), ApiInvalidResponseError);
  }

  const invalidWorkspaceValues: unknown[] = [
    { workspaces: [], extra: true },
    { workspaces: [{ ownerType: "team", ownerId: USER_ID, displayLabel: "T", storageScopeId: SCOPE_ID }] },
    { workspaces: [{ ownerType: "user", ownerId: "bad", displayLabel: "T", storageScopeId: SCOPE_ID }] },
    { workspaces: Array.from({ length: 129 }, () => ({ ownerType: "user", ownerId: USER_ID, displayLabel: "T", storageScopeId: SCOPE_ID })) }
  ];
  for (const value of invalidWorkspaceValues) {
    const client = createApiClient({ fetch: async () => Response.json(value) });
    await assert.rejects(getCurrentWorkspaces(client), ApiInvalidResponseError);
  }
}

async function testTransportErrorsPassThroughSafely(): Promise<void> {
  const problem: ProblemDetails = {
    type: "/docs/problems/authentication-required",
    title: "Authentication required",
    status: 401,
    detail: "Authentication is required.",
    instance: "/api/v1/me",
    code: "AUTHENTICATION_REQUIRED",
    request_id: "request-auth",
    errors: []
  };
  const unauthorized = createApiClient({
    fetch: async () => Response.json(problem, { status: 401 })
  });
  await assert.rejects(
    getCurrentUser(unauthorized),
    (error) => error instanceof ApiError && error.status === 401 && error.code === problem.code
  );

  const controller = new AbortController();
  const pending = createApiClient({
    fetch: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret reason")), {
          once: true
        });
      })
  });
  const request = getCurrentWorkspaces(pending, { signal: controller.signal });
  controller.abort("secret abort credential");
  await assert.rejects(request, ApiAbortError);
}

function validMe(): Record<string, unknown> & {
  readonly session: Record<string, unknown>;
  readonly user: Record<string, unknown>;
} {
  return {
    user: {
      id: USER_ID,
      email: "admin@example.test",
      display_name: "Admin",
      is_instance_admin: true
    },
    session: {
      id: SESSION_ID,
      last_seen_at: "2026-10-04T00:00:00Z",
      idle_expires_at: "2026-10-04T01:00:00Z",
      absolute_expires_at: "2026-10-05T00:00:00Z"
    }
  };
}
