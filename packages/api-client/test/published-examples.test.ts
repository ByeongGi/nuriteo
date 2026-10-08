import assert from "node:assert/strict";

import {
  ApiConfigurationError,
  ApiInvalidResponseError,
  addPublishedExampleVersion,
  createApiClient,
  createPublishedExample,
  deletePublishedExample,
  forkPublishedExample,
  getPublicPublishedExample,
  getPublicPublishedExampleVersion,
  listPublicPublishedExamples,
  publicPublishedExampleContentPath,
  republishPublishedExample,
  selectPublishedExampleActiveVersion,
  setPublishedExampleVisibility,
  unpublishPublishedExample
} from "../src/index.ts";
import type { ProjectOwner } from "../src/index.ts";

const USER_ID = "018f22c4-3cb2-7cc8-98d8-b4f7f753f7bb";
const PROJECT_ID = "018f22c4-3cb8-7f31-b579-f044c9502bb7";
const PROJECT_VERSION_ID = "0199ee6c-c777-7000-8000-000000080001";
const NEXT_PROJECT_VERSION_ID = "0199ee6c-c777-7000-8000-000000080002";
const EXAMPLE_ID = "0199ee6c-c777-7000-8000-000000080003";
const VERSION_ID = "0199ee6c-c777-7000-8000-000000080004";
const NEXT_VERSION_ID = "0199ee6c-c777-7000-8000-000000080005";
const PUBLIC_ID = "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA";
const CSRF = "nrt_csrf_published-example-client";
const OWNER: ProjectOwner = { ownerType: "user", ownerId: USER_ID };

await managementContract();
await publicContractAndFailClosedProjection();
await forkContractAndFailClosedProjection();
await invalidRequestsFailBeforeFetch();

async function managementContract(): Promise<void> {
  const calls: RequestCall[] = [];
  const created = example(1);
  const versionTwo = version(2, NEXT_VERSION_ID, NEXT_PROJECT_VERSION_ID);
  const queue = [
    exampleResponse({ example: created, version: version(1) }, 201, 1, managementItemPath()),
    exampleResponse({ version: versionTwo, generation: 2 }, 201, 2),
    exampleResponse({ ...example(3), activeVersionId: NEXT_VERSION_ID }, 200, 3),
    exampleResponse({ ...example(4), activeVersionId: NEXT_VERSION_ID, visibility: "unlisted" }, 200, 4),
    exampleResponse({
      ...example(5),
      activeVersionId: NEXT_VERSION_ID,
      visibility: "unlisted",
      state: "unpublished",
      unpublishedAt: "2026-10-08T01:00:00Z",
      updatedAt: "2026-10-08T01:00:00Z"
    }, 200, 5),
    exampleResponse({ ...example(6), activeVersionId: NEXT_VERSION_ID, visibility: "unlisted" }, 200, 6),
    new Response(null, { status: 204 })
  ];
  const client = recordingClient(calls, queue);

  const createdResult = await createPublishedExample(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    projectVersionId: PROJECT_VERSION_ID,
    name: "Example",
    visibility: "public"
  }, { csrfToken: CSRF });
  const added = await addPublishedExampleVersion(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    exampleId: EXAMPLE_ID,
    projectVersionId: NEXT_PROJECT_VERSION_ID,
    etag: createdResult.etag
  }, { csrfToken: CSRF });
  const selected = await selectPublishedExampleActiveVersion(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    exampleId: EXAMPLE_ID,
    versionId: NEXT_VERSION_ID,
    etag: added.etag
  }, { csrfToken: CSRF });
  const hidden = await setPublishedExampleVisibility(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    exampleId: EXAMPLE_ID,
    visibility: "unlisted",
    etag: selected.etag
  }, { csrfToken: CSRF });
  const unpublished = await unpublishPublishedExample(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    exampleId: EXAMPLE_ID,
    etag: hidden.etag
  }, { csrfToken: CSRF });
  const republished = await republishPublishedExample(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    exampleId: EXAMPLE_ID,
    etag: unpublished.etag
  }, { csrfToken: CSRF });
  await deletePublishedExample(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    exampleId: EXAMPLE_ID,
    name: "Example",
    etag: republished.etag
  }, { csrfToken: CSRF });

  assert.equal(createdResult.location, managementItemPath());
  assert.deepEqual(calls.map((call) => [call.method, call.url, call.body, call.etag]), [
    ["POST", managementCollectionPath(), {
      projectVersionId: PROJECT_VERSION_ID, name: "Example", visibility: "public"
    }, null],
    ["POST", `${managementItemPath()}/versions`, {
      projectVersionId: NEXT_PROJECT_VERSION_ID
    }, '"published-example-v1"'],
    ["POST", `${managementItemPath()}/active-version`, { versionId: NEXT_VERSION_ID }, '"published-example-v2"'],
    ["PATCH", managementItemPath(), { visibility: "unlisted" }, '"published-example-v3"'],
    ["POST", `${managementItemPath()}/unpublish`, undefined, '"published-example-v4"'],
    ["POST", `${managementItemPath()}/republish`, undefined, '"published-example-v5"'],
    ["DELETE", managementItemPath(), { name: "Example" }, '"published-example-v6"']
  ]);
  assert.ok(calls.every((call) => call.csrf === CSRF));
}

