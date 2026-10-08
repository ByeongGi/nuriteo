import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  createApiClient,
  issueAccessToken,
  listAccessTokens,
  revokeAccessToken,
  rotateAccessToken
} from "../src/index.ts";

const TOKEN_ID = "0199ee6c-c777-7000-8000-000000040001";
const ROTATED_ID = "0199ee6c-c777-7000-8000-000000040002";
const PROJECT_ID = "0199ee6c-c777-7000-8000-000000040003";
const CSRF = "nrt_csrf_access-token-contract";

await lifecycleContract();
await malformedResponsesFailClosed();

async function lifecycleContract() {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const current = token(TOKEN_ID);
  const rotated = token(ROTATED_ID);
  const responses = [
    json([current]),
    json({ token: current, plaintext: `nur_pat_${"a".repeat(43)}` }, 201),
    json({ ...current, status: "revoked", revokedAt: "2026-10-08T01:00:00Z" }),
    json({ token: rotated, plaintext: `nur_pat_${"b".repeat(43)}` }, 201)
  ];
  const client = createApiClient({ fetch: async (input, init) => {
    calls.push({ input, ...(init === undefined ? {} : { init }) });
    return responses.shift()!;
  } });

  await listAccessTokens(client, { kind: "personal" });
  await issueAccessToken(client, { kind: "personal" }, {
    name: "CLI", scopes: ["project:read"], expiryDays: 30
  }, { csrfToken: CSRF });
  await revokeAccessToken(client, { kind: "personal" }, TOKEN_ID, { csrfToken: CSRF });
  await rotateAccessToken(client, { kind: "project", projectId: PROJECT_ID }, TOKEN_ID, undefined, { csrfToken: CSRF });

  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/access-tokens"],
    ["POST", "/api/v1/access-tokens"],
    ["DELETE", `/api/v1/access-tokens/${TOKEN_ID}`],
    ["POST", `/api/v1/projects/${PROJECT_ID}/access-tokens/${TOKEN_ID}/rotate`]
  ]);
  assert.equal(new Headers(calls[1]?.init?.headers).get("x-csrf-token"), CSRF);
  assert.equal(calls[3]?.init?.body, "{}");
}

async function malformedResponsesFailClosed() {
  await assert.rejects(
    () => listAccessTokens(single([{ ...token(TOKEN_ID), secretHash: "leak" }]), { kind: "personal" }),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => issueAccessToken(single({ token: token(TOKEN_ID), plaintext: "", extra: true }), { kind: "personal" }, { name: "CLI", scopes: [] }, { csrfToken: CSRF }),
    ApiInvalidResponseError
  );
  assert.throws(
    () => listAccessTokens(single([]), { kind: "project", projectId: "not-a-project" }),
    /UUID/u
  );
}

function token(id: string) {
  return {
    id,
    kind: "personal",
    name: "CLI",
    projectId: null,
    scopes: ["project:read"],
    status: "active",
    prefix: "nur_pat_0199ee6c",
    createdAt: "2026-10-08T00:00:00Z",
    expiresAt: "2026-11-07T00:00:00Z",
    revokedAt: null,
    lastUsedAt: null,
    lastApiCategory: null,
    recentSourceIps: []
  };
}

function single(payload: unknown) { return createApiClient({ fetch: async () => json(payload) }); }
function json(payload: unknown, status = 200) { return Response.json(payload, { status }); }
