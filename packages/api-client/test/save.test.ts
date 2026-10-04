import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  ProjectTransferError,
  abortSaveSession,
  completeSaveSession,
  createApiClient,
  createSaveSession,
  downloadProjectContent,
  getProjectContentDescriptor,
  issueSaveParts,
  reconcileSaveSession,
  recordSaveReceipts,
  uploadSaveCapability
} from "../src/index.ts";
import type {
  ProjectContentDescriptor,
  ProjectContentSink,
  ProjectOwner,
  SavePart,
  SaveUploadCapability
} from "../src/index.ts";

const USER_ID = "018f22c4-3cb2-7cc8-98d8-b4f7f753f7bb";
const PROJECT_ID = "018f22c4-3cb8-7f31-b579-f044c9502bb7";
const SESSION_ID = "018f22c4-3cba-7521-9d3e-b07eb4be1411";
const BUNDLE_ID = "018f22c4-3cbb-7caa-a124-561dc8ed4033";
const OWNER: ProjectOwner = { ownerType: "user", ownerId: USER_ID };
const CSRF = "nrt_csrf_save-client";
const DIGEST_HEX = createHash("sha256").update("bundle").digest("hex");
const DIGEST_BASE64 = Buffer.from(DIGEST_HEX, "hex").toString("base64");
const PROJECT_PATH = `/api/v1/workspaces/users/${USER_ID}/projects/${PROJECT_ID}`;

await testSaveLifecycleWireContract();
await testMultipartWireContract();
await testUploadCapabilityBoundary();
await testBoundedVerifiedDownload();
await testDownloadFailuresAndCoreErrors();
await testInputAndResponseValidation();

async function testSaveLifecycleWireContract(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [
    jsonResponse(saveSession("single", capability(6, DIGEST_BASE64)), 201),
    jsonResponse({ bundleId: BUNDLE_ID, projectVersion: 2 }, 200, { etag: '"project-v2"' }),
    jsonResponse({ state: "committed", bundleId: BUNDLE_ID, projectVersion: 2 }),
    new Response(null, { status: 204 })
  ];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const response = queue.shift();
      assert.ok(response);
      return response;
    }
  });
  const created = await createSaveSession(
    client,
    {
      owner: OWNER,
      projectId: PROJECT_ID,
      projectEtag: '"project-v1"',
      idempotencyKey: "save-client-idempotency-0001",
      physicalBytes: 6,
      logicalBytes: 6,
      fileCount: 1,
      sha256: DIGEST_HEX
    },
    { csrfToken: CSRF }
  );
  assert.equal(created.status, 201);
  assert.equal(created.replayed, false);
  assert.equal(created.data.upload?.url, "https://storage.example.test/bucket?signature=secret");

  const completed = await completeSaveSession(
    client,
    { owner: OWNER, projectId: PROJECT_ID, sessionId: SESSION_ID, uploadMode: "single" },
    { csrfToken: CSRF }
  );
  assert.equal(completed.projectEtag, '"project-v2"');
  const reconciliation = await reconcileSaveSession(
    client,
    { owner: OWNER, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { csrfToken: CSRF }
  );
  assert.deepEqual(reconciliation.data, {
    state: "committed",
    bundleId: BUNDLE_ID,
    projectVersion: 2
  });
  await abortSaveSession(
    client,
    { owner: OWNER, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { csrfToken: CSRF }
  );

  assert.equal(calls[0]?.url, `${PROJECT_PATH}/save-sessions`);
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    physicalBytes: 6,
    logicalBytes: 6,
    fileCount: 1,
    sha256: DIGEST_BASE64,
    parts: []
  });
  const createHeaders = new Headers(calls[0]?.init.headers);
  assert.equal(createHeaders.get("if-match"), '"project-v1"');
  assert.equal(createHeaders.get("idempotency-key"), "save-client-idempotency-0001");
  assert.equal(createHeaders.get("x-csrf-token"), CSRF);
  assert.equal(calls[1]?.url, `${PROJECT_PATH}/save-sessions/${SESSION_ID}/complete`);
  assert.equal(calls[2]?.url, `${PROJECT_PATH}/save-sessions/${SESSION_ID}/reconcile`);
  assert.equal(calls[3]?.url, `${PROJECT_PATH}/save-sessions/${SESSION_ID}`);
  assert.equal(calls[3]?.init.method, "DELETE");
}

