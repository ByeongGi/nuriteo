import assert from "node:assert/strict";

import {
  ApiAbortError,
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  ApiTimeoutError,
  archiveProject,
  changeDirectProjectRole,
  createApiClient,
  createProject,
  deleteProject,
  getProject,
  grantDirectProjectRole,
  listDirectProjectRoles,
  listProjects,
  renameProject,
  restoreProject,
  revokeDirectProjectRole
} from "../src/index.ts";
import type { ProblemDetails, ProjectOwner } from "../src/index.ts";

const USER_ID = "018f22c4-3cb2-7cc8-98d8-b4f7f753f7bb";
const ORGANIZATION_ID = "018f22c4-3cb5-7ac7-b464-8214f90ad21a";
const MEMBER_ID = "018f22c4-3cb6-7819-a58e-a5831700f999";
const PROJECT_ID = "018f22c4-3cb8-7f31-b579-f044c9502bb7";
const OTHER_PROJECT_ID = "018f22c4-3cb9-7ce8-9e53-798892f5b1f3";
const STORAGE_SCOPE_ID = "018f22c4-3cb4-70c0-8f01-7252dd5c2d61";
const CSRF = "nrt_csrf_project-client";
const PERSONAL_OWNER: ProjectOwner = { ownerType: "user", ownerId: USER_ID };
const ORGANIZATION_OWNER: ProjectOwner = {
  ownerType: "organization",
  ownerId: ORGANIZATION_ID
};

await testLifecycleContracts();
await testDirectRoleContractsAndNoOpRevoke();
await testListAndRuntimeValidation();
await testRequestValidationFailsBeforeFetch();
await testProblemAbortAndTimeoutPassthrough();

async function testLifecycleContracts(): Promise<void> {
  const calls: RequestCall[] = [];
  const created = project(1);
  const renamed = { ...project(2), name: "Renamed" };
  const archived = {
    ...project(3),
    name: "Renamed",
    state: "archived",
    updatedAt: "2026-10-04T01:00:00Z",
    archivedAt: "2026-10-04T01:00:00Z"
  };
  const restored = {
    ...project(4),
    name: "Renamed",
    updatedAt: "2026-10-04T02:00:00Z"
  };
  const queue = [
    projectResponse(created, 201, '"project-v1"', projectLocation(PERSONAL_OWNER)),
    projectResponse(created, 200, '"project-v1"'),
    projectResponse(renamed, 200, '"project-v2"'),
    projectResponse(archived, 200, '"project-v3"'),
    projectResponse(restored, 200, '"project-v4"'),
    new Response(null, { status: 204 })
  ];
  const client = recordingClient(calls, queue);

  const createdResult = await createProject(
    client,
    { owner: PERSONAL_OWNER, slug: "example-project", name: "Example" },
    { csrfToken: CSRF }
  );
  assert.equal(createdResult.etag, '"project-v1"');
  assert.equal(createdResult.location, projectLocation(PERSONAL_OWNER));
  await getProject(client, { owner: PERSONAL_OWNER, projectId: PROJECT_ID });
  const renamedResult = await renameProject(
    client,
    { owner: PERSONAL_OWNER, projectId: PROJECT_ID, name: "Renamed", etag: createdResult.etag },
    { csrfToken: CSRF }
  );
  const archivedResult = await archiveProject(
    client,
    { owner: PERSONAL_OWNER, projectId: PROJECT_ID, etag: renamedResult.etag },
    { csrfToken: CSRF }
  );
  const restoredResult = await restoreProject(
    client,
    { owner: PERSONAL_OWNER, projectId: PROJECT_ID, etag: archivedResult.etag },
    { csrfToken: CSRF }
  );
  await deleteProject(
    client,
    {
      owner: PERSONAL_OWNER,
      projectId: PROJECT_ID,
      name: "Renamed",
      etag: restoredResult.etag
    },
    { csrfToken: CSRF }
  );

  assertCalls(calls, [
    ["POST", projectCollection(PERSONAL_OWNER), { slug: "example-project", name: "Example" }, undefined],
    ["GET", projectLocation(PERSONAL_OWNER), undefined, undefined],
    ["PATCH", projectLocation(PERSONAL_OWNER), { name: "Renamed" }, '"project-v1"'],
    ["POST", `${projectLocation(PERSONAL_OWNER)}/archive`, undefined, '"project-v2"'],
    ["POST", `${projectLocation(PERSONAL_OWNER)}/restore`, undefined, '"project-v3"'],
    ["DELETE", projectLocation(PERSONAL_OWNER), { name: "Renamed" }, '"project-v4"']
  ]);
}

