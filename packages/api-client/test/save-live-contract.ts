import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ApiError,
  ProjectTransferError,
  SAVE_MULTIPART_PART_BYTES,
  SAVE_PART_BATCH_LIMIT,
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
  issueSaveParts,
  issueOrganizationInvitation,
  reconcileSaveSession,
  recordSaveReceipts,
  revokeDirectProjectRole,
  uploadSaveCapability
} from "../src/index.ts";
import type {
  ProjectContentDescriptor,
  ProjectContentSink,
  SavePart,
  SaveUploadCapability,
  SaveUploadReceipt
} from "../src/index.ts";
import { validateProjectBundleV1Projection } from "../../../apps/web/src/bundles/project-bundle-v1-validation.ts";
import { writeValidatedProjectBundleV1 } from "../../../apps/web/src/bundles/project-bundle-v1.ts";

const baseUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const adminEmail = requiredEnvironment("NURITEO_CLIENT_TEST_EMAIL");
const adminPassword = await readSecret("NURITEO_CLIENT_TEST_PASSWORD_FILE");
const memberPassword = await readSecret("NURITEO_CLIENT_TEST_MEMBER_PASSWORD_FILE");
const expectedTransport = requiredUploadTransport();
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
assert.equal(activation.data.delivery, "copy_once");
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
assert.equal(created.data.upload.transport, expectedTransport);

const replayed = await createSaveSession(member, saveInput, {
  csrfToken: memberBrowser.csrfToken()
});
assert.equal(replayed.status, 200);
assert.equal(replayed.replayed, true);
assert.equal(replayed.data.sessionId, created.data.sessionId);
assert.ok(replayed.data.upload);
assert.equal(replayed.data.upload.transport, expectedTransport);

const singlePart: SavePart = {
  partNumber: 1,
  expectedBytes: bundle.bytes.byteLength,
  sha256: bundleDigest
};
const singleReceipt = await uploadLiveCapability(
  replayed.data.upload,
  singlePart,
  blobFrom(bundle.bytes),
  memberBrowser,
  { owner, projectId: project.data.id, sessionId: created.data.sessionId, uploadMode: "single" }
);
if (expectedTransport === "direct") {
  assert.ok(singleReceipt);
  assert.deepEqual(
    {
      partNumber: singleReceipt.partNumber,
      expectedBytes: singleReceipt.expectedBytes,
      sha256: singleReceipt.sha256
    },
    singlePart
  );
  assert.match(singleReceipt.etag, /^"[0-9a-f]{32}"$/u);
} else {
  assert.equal(singleReceipt, undefined);
}
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

