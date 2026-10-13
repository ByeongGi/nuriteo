import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  activateOidcProvider,
  createApiClient,
  createOidcProvider,
  deleteOidcProvider,
  disableOidcProvider,
  listAdminOidcProviders,
  listOidcIdentities,
  listOidcLoginProviders,
  rotateOidcProviderSecret,
  unlinkOidcIdentity,
  updateOidcProvider
} from "../src/index.ts";

const PROVIDER_ID = "0199ee6c-c777-7000-8000-000000050001";
const CSRF = "nrt_csrf_oidc-contract";

await lifecycleContract();
await malformedResponsesFailClosed();

async function lifecycleContract() {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const responses = [
    json({ items: [{ id: PROVIDER_ID, displayName: "Corporate SSO" }] }),
    json({ items: [identity()] }),
    new Response(null, { status: 204 }),
    json({ items: [provider()] }),
    json(provider(), 201), json(provider()), json(provider()), json(provider()), json(provider()),
    new Response(null, { status: 204 })
  ];
  const client = createApiClient({ fetch: async (input, init) => { calls.push({ input, ...(init ? { init } : {}) }); return responses.shift()!; } });
  await listOidcLoginProviders(client);
  await listOidcIdentities(client);
  await unlinkOidcIdentity(client, PROVIDER_ID, { csrfToken: CSRF });
  await listAdminOidcProviders(client);
  await createOidcProvider(client, { displayName: "Corporate SSO", issuer: "https://id.example.test", clientId: "nuriteo", clientSecret: "secret" }, { csrfToken: CSRF });
  await updateOidcProvider(client, PROVIDER_ID, 1, { displayName: "Work SSO", clientId: "nuriteo-web" }, { csrfToken: CSRF });
  await disableOidcProvider(client, PROVIDER_ID, 1, { csrfToken: CSRF });
  await rotateOidcProviderSecret(client, PROVIDER_ID, 1, "replacement", { csrfToken: CSRF });
  await activateOidcProvider(client, PROVIDER_ID, 1, "https://app.example.test/api/v1/auth/oidc/callback", { csrfToken: CSRF });
  await deleteOidcProvider(client, PROVIDER_ID, 1, { csrfToken: CSRF });
  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/auth/oidc/providers"], ["GET", "/api/v1/me/oidc-identities"],
    ["DELETE", `/api/v1/me/oidc-identities/${PROVIDER_ID}`], ["GET", "/api/v1/admin/oidc/providers"],
    ["POST", "/api/v1/admin/oidc/providers"], ["PATCH", `/api/v1/admin/oidc/providers/${PROVIDER_ID}`],
    ["POST", `/api/v1/admin/oidc/providers/${PROVIDER_ID}/disable`],
    ["POST", `/api/v1/admin/oidc/providers/${PROVIDER_ID}/rotate-secret`],
    ["POST", `/api/v1/admin/oidc/providers/${PROVIDER_ID}/activate`],
    ["DELETE", `/api/v1/admin/oidc/providers/${PROVIDER_ID}`]
  ]);
  assert.equal(new Headers(calls[5]?.init?.headers).get("if-match"), '"oidc-provider-v1"');
  assert.equal(new Headers(calls[5]?.init?.headers).get("x-csrf-token"), CSRF);
}

async function malformedResponsesFailClosed() {
  await assert.rejects(() => listAdminOidcProviders(single({ items: [{ ...provider(), clientSecret: "leak" }] })), ApiInvalidResponseError);
  await assert.rejects(() => listOidcLoginProviders(single({ items: [{ id: PROVIDER_ID, displayName: "SSO", issuer: "leak" }] })), ApiInvalidResponseError);
}

function provider() { return { id: PROVIDER_ID, displayName: "Corporate SSO", issuer: "https://id.example.test", clientId: "nuriteo", state: "disabled", configVersion: 1, secretVersion: 1, linkedIdentityCount: 0, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }; }
function identity() { return { providerId: PROVIDER_ID, providerDisplayName: "Corporate SSO", linkedAt: "2026-10-08T00:00:00Z", lastAuthenticatedAt: "2026-10-08T00:00:00Z" }; }
function single(payload: unknown) { return createApiClient({ fetch: async () => json(payload) }); }
function json(payload: unknown, status = 200) { return Response.json(payload, { status }); }
