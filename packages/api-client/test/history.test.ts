import assert from "node:assert/strict";

import {
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  createApiClient,
  createProjectVersion,
  listProjectVersions,
  listRecoveryCheckpoints,
  reconcileProjectHistory,
  restoreProjectHistory
} from "../src/index.ts";
import type {
  HistoricalReferenceKind,
  ProjectOwner
} from "../src/index.ts";

const OWNER_ID = "018f22c4-3cb2-7cc8-98d8-b4f7f753f7bb";
const PROJECT_ID = "018f22c4-3cb8-7f31-b579-f044c9502bb7";
const VERSION_ID = "018f22c4-3cba-7521-9d3e-b07eb4be1411";
const RECOVERY_ID = "018f22c4-3cbb-7caa-a124-561dc8ed4033";
const BUNDLE_ID = "018f22c4-3cbc-7d1f-8b08-4080996d7ba4";
const ACTOR_ID = "018f22c4-3cbd-7882-a2eb-f41c2e4de8b5";
const OPERATION_ID = "018f22c4-3cbe-79ac-b2ab-d9525194119f";
const OWNER: ProjectOwner = { ownerType: "user", ownerId: OWNER_ID };
const PROJECT_PATH = `/api/v1/workspaces/users/${OWNER_ID}/projects/${PROJECT_ID}`;
const CSRF = "nrt_csrf_history-client";
const KEY = "client-006-history-key-0001";

await testHistoryWireContract();
await testStrictRuntimeValidation();
await testRequestBoundsBeforeNetwork();
await testApiErrorPreservation();

async function testHistoryWireContract(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [
    jsonResponse({ version: version(), idempotentRetry: false }, 201),
    jsonResponse({ version: version(), idempotentRetry: true }),
    jsonResponse({ items: [version()], nextCursor: "nrt_project_cursor_next" }),
    jsonResponse({ items: [recovery()] }),
    jsonResponse(promotion("version", VERSION_ID, false), 200, { etag: '"project-v3"' }),
    jsonResponse(promotion("version", VERSION_ID, true), 200, { etag: '"project-v3"' })
  ];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const response = queue.shift();
      assert.ok(response);
      return response;
    }
  });

  const created = await createProjectVersion(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    name: "Release 1",
    projectEtag: '"project-v2"',
    idempotencyKey: KEY
  }, { csrfToken: CSRF });
  assert.equal(created.status, 201);
  assert.equal(created.replayed, false);
  const replay = await createProjectVersion(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    name: "Release 1",
    projectEtag: '"project-v2"',
    idempotencyKey: KEY
  }, { csrfToken: CSRF });
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, true);

  const versions = await listProjectVersions(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    pageSize: 2,
    cursor: "nrt_project_cursor_current"
  });
  assert.equal(versions.data.items[0]?.projectId, PROJECT_ID);
  assert.equal(versions.data.nextCursor, "nrt_project_cursor_next");
  const checkpoints = await listRecoveryCheckpoints(client, { owner: OWNER, projectId: PROJECT_ID });
  assert.equal(checkpoints.data.items[0]?.position, 1);

  const restored = await restoreProjectHistory(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    referenceKind: "version",
    referenceId: VERSION_ID,
    projectEtag: '"project-v2"',
    idempotencyKey: KEY
  }, { csrfToken: CSRF });
  assert.equal(restored.projectEtag, '"project-v3"');
  assert.equal(restored.data.changed, true);
  const reconciled = await reconcileProjectHistory(client, {
    owner: OWNER,
    projectId: PROJECT_ID,
    idempotencyKey: KEY
  });
  assert.equal(reconciled.data.idempotentRetry, true);

  assert.equal(calls[0]?.url, `${PROJECT_PATH}/versions`);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { name: "Release 1" });
  const createHeaders = new Headers(calls[0]?.init.headers);
  assert.equal(createHeaders.get("if-match"), '"project-v2"');
  assert.equal(createHeaders.get("idempotency-key"), KEY);
  assert.equal(createHeaders.get("x-csrf-token"), CSRF);
  assert.equal(
    calls[2]?.url,
    `${PROJECT_PATH}/versions?pageSize=2&cursor=nrt_project_cursor_current`
  );
  assert.equal(calls[3]?.url, `${PROJECT_PATH}/recovery-checkpoints`);
  assert.equal(calls[4]?.url, `${PROJECT_PATH}/history/restore`);
  assert.deepEqual(JSON.parse(String(calls[4]?.init.body)), {
    referenceKind: "version",
    referenceId: VERSION_ID
  });
  assert.equal(new Headers(calls[5]?.init.headers).get("idempotency-key"), KEY);
  assert.equal(calls[5]?.init.method, "GET");
}