async function testDirectRoleContractsAndNoOpRevoke(): Promise<void> {
  const calls: RequestCall[] = [];
  const grant = directRole("admin", 1);
  const changedGrant = directRole("write", 2);
  const queue = [
    jsonResponse({ items: [grant], nextCursor: null }),
    roleMutationResponse({ changed: true, grant, projectVersion: 2 }, 201, 2),
    roleMutationResponse({ changed: true, grant: changedGrant, projectVersion: 3 }, 200, 3),
    roleMutationResponse({ changed: true, grant: null, projectVersion: 4 }, 200, 4),
    roleMutationResponse({ changed: false, grant: null, projectVersion: 4 }, 200, 4)
  ];
  const client = recordingClient(calls, queue);

  await listDirectProjectRoles(client, {
    owner: ORGANIZATION_OWNER,
    projectId: PROJECT_ID,
    pageSize: 25
  });
  const granted = await grantDirectProjectRole(
    client,
    {
      owner: ORGANIZATION_OWNER,
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      role: "admin",
      etag: '"project-v1"'
    },
    { csrfToken: CSRF }
  );
  const changed = await changeDirectProjectRole(
    client,
    {
      owner: ORGANIZATION_OWNER,
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      role: "write",
      etag: granted.etag
    },
    { csrfToken: CSRF }
  );
  const revoked = await revokeDirectProjectRole(
    client,
    {
      owner: ORGANIZATION_OWNER,
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      etag: changed.etag
    },
    { csrfToken: CSRF }
  );
  const noOp = await revokeDirectProjectRole(
    client,
    {
      owner: ORGANIZATION_OWNER,
      projectId: PROJECT_ID,
      userId: MEMBER_ID,
      etag: revoked.etag
    },
    { csrfToken: CSRF }
  );
  assert.equal(noOp.data.changed, false);
  assert.equal(noOp.data.projectVersion, 4);
  assert.equal(noOp.etag, '"project-v4"');

  const rolesPath = `${projectLocation(ORGANIZATION_OWNER)}/roles`;
  assert.equal(calls[0]?.url, `${rolesPath}?pageSize=25`);
  assertCalls(calls.slice(1), [
    ["POST", rolesPath, { userId: MEMBER_ID, role: "admin" }, '"project-v1"'],
    ["PATCH", `${rolesPath}/${MEMBER_ID}`, { role: "write" }, '"project-v2"'],
    ["DELETE", `${rolesPath}/${MEMBER_ID}`, undefined, '"project-v3"'],
    ["DELETE", `${rolesPath}/${MEMBER_ID}`, undefined, '"project-v4"']
  ]);
}

