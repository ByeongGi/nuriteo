import assert from "node:assert/strict";

import {
  ApiInvalidResponseError,
  activateGitProvider,
  commitAndPushGitRemote,
  connectGitProvider,
  createApiClient,
  createGitProvider,
  deleteGitProvider,
  disableGitProvider,
  disconnectGitProvider,
  getGitRemote,
  importGitRepository,
  listGitConnections,
  listGitProvidersForAdmin,
  listGitProviders,
  pullGitRemote,
  rotateGitCredential,
  updateGitProvider
} from "../src/index.ts";

const PROVIDER_ID = "0199ee6c-c777-7000-8000-000000090001";
const CONNECTION_ID = "0199ee6c-c777-7000-8000-000000090002";
const PROJECT_ID = "0199ee6c-c777-7000-8000-000000090003";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEXT_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const SHA_256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CSRF = "nrt_csrf_git-contract";

await lifecycleContract();
await adminLifecycleContract();
await secretAndResponseBoundaries();

async function adminLifecycleContract(): Promise<void> {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const queue = [
    json([adminProvider()]),
    json(adminProvider(), 201, { etag: '"git-provider-v1"' }),
    json({ ...adminProvider(), displayName: "Updated Git", configVersion: 2 }),
    json({ ...adminProvider(), state: "active", configVersion: 3, validatedAt: "2026-10-08T01:00:00Z" }),
    json({ ...adminProvider(), configVersion: 4 }),
    new Response(null, { status: 204 })
  ];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return queue.shift()!;
    }
  });
  const mutation = { csrfToken: CSRF };
  await listGitProvidersForAdmin(client);
  await createGitProvider(client, adminInput(), mutation);
  await updateGitProvider(client, PROVIDER_ID, 1, {
    displayName: "Updated Git",
    apiBaseUrl: "https://git.example.test/api/v4",
    oauthAuthorizationUrl: null,
    oauthTokenUrl: null,
    oauthClientId: null,
    allowsRead: true,
    allowsWrite: true
  }, mutation);
  await activateGitProvider(client, PROVIDER_ID, 2, mutation);
  await disableGitProvider(client, PROVIDER_ID, 3, mutation);
  await deleteGitProvider(client, PROVIDER_ID, 4, mutation);

  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/admin/git-providers"],
    ["POST", "/api/v1/admin/git-providers"],
    ["PATCH", `/api/v1/admin/git-providers/${PROVIDER_ID}`],
    ["POST", `/api/v1/admin/git-providers/${PROVIDER_ID}/activate`],
    ["POST", `/api/v1/admin/git-providers/${PROVIDER_ID}/disable`],
    ["DELETE", `/api/v1/admin/git-providers/${PROVIDER_ID}`]
  ]);
  assert.deepEqual(calls.slice(2).map(({ init }) => new Headers(init?.headers).get("if-match")), [
    '"git-provider-v1"',
    '"git-provider-v2"',
    '"git-provider-v3"',
    '"git-provider-v4"'
  ]);
  for (const index of [1, 2, 3, 4, 5]) {
    assert.equal(new Headers(calls[index]?.init?.headers).get("x-csrf-token"), CSRF);
  }
}

