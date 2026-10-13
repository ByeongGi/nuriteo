import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  createApiClient,
  getAdminOperations,
  getAdminStatus,
  listAdminSettings,
  previewAdminPolicyChange,
  previewAdminPolicyCleanup,
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
    json(operations()),
    json(setting(2, 336)),
    json(policyImpact()),
    json(cleanupPreview())
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
  const operationsResult = await getAdminOperations(client);
  assert.equal(operationsResult.data.dependencies.category, "object_storage");
  assert.equal(operationsResult.data.usage.trackedPhysicalBytes, "1073741824");
  const updated = await updateAdminSetting(
    client,
    { key: "invitations.default_expiry_hours", value: 336, version: 1 },
    { csrfToken: CSRF }
  );
  assert.equal(updated.data.version, 2);
  const impact = await previewAdminPolicyChange(
    client,
    "workspace.personal_default_quota_bytes",
    1_048_576,
    { csrfToken: CSRF }
  );
  assert.equal(impact.data.nonCompliantResources, 2);
  assert.equal(impact.data.automaticallyDeletesExistingData, false);
  const cleanup = await previewAdminPolicyCleanup(client, 25);
  assert.equal(cleanup.data.expectedReclaimBytes, "4096");

  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/admin/settings"],
    ["GET", "/api/v1/admin/status"],
    ["GET", "/api/v1/admin/operations"],
    ["PATCH", "/api/v1/admin/settings/invitations.default_expiry_hours"],
    ["POST", "/api/v1/admin/settings/workspace.personal_default_quota_bytes/impact"],
    ["GET", "/api/v1/admin/policy-cleanup/preview?batchLimit=25"]
  ]);
  const headers = new Headers(calls[3]?.init?.headers);
  assert.equal(headers.get("x-csrf-token"), CSRF);
  assert.equal(headers.get("if-match"), '"setting-v1"');
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { value: 336 });
}

async function rejectsMalformedResponses(): Promise<void> {
  const badPayloads = [
    { registryVersion: 1, items: [{ ...setting(1, 168), constraint: { kind: "unsigned_integer", minimum: 10, maximum: 1 } }] },
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
    () => getAdminOperations(single({
      ...operations(),
      usage: { ...operations().usage, trackedPhysicalBytes: "-1" }
    })),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => getAdminOperations(single({
      ...operations(),
      dependencies: { state: "nominal", category: "object_storage" }
    })),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => getAdminOperations(single({
      ...operations(),
      supportBundle: { ...operations().supportBundle, maximumBytes: 1_000_000 }
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
  await assert.rejects(
    () => previewAdminPolicyChange(
      single({ ...policyImpact(), automaticallyDeletesExistingData: true }),
      "workspace.personal_default_quota_bytes",
      1_048_576,
      { csrfToken: CSRF }
    ),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => previewAdminPolicyCleanup(single({ ...cleanupPreview(), dryRun: false })),
    ApiInvalidResponseError
  );
}

function policyImpact() {
  return {
    key: "workspace.personal_default_quota_bytes",
    direction: "decrease",
    applyScope: "new_operations",
    affectedResources: 4,
    nonCompliantResources: 2,
    gracePeriodSeconds: 0,
    requiresRecentReauthentication: true,
    automaticallyDeletesExistingData: false
  };
}

function cleanupPreview() {
  return {
    gcEnabled: true,
    gracePeriodSeconds: 86_400,
    eligibleCandidates: 3,
    expectedReclaimBytes: "4096",
    batchLimit: 25,
    dryRun: true
  };
}

function operations() {
  return {
    generatedAt: "2026-10-07T12:00:00Z",
    overallState: "degraded",
    dependencies: { state: "degraded", category: "object_storage" },
    cleanup: {
      state: "nominal",
      queueDepth: 2,
      oldestEligibleAgeSeconds: 30,
      runningCount: 1,
      retryCount: 1,
      failedCount: 0
    },
    usage: {
      state: "nominal",
      activeUsers: 3,
      activeOrganizations: 1,
      activeProjects: 4,
      verifiedBundles: 8,
      trackedPhysicalBytes: "1073741824",
      reservedBytes: "1024"
    },
    supportBundle: {
      format: "nuriteo-support-bundle-v1+json",
      maximumBytes: 65536,
      includes: ["release and health"],
      excludes: ["credentials and source"]
    }
  };
}

function setting(version: number, value: unknown) {
  return {
    key: "invitations.default_expiry_hours",
    value,
    defaultValue: 168,
    version,
    applyMode: "live",
    constraint: { kind: "unsigned_integer", minimum: 1, maximum: 720 },
    policyCategory: "identity"
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
