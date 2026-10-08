import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  ApiError,
  acceptOrganizationInvitation,
  activateAccount,
  archiveProject,
  changeDirectProjectRole,
  createApiClient,
  createOrganization,
  createProject,
  createSession,
  deleteProject,
  getCurrentUser,
  getProject,
  grantDirectProjectRole,
  issueActivationInvitation,
  issueOrganizationInvitation,
  listDirectProjectRoles,
  listProjects,
  renameProject,
  restoreProject,
  revokeDirectProjectRole
} from "../src/index.ts";

const baseUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const adminEmail = requiredEnvironment("NURITEO_CLIENT_TEST_EMAIL");
const adminPassword = await readSecret("NURITEO_CLIENT_TEST_PASSWORD_FILE");
const memberPassword = await readSecret("NURITEO_CLIENT_TEST_MEMBER_PASSWORD_FILE");
const memberEmail = "project-member@example.test";
const execFileAsync = promisify(execFile);
const adminBrowser = createFixtureBrowser(baseUrl);
const memberBrowser = createFixtureBrowser(baseUrl);
const publicBrowser = createFixtureBrowser(baseUrl);
const admin = createApiClient({ baseUrl, credentials: "include", fetch: adminBrowser.fetch });
const member = createApiClient({ baseUrl, credentials: "include", fetch: memberBrowser.fetch });
const publicClient = createApiClient({ baseUrl, fetch: publicBrowser.fetch });

await createSession(admin, { email: adminEmail, password: adminPassword });
const adminIdentity = await getCurrentUser(admin);
const personalOwner = {
  ownerType: "user" as const,
  ownerId: adminIdentity.data.user.id
};