async function testListAndRuntimeValidation(): Promise<void> {
  const cursor = "nrt_project_cursor_opaque.value";
  let requestedUrl: string | undefined;
  const client = createApiClient({
    fetch: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({ items: [project(1)], nextCursor: cursor });
    }
  });
  const page = await listProjects(client, {
    owner: PERSONAL_OWNER,
    state: "all",
    pageSize: 1,
    cursor
  });
  assert.equal(
    requestedUrl,
    `${projectCollection(PERSONAL_OWNER)}?state=all&pageSize=1&cursor=${encodeURIComponent(cursor)}`
  );
  assert.equal(page.data.nextCursor, cursor);

  const invalidResponses: Response[] = [
    projectResponse({ ...project(1), extra: true }, 200, '"project-v1"'),
    projectResponse({ ...project(1), ownerId: ORGANIZATION_ID }, 200, '"project-v1"'),
    projectResponse(project(1), 200, 'W/"project-v1"'),
    projectResponse(project(1), 200, '"project-v2"'),
    jsonResponse({ items: Array.from({ length: 101 }, () => project(1)), nextCursor: null }),
    jsonResponse({ items: [], nextCursor: "x".repeat(2_049) }),
    roleMutationResponse({ changed: false, grant: directRole("read", 1), projectVersion: 1 }, 200, 1),
    jsonResponse({ items: [{ ...directRole("read", 1), organizationId: USER_ID }], nextCursor: null }),
    jsonResponse({ items: [{ ...directRole("read", 1), projectId: USER_ID }], nextCursor: null }),
    roleMutationResponse({ changed: true, grant: { ...directRole("read", 1), userId: USER_ID }, projectVersion: 2 }, 201, 2)
  ];
  for (const response of invalidResponses.slice(0, 4)) {
    await assert.rejects(
      getProject(responseClient(response), { owner: PERSONAL_OWNER, projectId: PROJECT_ID }),
      ApiInvalidResponseError
    );
  }
  await assert.rejects(
    getProject(
      responseClient(projectResponse({ ...project(1), id: OTHER_PROJECT_ID }, 200, '"project-v1"')),
      { owner: PERSONAL_OWNER, projectId: PROJECT_ID }
    ),
    ApiInvalidResponseError
  );
  await assert.rejects(
    renameProject(
      responseClient(projectResponse({ ...project(2), id: OTHER_PROJECT_ID }, 200, '"project-v2"')),
      {
        owner: PERSONAL_OWNER,
        projectId: PROJECT_ID,
        name: "Renamed",
        etag: '"project-v1"'
      },
      { csrfToken: CSRF }
    ),
    ApiInvalidResponseError
  );
  const archivedThenUpdated = await getProject(
    responseClient(projectResponse({
      ...project(3),
      state: "archived",
      archivedAt: "2026-10-04T01:00:00Z",
      updatedAt: "2026-10-04T02:00:00Z"
    }, 200, '"project-v3"')),
    { owner: PERSONAL_OWNER, projectId: PROJECT_ID }
  );
  assert.equal(archivedThenUpdated.data.updatedAt, "2026-10-04T02:00:00Z");
  await assert.rejects(
    getProject(
      responseClient(projectResponse({
        ...project(3),
        state: "archived",
        archivedAt: "2026-10-04T02:00:00Z",
        updatedAt: "2026-10-04T01:00:00Z"
      }, 200, '"project-v3"')),
      { owner: PERSONAL_OWNER, projectId: PROJECT_ID }
    ),
    ApiInvalidResponseError
  );
  for (const response of invalidResponses.slice(4, 6)) {
    await assert.rejects(
      listProjects(responseClient(response), { owner: PERSONAL_OWNER }),
      ApiInvalidResponseError
    );
  }
  await assert.rejects(
    revokeDirectProjectRole(
      responseClient(invalidResponses[6] as Response),
      {
        owner: ORGANIZATION_OWNER,
        projectId: PROJECT_ID,
        userId: MEMBER_ID,
        etag: '"project-v1"'
      },
      { csrfToken: CSRF }
    ),
    ApiInvalidResponseError
  );
  await assert.rejects(
    listDirectProjectRoles(responseClient(invalidResponses[7] as Response), {
      owner: ORGANIZATION_OWNER,
      projectId: PROJECT_ID
    }),
    ApiInvalidResponseError
  );
  await assert.rejects(
    listDirectProjectRoles(responseClient(invalidResponses[8] as Response), {
      owner: ORGANIZATION_OWNER,
      projectId: PROJECT_ID
    }),
    ApiInvalidResponseError
  );
  await assert.rejects(
    grantDirectProjectRole(
      responseClient(invalidResponses[9] as Response),
      {
        owner: ORGANIZATION_OWNER,
        projectId: PROJECT_ID,
        userId: MEMBER_ID,
        role: "read",
        etag: '"project-v1"'
      },
      { csrfToken: CSRF }
    ),
    ApiInvalidResponseError
  );
}

async function testRequestValidationFailsBeforeFetch(): Promise<void> {
  let fetches = 0;
  const client = createApiClient({
    fetch: async () => {
      fetches += 1;
      throw new Error("must not fetch");
    }
  });
  const operations: Array<() => Promise<unknown>> = [
    () => listProjects(client, { owner: PERSONAL_OWNER, pageSize: 0 }),
    () => listProjects(client, { owner: { ownerType: "users", ownerId: USER_ID } as never }),
    () => listProjects(client, { owner: PERSONAL_OWNER, cursor: "" }),
    () => listProjects(client, { owner: PERSONAL_OWNER, cursor: "opaque cursor" }),
    () => getProject(client, { owner: PERSONAL_OWNER, projectId: "not-a-uuid" }),
    () => renameProject(client, { owner: PERSONAL_OWNER, projectId: PROJECT_ID, name: "Renamed", etag: 'W/"project-v1"' }, { csrfToken: CSRF }),
    () => archiveProject(client, { owner: PERSONAL_OWNER, projectId: PROJECT_ID, etag: '"project-v01"' }, { csrfToken: CSRF }),
    () => archiveProject(client, { owner: PERSONAL_OWNER, projectId: PROJECT_ID, etag: '"project-v0"' }, { csrfToken: CSRF }),
    () => archiveProject(client, { owner: PERSONAL_OWNER, projectId: PROJECT_ID, etag: '"project-v9223372036854775807"' }, { csrfToken: CSRF }),
    () => archiveProject(client, { owner: PERSONAL_OWNER, projectId: PROJECT_ID, etag: `"project-v${"9".repeat(500)}"` }, { csrfToken: CSRF }),
    () => createProject(client, { owner: PERSONAL_OWNER, slug: "Bad-Slug", name: "Name" }, { csrfToken: CSRF }),
    () => deleteProject(client, { owner: PERSONAL_OWNER, projectId: PROJECT_ID, name: " Name", etag: '"project-v1"' }, { csrfToken: CSRF }),
    () => listDirectProjectRoles(client, { owner: PERSONAL_OWNER, projectId: PROJECT_ID }),
    () => grantDirectProjectRole(client, { owner: ORGANIZATION_OWNER, projectId: PROJECT_ID, userId: MEMBER_ID, role: "admin", etag: '"project-v1"' }, { csrfToken: "line\nbreak" })
  ];
  for (const operation of operations) {
    await assert.rejects(operation(), ApiConfigurationError);
  }
  assert.equal(fetches, 0);
}

