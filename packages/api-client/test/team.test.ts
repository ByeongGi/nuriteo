import assert from "node:assert/strict";

import {
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  addTeamMember,
  addTeamProjectRole,
  changeTeamMemberRole,
  changeTeamProjectRole,
  createApiClient,
  createTeam,
  deleteTeam,
  getTeam,
  listTeamMembers,
  listTeamProjectRoles,
  listTeams,
  removeTeamMember,
  removeTeamProjectRole,
  renameTeam
} from "../src/index.ts";
import type { ApiClient, ProblemDetails } from "../src/index.ts";

const ORGANIZATION_ID = "0199ee6c-c777-7000-8000-000000009101";
const TEAM_ID = "0199ee6c-c777-7000-8000-000000009102";
const USER_ID = "0199ee6c-c777-7000-8000-000000009103";
const PROJECT_ID = "0199ee6c-c777-7000-8000-000000009104";
const CSRF = "nrt_csrf_team-client";
const COLLECTION = `/organizations/${ORGANIZATION_ID}/teams` as const;
const ITEM = `${COLLECTION}/${TEAM_ID}` as const;

await lifecycleAndNestedContracts();
await strictResponseAndRequestValidation();
await problemPropagation();

async function lifecycleAndNestedContracts(): Promise<void> {
  const calls: RequestCall[] = [];
  const queue = [
    entityResponse(team(1), 201, "team", 1, `/api/v1${ITEM}`),
    jsonResponse({ items: [team(1)], nextCursor: "nrt_team_cursor_opaque" }),
    entityResponse(team(1), 200, "team", 1),
    entityResponse({ ...team(2), displayName: "Platform Engineering", updatedAt: "2026-10-07T01:00:00Z" }, 200, "team", 2),
    jsonResponse({ changed: true }),
    jsonResponse({ items: [member(1)], nextCursor: null }),
    entityResponse(member(1), 201, "team-member", 1),
    entityResponse({ ...member(2), role: "maintainer", updatedAt: "2026-10-07T01:00:00Z" }, 200, "team-member", 2),
    jsonResponse({ changed: true }),
    jsonResponse({ items: [projectRole(1)], nextCursor: null }),
    entityResponse(projectRole(1), 201, "team-project-role", 1),
    entityResponse({ ...projectRole(2), role: "admin", updatedAt: "2026-10-07T01:00:00Z" }, 200, "team-project-role", 2),
    jsonResponse({ changed: false })
  ];
  const client = recordingClient(calls, queue);

  const created = await createTeam(
    client,
    { organizationId: ORGANIZATION_ID, slug: "platform", displayName: "Platform" },
    { csrfToken: CSRF }
  );
  assert.equal(created.etag, '"team-v1"');
  assert.equal(created.location, `/api/v1${ITEM}`);
  await listTeams(client, { organizationId: ORGANIZATION_ID, pageSize: 25, cursor: "nrt_team_cursor_opaque" });
  await getTeam(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID });
  await renameTeam(
    client,
    { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, displayName: "Platform Engineering", etag: '"team-v1"' },
    { csrfToken: CSRF }
  );
  await deleteTeam(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, etag: '"team-v2"' }, { csrfToken: CSRF });
  await listTeamMembers(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID });
  await addTeamMember(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, userId: USER_ID, role: "member" }, { csrfToken: CSRF });
  await changeTeamMemberRole(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, userId: USER_ID, role: "maintainer", etag: '"team-member-v1"' }, { csrfToken: CSRF });
  await removeTeamMember(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, userId: USER_ID, etag: '"team-member-v2"' }, { csrfToken: CSRF });
  await listTeamProjectRoles(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID });
  await addTeamProjectRole(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, projectId: PROJECT_ID, role: "write" }, { csrfToken: CSRF });
  await changeTeamProjectRole(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, projectId: PROJECT_ID, role: "admin", etag: '"team-project-role-v1"' }, { csrfToken: CSRF });
  const removed = await removeTeamProjectRole(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, projectId: PROJECT_ID, etag: '"team-project-role-v2"' }, { csrfToken: CSRF });
  assert.equal(removed.data.changed, false);

  assert.deepEqual(calls.map(({ method, path, body, etag }) => [method, path, body, etag]), [
    ["POST", COLLECTION, { slug: "platform", displayName: "Platform" }, null],
    ["GET", `${COLLECTION}?pageSize=25&cursor=nrt_team_cursor_opaque`, undefined, null],
    ["GET", ITEM, undefined, null],
    ["PATCH", ITEM, { displayName: "Platform Engineering" }, '"team-v1"'],
    ["DELETE", ITEM, undefined, '"team-v2"'],
    ["GET", `${ITEM}/members?pageSize=50`, undefined, null],
    ["POST", `${ITEM}/members`, { userId: USER_ID, role: "member" }, null],
    ["PATCH", `${ITEM}/members/${USER_ID}`, { role: "maintainer" }, '"team-member-v1"'],
    ["DELETE", `${ITEM}/members/${USER_ID}`, undefined, '"team-member-v2"'],
    ["GET", `${ITEM}/project-roles?pageSize=50`, undefined, null],
    ["POST", `${ITEM}/project-roles`, { projectId: PROJECT_ID, role: "write" }, null],
    ["PATCH", `${ITEM}/project-roles/${PROJECT_ID}`, { role: "admin" }, '"team-project-role-v1"'],
    ["DELETE", `${ITEM}/project-roles/${PROJECT_ID}`, undefined, '"team-project-role-v2"']
  ]);
  for (const call of calls.filter(({ method }) => method !== "GET")) {
    assert.equal(call.csrf, CSRF);
  }
}

