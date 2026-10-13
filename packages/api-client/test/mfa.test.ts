import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  beginMfaEnrollment,
  challengeMfa,
  confirmMfaEnrollment,
  createApiClient,
  getMfaPolicy,
  getMfaStatus,
  previewMfaPolicy,
  resetUserMfa,
  searchMfaResetTargets,
  updateMfaPolicy
} from "../src/index.ts";

const CSRF = "nrt_csrf_mfa_contract";
const USER_ID = "0199ee6c-c777-7000-8000-000000000001";
const CREDENTIAL_ID = "0199ee6c-c777-7000-8000-000000000002";
const IDEMPOTENCY_KEY = "mfa-contract-key-0001";
const POPULATION_PROOF = "p".repeat(43);
const TARGET = { userId: USER_ID, email: "target@example.test", displayName: "Target", credentialGeneration: CREDENTIAL_ID };

await contracts();
await rejectsMalformedPayloads();

async function contracts(): Promise<void> {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const responses = [
    json(status()),
    json({ credentialId: CREDENTIAL_ID, manualSecret: "JBSWY3DPEHPK3PXP", provisioningUri: "otpauth://totp/NURITEO%3Aadmin?secret=JBSWY3DPEHPK3PXP&issuer=NURITEO" }),
    json({ recoveryCodes: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"] }),
    new Response(null, { status: 204 }),
    json(policy()),
    json({ mode: "administrators", gracePeriodDays: 0, policyVersion: 1, affectedUsers: 2, unenrolledUsers: 1, immediatelyRestrictedUsers: 1, enrolledLocalAdministrators: 1, populationProof: POPULATION_PROOF }),
    json({ ...policy(), mode: "administrators", gracePeriodDays: 0, version: 2 }),
    json({ items: [TARGET] }),
    new Response(null, { status: 204 })
  ];
  const client = createApiClient({ fetch: async (input, init) => {
    calls.push({ input, ...(init === undefined ? {} : { init }) });
    const response = responses.shift();
    assert.ok(response);
    return response;
  } });

  assert.equal((await getMfaStatus(client)).data.notificationState, "grace_period");
  const enrollment = await beginMfaEnrollment(client, { csrfToken: CSRF, idempotencyKey: IDEMPOTENCY_KEY });
  assert.equal(enrollment.data.manualSecret, "JBSWY3DPEHPK3PXP");
  assert.equal((await confirmMfaEnrollment(client, { credentialId: CREDENTIAL_ID, code: "123456" }, { csrfToken: CSRF, idempotencyKey: IDEMPOTENCY_KEY })).data.recoveryCodes.length, 2);
  await challengeMfa(client, "123456", { csrfToken: CSRF, idempotencyKey: IDEMPOTENCY_KEY });
  assert.equal((await getMfaPolicy(client)).data.version, 1);
  const impact = await previewMfaPolicy(client, { mode: "administrators", gracePeriodDays: 0, version: 1 }, { csrfToken: CSRF });
  assert.equal(impact.data.immediatelyRestrictedUsers, 1);
  assert.equal((await updateMfaPolicy(client, { mode: "administrators", gracePeriodDays: 0, version: 1, populationProof: impact.data.populationProof }, { csrfToken: CSRF })).data.version, 2);
  assert.equal((await searchMfaResetTargets(client, "target@example.test")).data[0]?.email, TARGET.email);
  await resetUserMfa(client, TARGET, { csrfToken: CSRF });

  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/mfa"], ["POST", "/api/v1/mfa/enrollment"],
    ["POST", "/api/v1/mfa/enrollment/confirm"], ["POST", "/api/v1/mfa/challenge"],
    ["GET", "/api/v1/admin/mfa-policy"], ["POST", "/api/v1/admin/mfa-policy/preview"],
    ["PATCH", "/api/v1/admin/mfa-policy"], ["GET", "/api/v1/admin/mfa-reset-targets?query=target%40example.test"],
    ["POST", `/api/v1/admin/users/${USER_ID}/mfa/reset`]
  ]);
  assert.equal(new Headers(calls[5]?.init?.headers).get("if-match"), '"mfa-policy-v1"');
  assert.equal(new Headers(calls[6]?.init?.headers).get("if-match"), '"mfa-policy-v1"');
  assert.equal(new Headers(calls[6]?.init?.headers).get("x-csrf-token"), CSRF);
  assert.equal(JSON.parse(String(calls[6]?.init?.body)).populationProof, POPULATION_PROOF);
  assert.equal(new Headers(calls[1]?.init?.headers).get("idempotency-key"), IDEMPOTENCY_KEY);
  assert.doesNotMatch(String(calls[1]?.input), /JBSWY|secret|otpauth/iu);
}

async function rejectsMalformedPayloads(): Promise<void> {
  await assert.rejects(() => getMfaStatus(single({ ...status(), gracePeriodDays: 31 })), ApiInvalidResponseError);
  await assert.rejects(() => getMfaStatus(single({ ...status(), secret: "leak" })), ApiInvalidResponseError);
  await assert.rejects(() => beginMfaEnrollment(single({ credentialId: CREDENTIAL_ID, manualSecret: "bad-hex", provisioningUri: "https://example.test" }), { csrfToken: CSRF, idempotencyKey: IDEMPOTENCY_KEY }), ApiInvalidResponseError);
  await assert.rejects(() => resetUserMfa(single(null), { ...TARGET, userId: "../unsafe" }, { csrfToken: CSRF }), /invalid UUID/u);
}

function status() {
  return { localAccount: true, enrolled: false, pendingEnrollment: false, recoveryCodesRemaining: 0, policyMode: "all_local_users", gracePeriodDays: 7, required: true, deadlineAt: "2026-10-15T00:00:00Z", restricted: false, notificationState: "grace_period" };
}

function policy() {
  return { mode: "off", gracePeriodDays: 7, version: 1, affectedUsers: 0, immediatelyRestrictedUsers: 0, enrolledLocalAdministrators: 1 };
}

function single(payload: unknown) { return createApiClient({ fetch: async () => json(payload) }); }
function json(payload: unknown) { return Response.json(payload, { headers: { "x-request-id": "mfa-test" } }); }
