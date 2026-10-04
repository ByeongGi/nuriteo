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
  DirectSaveUploadCapability,
  ProjectContentDescriptor,
  ProjectContentSink,
  ProjectOwner,
  RelaySaveUploadCapability,
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
const OTHER_DIGEST_BASE64 = Buffer.alloc(32, 1).toString("base64");
const PROJECT_PATH = `/api/v1/workspaces/users/${USER_ID}/projects/${PROJECT_ID}`;

await testSaveLifecycleWireContract();
await testMultipartWireContract();
await testUploadCapabilityBoundary();
await testRelayUploadCapabilityBoundary();
await testHardTransferDeadlines();
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
  assert.equal(created.data.upload?.transport, "direct");
  if (created.data.upload?.transport !== "direct") assert.fail("expected direct capability");
  assert.equal(created.data.upload.url, "https://storage.example.test/bucket?signature=secret");

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

  const mismatchedCapability = createApiClient({
    fetch: async () => jsonResponse(capabilities.map((item, index) =>
      index === 0 ? capability(item.expectedBytes, OTHER_DIGEST_BASE64) : item
    ))
  });
  await assert.rejects(
    issueSaveParts(
      mismatchedCapability,
      { owner: OWNER, projectId: PROJECT_ID, sessionId: SESSION_ID, parts },
      { csrfToken: CSRF }
    ),
    ApiInvalidResponseError
  );
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
  assert.deepEqual(receipt, {
    transport: "direct",
    receipt: { ...part, etag: '"object-etag"' }
  });
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

  const mismatchedResponseChecksum = await captureError(uploadSaveCapability(signed, part, body, {
    fetch: async () => new Response(null, {
      status: 200,
      headers: { etag: '"object-etag"', "x-amz-checksum-sha256": OTHER_DIGEST_BASE64 }
    })
  }));
  assert.ok(mismatchedResponseChecksum instanceof ProjectTransferError);
  assert.equal(mismatchedResponseChecksum.kind, "integrity");

  await assert.rejects(
    uploadSaveCapability(signed, { ...part, sha256: "0".repeat(64) }, body),
    ApiConfigurationError
  );

  for (const url of [
    "http://storage.example.test/bucket?signature=secret",
    "http://localhost:9000/bucket?signature=secret",
    "http://127.0.0.1:9000/bucket?signature=secret"
  ]) {
    await assert.rejects(
      uploadSaveCapability({ ...signed, url }, part, body, {
        fetch: async () => assert.fail("plaintext bearer capability reached fetch")
      }),
      ApiConfigurationError
    );
  }
}

