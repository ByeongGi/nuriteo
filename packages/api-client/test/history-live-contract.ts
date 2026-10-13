import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ApiError,
  acceptOrganizationInvitation,
  activateAccount,
  archiveProject,
  completeSaveSession,
  createApiClient,
  createOrganization,
  createProject,
  createProjectVersion,
  createSaveSession,
  createSession,
  getCurrentUser,
  grantDirectProjectRole,
  issueActivationInvitation,
  issueOrganizationInvitation,
  listProjectVersions,
  listRecoveryCheckpoints,
  reconcileProjectHistory,
  restoreProject,
  restoreProjectHistory,
  revokeDirectProjectRole,
  uploadSaveCapability
} from "../src/index.ts";
import type { ProjectOwner, SavePart } from "../src/index.ts";
import { validateProjectBundleV1Projection } from "../../../apps/web/src/bundles/project-bundle-v1-validation.ts";
import { writeValidatedProjectBundleV1 } from "../../../apps/web/src/bundles/project-bundle-v1.ts";

const baseUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const memberEmail = "history-member@example.test";
const adminPassword = await readSecret("NURITEO_CLIENT_TEST_PASSWORD_FILE");
const memberPassword = await readSecret("NURITEO_CLIENT_TEST_MEMBER_PASSWORD_FILE");
const adminBrowser = createFixtureBrowser(baseUrl);
const memberBrowser = createFixtureBrowser(baseUrl);
const publicBrowser = createFixtureBrowser(baseUrl);
const admin = createApiClient({ baseUrl, credentials: "include", fetch: adminBrowser.fetch });
const member = createApiClient({ baseUrl, credentials: "include", fetch: memberBrowser.fetch });
const publicClient = createApiClient({ baseUrl, fetch: publicBrowser.fetch });

