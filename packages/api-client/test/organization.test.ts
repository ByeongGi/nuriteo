import assert from "node:assert/strict";

import {
  ApiAbortError,
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  ApiTimeoutError,
  acceptOrganizationInvitation,
  activateAccount,
  archiveOrganization,
  changeOrganizationMemberRole,
  createApiClient,
  createOrganization,
  declineOrganizationInvitation,
  getOrganization,
  issueActivationInvitation,
  issueOrganizationInvitation,
  listActivationInvitations,
  listOrganizationInvitations,
  listOrganizationMembers,
  reissueActivationInvitation,
  reissueOrganizationInvitation,
  removeOrganizationMember,
  revokeActivationInvitation,
  revokeOrganizationInvitation,
  updateOrganization
} from "../src/index.ts";
import type { IssueOrganizationInvitationInput, ProblemDetails } from "../src/index.ts";

const ORGANIZATION_ID = "018f22c4-3cb5-7ac7-b464-8214f90ad21a";
const OTHER_ORGANIZATION_ID = "018f22c4-3cb6-7f25-823e-649318d8e0b8";
const USER_ID = "018f22c4-3cb2-7cc8-98d8-b4f7f753f7bb";
const INVITATION_ID = "018f22c4-3cb7-7ee1-936c-4a54190dc872";
const REPLACEMENT_INVITATION_ID = "018f22c4-3cb8-77f8-b711-415364ce1d14";
const CSRF = "nrt_csrf_client005";
const ACTIVATION_TOKEN = `nrt_inv_${"A".repeat(43)}`;
const ORGANIZATION_TOKEN = `nrt_org_inv_${"B".repeat(43)}`;
const MEMBER_EMAIL = "member@example.test";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
const issueInputKeysAreExact: Equal<
  keyof IssueOrganizationInvitationInput,
  "email" | "organizationId" | "role"
> = true;
assert.equal(issueInputKeysAreExact, true);

await testActivationInvitationContracts();
await testOrganizationContracts();
await testUnicodeInvitationEmailContracts();
await testFailClosedBoundaries();
await testProblemAndCancellationPassthrough();

async function testActivationInvitationContracts(): Promise<void> {
  const calls: RequestCall[] = [];
  const queue = [
    jsonResponse(issuedActivation(), 201),
    jsonResponse({ items: [activationInvitation()] }),
    jsonResponse(issuedActivation(), 200),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 })
  ];
  const client = recordingClient(calls, queue);

  const issued = await issueActivationInvitation(
    client,
    { email: "member@example.test", expiresInSeconds: 604_800 },
    { csrfToken: CSRF }
  );
  assert.equal(issued.status, 201);
  assert.equal(issued.data.delivery, "copy_once");
  assert.doesNotMatch(JSON.stringify(issued), /nrt_inv_|activation_url/u);
  const oneTimeActivationUrl = issued.data.activationUrl;
  const activationUrl = oneTimeActivationUrl.consume();
  assert.equal(new URL(activationUrl).searchParams.get("token"), ACTIVATION_TOKEN);
  assert.throws(() => oneTimeActivationUrl.consume(), /already been consumed/u);

  const queued = await issueActivationInvitation(
    singleResponse({ ...issuedActivation(), delivery: "email_queued", activation_url: null }, 201),
    { email: "queued@example.test" },
    { csrfToken: CSRF }
  );
  assert.equal(queued.data.delivery, "email_queued");
  assert.equal(queued.data.activationUrl, null);

  const listed = await listActivationInvitations(client);
  assert.equal(listed.data.items.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), /activation_url|token|digest/u);

  const reissued = await reissueActivationInvitation(
    client,
    { invitationId: INVITATION_ID },
    { csrfToken: CSRF }
  );
  assert.equal(reissued.data.delivery, "copy_once");
  assert.equal(reissued.data.activationUrl.toString(), "[REDACTED]");
  await revokeActivationInvitation(client, INVITATION_ID, { csrfToken: CSRF });
  await activateAccount(client, {
    token: ACTIVATION_TOKEN,
    email: "member@example.test",
    displayName: "Member",
    password: "do-not-log-password"
  });

  assertCalls(calls, [
    ["POST", "/api/v1/admin/activation-invitations", { email: "member@example.test", expires_in_seconds: 604_800 }, true],
    ["GET", "/api/v1/admin/activation-invitations", undefined, false],
    ["POST", `/api/v1/admin/activation-invitations/${INVITATION_ID}/reissue`, {}, true],
    ["DELETE", `/api/v1/admin/activation-invitations/${INVITATION_ID}`, undefined, true],
    ["POST", "/api/v1/auth/activation", { token: ACTIVATION_TOKEN, email: "member@example.test", display_name: "Member", password: "do-not-log-password" }, false]
  ]);
}