async function publicContractAndFailClosedProjection(): Promise<void> {
  assert.equal(
    publicPublishedExampleContentPath({ publicId: PUBLIC_ID }),
    `/published-examples/${PUBLIC_ID}/content`
  );
  assert.equal(
    publicPublishedExampleContentPath({ publicId: PUBLIC_ID, versionNumber: 3 }),
    `/published-examples/${PUBLIC_ID}/versions/3/content`
  );
  const calls: string[] = [];
  const client = createApiClient({
    fetch: async (input) => {
      calls.push(String(input));
      if (calls.length === 1) return json({ items: [publicExample()] });
      return json(publicExample());
    }
  });
  await listPublicPublishedExamples(client, { limit: 7 });
  await getPublicPublishedExample(client, { publicId: PUBLIC_ID });
  await getPublicPublishedExampleVersion(client, { publicId: PUBLIC_ID, versionNumber: 1 });
  assert.deepEqual(calls, [
    "/api/v1/published-examples?limit=7",
    `/api/v1/published-examples/${PUBLIC_ID}`,
    `/api/v1/published-examples/${PUBLIC_ID}/versions/1`
  ]);

  for (const field of [
    "id", "projectId", "projectVersionId", "bundleId", "userId", "storageId",
    "activeVersionId", "generation", "createdAt", "updatedAt", "unpublishedAt"
  ]) {
    await assert.rejects(
      () => getPublicPublishedExample(single({ ...publicExample(), [field]: "internal" }), {
        publicId: PUBLIC_ID
      }),
      ApiInvalidResponseError
    );
  }
  await assert.rejects(
    () => listPublicPublishedExamples(single({ items: [{ ...publicExample(), projectId: PROJECT_ID }] })),
    ApiInvalidResponseError
  );
  await assert.rejects(
    () => getPublicPublishedExampleVersion(single(publicExample()), {
      publicId: PUBLIC_ID,
      versionNumber: 2
    }),
    ApiInvalidResponseError
  );
}

async function forkContractAndFailClosedProjection(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const forkedProjectId = "0199ee6c-c777-7000-8000-000000080006";
  const active = forkPayload(forkedProjectId, 2, false);
  const replay = forkPayload(forkedProjectId, 3, true);
  const location = `/api/v1/workspaces/users/${USER_ID}/projects/${forkedProjectId}`;
  const queue = [json(active, 201, { location }), json(replay, 200, { location })];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return queue.shift()!;
    }
  });

  const created = await forkPublishedExample(client, {
    publicId: PUBLIC_ID,
    destinationOwner: OWNER,
    slug: "forked-example",
    name: "Forked Example",
    idempotencyKey: "browser-fork-request-01"
  }, { csrfToken: CSRF });
  const retried = await forkPublishedExample(client, {
    publicId: PUBLIC_ID,
    versionNumber: 3,
    destinationOwner: OWNER,
    slug: "forked-example",
    name: "Forked Example",
    idempotencyKey: "browser-fork-request-02"
  }, { csrfToken: CSRF });

  assert.equal(created.location, location);
  assert.equal(created.data.idempotentRetry, false);
  assert.equal(retried.data.idempotentRetry, true);
  assert.deepEqual(calls.map(({ url, init }) => ({
    url,
    body: JSON.parse(String(init?.body)),
    csrf: new Headers(init?.headers).get("x-csrf-token"),
    idempotency: new Headers(init?.headers).get("idempotency-key")
  })), [
    {
      url: `/api/v1/published-examples/${PUBLIC_ID}/forks`,
      body: { destinationOwner: OWNER, slug: "forked-example", name: "Forked Example" },
      csrf: CSRF,
      idempotency: "browser-fork-request-01"
    },
    {
      url: `/api/v1/published-examples/${PUBLIC_ID}/versions/3/forks`,
      body: { destinationOwner: OWNER, slug: "forked-example", name: "Forked Example" },
      csrf: CSRF,
      idempotency: "browser-fork-request-02"
    }
  ]);

  for (const field of [
    "sourceExampleId", "sourceExampleVersionId", "sourceBundleId", "projectVersionId",
    "storageScopeId", "idempotencyKey"
  ]) {
    await assert.rejects(
      () => forkPublishedExample(single({ ...active, [field]: "internal" }), {
        publicId: PUBLIC_ID,
        destinationOwner: OWNER,
        slug: "forked-example",
        name: "Forked Example",
        idempotencyKey: "browser-fork-request-03"
      }, { csrfToken: CSRF }),
      ApiInvalidResponseError
    );
  }
}

