import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  activateRegistry,
  createApiClient,
  createRegistry,
  deleteRegistry,
  disableRegistry,
  listRegistries,
  mapRegistryScope,
  renameRegistry,
  rotateRegistryToken,
  setDefaultRegistry
} from "../src/index.ts";

const REGISTRY_ID = "0199ee6c-c777-7000-8000-000000070001";
const CSRF = "nrt_csrf_registry-contract";

await lifecycleContract();
await malformedResponsesFailClosed();

async function lifecycleContract() {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const responses = [
    json({ items: [registry()], scopes: [{ scope: "@company", connectionId: REGISTRY_ID }] }),
    json(registry()),
    json(registry()),
    json(registry()),
    json(registry()),
    json(registry()),
    json(registry()),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 })
  ];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return responses.shift()!;
    }
  });

  await listRegistries(client);
  await createRegistry(client, {
    displayName: "Company npm",
    baseUrl: "https://registry.example.test/npm",
    token: "create-secret"
  }, { csrfToken: CSRF });
  await renameRegistry(client, REGISTRY_ID, 2, "Engineering npm", { csrfToken: CSRF });
  await rotateRegistryToken(client, REGISTRY_ID, 3, "replacement-secret", { csrfToken: CSRF });
  await activateRegistry(client, REGISTRY_ID, 4, { csrfToken: CSRF });
  await setDefaultRegistry(client, REGISTRY_ID, 5, { csrfToken: CSRF });
  await disableRegistry(client, REGISTRY_ID, 6, { csrfToken: CSRF });
  await mapRegistryScope(client, "@company", REGISTRY_ID, { csrfToken: CSRF });
  await deleteRegistry(client, REGISTRY_ID, 7, { csrfToken: CSRF });

  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/admin/registries"],
    ["POST", "/api/v1/admin/registries"],
    ["PATCH", `/api/v1/admin/registries/${REGISTRY_ID}`],
    ["POST", `/api/v1/admin/registries/${REGISTRY_ID}/rotate-token`],
    ["POST", `/api/v1/admin/registries/${REGISTRY_ID}/activate`],
    ["POST", `/api/v1/admin/registries/${REGISTRY_ID}/default`],
    ["POST", `/api/v1/admin/registries/${REGISTRY_ID}/disable`],
    ["POST", "/api/v1/admin/registry-scopes"],
    ["DELETE", `/api/v1/admin/registries/${REGISTRY_ID}`]
  ]);
  assert.equal(new Headers(calls[2]?.init?.headers).get("if-match"), '"registry-v2"');
  assert.equal(new Headers(calls[2]?.init?.headers).get("x-csrf-token"), CSRF);
}

async function malformedResponsesFailClosed() {
  await assert.rejects(
    () => listRegistries(single({ items: [{ ...registry(), token: "leak" }], scopes: [] })),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => listRegistries(single({ items: [registry()], scopes: [{ scope: "@company", connectionId: REGISTRY_ID, fallback: true }] })),
    ApiInvalidResponseError
  );
}

function registry() {
  return {
    id: REGISTRY_ID,
    displayName: "Company npm",
    baseUrl: "https://registry.example.test/npm",
    state: "disabled",
    isDefault: false,
    configVersion: 2,
    credentialVersion: 1,
    validatedAt: null
  };
}

function single(payload: unknown) {
  return createApiClient({ fetch: async () => json(payload) });
}

function json(payload: unknown) {
  return Response.json(payload);
}
