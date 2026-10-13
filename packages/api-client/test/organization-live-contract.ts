import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ApiError,
  acceptOrganizationInvitation,
  activateAccount,
  changeOrganizationMemberRole,
  createApiClient,
  createOrganization,
  createSession,
  declineOrganizationInvitation,
  getCurrentUser,
  getCurrentWorkspaces,
  issueActivationInvitation,
  issueOrganizationInvitation,
  listActivationInvitations,
  listOrganizationInvitations,
  listOrganizationMembers,
  reissueActivationInvitation,
  reissueOrganizationInvitation
} from "../src/index.ts";

const baseUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const adminEmail = requiredEnvironment("NURITEO_CLIENT_TEST_EMAIL");
const memberEmail = "member@example.test";
const unavailableEmail = "Missing.Member@Example.Test";
const unauthorizedTargetEmail = adminEmail.toUpperCase();
const adminPassword = await readSecret("NURITEO_CLIENT_TEST_PASSWORD_FILE");
const memberPassword = await readSecret("NURITEO_CLIENT_TEST_MEMBER_PASSWORD_FILE");
const adminBrowser = createFixtureBrowser(baseUrl);
const memberBrowser = createFixtureBrowser(baseUrl);
const publicBrowser = createFixtureBrowser(baseUrl);
const admin = createApiClient({ baseUrl, credentials: "include", fetch: adminBrowser.fetch });
const member = createApiClient({ baseUrl, credentials: "include", fetch: memberBrowser.fetch });
const activation = createApiClient({ baseUrl, fetch: publicBrowser.fetch });

await createSession(admin, { email: adminEmail, password: adminPassword });

