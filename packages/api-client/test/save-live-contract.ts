import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ApiError,
  ProjectTransferError,
  abortSaveSession,
  acceptOrganizationInvitation,
  activateAccount,
  completeSaveSession,
  createApiClient,
  createOrganization,
  createProject,
  createSaveSession,
  createSession,
  downloadProjectContent,
  getCurrentUser,
  getProjectContentDescriptor,
  grantDirectProjectRole,
  issueActivationInvitation,
  issueOrganizationInvitation,
  reconcileSaveSession,
  revokeDirectProjectRole,
  uploadSaveCapability
} from "../src/index.ts";
import type {
  ProjectContentDescriptor,
  ProjectContentSink,
  SavePart
} from "../src/index.ts";
import { validateProjectBundleV1Projection } from "../../../apps/web/src/bundles/project-bundle-v1-validation.ts";
import { writeValidatedProjectBundleV1 } from "../../../apps/web/src/bundles/project-bundle-v1.ts";

const baseUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const adminEmail = requiredEnvironment("NURITEO_CLIENT_TEST_EMAIL");
const adminPassword = await readSecret("NURITEO_CLIENT_TEST_PASSWORD_FILE");
const memberPassword = await readSecret("NURITEO_CLIENT_TEST_MEMBER_PASSWORD_FILE");
const memberEmail = "save-member@example.test";
const adminBrowser = createFixtureBrowser(baseUrl);
const memberBrowser = createFixtureBrowser(baseUrl);
const publicBrowser = createFixtureBrowser(baseUrl);
const admin = createApiClient({ baseUrl, credentials: "include", fetch: adminBrowser.fetch });
const member = createApiClient({ baseUrl, credentials: "include", fetch: memberBrowser.fetch });
const publicClient = createApiClient({ baseUrl, fetch: publicBrowser.fetch });

await createSession(admin, { email: adminEmail, password: adminPassword });
const adminIdentity = await getCurrentUser(admin);
const activation = await issueActivationInvitation(
  admin,
  { email: memberEmail },
  { csrfToken: adminBrowser.csrfToken() }
);
await activateAccount(publicClient, {
  token: tokenFrom(activation.data.activationUrl.consume(), "/activate"),
  email: memberEmail,
  displayName: "Save Member",
  password: memberPassword
});
await createSession(member, { email: memberEmail, password: memberPassword });
const memberIdentity = await getCurrentUser(member);

const organization = await createOrganization(
  admin,
  { slug: "client-004-save", displayName: "Client 004 Save" },
  { csrfToken: adminBrowser.csrfToken() }
);
const invitation = await issueOrganizationInvitation(
  admin,
  {
    organizationId: organization.data.id,
    inviteeUserId: memberIdentity.data.user.id,
    role: "member"
  },
  { csrfToken: adminBrowser.csrfToken() }
);
await acceptOrganizationInvitation(
  member,
  tokenFrom(invitation.data.acceptUrl.consume(), "/organization-invitations/accept"),
  { csrfToken: memberBrowser.csrfToken() }
);