async function testOrganizationContracts(): Promise<void> {
  const calls: RequestCall[] = [];
  const org1 = organization(1);
  const org2 = organization(2);
  const archived = { ...organization(3), status: "archived", archivedAt: "2026-10-04T02:00:00Z" };
  const queue = [
    organizationResponse(org1, 201, '"org-v1"', `/api/v1/organizations/${ORGANIZATION_ID}`),
    organizationResponse(org1, 200, '"org-v1"'),
    organizationResponse(org2, 200, '"org-v2"'),
    organizationResponse(archived, 200, '"org-v3"'),
    jsonResponse({ items: [{ userId: USER_ID, displayName: "Owner", role: "owner" }] }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    jsonResponse({ items: [organizationInvitation()] }),
    jsonResponse(issuedOrganizationInvitation(), 201),
    jsonResponse(
      issuedOrganizationInvitation({
        id: REPLACEMENT_INVITATION_ID,
        proposedRole: "owner"
      }),
      200
    ),
    new Response(null, { status: 204 }),
    jsonResponse({ ...organizationInvitation(), status: "accepted", acceptedAt: "2026-10-04T01:00:00Z" }),
    jsonResponse({ ...organizationInvitation(), status: "declined", declinedAt: "2026-10-04T01:00:00Z" })
  ];
  const client = recordingClient(calls, queue);

  const created = await createOrganization(
    client,
    { slug: "platform", displayName: "Platform" },
    { csrfToken: CSRF }
  );
  assert.equal(created.etag, '"org-v1"');
  assert.equal(created.location, `/api/v1/organizations/${ORGANIZATION_ID}`);
  await getOrganization(client, ORGANIZATION_ID);
  const updated = await updateOrganization(
    client,
    { organizationId: ORGANIZATION_ID, displayName: "Platform Engineering", etag: created.etag },
    { csrfToken: CSRF }
  );
  assert.equal(updated.etag, '"org-v2"');
  await archiveOrganization(
    client,
    { organizationId: ORGANIZATION_ID, etag: updated.etag },
    { csrfToken: CSRF }
  );
  await listOrganizationMembers(client, ORGANIZATION_ID);
  await changeOrganizationMemberRole(
    client,
    { organizationId: ORGANIZATION_ID, userId: USER_ID, role: "member" },
    { csrfToken: CSRF }
  );
  await removeOrganizationMember(
    client,
    { organizationId: ORGANIZATION_ID, userId: USER_ID },
    { csrfToken: CSRF }
  );
  const invitations = await listOrganizationInvitations(client, ORGANIZATION_ID);
  assert.doesNotMatch(JSON.stringify(invitations), /acceptUrl|token|digest/u);
  const issued = await issueOrganizationInvitation(
    client,
    { organizationId: ORGANIZATION_ID, email: "Member@Example.Test", role: "member" },
    { csrfToken: CSRF }
  );
  assert.doesNotMatch(JSON.stringify(issued), /nrt_org_inv_/u);
  assert.equal(issued.data.delivery, "copy_once");
  assert.equal(
    new URL(issued.data.acceptUrl.consume()).searchParams.get("token"),
    ORGANIZATION_TOKEN
  );
  const queued = await issueOrganizationInvitation(
    singleResponse(
      { ...issuedOrganizationInvitation(), delivery: "email_queued", acceptUrl: null },
      201
    ),
    { organizationId: ORGANIZATION_ID, email: MEMBER_EMAIL, role: "member" },
    { csrfToken: CSRF }
  );
  assert.equal(queued.data.delivery, "email_queued");
  assert.equal(queued.data.acceptUrl, null);
  await reissueOrganizationInvitation(
    client,
    { organizationId: ORGANIZATION_ID, invitationId: INVITATION_ID, role: "owner" },
    { csrfToken: CSRF }
  );
  await revokeOrganizationInvitation(
    client,
    { organizationId: ORGANIZATION_ID, invitationId: INVITATION_ID },
    { csrfToken: CSRF }
  );
  await acceptOrganizationInvitation(client, ORGANIZATION_TOKEN, { csrfToken: CSRF });
  await declineOrganizationInvitation(client, ORGANIZATION_TOKEN, { csrfToken: CSRF });

  const mutationCalls = calls.filter((call) => !["GET"].includes(call.init?.method ?? ""));
  for (const call of mutationCalls) {
    const headers = new Headers(call.init?.headers);
    assert.equal([...headers.keys()].filter((name) => name === "x-csrf-token").length, 1);
  }
  assert.equal(new Headers(calls[2]?.init?.headers).get("if-match"), '"org-v1"');
  assert.equal(new Headers(calls[3]?.init?.headers).get("if-match"), '"org-v2"');
  assert.deepEqual(requestBody(calls[8]), { email: MEMBER_EMAIL, role: "member" });
  assert.deepEqual(Object.keys(requestBody(calls[8]) as object).toSorted(), ["email", "role"]);
}

async function testUnicodeInvitationEmailContracts(): Promise<void> {
  const exactScalarBoundary = `${"😀".repeat(313)}@x.test`;
  assert.equal(Array.from(exactScalarBoundary).length, 320);

  for (const email of ["사용자@example.test", exactScalarBoundary]) {
    let body: unknown;
    const client = createApiClient({
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(issuedOrganizationInvitation(), 201);
      }
    });
    await issueOrganizationInvitation(
      client,
      { organizationId: ORGANIZATION_ID, email, role: "member" },
      { csrfToken: CSRF }
    );
    assert.deepEqual(body, { email, role: "member" });
  }
}