async function testMultipartWireContract(): Promise<void> {
  const partBytes = 16 * 1024 * 1024;
  const parts: readonly SavePart[] = [
    { partNumber: 1, expectedBytes: partBytes, sha256: DIGEST_HEX },
    { partNumber: 2, expectedBytes: partBytes, sha256: DIGEST_HEX },
    { partNumber: 3, expectedBytes: partBytes, sha256: DIGEST_HEX },
    { partNumber: 4, expectedBytes: partBytes, sha256: DIGEST_HEX },
    { partNumber: 5, expectedBytes: 1, sha256: DIGEST_HEX }
  ];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const capabilities = parts.map((part) => capability(part.expectedBytes, DIGEST_BASE64));
  const queue = [
    jsonResponse(saveSession("multipart", null, 5), 201),
    jsonResponse(capabilities),
    new Response(null, { status: 204 }),
    jsonResponse({ state: "notCommitted" })
  ];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const response = queue.shift();
      assert.ok(response);
      return response;
    }
  });
  await createSaveSession(
    client,
    {
      owner: OWNER,
      projectId: PROJECT_ID,
      projectEtag: '"project-v1"',
      idempotencyKey: "save-client-idempotency-0002",
      physicalBytes: partBytes * 4 + 1,
      logicalBytes: partBytes,
      fileCount: 1,
      sha256: DIGEST_HEX,
      parts
    },
    { csrfToken: CSRF }
  );
  const issued = await issueSaveParts(
    client,
    { owner: OWNER, projectId: PROJECT_ID, sessionId: SESSION_ID, parts },
    { csrfToken: CSRF }
  );
  assert.equal(issued.data.length, 5);
  const receipts = parts.map((part) => ({ ...part, etag: `"etag-${part.partNumber}"` }));
  await recordSaveReceipts(
    client,
    { owner: OWNER, projectId: PROJECT_ID, sessionId: SESSION_ID, receipts },
    { csrfToken: CSRF }
  );
  const reconciled = await reconcileSaveSession(
    client,
    { owner: OWNER, projectId: PROJECT_ID, sessionId: SESSION_ID },
    { csrfToken: CSRF }
  );
  assert.deepEqual(reconciled.data, { state: "notCommitted" });

  const createBody = JSON.parse(String(calls[0]?.init.body)) as { parts: unknown[] };
  assert.deepEqual(createBody.parts, parts.map((part) => ({
    partNumber: part.partNumber,
    expectedBytes: part.expectedBytes,
    sha256: DIGEST_BASE64
  })));
  assert.equal(calls[1]?.url, `${PROJECT_PATH}/save-sessions/${SESSION_ID}/parts`);
  assert.equal(calls[2]?.url, `${PROJECT_PATH}/save-sessions/${SESSION_ID}/parts/receipts`);
}

async function testUploadCapabilityBoundary(): Promise<void> {
  const body = new Blob(["bundle"]);
  const part: SavePart = { partNumber: 3, expectedBytes: body.size, sha256: DIGEST_HEX };
  const signed = capability(body.size, DIGEST_BASE64);
  let receivedInit: RequestInit | undefined;
  const receipt = await uploadSaveCapability(signed, part, body, {
    fetch: async (_input, init) => {
      receivedInit = init;
      return new Response(null, {
        status: 200,
        headers: { etag: '"object-etag"', "x-amz-checksum-sha256": DIGEST_BASE64 }
      });
    }
  });
  assert.deepEqual(receipt, { ...part, etag: '"object-etag"' });
  assert.equal(receivedInit?.credentials, "omit");
  assert.equal(receivedInit?.redirect, "error");
  assert.equal(receivedInit?.referrerPolicy, "no-referrer");
  const headers = new Headers(receivedInit?.headers);
  assert.equal(headers.get("content-length"), null, "the Browser owns Content-Length");
  assert.equal(headers.get("x-amz-checksum-sha256"), DIGEST_BASE64);

  const rejected = await captureError(uploadSaveCapability(signed, part, body, {
    fetch: async () => new Response(null, { status: 503 })
  }));
  assert.ok(rejected instanceof ProjectTransferError);
  assert.equal(rejected.phase, "upload");
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.retryable, true);
  assert.doesNotMatch(JSON.stringify(rejected), /signature|storage\.example/u);

  const missingEtag = await captureError(uploadSaveCapability(signed, part, body, {
    fetch: async () => new Response(null, { status: 200 })
  }));
  assert.ok(missingEtag instanceof ProjectTransferError);
  assert.equal(missingEtag.phase, "upload");
  assert.equal(missingEtag.kind, "invalid-response");
  assert.match(missingEtag.message, /upload response/u);

  const ambiguousEtag = await captureError(uploadSaveCapability(signed, part, body, {
    fetch: async () => new Response(null, { status: 200, headers: { etag: '"one", "two"' } })
  }));
  assert.ok(ambiguousEtag instanceof ProjectTransferError);
  assert.equal(ambiguousEtag.kind, "invalid-response");

  await assert.rejects(
    uploadSaveCapability(signed, { ...part, sha256: "0".repeat(64) }, body),
    ApiConfigurationError
  );
}