const owner = { ownerType: "organization" as const, ownerId: organization.data.id };
const project = await createProject(
  admin,
  { owner, slug: "saved-project", name: "Saved Project" },
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

const sourceBytes = new TextEncoder().encode("saved through the CLIENT-004 Browser contract\n");
const bundle = await writeValidatedProjectBundleV1(validateProjectBundleV1Projection({
  projectId: project.data.id,
  storageScopeId: project.data.storageScopeId,
  files: [{ path: "src/message.txt", kind: "text", executable: false, bytes: sourceBytes }]
}));
const bundleDigest = createHash("sha256").update(bundle.bytes).digest("hex");
const saveInput = {
  owner,
  projectId: project.data.id,
  projectEtag: granted.etag,
  idempotencyKey: "client-004-live-save-0001",
  physicalBytes: bundle.bytes.byteLength,
  logicalBytes: bundle.manifest.logicalBytes,
  fileCount: bundle.manifest.fileCount,
  sha256: bundleDigest
};
const created = await createSaveSession(member, saveInput, {
  csrfToken: memberBrowser.csrfToken()
});
assert.equal(created.status, 201);
assert.equal(created.data.uploadMode, "single");
assert.ok(created.data.upload);

const replayed = await createSaveSession(member, saveInput, {
  csrfToken: memberBrowser.csrfToken()
});
assert.equal(replayed.status, 200);
assert.equal(replayed.replayed, true);
assert.equal(replayed.data.sessionId, created.data.sessionId);
assert.ok(replayed.data.upload);

const singlePart: SavePart = {
  partNumber: 1,
  expectedBytes: bundle.bytes.byteLength,
  sha256: bundleDigest
};
await uploadSaveCapability(
  replayed.data.upload,
  singlePart,
  blobFrom(bundle.bytes),
  { fetch: storageBrowserFetch(baseUrl) }
);
const completed = await completeSaveSession(
  member,
  {
    owner,
    projectId: project.data.id,
    sessionId: created.data.sessionId,
    uploadMode: "single"
  },
  { csrfToken: memberBrowser.csrfToken() }
);
assert.equal(completed.data.projectVersion, 3);
assert.equal(completed.projectEtag, '"project-v3"');
const reconciliation = await reconcileSaveSession(
  member,
  { owner, projectId: project.data.id, sessionId: created.data.sessionId },
  { csrfToken: memberBrowser.csrfToken() }
);
assert.deepEqual(reconciliation.data, {
  state: "committed",
  bundleId: completed.data.bundleId,
  projectVersion: 3
});

const descriptorBeforeRevoke = await getProjectContentDescriptor(member, {
  owner,
  projectId: project.data.id
});
assert.equal(descriptorBeforeRevoke.data.bundleId, completed.data.bundleId);
assert.equal(descriptorBeforeRevoke.data.checksum, createHash("sha256").update(bundle.bytes).digest("base64url"));

const revoked = await revokeDirectProjectRole(
  admin,
  {
    owner,
    projectId: project.data.id,
    userId: memberIdentity.data.user.id,
    etag: completed.projectEtag
  },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.equal(revoked.etag, '"project-v4"');
await assert.rejects(
  getProjectContentDescriptor(member, { owner, projectId: project.data.id }),
  (error) => error instanceof ApiError && error.status === 404
);

const descriptor = await getProjectContentDescriptor(admin, {
  owner,
  projectId: project.data.id
});
const sink = createBoundedFixtureSink(descriptor.data.physicalBytes);
const downloaded = await downloadProjectContent(descriptor.data, {
  baseUrl,
  fetch: adminBrowser.fetch,
  maxBytes: descriptor.data.physicalBytes,
  sink
});
assert.equal(downloaded.receivedBytes, bundle.bytes.byteLength);
assert.deepEqual(downloaded.sinkResult, bundle.bytes);

const cancelledSession = await createSaveSession(
  admin,
  { ...saveInput, projectEtag: revoked.etag, idempotencyKey: "client-004-live-cancel-01" },
  { csrfToken: adminBrowser.csrfToken() }
);
assert.ok(cancelledSession.data.upload);
const controller = new AbortController();
controller.abort("must-not-leak");
await assert.rejects(
  uploadSaveCapability(
    cancelledSession.data.upload,
    singlePart,
    blobFrom(bundle.bytes),
    { fetch: storageBrowserFetch(baseUrl), signal: controller.signal }
  ),
  (error) => error instanceof ProjectTransferError && error.kind === "aborted"
);
await abortSaveSession(
  admin,
  { owner, projectId: project.data.id, sessionId: cancelledSession.data.sessionId },
  { csrfToken: adminBrowser.csrfToken() }
);

assert.doesNotMatch(
  JSON.stringify({
    adminUserId: adminIdentity.data.user.id,
    projectId: project.data.id,
    committedBundleId: completed.data.bundleId,
    downloadedBytes: downloaded.receivedBytes
  }),
  /signature|x-amz|nrt_session_|nrt_csrf_|password|token/u
);
console.log("api client Save and Resume live contract ok");

function createBoundedFixtureSink(maximumBytes: number): ProjectContentSink<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  return {
    async write(chunk) {
      receivedBytes += chunk.byteLength;
      assert.ok(receivedBytes <= maximumBytes);
      chunks.push(Uint8Array.from(chunk));
    },
    async complete(descriptor: ProjectContentDescriptor) {
      assert.equal(receivedBytes, descriptor.physicalBytes);
      const bytes = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
        chunk.fill(0);
      }
      chunks.length = 0;
      return bytes;
    },
    async abort() {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      receivedBytes = 0;
    }
  };
}

function blobFrom(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
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

async function readSecret(environmentName: string): Promise<string> {
  return (await readFile(requiredEnvironment(environmentName), "utf8")).trim();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