async function testRelayUploadCapabilityBoundary(): Promise<void> {
  const body = new Blob(["bundle"], { type: "application/vnd.nuriteo.project-bundle" });
  const part: SavePart = { partNumber: 1, expectedBytes: body.size, sha256: DIGEST_HEX };
  const relay = relayCapability("single", part, DIGEST_BASE64);
  const relayOptions = {
    owner: OWNER,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    uploadMode: "single" as const,
    csrfToken: CSRF
  };
  let calls = 0;
  let receivedInput: RequestInfo | URL | undefined;
  let receivedInit: RequestInit | undefined;
  const result = await uploadSaveCapability(relay, part, body, {
    ...relayOptions,
    fetch: async (input, init) => {
      calls += 1;
      receivedInput = input;
      receivedInit = init;
      return new Response(null, { status: 204 });
    }
  });
  assert.deepEqual(result, { transport: "relay" });
  assert.equal(calls, 1);
  assert.equal(receivedInput, relay.path);
  assert.equal(receivedInit?.body, body, "the relay client must not copy or buffer the body");
  assert.equal(receivedInit?.credentials, "same-origin");
  assert.equal(receivedInit?.redirect, "error");
  assert.equal(receivedInit?.referrerPolicy, "no-referrer");
  const headers = new Headers(receivedInit?.headers);
  assert.equal(headers.get("content-type"), "application/vnd.nuriteo.project-bundle");
  assert.equal(headers.get("x-nuriteo-content-sha256"), DIGEST_BASE64);
  assert.equal(headers.get("x-csrf-token"), CSRF);
  assert.equal(headers.get("content-length"), null, "the Browser owns Content-Length");
  assert.equal(headers.get("x-amz-checksum-sha256"), null);

  const relayClient = createApiClient({
    fetch: async () => jsonResponse(saveSession("single", relay), 201)
  });
  const created = await createSaveSession(relayClient, {
    owner: OWNER,
    projectId: PROJECT_ID,
    projectEtag: '"project-v1"',
    idempotencyKey: "save-client-relay-identity-0001",
    physicalBytes: body.size,
    logicalBytes: body.size,
    fileCount: 1,
    sha256: DIGEST_HEX
  }, { csrfToken: CSRF });
  assert.equal(created.data.upload?.transport, "relay");
  assert.equal(created.data.upload?.path, relay.path);

  const multipartPart = { ...part, partNumber: 3 };
  const multipartCapability = relayCapability("part", multipartPart, DIGEST_BASE64);
  const issueClient = createApiClient({
    fetch: async () => jsonResponse([multipartCapability])
  });
  const issued = await issueSaveParts(issueClient, {
    owner: OWNER,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    parts: [multipartPart]
  }, { csrfToken: CSRF });
  assert.equal(issued.data[0]?.transport, "relay");
  assert.equal(issued.data[0]?.path, multipartCapability.path);
  assert.deepEqual(issued.data[0]?.headers.map((header) => header.name), [
    "content-type",
    "x-nuriteo-content-sha256"
  ]);

  let failedFetches = 0;
  const neverFetch = async () => {
    failedFetches += 1;
    return new Response(null, { status: 204 });
  };
  const malformedCapabilities: unknown[] = [
    { ...relay, transport: "direct" },
    { ...relay, url: "https://storage.example.test/object?signature=secret" },
    { ...relay, method: "POST" },
    { ...relay, path: `${relay.path}?mixed=true` },
    { ...relay, path: relay.path.replace(PROJECT_ID, USER_ID) },
    { ...relay, expectedBytes: body.size + 1 },
    { ...relay, headers: [...relay.headers, { name: "x-amz-checksum-sha256", value: DIGEST_BASE64 }] },
    { ...relay, headers: relay.headers.map((header) => (
      header.name.toLowerCase() === "x-nuriteo-content-sha256"
        ? { ...header, value: OTHER_DIGEST_BASE64 }
        : header
    )) },
    { ...relay, extra: true }
  ];
  for (const malformed of malformedCapabilities) {
    await assert.rejects(
      uploadSaveCapability(
        malformed as RelaySaveUploadCapability,
        part,
        body,
        { ...relayOptions, fetch: neverFetch }
      ),
      ApiConfigurationError
    );
  }
  await assert.rejects(
    uploadSaveCapability(relay, part, body, {
      ...relayOptions,
      csrfToken: "bad\ncsrf",
      fetch: neverFetch
    }),
    ApiConfigurationError
  );
  await assert.rejects(
    uploadSaveCapability(relay, part, body, {
      ...relayOptions,
      sessionId: USER_ID,
      fetch: neverFetch
    }),
    ApiConfigurationError
  );
  await assert.rejects(
    uploadSaveCapability(capability(body.size, DIGEST_BASE64), part, body, {
      csrfToken: CSRF,
      fetch: neverFetch
    } as never),
    ApiConfigurationError
  );
  assert.equal(failedFetches, 0, "malformed or mixed transport data must fail before fetch");

  let rejectedCalls = 0;
  const rejected = await captureError(uploadSaveCapability(relay, part, body, {
    ...relayOptions,
    fetch: async () => {
      rejectedCalls += 1;
      return Response.json({
        type: "/docs/problems/upload",
        title: "Upload rejected",
        status: 503,
        detail: "The relay is unavailable.",
        instance: relay.path,
        code: "UPLOAD_UNAVAILABLE",
        request_id: "request-relay-upload",
        errors: []
      }, { status: 503, headers: { "content-type": "application/problem+json" } });
    }
  }));
  assert.ok(rejected instanceof ApiError);
  assert.equal(rejected.status, 503);
  assert.equal(rejectedCalls, 1, "a non-replayable upload must never retry automatically");
  assert.doesNotMatch(String(rejected), /csrf|checksum|signature|secret/iu);

  const malformedSuccess = await captureError(uploadSaveCapability(relay, part, body, {
    ...relayOptions,
    fetch: async () => new Response(null, { status: 200 })
  }));
  assert.ok(malformedSuccess instanceof ProjectTransferError);
  assert.equal(malformedSuccess.kind, "invalid-response");
}