async function testProblemAbortAndTimeoutPassthrough(): Promise<void> {
  const problem: ProblemDetails = {
    type: "/docs/problems/commit-outcome-unknown",
    title: "Commit outcome unknown",
    status: 503,
    detail: "Read the resource before deciding whether to retry.",
    instance: projectLocation(PERSONAL_OWNER),
    code: "COMMIT_OUTCOME_UNKNOWN",
    request_id: "request-project-unknown",
    errors: []
  };
  let attempts = 0;
  const uncertain = createApiClient({
    fetch: async () => {
      attempts += 1;
      return jsonResponse(problem, 503);
    }
  });
  await assert.rejects(
    renameProject(
      uncertain,
      { owner: PERSONAL_OWNER, projectId: PROJECT_ID, name: "Renamed", etag: '"project-v1"' },
      { csrfToken: CSRF }
    ),
    (error) =>
      error instanceof ApiError &&
      error.code === "COMMIT_OUTCOME_UNKNOWN" &&
      error.problem?.detail === problem.detail
  );
  assert.equal(attempts, 1);

  const abort = new AbortController();
  const pending = createApiClient({ fetch: pendingFetch });
  const aborted = getProject(
    pending,
    { owner: PERSONAL_OWNER, projectId: PROJECT_ID },
    { signal: abort.signal }
  );
  abort.abort("secret abort reason");
  await assert.rejects(aborted, ApiAbortError);
  await assert.rejects(
    listProjects(pending, { owner: PERSONAL_OWNER }, { timeoutMs: 1 }),
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

function responseClient(response: Response) {
  return createApiClient({ fetch: async () => response });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

function projectResponse(
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

function roleMutationResponse(body: unknown, status: number, version: number): Response {
  return jsonResponse(body, status, { etag: `"project-v${version}"` });
}

function project(version: number): Record<string, unknown> {
  return {
    id: PROJECT_ID,
    ownerType: "user",
    ownerId: USER_ID,
    storageScopeId: STORAGE_SCOPE_ID,
    slug: "example-project",
    name: "Example",
    state: "active",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    archivedAt: null,
    version
  };
}

function directRole(role: "read" | "write" | "admin", version: number): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    userId: MEMBER_ID,
    role,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    version
  };
}

function projectCollection(owner: ProjectOwner): string {
  const segment = owner.ownerType === "user" ? "users" : "organizations";
  return `/api/v1/workspaces/${segment}/${owner.ownerId}/projects`;
}

function projectLocation(owner: ProjectOwner): string {
  return `${projectCollection(owner)}/${PROJECT_ID}`;
}

function assertCalls(
  calls: readonly RequestCall[],
  expected: readonly (readonly [string, string, unknown, string | undefined])[]
): void {
  assert.equal(calls.length, expected.length);
  expected.forEach(([method, url, body, etag], index) => {
    const call = calls[index];
    assert.equal(call?.init?.method, method);
    assert.equal(call?.url, url);
    assert.deepEqual(
      call?.init?.body === undefined ? undefined : JSON.parse(String(call.init.body)),
      body
    );
    const headers = new Headers(call?.init?.headers);
    assert.equal(headers.get("if-match") ?? undefined, etag);
    assert.equal(headers.has("origin"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(headers.has("x-csrf-token"), method !== "GET");
  });
}

async function pendingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("secret reason")), {
      once: true
    });
  });
}