const firstActivation = await issueActivationInvitation(admin, { email: memberEmail }, { csrfToken: adminBrowser.csrfToken() });
assert.equal(firstActivation.data.delivery, "copy_once");
const firstActivationToken = tokenFrom(firstActivation.data.activationUrl.consume(), "/activate");
const replacementActivation = await reissueActivationInvitation(
  admin,
  { invitationId: firstActivation.data.id },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(replacementActivation.data.delivery, "copy_once");
const activationToken = tokenFrom(replacementActivation.data.activationUrl.consume(), "/activate");
assert.notEqual(firstActivationToken, activationToken);
const activationList = await listActivationInvitations(admin);
assert.equal(activationList.data.items.some((item) => item.id === firstActivation.data.id && item.status === "superseded"), true);
assert.doesNotMatch(JSON.stringify(activationList), /activation_url|token|digest/u);

await activateAccount(activation, {
  token: activationToken,
  email: memberEmail,
  displayName: "Fixture Member",
  password: memberPassword
});
await createSession(member, { email: memberEmail, password: memberPassword });
const memberIdentity = await getCurrentUser(member);

const organization = await createOrganization(
  admin,
  { slug: "client005", displayName: "Client 005" },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(organization.etag, '"org-v1"');
assert.equal(organization.location, `/api/v1/organizations/${organization.data.id}`);

const firstInvitation = await issueOrganizationInvitation(
  admin,
  { organizationId: organization.data.id, email: "MeMbEr@Example.Test", role: "member" },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(firstInvitation.data.organizationId, organization.data.id);
assert.equal(firstInvitation.data.inviteeUserId, memberIdentity.data.user.id);
assert.equal(firstInvitation.data.proposedRole, "member");
assert.equal(firstInvitation.data.delivery, "copy_once");
const firstAcceptToken = tokenFrom(firstInvitation.data.acceptUrl.consume(), "/organization-invitations/accept");
const replacementInvitation = await reissueOrganizationInvitation(
  admin,
  { organizationId: organization.data.id, invitationId: firstInvitation.data.id, role: "member" },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(replacementInvitation.data.delivery, "copy_once");
const acceptToken = tokenFrom(replacementInvitation.data.acceptUrl.consume(), "/organization-invitations/accept");
assert.notEqual(firstAcceptToken, acceptToken);
await acceptOrganizationInvitation(member, acceptToken, { csrfToken: memberBrowser.csrfToken() });

const workspaces = await getCurrentWorkspaces(member);
assert.equal(workspaces.data.workspaces.length, 2);
assert.equal(workspaces.data.workspaces.some((workspace) => workspace.ownerType === "organization" && workspace.ownerId === organization.data.id), true);
const members = await listOrganizationMembers(admin, organization.data.id);
assert.deepEqual(members.data.items.map((item) => item.role).toSorted(), ["member", "owner"]);
await changeOrganizationMemberRole(
  admin,
  { organizationId: organization.data.id, userId: memberIdentity.data.user.id, role: "owner" },
  { csrfToken: adminBrowser.csrfToken() }
);
await changeOrganizationMemberRole(
  admin,
  { organizationId: organization.data.id, userId: memberIdentity.data.user.id, role: "member" },
  { csrfToken: adminBrowser.csrfToken() }
);

const unavailable = await safeInvitationProblem(
  issueOrganizationInvitation(
    admin,
    { organizationId: organization.data.id, email: unavailableEmail, role: "member" },
    { csrfToken: adminBrowser.csrfToken() }
  ),
  [unavailableEmail, unavailableEmail.toLowerCase()]
);
const unauthorized = await safeInvitationProblem(
  issueOrganizationInvitation(
    member,
    { organizationId: organization.data.id, email: unauthorizedTargetEmail, role: "member" },
    { csrfToken: memberBrowser.csrfToken() }
  ),
  [unauthorizedTargetEmail, adminEmail.toLowerCase()]
);
assert.deepEqual(unavailable, unauthorized);

const declineOrganization = await createOrganization(
  admin,
  { slug: "client005-decline", displayName: "Client 005 Decline" },
  { csrfToken: adminBrowser.csrfToken() }
);
const declineInvitation = await issueOrganizationInvitation(
  admin,
  { organizationId: declineOrganization.data.id, email: memberEmail, role: "member" },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(declineInvitation.data.delivery, "copy_once");
const declineToken = tokenFrom(declineInvitation.data.acceptUrl.consume(), "/organization-invitations/accept");
const declined = await declineOrganizationInvitation(member, declineToken, { csrfToken: memberBrowser.csrfToken() });
assert.equal(declined.data.status, "declined");
const safeInvitations = await listOrganizationInvitations(admin, declineOrganization.data.id);
assert.equal(safeInvitations.data.items.some((item) => item.status === "declined"), true);
assert.doesNotMatch(JSON.stringify(safeInvitations), /acceptUrl|token|digest/u);

assert.doesNotMatch(JSON.stringify({ activationList, organization, workspaces, members, safeInvitations }), /nrt_session_|nrt_csrf_|set-cookie|do-not-log/u);
console.log("api client organization live contract ok");

function createFixtureBrowser(origin: string): { readonly csrfToken: () => string; readonly fetch: typeof globalThis.fetch } {
  const cookies = new Map<string, string>();
  return {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (cookies.size > 0) {
        headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      }
      if (init?.method !== undefined && !["GET", "HEAD"].includes(init.method)) {
        headers.set("origin", origin);
      }
      const response = await globalThis.fetch(input, { ...init, headers });
      const responseHeaders = response.headers as Headers & { getSetCookie(): string[] };
      for (const value of responseHeaders.getSetCookie()) {
        updateCookieJar(cookies, value);
      }
      return response;
    },
    csrfToken: () => {
      const token = cookies.get("nuriteo_dev_csrf");
      assert.ok(token, "the Core API did not issue a CSRF cookie");
      return token;
    }
  };
}

function updateCookieJar(cookies: Map<string, string>, setCookie: string): void {
  const pair = setCookie.split(";", 1)[0];
  assert.ok(pair);
  const separator = pair.indexOf("=");
  assert.ok(separator > 0);
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  if (value.length === 0) cookies.delete(name);
  else cookies.set(name, value);
}

function tokenFrom(value: string, path: string): string {
  const url = new URL(value);
  assert.equal(url.pathname, path);
  const token = url.searchParams.get("token");
  assert.ok(token);
  return token;
}

async function safeInvitationProblem(
  request: Promise<unknown>,
  privateValues: readonly string[]
): Promise<Omit<NonNullable<ApiError["problem"]>, "request_id">> {
  let captured: unknown;
  try {
    await request;
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof ApiError);
  assert.equal(captured.status, 404);
  assert.ok(captured.problem);
  assert.equal(typeof captured.problem.request_id, "string");
  const renderings = [JSON.stringify(captured.problem), String(captured), JSON.stringify(captured)];
  for (const privateValue of [...privateValues, "nrt_org_inv_", "postgres://"]) {
    const pattern = new RegExp(escapeRegExp(privateValue), "iu");
    for (const rendering of renderings) {
      assert.doesNotMatch(rendering, pattern);
    }
  }
  const { request_id: _requestId, ...comparable } = captured.problem;
  return comparable;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readSecret(name: string): Promise<string> {
  return (await readFile(requiredEnvironment(name), "utf8")).replace(/\r?\n$/u, "");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`required fixture variable ${name} is missing`);
  return value;
}