await runMultipartJourney();

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
  uploadLiveCapability(
    cancelledSession.data.upload,
    singlePart,
    blobFrom(bundle.bytes),
    adminBrowser,
    {
      owner,
      projectId: project.data.id,
      sessionId: cancelledSession.data.sessionId,
      uploadMode: "single"
    },
    controller.signal
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

async function uploadLiveCapability(
  capability: SaveUploadCapability,
  part: SavePart,
  body: Blob,
  browser: ReturnType<typeof createFixtureBrowser>,
  identity: {
    readonly owner: typeof owner;
    readonly projectId: string;
    readonly sessionId: string;
    readonly uploadMode: "single" | "multipart";
  },
  signal?: AbortSignal
): Promise<SaveUploadReceipt | undefined> {
  if (capability.transport === "direct") {
    const result = await uploadSaveCapability(capability, part, body, {
      fetch: storageBrowserFetch(baseUrl),
      ...(signal === undefined ? {} : { signal })
    });
    assert.equal(result.transport, "direct");
    return result.receipt;
  }
  try {
    const result = await uploadSaveCapability(capability, part, body, {
      ...identity,
      csrfToken: browser.csrfToken(),
      fetch: browser.fetch,
      ...(signal === undefined ? {} : { signal })
    });
    assert.deepEqual(result, { transport: "relay" });
    return undefined;
  } catch (error) {
    const apiError = error instanceof ApiError || (
      typeof error === "object" && error !== null &&
      "status" in error && "code" in error && "requestId" in error
    ) ? error as ApiError : undefined;
    if (apiError !== undefined) {
      console.error(JSON.stringify({
        stage: identity.uploadMode === "single" ? "relay-single-upload" : "relay-part-upload",
        endpoint: identity.uploadMode === "single" ? ".../save-sessions/{session}/upload" : ".../save-sessions/{session}/parts/{part}",
        partNumber: part.partNumber,
        physicalBytes: body.size,
        status: apiError.status,
        code: apiError.code,
        detail: apiError.problem?.detail,
        requestId: apiError.requestId
      }));
    }
    throw error;
  }
}

async function runMultipartJourney(): Promise<void> {
  const multipartProject = await createProject(
    admin,
    {
      owner,
      slug: `${expectedTransport}-multipart`,
      name: `${expectedTransport === "direct" ? "Direct" : "Relay"} Multipart`
    },
    { csrfToken: adminBrowser.csrfToken() }
  );
  const grantedMultipart = await grantDirectProjectRole(
    admin,
    {
      owner,
      projectId: multipartProject.data.id,
      userId: memberIdentity.data.user.id,
      role: "write",
      etag: multipartProject.etag
    },
    { csrfToken: adminBrowser.csrfToken() }
  );
  const fileBytes = 11 * 1024 * 1024;
  const files = Array.from({ length: 6 }, (_value, index) => {
    const bytes = new Uint8Array(fileBytes);
    bytes.fill(index + 1);
    return {
      path: `data/part-${index + 1}.bin`,
      kind: "binary" as const,
      executable: false,
      bytes
    };
  });
  const multipartBundle = await writeValidatedProjectBundleV1(validateProjectBundleV1Projection({
    projectId: multipartProject.data.id,
    storageScopeId: multipartProject.data.storageScopeId,
    files
  }));
  assert.ok(multipartBundle.bytes.byteLength > 64 * 1024 * 1024);
  const multipartDigest = createHash("sha256").update(multipartBundle.bytes).digest("hex");
  const parts: SavePart[] = [];
  for (let offset = 0, partNumber = 1; offset < multipartBundle.bytes.byteLength; partNumber += 1) {
    const end = Math.min(offset + SAVE_MULTIPART_PART_BYTES, multipartBundle.bytes.byteLength);
    const bytes = multipartBundle.bytes.subarray(offset, end);
    parts.push({
      partNumber,
      expectedBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    offset = end;
  }
  const createdMultipart = await createSaveSession(member, {
    owner,
    projectId: multipartProject.data.id,
    projectEtag: grantedMultipart.etag,
    idempotencyKey: `client-007-${expectedTransport}-multipart-0001`,
    physicalBytes: multipartBundle.bytes.byteLength,
    logicalBytes: multipartBundle.manifest.logicalBytes,
    fileCount: multipartBundle.manifest.fileCount,
    sha256: multipartDigest,
    parts
  }, { csrfToken: memberBrowser.csrfToken() });
  assert.equal(createdMultipart.data.uploadMode, "multipart");
  assert.equal(createdMultipart.data.upload, null);
  const receiptCallsBefore = memberBrowser.requests.filter(
    (request) => request.url.includes("/parts/receipts")
  ).length;
  let receiptBatches = 0;
  for (let offset = 0; offset < parts.length; offset += SAVE_PART_BATCH_LIMIT) {
    const batch = parts.slice(offset, offset + SAVE_PART_BATCH_LIMIT);
    const capabilities = (await issueSaveParts(member, {
      owner,
      projectId: multipartProject.data.id,
      sessionId: createdMultipart.data.sessionId,
      parts: batch
    }, { csrfToken: memberBrowser.csrfToken() })).data;
    assert.equal(capabilities.length, batch.length);
    const receipts: SaveUploadReceipt[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const part = batch[index];
      const capability = capabilities[index];
      assert.ok(part && capability);
      assert.equal(capability.transport, expectedTransport);
      const start = (part.partNumber - 1) * SAVE_MULTIPART_PART_BYTES;
      const bytes = multipartBundle.bytes.subarray(start, start + part.expectedBytes);
      const receipt = await uploadLiveCapability(
        capability,
        part,
        blobFrom(bytes),
        memberBrowser,
        {
          owner,
          projectId: multipartProject.data.id,
          sessionId: createdMultipart.data.sessionId,
          uploadMode: "multipart"
        }
      );
      if (expectedTransport === "direct") {
        assert.ok(receipt);
        receipts.push(receipt);
      } else {
        assert.equal(receipt, undefined);
      }
    }
    if (expectedTransport === "direct") {
      const recorded = await recordSaveReceipts(member, {
        owner,
        projectId: multipartProject.data.id,
        sessionId: createdMultipart.data.sessionId,
        receipts
      }, { csrfToken: memberBrowser.csrfToken() });
      assert.equal(recorded.status, 204);
      receiptBatches += 1;
    }
  }
  const receiptCallsAfter = memberBrowser.requests.filter(
    (request) => request.url.includes("/parts/receipts")
  ).length;
  if (expectedTransport === "direct") {
    assert.equal(receiptCallsAfter, receiptCallsBefore + receiptBatches);
  } else {
    assert.equal(receiptCallsAfter, receiptCallsBefore, "relay upload must not submit a client receipt");
  }
  const completedMultipart = await completeSaveSession(member, {
    owner,
    projectId: multipartProject.data.id,
    sessionId: createdMultipart.data.sessionId,
    uploadMode: "multipart"
  }, { csrfToken: memberBrowser.csrfToken() });
  const descriptor = await getProjectContentDescriptor(member, {
    owner,
    projectId: multipartProject.data.id
  });
  assert.equal(descriptor.data.bundleId, completedMultipart.data.bundleId);
  let received = 0;
  const downloaded = await downloadProjectContent(descriptor.data, {
    baseUrl,
    fetch: memberBrowser.fetch,
    maxBytes: descriptor.data.physicalBytes,
    sink: {
      async write(chunk) { received += chunk.byteLength; },
      async complete() { return received; },
      async abort() { received = 0; }
    }
  });
  assert.equal(downloaded.receivedBytes, multipartBundle.bytes.byteLength);
  assert.equal(downloaded.sinkResult, multipartBundle.bytes.byteLength);
  multipartBundle.bytes.fill(0);
  for (const file of files) file.bytes.fill(0);
}

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
  readonly requests: readonly { readonly method: string; readonly url: string }[];
} {
  const cookies = new Map<string, string>();
  const requests: Array<{ readonly method: string; readonly url: string }> = [];
  return {
    fetch: async (input, init) => {
      const requestUrl = typeof input === "string" && input.startsWith("/")
        ? `${origin}${input}`
        : input;
      requests.push({ method: init?.method ?? "GET", url: String(requestUrl) });
      const headers = new Headers(init?.headers);
      if (cookies.size > 0) {
        headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      }
      if (init?.method !== undefined && !["GET", "HEAD"].includes(init.method)) {
        headers.set("origin", origin);
      }
      const response = await globalThis.fetch(requestUrl, { ...init, headers });
      const responseHeaders = response.headers as Headers & { getSetCookie(): string[] };
      for (const value of responseHeaders.getSetCookie()) updateCookieJar(cookies, value);
      return response;
    },
    csrfToken: () => {
      const token = cookies.get("nuriteo_dev_csrf");
      assert.ok(token, "the Core API did not issue a CSRF cookie");
      return token;
    },
    requests
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

function requiredUploadTransport(): "direct" | "relay" {
  const value = requiredEnvironment("NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT");
  if (value !== "direct" && value !== "relay") {
    throw new Error("NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT must be direct or relay");
  }
  return value;
}