async function testHardTransferDeadlines(): Promise<void> {
  const body = new Blob(["bundle"]);
  const part: SavePart = { partNumber: 1, expectedBytes: body.size, sha256: DIGEST_HEX };
  let resolveUpload: (response: Response) => void = () => undefined;
  let uploadBodyCancelled = false;
  const uploadFetch = new Promise<Response>((resolve) => { resolveUpload = resolve; });
  const uploadError = await captureWithin(uploadSaveCapability(
    capability(body.size, DIGEST_BASE64),
    part,
    body,
    { timeoutMs: 10, fetch: () => uploadFetch }
  ));
  assert.ok(uploadError instanceof ProjectTransferError);
  assert.equal(uploadError.kind, "timeout");
  resolveUpload(new Response(new ReadableStream<Uint8Array>({
    cancel() { uploadBodyCancelled = true; }
  }), {
    status: 200,
    headers: { etag: '"late-upload"' }
  }));
  await nextTurn();
  assert.equal(uploadBodyCancelled, true, "a late upload response body must be cancelled");

  const bytes = new TextEncoder().encode("downloaded project bundle");
  const descriptor = contentDescriptor(bytes);
  let rejectFetch: (reason: unknown) => void = () => undefined;
  const ignoredDownloadFetch = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
  const fetchTimeout = await captureWithin(downloadProjectContent(descriptor, {
    timeoutMs: 10,
    sink: noOpSink(),
    fetch: () => ignoredDownloadFetch
  }));
  assert.ok(fetchTimeout instanceof ProjectTransferError);
  assert.equal(fetchTimeout.kind, "timeout");
  rejectFetch(new Error("late fetch rejection"));
  await nextTurn();

  let sinkAbortCalled = false;
  const sinkTimeout = await captureWithin(downloadProjectContent(descriptor, {
    timeoutMs: 10,
    sink: {
      async write() { return new Promise<void>(() => undefined); },
      async complete() {},
      async abort() {
        sinkAbortCalled = true;
        return new Promise<void>(() => undefined);
      }
    },
    fetch: async () => binaryResponse(bytes, descriptor)
  }));
  assert.ok(sinkTimeout instanceof ProjectTransferError);
  assert.equal(sinkTimeout.kind, "timeout");
  await nextTurn();
  assert.equal(sinkAbortCalled, true, "deadline cleanup must start without delaying the caller");
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

  let invalidMetadataBodyCancelled = false;
  const invalidMetadata = await captureError(downloadProjectContent(descriptor, {
    sink,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.from(bytes)); },
      cancel() { invalidMetadataBodyCancelled = true; }
    }), {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": String(bytes.byteLength),
        etag: descriptor.etag
      }
    })
  }));
  assert.ok(invalidMetadata instanceof ProjectTransferError);
  assert.equal(invalidMetadata.kind, "invalid-response");
  assert.equal(invalidMetadataBodyCancelled, true);

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

  const mismatchedSingleCapability = createApiClient({
    fetch: async () => jsonResponse(
      saveSession("single", capability(6, OTHER_DIGEST_BASE64)),
      201
    )
  });
  await assert.rejects(
    createSaveSession(mismatchedSingleCapability, baseInput, { csrfToken: CSRF }),
    ApiInvalidResponseError
  );

  const plaintextSingleCapability = createApiClient({
    fetch: async () => jsonResponse(
      saveSession("single", {
        ...capability(6, DIGEST_BASE64),
        url: "http://127.0.0.1:9000/bucket?signature=secret"
      }),
      201
    )
  });
  await assert.rejects(
    createSaveSession(plaintextSingleCapability, baseInput, { csrfToken: CSRF }),
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

function capability(expectedBytes: number, checksum: string): DirectSaveUploadCapability {
  return {
    transport: "direct",
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

function relayCapability(
  kind: "single" | "part",
  part: SavePart,
  checksum: string
): RelaySaveUploadCapability {
  const base = `${PROJECT_PATH}/save-sessions/${SESSION_ID}/upload`;
  return {
    transport: "relay",
    method: "PUT",
    path: (kind === "single" ? base : `${base}/parts/${part.partNumber}`) as `/${string}`,
    headers: [
      { name: "Content-Type", value: "application/vnd.nuriteo.project-bundle" },
      { name: "X-Nuriteo-Content-SHA256", value: checksum }
    ],
    expectedBytes: part.expectedBytes
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

async function captureWithin(promise: Promise<unknown>, maximumMs = 500): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      captureError(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("transfer did not settle by its hard deadline")), maximumMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function noOpSink(): ProjectContentSink<void> {
  return {
    async write() {},
    async complete() {},
    async abort() {}
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