async function testStrictRuntimeValidation(): Promise<void> {
  for (const body of [
    { items: [version(), version(), version(), version()] },
    { items: [{ ...recovery(), format: "zip" }] },
    { items: [{ ...recovery(), projectId: OWNER_ID }] },
    { items: [{ ...recovery(), position: 0 }] },
    { items: [{ ...recovery(), position: 4 }] },
    { items: [{ ...recovery() }, { ...recovery(), id: VERSION_ID }] }
  ]) {
    const client = createApiClient({ fetch: async () => jsonResponse(body) });
    await assert.rejects(
      listRecoveryCheckpoints(client, { owner: OWNER, projectId: PROJECT_ID }),
      ApiInvalidResponseError
    );
  }

  const oversizedPage = createApiClient({
    fetch: async () => jsonResponse({
      items: [version(), { ...version(), id: RECOVERY_ID }],
      nextCursor: null
    })
  });
  await assert.rejects(
    listProjectVersions(oversizedPage, { owner: OWNER, projectId: PROJECT_ID, pageSize: 1 }),
    ApiInvalidResponseError
  );

  for (const responseVersion of [
    { ...version(), name: "Unexpected name" },
    { ...version(), sourceProjectVersion: 3 }
  ]) {
    const mismatchedCreate = createApiClient({
      fetch: async () => jsonResponse({ version: responseVersion, idempotentRetry: false }, 201)
    });
    await assert.rejects(
      createProjectVersion(mismatchedCreate, {
        owner: OWNER,
        projectId: PROJECT_ID,
        name: "Release 1",
        projectEtag: '"project-v2"',
        idempotencyKey: KEY
      }, { csrfToken: CSRF }),
      ApiInvalidResponseError
    );
  }

  for (const body of [
    { items: [{ ...version(), sha256: "A".repeat(64) }], nextCursor: null },
    { items: [{ ...version(), unknown: true }], nextCursor: null },
    { items: [version()], nextCursor: "cursor with space" }
  ]) {
    const client = createApiClient({ fetch: async () => jsonResponse(body) });
    await assert.rejects(
      listProjectVersions(client, { owner: OWNER, projectId: PROJECT_ID }),
      ApiInvalidResponseError
    );
  }

  const wrongEtag = createApiClient({
    fetch: async () => jsonResponse(promotion("version", VERSION_ID), 200, { etag: '"project-v4"' })
  });
  await assert.rejects(
    restoreProjectHistory(wrongEtag, {
      owner: OWNER, projectId: PROJECT_ID, referenceKind: "version", referenceId: VERSION_ID,
      projectEtag: '"project-v2"', idempotencyKey: KEY
    }, { csrfToken: CSRF }),
    ApiInvalidResponseError
  );
}

async function testRequestBoundsBeforeNetwork(): Promise<void> {
  let calls = 0;
  const client = createApiClient({ fetch: async () => {
    calls += 1;
    return jsonResponse({});
  } });
  const listBase = { owner: OWNER, projectId: PROJECT_ID };
  for (const pageSize of [0, 101, 1.5]) {
    await assert.rejects(listProjectVersions(client, { ...listBase, pageSize }), ApiConfigurationError);
  }
  for (const cursor of ["", "unsafe cursor", "x".repeat(2_049)]) {
    await assert.rejects(listProjectVersions(client, { ...listBase, cursor }), ApiConfigurationError);
  }
  const restoreBase = {
    owner: OWNER,
    projectId: PROJECT_ID,
    referenceKind: "version" as const,
    referenceId: VERSION_ID,
    projectEtag: '"project-v2"'
  };
  for (const idempotencyKey of ["short", "x".repeat(129), "unsafe key value"] ) {
    await assert.rejects(
      restoreProjectHistory(client, { ...restoreBase, idempotencyKey }, { csrfToken: CSRF }),
      ApiConfigurationError
    );
  }
  await assert.rejects(
    restoreProjectHistory(client, { ...restoreBase, referenceId: BUNDLE_ID.replace("7d1f", "4d1f"), idempotencyKey: KEY }, { csrfToken: CSRF }),
    ApiConfigurationError
  );
  for (const name of ["e\u0301", "unsafe\u0085name"]) {
    await assert.rejects(
      createProjectVersion(client, {
        owner: OWNER,
        projectId: PROJECT_ID,
        name,
        projectEtag: '"project-v2"',
        idempotencyKey: KEY
      }, { csrfToken: CSRF }),
      ApiConfigurationError
    );
  }
  assert.equal(calls, 0);
}

async function testApiErrorPreservation(): Promise<void> {
  for (const [status, code] of [
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "COMMIT_OUTCOME_UNKNOWN"],
    [412, "PRECONDITION_FAILED"]
  ] as const) {
    const client = createApiClient({ fetch: async () => problemResponse(status, code) });
    const error = await captureError(restoreProjectHistory(client, {
      owner: OWNER,
      projectId: PROJECT_ID,
      referenceKind: "recovery",
      referenceId: RECOVERY_ID,
      projectEtag: '"project-v2"',
      idempotencyKey: KEY
    }, { csrfToken: CSRF }));
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.requestId, "request-history-error");
    assert.doesNotMatch(JSON.stringify(error), new RegExp(KEY, "u"));
  }
}

function version() {
  return {
    id: VERSION_ID,
    projectId: PROJECT_ID,
    bundleId: BUNDLE_ID,
    name: "Release 1",
    createdByUserId: ACTOR_ID,
    sourceProjectVersion: 2,
    createdAt: "2026-10-05T01:02:03Z",
    sha256: "0".repeat(64),
    physicalBytes: 42,
    logicalBytes: 40,
    fileCount: 1,
    format: "project-bundle-v1"
  };
}

function recovery() {
  const { name: _name, sourceProjectVersion: _version, ...base } = version();
  return { ...base, id: RECOVERY_ID, position: 1 };
}

function promotion(
  referenceKind: HistoricalReferenceKind,
  referenceId: string,
  idempotentRetry = false
) {
  return {
    operationId: OPERATION_ID,
    referenceKind,
    referenceId,
    bundleId: BUNDLE_ID,
    projectVersion: 3,
    changed: true,
    idempotentRetry
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) }
  });
}

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({
    type: "about:blank",
    title: "History error",
    status,
    detail: "The history request failed.",
    instance: "/api/v1/history/restore",
    code,
    request_id: "request-history-error",
    errors: []
  }), {
    status,
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": "request-history-error"
    }
  });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    assert.fail("expected rejection");
  } catch (error) {
    return error;
  }
}