async function testFailClosedBoundaries(): Promise<void> {
  const invalidPayloads: Array<() => Promise<unknown>> = [
    () => listActivationInvitations(singleResponse({ items: [{ ...activationInvitation(), activation_url: "https://example.test/activate?token=secret" }] })),
    () => listActivationInvitations(singleResponse({ items: Array.from({ length: 101 }, activationInvitation) })),
    () => listOrganizationMembers(singleResponse({ items: [{ userId: USER_ID, displayName: "x".repeat(201), role: "owner" }] }), ORGANIZATION_ID),
    () => listOrganizationInvitations(singleResponse({ items: [{ ...organizationInvitation(), token_digest: "secret" }] }), ORGANIZATION_ID),
    () => issueOrganizationInvitation(singleResponse({ ...issuedOrganizationInvitation(), acceptUrl: "https://example.test/wrong?token=secret" }, 201), { organizationId: ORGANIZATION_ID, email: MEMBER_EMAIL, role: "member" }, { csrfToken: CSRF }),
    () => getOrganization(singleResponse(organization(1), 200, { etag: 'W/"org-v1"' }), ORGANIZATION_ID),
    () => getOrganization(singleResponse(organization(1)), ORGANIZATION_ID)
  ];
  for (const operation of invalidPayloads) {
    await assert.rejects(operation(), ApiInvalidResponseError);
  }

  const malformedIssuedInvitations: Array<() => Promise<unknown>> = [
    () => issueWithResponse({ organizationId: OTHER_ORGANIZATION_ID }),
    () => issueWithResponse({ proposedRole: "owner" }),
    () => issueWithResponse({ status: "accepted", acceptedAt: "2026-10-04T01:00:00Z" }),
    () => reissueWithResponse({
      id: REPLACEMENT_INVITATION_ID,
      organizationId: OTHER_ORGANIZATION_ID
    }),
    () => reissueWithResponse({ id: REPLACEMENT_INVITATION_ID, proposedRole: "owner" }),
    () => reissueWithResponse({
      id: REPLACEMENT_INVITATION_ID,
      status: "accepted",
      acceptedAt: "2026-10-04T01:00:00Z"
    }),
    () => reissueWithResponse({ id: INVITATION_ID }),
    () => acceptWithResponse({}),
    () => acceptWithResponse({
      status: "declined",
      declinedAt: "2026-10-04T01:00:00Z"
    }),
    () => declineWithResponse({}),
    () => declineWithResponse({
      status: "accepted",
      acceptedAt: "2026-10-04T01:00:00Z"
    })
  ];
  for (const operation of malformedIssuedInvitations) {
    await assert.rejects(operation(), ApiInvalidResponseError);
  }

  const normalized = await listOrganizationInvitations(
    singleResponse({
      items: [{
        ...organizationInvitation(),
        createdAt: "2026-10-04 00:00:00.123456 +00:00:00",
        expiresAt: "2026-10-11 00:00:00.123456 +00:00:00"
      }]
    }),
    ORGANIZATION_ID
  );
  assert.equal(normalized.data.items[0]?.createdAt, "2026-10-04T00:00:00.123456Z");

  await assert.rejects(
    updateOrganization(singleResponse(organization(2)), { organizationId: ORGANIZATION_ID, displayName: "X", etag: 'W/"org-v1"' }, { csrfToken: CSRF }),
    ApiConfigurationError
  );
  await assert.rejects(
    createOrganization(singleResponse(organization(1)), { slug: "x", displayName: "X" }, { csrfToken: "line\nbreak" }),
    ApiConfigurationError
  );

  for (const email of [
    " x@example.test",
    "x@example.test ",
    "ab",
    "x".repeat(321),
    "x\u0085@example.test",
    "x\ud800@example.test",
    "x\udc00@example.test"
  ]) {
    let requested = false;
    const client = createApiClient({
      fetch: async () => {
        requested = true;
        throw new Error("invalid invitation input must not reach fetch");
      }
    });
    await assert.rejects(
      issueOrganizationInvitation(
        client,
        { organizationId: ORGANIZATION_ID, email, role: "member" },
        { csrfToken: CSRF }
      ),
      ApiConfigurationError
    );
    assert.equal(requested, false);
  }

  let legacyRequested = false;
  const legacyClient = createApiClient({
    fetch: async () => {
      legacyRequested = true;
      throw new Error("legacy invitation input must not reach fetch");
    }
  });
  await assert.rejects(
    issueOrganizationInvitation(
      legacyClient,
      {
        organizationId: ORGANIZATION_ID,
        email: MEMBER_EMAIL,
        inviteeUserId: USER_ID,
        role: "member"
      } as unknown as IssueOrganizationInvitationInput,
      { csrfToken: CSRF }
    ),
    ApiConfigurationError
  );
  assert.equal(legacyRequested, false);
}

