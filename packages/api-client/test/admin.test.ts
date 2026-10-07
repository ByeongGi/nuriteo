import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  createApiClient,
  getAdminStatus,
  listAdminSettings,
  updateAdminSetting
} from "../src/index.ts";

const CSRF = "nrt_csrf_administrator";

await contracts();
await rejectsMalformedResponses();

async function contracts(): Promise<void> {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const responses = [
    json({ registryVersion: 1, items: [setting(1, 168)] }),
    json({
      releaseVersion: "0.1.0-beta.1",
      schemaVersion: 24,
      settingRegistryVersion: 1,
      settingCount: 10,
      restartRequired: false
    }),
    json(setting(2, 336))
  ];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  const listed = await listAdminSettings(client);
  assert.equal(listed.data.items[0]?.value, 168);
  const status = await getAdminStatus(client);
  assert.equal(status.data.settingCount, 10);
  const updated = await updateAdminSetting(
    client,
    { key: "invitations.default_expiry_hours", value: 336, version: 1 },
    { csrfToken: CSRF }
  );
  assert.equal(updated.data.version, 2);

  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/admin/settings"],
    ["GET", "/api/v1/admin/status"],
    ["PATCH", "/api/v1/admin/settings/invitations.default_expiry_hours"]
  ]);
  const headers = new Headers(calls[2]?.init?.headers);
  assert.equal(headers.get("x-csrf-token"), CSRF);
  assert.equal(headers.get("if-match"), '"setting-v1"');
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { value: 336 });
}

async function rejectsMalformedResponses(): Promise<void> {
  const badPayloads = [
    { registryVersion: 1, items: [setting(1, true)] },
    { registryVersion: 1, items: [{ ...setting(1, 168), secret: "no" }] },
    { registryVersion: 1, items: [setting(1, 168), setting(2, 336)] },
    { registryVersion: 0, items: [] }
  ];
  for (const payload of badPayloads) {
    await assert.rejects(() => listAdminSettings(single(payload)), ApiInvalidResponseError);
  }
  await assert.rejects(
    () => getAdminStatus(single({
      releaseVersion: "beta",
      schemaVersion: -1,
      settingRegistryVersion: 1,
      settingCount: 10,
      restartRequired: false
    })),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => updateAdminSetting(
      single(setting(1, 168)),
      { key: "../unsafe", value: 3, version: 1 },
      { csrfToken: CSRF }
    ),
    /invalid setting key/u
  );
}

function setting(version: number, value: unknown) {
  return {
    key: "invitations.default_expiry_hours",
    value,
    version,
    applyMode: "live"
  };
}

function single(payload: unknown) {
  return createApiClient({ fetch: async () => json(payload) });
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "admin-test" }
  });
}