async function strictResponseAndRequestValidation(): Promise<void> {
  const invalidResponses: Array<() => Promise<unknown>> = [
    () => getTeam(responseClient(entityResponse({ ...team(1), extra: true }, 200, "team", 1)), { organizationId: ORGANIZATION_ID, teamId: TEAM_ID }),
    () => getTeam(responseClient(entityResponse({ ...team(1), organizationId: USER_ID }, 200, "team", 1)), { organizationId: ORGANIZATION_ID, teamId: TEAM_ID }),
    () => getTeam(responseClient(entityResponse(team(1), 200, "team", 2)), { organizationId: ORGANIZATION_ID, teamId: TEAM_ID }),
    () => listTeams(responseClient(jsonResponse({ items: Array.from({ length: 101 }, () => team(1)), nextCursor: null })), { organizationId: ORGANIZATION_ID }),
    () => listTeamMembers(responseClient(jsonResponse({ items: [{ ...member(1), teamId: USER_ID }], nextCursor: null })), { organizationId: ORGANIZATION_ID, teamId: TEAM_ID }),
    () => listTeamProjectRoles(responseClient(jsonResponse({ items: [{ ...projectRole(1), organizationId: USER_ID }], nextCursor: null })), { organizationId: ORGANIZATION_ID, teamId: TEAM_ID })
  ];
  for (const operation of invalidResponses) await assert.rejects(operation(), ApiInvalidResponseError);

  let fetches = 0;
  const client = createApiClient({ fetch: async () => { fetches += 1; throw new Error("must not fetch"); } });
  const invalidRequests: Array<() => Promise<unknown>> = [
    () => listTeams(client, { organizationId: ORGANIZATION_ID, pageSize: 0 }),
    () => listTeams(client, { organizationId: ORGANIZATION_ID, cursor: "opaque cursor" }),
    () => createTeam(client, { organizationId: ORGANIZATION_ID, slug: "Bad-Slug", displayName: "Platform" }, { csrfToken: CSRF }),
    () => renameTeam(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, displayName: " Platform", etag: '"team-v1"' }, { csrfToken: CSRF }),
    () => deleteTeam(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, etag: 'W/"team-v1"' }, { csrfToken: CSRF }),
    () => changeTeamMemberRole(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, userId: USER_ID, role: "owner" as never, etag: '"team-member-v1"' }, { csrfToken: CSRF }),
    () => changeTeamProjectRole(client, { organizationId: ORGANIZATION_ID, teamId: TEAM_ID, projectId: PROJECT_ID, role: "owner" as never, etag: '"team-project-role-v1"' }, { csrfToken: CSRF })
  ];
  for (const operation of invalidRequests) await assert.rejects(operation(), ApiConfigurationError);
  assert.equal(fetches, 0);
}

async function problemPropagation(): Promise<void> {
  const problem: ProblemDetails = {
    type: "/docs/problems/forbidden",
    title: "Forbidden",
    status: 403,
    detail: "The Team operation is forbidden.",
    instance: `/api/v1${ITEM}`,
    code: "FORBIDDEN",
    request_id: "team-request",
    errors: []
  };
  await assert.rejects(
    getTeam(responseClient(Response.json(problem, { status: 403, headers: { "content-type": "application/problem+json" } })), { organizationId: ORGANIZATION_ID, teamId: TEAM_ID }),
    (error: unknown) => error instanceof ApiError && error.status === 403 && error.problem?.code === "FORBIDDEN"
  );
}

function team(version: number): Record<string, unknown> {
  return {
    id: TEAM_ID,
    organizationId: ORGANIZATION_ID,
    slug: "platform",
    displayName: "Platform",
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
    version
  };
}

function member(version: number): Record<string, unknown> {
  return {
    teamId: TEAM_ID,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    role: "member",
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
    version
  };
}

function projectRole(version: number): Record<string, unknown> {
  return {
    teamId: TEAM_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    role: "write",
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
    version
  };
}

function entityResponse(
  value: unknown,
  status: number,
  kind: "team" | "team-member" | "team-project-role",
  version: number,
  location?: string
): Response {
  return jsonResponse(value, status, {
    etag: `"${kind}-v${version}"`,
    ...(location === undefined ? {} : { location })
  });
}

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "x-request-id": "team-request", ...Object.fromEntries(new Headers(headers)) } });
}

function responseClient(response: Response): ApiClient {
  return createApiClient({ fetch: async () => response });
}

interface RequestCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly etag: string | null;
  readonly csrf: string | null;
}

function recordingClient(calls: RequestCall[], responses: Response[]): ApiClient {
  return createApiClient({
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? "GET",
        path: String(input).replace("http://localhost/api/v1", "").replace(/^\/api\/v1/u, ""),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        etag: headers.get("if-match"),
        csrf: headers.get("x-csrf-token")
      });
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });
}