async function testProblemAndCancellationPassthrough(): Promise<void> {
  for (const status of [401, 403, 404, 409, 422]) {
    const problem: ProblemDetails = {
      type: "/docs/problems/organization-invitation",
      title: "Organization invitation unavailable",
      status,
      detail: "The requested operation is unavailable.",
      instance: `/api/v1/organizations/${ORGANIZATION_ID}/invitations`,
      code: `STATUS_${status}`,
      request_id: `request-${status}`,
      errors: []
    };
    await assert.rejects(
      issueOrganizationInvitation(
        singleResponse(problem, status),
        { organizationId: ORGANIZATION_ID, email: "Private.Member@Example.Test", role: "member" },
        { csrfToken: CSRF }
      ),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, status);
        assert.equal(error.problem?.code, problem.code);
        assert.doesNotMatch(String(error), /private|member@example|token|credential/ui);
        assert.doesNotMatch(JSON.stringify(error), /private|member@example|token|credential/ui);
        assert.doesNotMatch(JSON.stringify(error.problem), /private|member@example|token|credential/ui);
        return true;
      }
    );
  }

  for (const status of [409, 412, 428]) {
    const problem: ProblemDetails = {
      type: "/docs/problems/precondition",
      title: "Precondition failed",
      status,
      detail: "The request cannot be applied.",
      instance: `/api/v1/organizations/${ORGANIZATION_ID}`,
      code: `STATUS_${status}`,
      request_id: `request-${status}`,
      errors: []
    };
    await assert.rejects(
      getOrganization(singleResponse(problem, status), ORGANIZATION_ID),
      (error) => error instanceof ApiError && error.status === status && error.problem?.code === problem.code
    );
  }

  const abort = new AbortController();
  const pending = createApiClient({ fetch: pendingFetch });
  const aborted = listOrganizationMembers(pending, ORGANIZATION_ID, { signal: abort.signal });
  abort.abort("secret abort reason");
  await assert.rejects(aborted, ApiAbortError);
  await assert.rejects(
    listActivationInvitations(pending, { timeoutMs: 1 }),
    ApiTimeoutError
  );
}

