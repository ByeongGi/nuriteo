import assert from "node:assert/strict";

import { forwardCollaborationMutation } from "../src/lib/api/collaboration-bff.ts";

const ORIGIN = "https://nuriteo.example.test";
const ID = "0199ee6c-c777-7000-8000-000000090101";
const PATH = `/api/v1/admin/integrations/oidc/${ID}/ca/candidates` as const;
const KEY = "integration-ca-bff-0001";
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  let upstreamHeaders = new Headers();
  globalThis.fetch = async (_input, init) => {
    upstreamHeaders = new Headers(init?.headers);
    return Response.json({ id: ID }, { status: 201, headers: { etag: '"integration-ca-v1"' } });
  };
  const response = await forwardCollaborationMutation(request('"integration-ca-v0"', KEY), {
    commitOutcomeUnknown: true,
    etagKind: "integration-ca",
    maxBodyBytes: 1_100_000,
    method: "POST",
    path: PATH,
    requireCsrf: true,
    withBody: true,
    withEtag: true,
    withIdempotencyKey: true
  });
  assert.equal(response.status, 201);
  assert.equal(upstreamHeaders.get("if-match"), '"integration-ca-v0"');
  assert.equal(upstreamHeaders.get("idempotency-key"), KEY);
  assert.equal(upstreamHeaders.get("x-ca-pem"), null);

  let dispatched = false;
  globalThis.fetch = async () => { dispatched = true; return new Response(); };
  const weak = await forwardCollaborationMutation(request('W/"integration-ca-v0"', KEY), {
    etagKind: "integration-ca", method: "POST", path: PATH, requireCsrf: true,
    withBody: true, withEtag: true, withIdempotencyKey: true
  });
  assert.equal(weak.status, 428);
  const missingKey = await forwardCollaborationMutation(request('"integration-ca-v0"', ""), {
    etagKind: "integration-ca", method: "POST", path: PATH, requireCsrf: true,
    withBody: true, withEtag: true, withIdempotencyKey: true
  });
  assert.equal(missingKey.status, 428);
  assert.equal(dispatched, false);
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

function request(etag: string, key: string): Request {
  const headers = new Headers({
    cookie: "nrt_session=opaque",
    host: "nuriteo.example.test",
    origin: ORIGIN,
    "content-type": "application/json",
    "if-match": etag,
    "x-csrf-token": "nrt_csrf_integration-ca"
  });
  if (key !== "") headers.set("idempotency-key", key);
  return new Request(`${ORIGIN}${PATH}`, {
    body: JSON.stringify({ pem: "-----BEGIN CERTIFICATE-----\nopaque\n-----END CERTIFICATE-----\n" }),
    headers,
    method: "POST"
  });
}
