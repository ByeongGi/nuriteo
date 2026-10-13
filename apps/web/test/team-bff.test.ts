import assert from "node:assert/strict";

import {
  forwardTeamRequest,
  teamChildCollectionPath,
  teamChildItemPath,
  teamCollectionPath,
  teamItemPath,
  teamLocation
} from "../src/lib/api/team-bff.ts";

const ORGANIZATION_ID = "0199ee6c-c777-7000-8000-000000009101";
const TEAM_ID = "0199ee6c-c777-7000-8000-000000009102";
const USER_ID = "0199ee6c-c777-7000-8000-000000009103";
const PROJECT_ID = "0199ee6c-c777-7000-8000-000000009104";
const BASE = `/api/v1/organizations/${ORGANIZATION_ID}/teams` as const;
const ORIGIN = "https://nuriteo.example.test";
const CSRF = "nrt_csrf_team-bff";
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  await forwardsCanonicalListWithoutAmbientHeaders();
  await forwardsMutationSecurityHeadersAndResponseMetadata();
  await rejectsInvalidParametersQueriesAndValidators();
  await propagatesBoundedProblemsWithoutCaching();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function forwardsCanonicalListWithoutAmbientHeaders(): Promise<void> {
  let upstreamUrl = "";
  let upstreamHeaders = new Headers();
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamHeaders = new Headers(init?.headers);
    return Response.json({ items: [], nextCursor: null }, {
      headers: { "cache-control": "private", "x-request-id": "core-team-list" }
    });
  };
  const request = teamRequest(`${BASE}?cursor=nrt_cursor.value&pageSize=25`, "GET", {
    authorization: "Bearer do-not-forward",
    "x-extra": "private"
  });
  const path = teamCollectionPath(request, ORGANIZATION_ID);
  assert.equal(path, `${BASE}?pageSize=25&cursor=nrt_cursor.value`);
  const response = await forwardTeamRequest(request, { method: "GET", path: required(path) });
  assert.equal(upstreamUrl, `http://core.internal:8080${BASE}?pageSize=25&cursor=nrt_cursor.value`);
  assert.equal(upstreamHeaders.get("cookie"), "nrt_session=opaque");
  assert.equal(upstreamHeaders.get("authorization"), null);
  assert.equal(upstreamHeaders.get("x-extra"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-request-id"), "core-team-list");
}

async function forwardsMutationSecurityHeadersAndResponseMetadata(): Promise<void> {
  let upstreamHeaders = new Headers();
  let upstreamBody = "";
  globalThis.fetch = async (_input, init) => {
    upstreamHeaders = new Headers(init?.headers);
    upstreamBody = new TextDecoder().decode(init?.body as ArrayBuffer);
    return Response.json({ ...team(), displayName: "Platform Engineering", version: 2 }, {
      headers: {
        etag: '"team-v2"',
        location: `${BASE}/${TEAM_ID}`,
        "set-cookie": "must-not-forward=secret",
        "x-request-id": "core-team-mutation"
      }
    });
  };
  const request = teamRequest(`${BASE}/${TEAM_ID}`, "PATCH", {
    "content-type": "application/json",
    "if-match": '"team-v1"',
    "x-csrf-token": CSRF
  }, JSON.stringify({ displayName: "Platform Engineering" }));
  const path = teamItemPath(request, ORGANIZATION_ID, TEAM_ID);
  const response = await forwardTeamRequest(request, {
    etagKind: "team",
    method: "PATCH",
    path: required(path),
    safeLocation: teamLocation(ORGANIZATION_ID),
    withBody: true
  });
  assert.equal(upstreamHeaders.get("origin"), ORIGIN);
  assert.equal(upstreamHeaders.get("x-csrf-token"), CSRF);
  assert.equal(upstreamHeaders.get("if-match"), '"team-v1"');
  assert.equal(upstreamBody, JSON.stringify({ displayName: "Platform Engineering" }));
  assert.equal(response.headers.get("etag"), '"team-v2"');
  assert.equal(response.headers.get("location"), `${BASE}/${TEAM_ID}`);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

async function rejectsInvalidParametersQueriesAndValidators(): Promise<void> {
  assert.equal(teamCollectionPath(teamRequest(`${BASE}?pageSize=0`, "GET"), ORGANIZATION_ID), undefined);
  assert.equal(teamCollectionPath(teamRequest(`${BASE}?unexpected=true`, "GET"), ORGANIZATION_ID), undefined);
  assert.equal(teamCollectionPath(teamRequest(`${BASE}?pageSize=1&pageSize=2`, "GET"), ORGANIZATION_ID), undefined);
  assert.equal(teamItemPath(teamRequest(`${BASE}/${TEAM_ID}?x=1`, "GET"), ORGANIZATION_ID, TEAM_ID), undefined);
  assert.equal(teamItemPath(teamRequest(`${BASE}/${TEAM_ID}`, "GET"), "not-a-uuid", TEAM_ID), undefined);
  assert.equal(teamChildCollectionPath(teamRequest(`${BASE}/${TEAM_ID}/members`, "GET"), ORGANIZATION_ID, TEAM_ID, "members"), `${BASE}/${TEAM_ID}/members`);
  assert.equal(teamChildItemPath(teamRequest(`${BASE}/${TEAM_ID}/members/${USER_ID}`, "PATCH"), ORGANIZATION_ID, TEAM_ID, "members", USER_ID), `${BASE}/${TEAM_ID}/members/${USER_ID}`);
  assert.equal(teamChildItemPath(teamRequest(`${BASE}/${TEAM_ID}/project-roles/${PROJECT_ID}`, "DELETE"), ORGANIZATION_ID, TEAM_ID, "project-roles", PROJECT_ID), `${BASE}/${TEAM_ID}/project-roles/${PROJECT_ID}`);

  let dispatched = false;
  globalThis.fetch = async () => { dispatched = true; return new Response(); };
  const invalidEtag = teamRequest(`${BASE}/${TEAM_ID}/members/${USER_ID}`, "PATCH", {
    "content-type": "application/json",
    "if-match": '"team-v1"',
    "x-csrf-token": CSRF
  }, JSON.stringify({ role: "maintainer" }));
  const response = await forwardTeamRequest(invalidEtag, {
    etagKind: "team-member",
    method: "PATCH",
    path: `${BASE}/${TEAM_ID}/members/${USER_ID}`,
    withBody: true
  });
  assert.equal(response.status, 428);
  assert.equal(dispatched, false);

  const crossOrigin = new Request(`${ORIGIN}${BASE}`, {
    headers: { host: "nuriteo.example.test", origin: "https://attacker.example.test", "x-csrf-token": CSRF },
    method: "POST"
  });
  assert.equal((await forwardTeamRequest(crossOrigin, { method: "POST", path: BASE })).status, 403);
}

async function propagatesBoundedProblemsWithoutCaching(): Promise<void> {
  const problem = { code: "FORBIDDEN", detail: "Team access denied" };
  globalThis.fetch = async () => Response.json(problem, {
    status: 403,
    headers: { "cache-control": "public, max-age=600", "content-type": "application/problem+json" }
  });
  const request = teamRequest(`${BASE}/${TEAM_ID}`, "GET");
  const response = await forwardTeamRequest(request, { method: "GET", path: `${BASE}/${TEAM_ID}` });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), problem);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function teamRequest(
  path: string,
  method: "DELETE" | "GET" | "PATCH" | "POST",
  headers: HeadersInit = {},
  body?: string
): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...(body === undefined ? {} : { body }),
    headers: {
      cookie: "nrt_session=opaque",
      host: "nuriteo.example.test",
      ...(method === "GET" ? {} : { origin: ORIGIN }),
      ...Object.fromEntries(new Headers(headers))
    },
    method
  });
}

function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

function team(): Record<string, unknown> {
  return {
    id: TEAM_ID,
    organizationId: ORGANIZATION_ID,
    slug: "platform",
    displayName: "Platform",
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
    version: 1
  };
}