async function testBoundedVerifiedDownload(): Promise<void> {
  const bytes = new TextEncoder().encode("downloaded project bundle");
  const descriptor = contentDescriptor(bytes);
  const chunks: Uint8Array[] = [];
  let completed = false;
  const sink: ProjectContentSink<number> = {
    async write(chunk) {
      chunks.push(Uint8Array.from(chunk));
    },
    async complete(received) {
      completed = true;
      assert.deepEqual(received, descriptor);
      return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    },
    async abort() {
      assert.fail("successful download must not abort its sink");
    }
  };
  let receivedUrl: string | undefined;
  let receivedInit: RequestInit | undefined;
  const result = await downloadProjectContent(descriptor, {
    baseUrl: "https://core.example.test/",
    maxBytes: bytes.byteLength,
    sink,
    fetch: async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return binaryResponse(bytes, descriptor, [4, 7]);
    }
  });
  assert.equal(completed, true);
  assert.equal(result.receivedBytes, bytes.byteLength);
  assert.equal(result.sinkResult, bytes.byteLength);
  assert.equal(receivedUrl, `https://core.example.test${descriptor.downloadUrl}`);
  assert.equal(new Headers(receivedInit?.headers).get("if-match"), descriptor.etag);
  assert.deepEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), Buffer.from(bytes));
}

async function testDownloadFailuresAndCoreErrors(): Promise<void> {
  const bytes = new TextEncoder().encode("downloaded project bundle");
  const descriptor = contentDescriptor(bytes);
  const aborts: ProjectTransferError[] = [];
  const sink: ProjectContentSink<void> = {
    async write() {},
    async complete() {},
    async abort(error) { aborts.push(error); }
  };
  const corrupt = Uint8Array.from(bytes);
  corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
  const integrity = await captureError(downloadProjectContent(descriptor, {
    sink,
    fetch: async () => binaryResponse(corrupt, descriptor)
  }));
  assert.ok(integrity instanceof ProjectTransferError);
  assert.equal(integrity.kind, "integrity");
  assert.equal(aborts.at(-1)?.kind, "integrity");

  const tooLarge = await captureError(downloadProjectContent(descriptor, {
    sink,
    maxBytes: bytes.byteLength - 1,
    fetch: async () => assert.fail("oversized descriptor must fail before fetch")
  }));
  assert.ok(tooLarge instanceof ProjectTransferError);
  assert.equal(tooLarge.kind, "too-large");

  const problem = {
    type: "/docs/problems/commit-outcome-unknown",
    title: "Commit outcome unknown",
    status: 503,
    detail: "Reconcile the operation.",
    instance: descriptor.downloadUrl,
    code: "COMMIT_OUTCOME_UNKNOWN",
    request_id: "request-save-download",
    errors: []
  };
  const coreError = await captureError(downloadProjectContent(descriptor, {
    sink,
    fetch: async () => Response.json(problem, {
      status: 503,
      headers: { "content-type": "application/problem+json" }
    })
  }));
  assert.ok(coreError instanceof ApiError);
  assert.equal(coreError.code, "COMMIT_OUTCOME_UNKNOWN");
  assert.equal(coreError.retryable, true);

  const controller = new AbortController();
  const pending = downloadProjectContent(descriptor, {
    sink,
    signal: controller.signal,
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("abort secret")), { once: true });
    })
  });
  controller.abort("do-not-leak");
  const aborted = await captureError(pending);
  assert.ok(aborted instanceof ProjectTransferError);
  assert.equal(aborted.kind, "aborted");
  assert.doesNotMatch(String(aborted), /do-not-leak|secret/u);
}