async function invalidRequestsFailBeforeFetch(): Promise<void> {
  let fetched = false;
  const client = createApiClient({ fetch: async () => { fetched = true; return json({}); } });
  await assert.rejects(
    () => createPublishedExample(client, {
      owner: OWNER, projectId: PROJECT_ID, projectVersionId: PROJECT_VERSION_ID,
      name: " Example", visibility: "public"
    }, { csrfToken: CSRF }),
    ApiConfigurationError
  );
  await assert.rejects(
    () => unpublishPublishedExample(client, {
      owner: OWNER, projectId: PROJECT_ID, exampleId: EXAMPLE_ID,
      etag: 'W/"published-example-v1"'
    }, { csrfToken: CSRF }),
    ApiConfigurationError
  );
  await assert.rejects(
    () => getPublicPublishedExample(client, { publicId: `${PUBLIC_ID.slice(0, -1)}B` }),
    ApiConfigurationError
  );
  await assert.rejects(
    () => listPublicPublishedExamples(client, { limit: 101 }),
    ApiConfigurationError
  );
  await assert.rejects(
    () => forkPublishedExample(client, {
      publicId: PUBLIC_ID,
      destinationOwner: OWNER,
      slug: "Forked Example",
      name: "Forked Example",
      idempotencyKey: "short"
    }, { csrfToken: CSRF }),
    ApiConfigurationError
  );
  assert.equal(fetched, false);
}

function example(generation: number) {
  return {
    id: EXAMPLE_ID,
    publicId: PUBLIC_ID,
    name: "Example",
    visibility: "public",
    state: "published",
    activeVersionId: VERSION_ID,
    generation,
    createdAt: "2026-10-08T00:00:00Z",
    updatedAt: "2026-10-08T00:00:00Z",
    unpublishedAt: null
  };
}

function version(
  versionNumber: number,
  id = VERSION_ID,
  projectVersionId = PROJECT_VERSION_ID
) {
  return { id, projectVersionId, versionNumber, createdAt: "2026-10-08T00:00:00Z" };
}

function publicExample() {
  return {
    publicId: PUBLIC_ID,
    name: "Example",
    visibility: "public",
    versionNumber: 1,
    publishedAt: "2026-10-08T00:00:00Z"
  };
}

function forkPayload(projectId: string, sourceVersionNumber: number, idempotentRetry: boolean) {
  return {
    project: {
      id: projectId,
      ownerType: "user",
      ownerId: USER_ID,
      slug: "forked-example",
      name: "Forked Example",
      state: "active",
      version: 2,
      createdAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z"
    },
    sourceVersionNumber,
    idempotentRetry
  };
}

interface RequestCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly etag: string | null;
  readonly csrf: string | null;
}

function recordingClient(calls: RequestCall[], queue: Response[]) {
  return createApiClient({
    fetch: async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        etag: new Headers(init?.headers).get("if-match"),
        csrf: new Headers(init?.headers).get("x-csrf-token")
      });
      return queue.shift()!;
    }
  });
}

function exampleResponse(
  payload: unknown,
  status: number,
  generation: number,
  location?: string
): Response {
  return json(payload, status, {
    etag: `"published-example-v${generation}"`,
    ...(location === undefined ? {} : { location })
  });
}

function single(payload: unknown) {
  return createApiClient({ fetch: async () => json(payload) });
}

function json(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(payload, { status, ...(headers === undefined ? {} : { headers }) });
}

function managementCollectionPath(): string {
  return `/api/v1/workspaces/users/${USER_ID}/projects/${PROJECT_ID}/published-examples`;
}

function managementItemPath(): string {
  return `${managementCollectionPath()}/${EXAMPLE_ID}`;
}