async function lifecycleContract(): Promise<void> {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const queue = [
    json([provider()]),
    json([connection()]),
    json(connection(), 201, { etag: '"git-connection-v1"' }),
    json({ ...connection(), credentialVersion: 2, connectionVersion: 2 }, 200, {
      etag: '"git-connection-v2"'
    }),
    json(remote(), 200, { etag: `"git-remote-${SHA}"` }),
    json(operation(null, SHA), 201, { etag: `"git-remote-${SHA}"` }),
    json(operation(SHA, NEXT_SHA), 200, { etag: `"git-remote-${NEXT_SHA}"` }),
    json(operation(NEXT_SHA, SHA), 200, { etag: `"git-remote-${SHA}"` }),
    new Response(null, { status: 204 })
  ];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return queue.shift()!;
    }
  });

  await listGitProviders(client);
  await listGitConnections(client);
  const connected = await connectGitProvider(client, PROVIDER_ID, "pat-secret", { csrfToken: CSRF });
  const rotated = await rotateGitCredential(client, { id: CONNECTION_ID, etag: connected.etag }, "replacement", { csrfToken: CSRF });
  const current = await getGitRemote(client, PROJECT_ID);
  const imported = await importGitRepository(client, {
    projectId: PROJECT_ID,
    repositoryUrl: "https://git.example.test/team/project.git",
    branch: "main"
  }, { csrfToken: CSRF });
  const pulled = await pullGitRemote(client, PROJECT_ID, imported.etag, { csrfToken: CSRF });
  await commitAndPushGitRemote(client, {
    projectId: PROJECT_ID,
    etag: pulled.etag,
    commitMessage: "Update project"
  }, { csrfToken: CSRF });
  await disconnectGitProvider(client, { id: CONNECTION_ID, etag: rotated.etag }, { csrfToken: CSRF });

  assert.equal(current.etag, `"git-remote-${SHA}"`);
  assert.deepEqual(calls.map(({ input, init }) => [init?.method, String(input)]), [
    ["GET", "/api/v1/me/git-providers"],
    ["GET", "/api/v1/me/git-connections"],
    ["POST", "/api/v1/me/git-connections"],
    ["POST", `/api/v1/me/git-connections/${CONNECTION_ID}/rotate`],
    ["GET", `/api/v1/projects/${PROJECT_ID}/git`],
    ["POST", `/api/v1/projects/${PROJECT_ID}/git/import`],
    ["POST", `/api/v1/projects/${PROJECT_ID}/git/pull`],
    ["POST", `/api/v1/projects/${PROJECT_ID}/git/commit-push`],
    ["DELETE", `/api/v1/me/git-connections/${CONNECTION_ID}`]
  ]);
  assert.equal(new Headers(calls[6]?.init?.headers).get("if-match"), `"git-remote-${SHA}"`);
  assert.equal(new Headers(calls[7]?.init?.headers).get("if-match"), `"git-remote-${NEXT_SHA}"`);
  for (const index of [2, 3, 5, 6, 7, 8]) {
    assert.equal(new Headers(calls[index]?.init?.headers).get("x-csrf-token"), CSRF);
  }
}

async function secretAndResponseBoundaries(): Promise<void> {
  const sha256 = await getGitRemote(
    single({ ...remote(), remoteHeadSha: SHA_256 }, { etag: `"git-remote-${SHA_256}"` }),
    PROJECT_ID
  );
  assert.equal(sha256.data.remoteHeadSha, SHA_256);
  await assert.rejects(
    () => listGitConnections(single([{ ...connection(), token: "leaked" }])),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => getGitRemote(single(remote(), { etag: `"git-remote-${NEXT_SHA}"` }), PROJECT_ID),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => listGitProvidersForAdmin(single([{ ...adminProvider(), credential: "leaked" }])),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => getGitRemote(
      single(
        { ...remote(), remoteHeadSha: SHA.toUpperCase() },
        { etag: `"git-remote-${SHA.toUpperCase()}"` }
      ),
      PROJECT_ID
    ),
    ApiInvalidResponseError
  );
}

function adminInput() {
  return {
    displayName: "Company Git",
    kind: "gitlab_self_managed" as const,
    host: "git.example.test",
    port: 443,
    apiBaseUrl: "https://git.example.test/api/v4",
    oauthAuthorizationUrl: null,
    oauthTokenUrl: null,
    oauthClientId: null,
    allowsRead: true,
    allowsWrite: true
  };
}

function adminProvider() {
  return {
    id: PROVIDER_ID,
    ...adminInput(),
    state: "disabled",
    configVersion: 1,
    validatedAt: null
  };
}

function provider() {
  return {
    id: PROVIDER_ID,
    displayName: "Company Git",
    kind: "gitlab_self_managed",
    host: "git.example.test:443",
    allowsWrite: true
  };
}

function connection() {
  return {
    id: CONNECTION_ID,
    providerId: PROVIDER_ID,
    credentialVersion: 1,
    connectionVersion: 1,
    createdAt: "2026-10-08T01:00:00Z",
    updatedAt: "2026-10-08T01:00:00Z"
  };
}

function remote() {
  return {
    projectId: PROJECT_ID,
    providerId: PROVIDER_ID,
    repositoryUrl: "https://git.example.test/team/project.git",
    branch: "main",
    remoteHeadSha: SHA,
    remoteVersion: 1,
    createdAt: "2026-10-08T01:00:00Z",
    updatedAt: "2026-10-08T01:00:00Z"
  };
}

function operation(previousHeadSha: string | null, headSha: string) {
  return {
    remote: { ...remote(), remoteHeadSha: headSha },
    previousHeadSha,
    headSha,
    changedObjects: 2,
    transferredBytes: 128
  };
}

function single(payload: unknown, headers: HeadersInit = {}) {
  return createApiClient({ fetch: async () => json(payload, 200, headers) });
}

function json(payload: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(payload, { status, headers });
}