interface RequestCall {
  readonly init: RequestInit | undefined;
  readonly url: string;
}

function recordingClient(calls: RequestCall[], responses: Response[]) {
  return createApiClient({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      assert.ok(response, "unexpected request");
      return response;
    }
  });
}

function singleResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return createApiClient({ fetch: async () => jsonResponse(body, status, headers) });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

function issueWithResponse(overrides: Record<string, unknown>): Promise<unknown> {
  return issueOrganizationInvitation(
    singleResponse(issuedOrganizationInvitation(overrides), 201),
    { organizationId: ORGANIZATION_ID, email: MEMBER_EMAIL, role: "member" },
    { csrfToken: CSRF }
  );
}

function reissueWithResponse(overrides: Record<string, unknown>): Promise<unknown> {
  return reissueOrganizationInvitation(
    singleResponse(issuedOrganizationInvitation(overrides), 200),
    { organizationId: ORGANIZATION_ID, invitationId: INVITATION_ID, role: "member" },
    { csrfToken: CSRF }
  );
}

function acceptWithResponse(overrides: Record<string, unknown>): Promise<unknown> {
  return acceptOrganizationInvitation(
    singleResponse(organizationInvitation(overrides)),
    ORGANIZATION_TOKEN,
    { csrfToken: CSRF }
  );
}

function declineWithResponse(overrides: Record<string, unknown>): Promise<unknown> {
  return declineOrganizationInvitation(
    singleResponse(organizationInvitation(overrides)),
    ORGANIZATION_TOKEN,
    { csrfToken: CSRF }
  );
}

function requestBody(call: RequestCall | undefined): unknown {
  assert.ok(call?.init?.body !== undefined);
  return JSON.parse(String(call.init.body)) as unknown;
}

function organizationResponse(
  body: unknown,
  status: number,
  etag: string,
  location?: string
): Response {
  return jsonResponse(body, status, {
    etag,
    ...(location === undefined ? {} : { location })
  });
}

function organization(version: number): Record<string, unknown> {
  return {
    id: ORGANIZATION_ID,
    slug: "platform",
    displayName: "Platform",
    status: "active",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    archivedAt: null,
    version
  };
}

function activationInvitation(): Record<string, unknown> {
  return {
    id: INVITATION_ID,
    email: "member@example.test",
    status: "pending",
    created_at: "2026-10-04T00:00:00Z",
    expires_at: "2026-10-11T00:00:00Z",
    accepted_at: null,
    revoked_at: null,
    superseded_at: null,
    replacement_id: null
  };
}

function issuedActivation(): Record<string, unknown> {
  return {
    ...activationInvitation(),
    delivery: "copy_once",
    activation_url: `https://example.test/activate?token=${ACTIVATION_TOKEN}`
  };
}

function organizationInvitation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INVITATION_ID,
    organizationId: ORGANIZATION_ID,
    inviteeUserId: USER_ID,
    proposedRole: "member",
    status: "pending",
    createdAt: "2026-10-04T00:00:00Z",
    expiresAt: "2026-10-11T00:00:00Z",
    acceptedAt: null,
    declinedAt: null,
    expiredAt: null,
    revokedAt: null,
    supersededAt: null,
    replacementId: null,
    ...overrides
  };
}

function issuedOrganizationInvitation(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...organizationInvitation(overrides),
    delivery: "copy_once",
    acceptUrl: `https://example.test/organization-invitations/accept?token=${ORGANIZATION_TOKEN}`
  };
}

function assertCalls(
  calls: readonly RequestCall[],
  expected: readonly (readonly [string, string, unknown, boolean])[]
): void {
  assert.equal(calls.length, expected.length);
  expected.forEach(([method, url, body, csrf], index) => {
    const call = calls[index];
    assert.equal(call?.init?.method, method);
    assert.equal(call?.url, url);
    assert.deepEqual(call?.init?.body === undefined ? undefined : JSON.parse(String(call.init.body)), body);
    assert.equal(new Headers(call?.init?.headers).has("x-csrf-token"), csrf);
  });
}

async function pendingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("secret reason")), { once: true });
  });
}