const personal = await createProject(
  admin,
  { owner: personalOwner, slug: "client-003-personal", name: "Client 003 Personal" },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(personal.etag, '"project-v1"');
assert.equal(personal.data.ownerId, personalOwner.ownerId);
const fetched = await getProject(admin, {
  owner: personalOwner,
  projectId: personal.data.id
});
assert.equal(fetched.etag, personal.etag);
const renamed = await renameProject(
  admin,
  {
    owner: personalOwner,
    projectId: personal.data.id,
    name: "Client 003 Renamed",
    etag: fetched.etag
  },
  { csrfToken: adminBrowser.csrfToken() }
);
const archived = await archiveProject(
  admin,
  { owner: personalOwner, projectId: personal.data.id, etag: renamed.etag },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(archived.data.state, "archived");
const restored = await restoreProject(
  admin,
  { owner: personalOwner, projectId: personal.data.id, etag: archived.etag },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(restored.data.state, "active");

await createProject(
  admin,
  { owner: personalOwner, slug: "client-003-second", name: "Client 003 Second" },
  { csrfToken: adminBrowser.csrfToken() }
);
const firstPage = await listProjects(admin, {
  owner: personalOwner,
  state: "all",
  pageSize: 1
});
assert.equal(firstPage.data.items.length, 1);
assert.ok(firstPage.data.nextCursor);
const secondPage = await listProjects(admin, {
  owner: personalOwner,
  state: "all",
  pageSize: 1,
  cursor: firstPage.data.nextCursor
});
assert.equal(secondPage.data.items.length, 1);
assert.notEqual(secondPage.data.items[0]?.id, firstPage.data.items[0]?.id);

await markReauthenticated(adminIdentity.data.user.id);
await deleteProject(
  admin,
  {
    owner: personalOwner,
    projectId: personal.data.id,
    name: "Client 003 Renamed",
    etag: restored.etag
  },
  { csrfToken: adminBrowser.csrfToken() }
);

const activation = await issueActivationInvitation(
  admin,
  { email: memberEmail },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(activation.data.delivery, "copy_once");
await activateAccount(publicClient, {
  token: tokenFrom(activation.data.activationUrl.consume(), "/activate"),
  email: memberEmail,
  displayName: "Project Member",
  password: memberPassword
});
await createSession(member, { email: memberEmail, password: memberPassword });
const memberIdentity = await getCurrentUser(member);

const organization = await createOrganization(
  admin,
  { slug: "client-003", displayName: "Client 003" },
  { csrfToken: adminBrowser.csrfToken() }
);
const invitation = await issueOrganizationInvitation(
  admin,
  {
    organizationId: organization.data.id,
    email: memberEmail,
    role: "member"
  },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(invitation.data.delivery, "copy_once");
await acceptOrganizationInvitation(
  member,
  tokenFrom(invitation.data.acceptUrl.consume(), "/organization-invitations/accept"),
  { csrfToken: memberBrowser.csrfToken() }
);

const organizationOwner = {
  ownerType: "organization" as const,
  ownerId: organization.data.id
};
const shared = await createProject(
  admin,
  { owner: organizationOwner, slug: "shared-project", name: "Shared Project" },
  { csrfToken: adminBrowser.csrfToken() }
);
const granted = await grantDirectProjectRole(
  admin,
  {
    owner: organizationOwner,
    projectId: shared.data.id,
    userId: memberIdentity.data.user.id,
    role: "read",
    etag: shared.etag
  },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(granted.data.grant?.userId, memberIdentity.data.user.id);
const grants = await listDirectProjectRoles(admin, {
  owner: organizationOwner,
  projectId: shared.data.id
});
assert.equal(grants.data.items[0]?.projectId, shared.data.id);
await getProject(member, { owner: organizationOwner, projectId: shared.data.id });
const changed = await changeDirectProjectRole(
  admin,
  {
    owner: organizationOwner,
    projectId: shared.data.id,
    userId: memberIdentity.data.user.id,
    role: "admin",
    etag: granted.etag
  },
  { csrfToken: adminBrowser.csrfToken() }
);
const revoked = await revokeDirectProjectRole(
  admin,
  {
    owner: organizationOwner,
    projectId: shared.data.id,
    userId: memberIdentity.data.user.id,
    etag: changed.etag
  },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(revoked.data.changed, true);
assert.equal(revoked.data.grant, null);
const noOp = await revokeDirectProjectRole(
  admin,
  {
    owner: organizationOwner,
    projectId: shared.data.id,
    userId: memberIdentity.data.user.id,
    etag: revoked.etag
  },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(noOp.data.changed, false);
assert.equal(noOp.data.projectVersion, revoked.data.projectVersion);
assert.equal(noOp.etag, revoked.etag);
await assert.rejects(
  getProject(member, { owner: organizationOwner, projectId: shared.data.id }),
  (error) => error instanceof ApiError && error.status === 404
);

assert.doesNotMatch(
  JSON.stringify({ personal, firstPage, secondPage, organization, shared, grants, noOp }),
  /nrt_session_|nrt_csrf_|set-cookie|password|token/u
);
console.log("api client Project live contract ok");

function createFixtureBrowser(origin: string): {
  readonly csrfToken: () => string;
  readonly fetch: typeof globalThis.fetch;
} {
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
  if (value.length === 0) {
    cookies.delete(name);
  } else {
    cookies.set(name, value);
  }
}

function tokenFrom(value: string, path: string): string {
  const url = new URL(value);
  assert.equal(url.pathname, path);
  const token = url.searchParams.get("token");
  assert.ok(token);
  return token;
}

async function markReauthenticated(userId: string): Promise<void> {
  const runtime = requiredEnvironment("NURITEO_CLIENT_TEST_CONTAINER_RUNTIME");
  const container = requiredEnvironment("NURITEO_CLIENT_TEST_POSTGRES_CONTAINER");
  await execFileAsync(runtime, [
    "exec",
    container,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "nuriteo",
    "-d",
    "nuriteo",
    "-c",
    `UPDATE sessions SET last_seen_at=transaction_timestamp(), last_reauthenticated_at=transaction_timestamp() WHERE user_id='${userId}'::uuid AND revoked_at IS NULL`
  ]);
}

async function readSecret(name: string): Promise<string> {
  return (await readFile(requiredEnvironment(name), "utf8")).replace(/\r?\n$/u, "");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`required fixture variable ${name} is missing`);
  }
  return value;
}