async function testInputAndResponseValidation(): Promise<void> {
  const neverFetch = createApiClient({ fetch: async () => assert.fail("invalid input reached fetch") });
  const baseInput = {
    owner: OWNER,
    projectId: PROJECT_ID,
    projectEtag: '"project-v1"',
    idempotencyKey: "save-client-idempotency-0003",
    physicalBytes: 6,
    logicalBytes: 6,
    fileCount: 1,
    sha256: DIGEST_HEX
  };
  await assert.rejects(
    createSaveSession(neverFetch, { ...baseInput, idempotencyKey: "short" }, { csrfToken: CSRF }),
    ApiConfigurationError
  );
  await assert.rejects(
    createSaveSession(neverFetch, { ...baseInput, sha256: "A".repeat(64) }, { csrfToken: CSRF }),
    ApiConfigurationError
  );
  await assert.rejects(
    createSaveSession(neverFetch, {
      ...baseInput,
      physicalBytes: 64 * 1024 * 1024 + 1
    }, { csrfToken: CSRF }),
    ApiConfigurationError
  );

  const malformedSession = createApiClient({
    fetch: async () => jsonResponse({ ...saveSession("single", capability(6, DIGEST_BASE64)), secret: true }, 201)
  });
  await assert.rejects(
    createSaveSession(malformedSession, baseInput, { csrfToken: CSRF }),
    ApiInvalidResponseError
  );

  const descriptor = contentDescriptor(new TextEncoder().encode("bundle"));
  const descriptorClient = createApiClient({
    fetch: async () => jsonResponse(descriptor, 200, { etag: descriptor.etag })
  });
  const result = await getProjectContentDescriptor(descriptorClient, {
    owner: OWNER,
    projectId: PROJECT_ID
  });
  assert.equal(result.data.downloadUrl, descriptor.downloadUrl);

  const wrongProject = createApiClient({
    fetch: async () => jsonResponse({ ...descriptor, projectId: USER_ID }, 200, { etag: descriptor.etag })
  });
  await assert.rejects(
    getProjectContentDescriptor(wrongProject, { owner: OWNER, projectId: PROJECT_ID }),
    ApiInvalidResponseError
  );

  await assert.rejects(
    downloadProjectContent(descriptor, {
      baseUrl: "https://core.example.test/nested",
      sink: {
        async write() {},
        async complete() {},
        async abort() {}
      },
      fetch: async () => assert.fail("invalid base URL reached fetch")
    }),
    ApiConfigurationError
  );
}

function saveSession(
  uploadMode: "single" | "multipart",
  upload: SaveUploadCapability | null,
  partCount = 1
): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    uploadMode,
    expiresAt: "2026-10-04T23:59:59Z",
    partCount,
    idempotentRetry: false,
    upload
  };
}

function capability(expectedBytes: number, checksum: string): SaveUploadCapability {
  return {
    method: "PUT",
    url: "https://storage.example.test/bucket?signature=secret",
    headers: [
      { name: "content-length", value: String(expectedBytes) },
      { name: "content-type", value: "application/vnd.nuriteo.project-bundle" },
      { name: "x-amz-checksum-sha256", value: checksum }
    ],
    expectedBytes
  };
}

function contentDescriptor(bytes: Uint8Array): ProjectContentDescriptor {
  const checksum = createHash("sha256").update(bytes).digest("base64url");
  return {
    projectId: PROJECT_ID,
    projectVersion: 2,
    bundleId: BUNDLE_ID,
    etag: `"content-v2-${checksum}"`,
    checksumAlgorithm: "sha-256",
    checksum,
    physicalBytes: bytes.byteLength,
    logicalBytes: bytes.byteLength,
    fileCount: 1,
    format: "project-bundle-v1",
    downloadUrl: `${PROJECT_PATH}/content/${BUNDLE_ID}`
  };
}

function binaryResponse(
  bytes: Uint8Array,
  descriptor: ProjectContentDescriptor,
  splitAt: readonly number[] = []
): Response {
  let offset = 0;
  const boundaries = [...splitAt, bytes.byteLength];
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const boundary = boundaries.shift();
      if (boundary === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(Uint8Array.from(bytes.subarray(offset, boundary)));
      offset = boundary;
    }
  }), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      etag: descriptor.etag
    }
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) }
  });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    assert.fail("expected promise to reject");
  } catch (error) {
    return error;
  }
}
