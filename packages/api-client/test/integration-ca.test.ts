import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  activateIntegrationCa,
  createApiClient,
  listIntegrationCas,
  stageIntegrationCa
} from "../src/index.ts";

const INTEGRATION_ID = "0199ee6c-c777-7000-8000-000000090101";
const CANDIDATE_ID = "0199ee6c-c777-7000-8000-000000090102";
const CSRF = "nrt_csrf_integration-ca";
const KEY = "integration-ca-test-0001";

const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const client = createApiClient({
  fetch: async (input, init) => {
    calls.push({ input, ...(init === undefined ? {} : { init }) });
    if (calls.length === 1) return json({ items: [], version: 0 });
    return json(bundle(calls.length === 2 ? "candidate" : "active"), calls.length === 2 ? 201 : 200);
  }
});

await listIntegrationCas(client, "oidc", INTEGRATION_ID);
await stageIntegrationCa(client, "oidc", INTEGRATION_ID, 0, "-----BEGIN CERTIFICATE-----\nopaque\n-----END CERTIFICATE-----\n", {
  csrfToken: CSRF,
  idempotencyKey: KEY
});
await activateIntegrationCa(client, "oidc", INTEGRATION_ID, CANDIDATE_ID, 1, {
  csrfToken: CSRF,
  idempotencyKey: `${KEY}-activate`
});

assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
  ["GET", `/api/v1/admin/integrations/oidc/${INTEGRATION_ID}/ca`],
  ["POST", `/api/v1/admin/integrations/oidc/${INTEGRATION_ID}/ca/candidates`],
  ["POST", `/api/v1/admin/integrations/oidc/${INTEGRATION_ID}/ca/candidates/${CANDIDATE_ID}/activate`]
]);
assert.equal(new Headers(calls[1]?.init?.headers).get("if-match"), '"integration-ca-v0"');
assert.equal(new Headers(calls[2]?.init?.headers).get("if-match"), '"integration-ca-v1"');
assert.equal(new Headers(calls[1]?.init?.headers).get("idempotency-key"), KEY);
assert.equal(new Headers(calls[2]?.init?.headers).get("x-csrf-token"), CSRF);

await assert.rejects(
  () => listIntegrationCas(single({ items: [bundle("candidate", { pem: "leaked" })], version: 1 }), "oidc", INTEGRATION_ID),
  ApiInvalidResponseError
);
await assert.rejects(
  () => listIntegrationCas(single({ items: [bundle("candidate", { endpoint: "private.internal" })], version: 1 }), "oidc", INTEGRATION_ID),
  ApiInvalidResponseError
);

function bundle(state: "active" | "candidate", extra: Record<string, unknown> = {}) {
  return {
    earliestExpiry: "2027-10-08T00:00:00Z",
    fingerprints: ["a".repeat(64)],
    id: CANDIDATE_ID,
    integrationId: INTEGRATION_ID,
    integrationType: "oidc",
    state,
    version: 1,
    ...extra
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "request-integration-ca" }
  });
}

function single(value: unknown) {
  return createApiClient({ fetch: async () => json(value) });
}
