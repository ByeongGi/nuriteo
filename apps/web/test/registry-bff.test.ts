import assert from "node:assert/strict";

import { forwardCollaborationMutation } from "../src/lib/api/collaboration-bff.ts";

const ID = "0199ee6c-c777-7000-8000-000000070001";
const ORIGIN = "https://nuriteo.example.test";
const CSRF = "nrt_csrf_registry-bff";
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  await forwardsRegistryMutationSecurityBoundary();
  await rejectsWrongValidatorAndCrossOrigin();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function forwardsRegistryMutationSecurityBoundary() {
  let upstreamUrl = "";
  let upstreamHeaders = new Headers();
  let upstreamBody = "";
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamHeaders = new Headers(init?.headers);
    upstreamBody = new TextDecoder().decode(init?.body as ArrayBuffer);
    return Response.json(registry(), { headers: { etag: '"registry-v3"' } });
  };
  const path = `/api/v1/admin/registries/${ID}/rotate-token` as const;
  const response = await forwardCollaborationMutation(request(path, '"registry-v2"'), {
    method: "POST",
    path,
    requireCsrf: true,
    withBody: true,
    withEtag: true,
    etagKind: "registry",
    commitOutcomeUnknown: true
  });
  assert.equal(upstreamUrl, `http://core.internal:8080${path}`);
  assert.equal(upstreamHeaders.get("origin"), ORIGIN);
  assert.equal(upstreamHeaders.get("cookie"), "nrt_session=opaque");
  assert.equal(upstreamHeaders.get("x-csrf-token"), CSRF);
  assert.equal(upstreamHeaders.get("if-match"), '"registry-v2"');
  assert.equal(upstreamBody, JSON.stringify({ token: "replacement-secret" }));
  assert.equal(response.headers.get("etag"), '"registry-v3"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.text()).includes("replacement-secret"), false);
}

async function rejectsWrongValidatorAndCrossOrigin() {
  let dispatched = false;
  globalThis.fetch = async () => { dispatched = true; return new Response(); };
  const path = `/api/v1/admin/registries/${ID}/disable` as const;
  const invalid = await forwardCollaborationMutation(request(path, '"oidc-provider-v2"'), {
    method: "POST", path, requireCsrf: true, withBody: false,
    withEtag: true, etagKind: "registry"
  });
  assert.equal(invalid.status, 428);
  const crossOrigin = request(path, '"registry-v2"', "https://attacker.example.test");
  const rejected = await forwardCollaborationMutation(crossOrigin, {
    method: "POST", path, requireCsrf: true, withBody: false,
    withEtag: true, etagKind: "registry"
  });
  assert.equal(rejected.status, 403);
  assert.equal(dispatched, false);
}

function request(path: string, etag: string, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...(path.endsWith("rotate-token") ? { body: JSON.stringify({ token: "replacement-secret" }) } : {}),
    headers: {
      cookie: "nrt_session=opaque",
      host: "nuriteo.example.test",
      origin,
      "content-type": "application/json",
      "if-match": etag,
      "x-csrf-token": CSRF
    },
    method: "POST"
  });
}

function registry() {
  return {
    id: ID, displayName: "Company npm", baseUrl: "https://registry.example.test/npm",
    state: "disabled", isDefault: false, configVersion: 3, credentialVersion: 2,
    validatedAt: null
  };
}