await createSession(admin, {
  email: requiredEnvironment("NURITEO_CLIENT_TEST_EMAIL"),
  password: adminPassword
});
const activation = await issueActivationInvitation(
  admin,
  { email: memberEmail },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(activation.data.delivery, "copy_once");
await activateAccount(publicClient, {
  token: tokenFrom(activation.data.activationUrl.consume(), "/activate"),
  email: memberEmail,
  displayName: "History Member",
  password: memberPassword
});
await createSession(member, { email: memberEmail, password: memberPassword });
const memberIdentity = await getCurrentUser(member);

const organization = await createOrganization(
  admin,
  { slug: "client-006-history", displayName: "Client 006 History" },
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

const owner: ProjectOwner = { ownerType: "organization", ownerId: organization.data.id };
const project = await createProject(
  admin,
  { owner, slug: "history-project", name: "History Project" },
  { csrfToken: adminBrowser.csrfToken() }
);
const granted = await grantDirectProjectRole(
  admin,
  {
    owner,
    projectId: project.data.id,
    userId: memberIdentity.data.user.id,
    role: "write",
    etag: project.etag
  },
  { csrfToken: adminBrowser.csrfToken() }
);

const first = await saveBundle(owner, project.data.id, project.data.storageScopeId, granted.etag, 1);
const versionInput = {
  owner,
  projectId: project.data.id,
  name: "Stable checkpoint",
  projectEtag: first.etag,
  idempotencyKey: "client-006-version-live-0001"
};
const createdVersion = await createProjectVersion(member, versionInput, {
  csrfToken: memberBrowser.csrfToken()
});
assert.equal(createdVersion.status, 201);
assert.equal(createdVersion.data.version.bundleId, first.bundleId);
const replayedVersion = await createProjectVersion(member, versionInput, {
  csrfToken: memberBrowser.csrfToken()
});
assert.equal(replayedVersion.status, 200);
assert.equal(replayedVersion.replayed, true);
assert.equal(replayedVersion.data.version.id, createdVersion.data.version.id);

const second = await saveBundle(owner, project.data.id, project.data.storageScopeId, first.etag, 2);
const secondVersion = await createProjectVersion(member, {
  owner,
  projectId: project.data.id,
  name: "Later checkpoint",
  projectEtag: second.etag,
  idempotencyKey: "client-006-version-live-0002"
}, { csrfToken: memberBrowser.csrfToken() });
const third = await saveBundle(owner, project.data.id, project.data.storageScopeId, second.etag, 3);
const fourth = await saveBundle(owner, project.data.id, project.data.storageScopeId, third.etag, 4);
const firstPage = await listProjectVersions(member, {
  owner,
  projectId: project.data.id,
  pageSize: 1
});
assert.equal(firstPage.data.items.length, 1);
assert.equal(firstPage.data.items[0]?.id, secondVersion.data.version.id);
assert.ok(firstPage.data.nextCursor);
const secondPage = await listProjectVersions(member, {
  owner,
  projectId: project.data.id,
  pageSize: 1,
  cursor: firstPage.data.nextCursor
});
assert.equal(secondPage.data.items.length, 1);
assert.equal(secondPage.data.items[0]?.id, createdVersion.data.version.id);
assert.equal(secondPage.data.nextCursor, null);
const beforeRestore = await listRecoveryCheckpoints(member, { owner, projectId: project.data.id });
assert.equal(beforeRestore.data.items.length, 3);
assert.deepEqual(
  beforeRestore.data.items.map((checkpoint) => checkpoint.position).toSorted(),
  [1, 2, 3]
);
assert.equal(beforeRestore.data.items.some((checkpoint) => checkpoint.position === 3), true);
assert.equal(beforeRestore.data.items.some((checkpoint) => checkpoint.bundleId === first.bundleId), true);

const restoreInput = {
  owner,
  projectId: project.data.id,
  referenceKind: "version" as const,
  referenceId: createdVersion.data.version.id,
  projectEtag: fourth.etag,
  idempotencyKey: "client-006-restore-live-0001"
};
const restoredVersion = await restoreProjectHistory(member, restoreInput, {
  csrfToken: memberBrowser.csrfToken()
});
assert.equal(restoredVersion.data.changed, true);
assert.equal(restoredVersion.data.bundleId, first.bundleId);
assert.equal(restoredVersion.data.projectVersion, fourth.version + 1);
const replayedRestore = await restoreProjectHistory(member, restoreInput, {
  csrfToken: memberBrowser.csrfToken()
});
assert.equal(replayedRestore.data.operationId, restoredVersion.data.operationId);
assert.equal(replayedRestore.data.idempotentRetry, true);
const reconciled = await reconcileProjectHistory(member, {
  owner,
  projectId: project.data.id,
  idempotencyKey: restoreInput.idempotencyKey
});
assert.deepEqual(reconciled.data, replayedRestore.data);
assert.equal(reconciled.projectEtag, restoredVersion.projectEtag);

const afterVersionRestore = await listRecoveryCheckpoints(member, {
  owner,
  projectId: project.data.id
});
const recovery = afterVersionRestore.data.items.find((item) => item.bundleId === second.bundleId);
assert.ok(recovery);
const restoredRecovery = await restoreProjectHistory(member, {
  owner,
  projectId: project.data.id,
  referenceKind: "recovery",
  referenceId: recovery.id,
  projectEtag: restoredVersion.projectEtag,
  idempotencyKey: "client-006-recovery-live-001"
}, { csrfToken: memberBrowser.csrfToken() });
assert.equal(restoredRecovery.data.bundleId, second.bundleId);

const archived = await archiveProject(admin, {
  owner,
  projectId: project.data.id,
  etag: restoredRecovery.projectEtag
}, { csrfToken: adminBrowser.csrfToken() });
assert.equal((await listProjectVersions(member, { owner, projectId: project.data.id })).data.items.length, 2);
assert.ok((await listRecoveryCheckpoints(member, { owner, projectId: project.data.id })).data.items.length > 0);
await assert.rejects(
  restoreProjectHistory(member, {
    ...restoreInput,
    projectEtag: archived.etag,
    idempotencyKey: "client-006-archived-live-01"
  }, { csrfToken: memberBrowser.csrfToken() }),
  (error) => error instanceof ApiError && error.status === 409
);
const active = await restoreProject(admin, {
  owner,
  projectId: project.data.id,
  etag: archived.etag
}, { csrfToken: adminBrowser.csrfToken() });
await revokeDirectProjectRole(admin, {
  owner,
  projectId: project.data.id,
  userId: memberIdentity.data.user.id,
  etag: active.etag
}, { csrfToken: adminBrowser.csrfToken() });
await assert.rejects(
  listProjectVersions(member, { owner, projectId: project.data.id }),
  (error) => error instanceof ApiError && error.status === 404
);
await assert.rejects(
  listRecoveryCheckpoints(member, { owner, projectId: project.data.id }),
  (error) => error instanceof ApiError && error.status === 404
);

assert.doesNotMatch(
  JSON.stringify({
    projectId: project.data.id,
    versionId: createdVersion.data.version.id,
    operationId: restoredVersion.data.operationId
  }),
  /nrt_session_|nrt_csrf_|idempotency|signature|object.?key|password|token/iu
);
console.log("api client Project history live contract ok");

async function saveBundle(
  owner: ProjectOwner,
  projectId: string,
  storageScopeId: string,
  projectEtag: string,
  sequence: number
): Promise<{ readonly bundleId: string; readonly etag: string; readonly version: number }> {
  const bytes = new TextEncoder().encode(`CLIENT-006 history bundle ${sequence}\n`);
  const bundle = await writeValidatedProjectBundleV1(validateProjectBundleV1Projection({
    projectId,
    storageScopeId,
    files: [{ path: "src/history.txt", kind: "text", executable: false, bytes }]
  }));
  const sha256 = createHash("sha256").update(bundle.bytes).digest("hex");
  const created = await createSaveSession(member, {
    owner,
    projectId,
    projectEtag,
    idempotencyKey: `client-006-save-live-000${sequence}`,
    physicalBytes: bundle.bytes.byteLength,
    logicalBytes: bundle.manifest.logicalBytes,
    fileCount: bundle.manifest.fileCount,
    sha256
  }, { csrfToken: memberBrowser.csrfToken() });
  assert.ok(created.data.upload);
  const part: SavePart = { partNumber: 1, expectedBytes: bundle.bytes.byteLength, sha256 };
  if (created.data.upload.transport === "direct") {
    await uploadSaveCapability(created.data.upload, part, blobFrom(bundle.bytes), {
      fetch: storageBrowserFetch(baseUrl)
    });
  } else {
    await uploadSaveCapability(created.data.upload, part, blobFrom(bundle.bytes), {
      owner,
      projectId,
      sessionId: created.data.sessionId,
      uploadMode: "single",
      csrfToken: memberBrowser.csrfToken(),
      fetch: memberBrowser.fetch
    });
  }
  const completed = await completeSaveSession(member, {
    owner,
    projectId,
    sessionId: created.data.sessionId,
    uploadMode: "single"
  }, { csrfToken: memberBrowser.csrfToken() });
  return {
    bundleId: completed.data.bundleId,
    etag: completed.projectEtag,
    version: completed.data.projectVersion
  };
}

function blobFrom(bytes: Uint8Array): Blob {
  const copy = Uint8Array.from(bytes);
  return new Blob([copy.buffer]);
}

function storageBrowserFetch(origin: string): typeof globalThis.fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    return globalThis.fetch(input, { ...init, headers });
  };
}

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
      for (const value of responseHeaders.getSetCookie()) updateCookieJar(cookies, value);
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
  if (value === "") cookies.delete(name);
  else cookies.set(name, value);
}

function tokenFrom(value: string, path: string): string {
  const oneTimeUrl = new URL(value);
  assert.equal(oneTimeUrl.origin, new URL(baseUrl).origin);
  assert.equal(oneTimeUrl.pathname, path);
  const token = oneTimeUrl.searchParams.get("token");
  assert.ok(token);
  return token;
}

async function readSecret(name: string): Promise<string> {
  return (await readFile(requiredEnvironment(name), "utf8")).replace(/\r?\n$/u, "");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
