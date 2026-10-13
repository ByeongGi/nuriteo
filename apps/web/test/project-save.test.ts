import assert from "node:assert/strict";

import { createApiClient } from "@nuriteo/api-client";

import { saveCurrentProject } from "../src/save/project-save.ts";
import type { RuntimeBundleFile } from "../src/runtime/runtime-adapter.ts";

const OWNER_ID = "0199ee6c-c777-7000-8000-000000006001";
const PROJECT_ID = "0199ee6c-c777-7000-8000-000000006002";
const SCOPE_ID = "0199ee6c-c777-7000-8000-000000006003";
const SESSION_ID = "0199ee6c-c777-7000-8000-000000006004";
const BUNDLE_ID = "0199ee6c-c777-7000-8000-000000006005";

await testSingleSaveAndRevisionFence();
await testRelaySingleSaveWithoutReceipt();
await testEmptyCurrentTree();
await testMultipartSave();
await testRelayMultipartSaveWithoutReceipts();
await testCancelledUploadAbortsSession();
await testIdempotencyKeyScopesBaseRevision();
await testAmbiguousCompleteReconciles();
await testExplicitAbortDoesNotReconcile();

async function testSingleSaveAndRevisionFence() {
  const current: readonly RuntimeBundleFile[] = [
    { path: "src/main.tsx", kind: "text", bytes: new TextEncoder().encode("before") },
    { path: "public/logo.bin", kind: "binary", bytes: Uint8Array.of(0, 255, 1, 2) },
    { path: "node_modules/ignored.js", kind: "text", bytes: Uint8Array.of(1) }
  ];
  let localRevision = 1;
  let snapshotCalls = 0;
  const requests: Array<{ body: unknown; headers: Headers; method: string; url: string }> = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ body, headers: new Headers(init?.headers), method: String(init?.method), url });
    if (url.endsWith("/save-sessions")) {
      const physicalBytes = Number(body?.physicalBytes);
      const checksum = String(body?.sha256);
      return Response.json({
        expiresAt: "2026-10-04T12:00:00Z",
        idempotentRetry: false,
        partCount: 1,
        sessionId: SESSION_ID,
        uploadMode: "single",
        upload: {
          transport: "direct",
          method: "PUT",
          url: "https://storage.test/upload?signature=redacted",
          expectedBytes: physicalBytes,
          headers: [{ name: "x-amz-checksum-sha256", value: checksum }]
        }
      }, { status: 201 });
    }
    if (url.startsWith("https://storage.test/")) {
      // A -> B -> A still advances the monotonic revision and must remain dirty.
      localRevision = 3;
      return new Response(null, { status: 200, headers: { etag: '"uploaded-etag"' } });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/complete`)) {
      return Response.json({
        type: "about:blank", title: "Unknown", status: 503, detail: "Unknown.",
        instance: "/api/v1/save", code: "RECONCILIATION_REQUIRED", request_id: "safe", errors: []
      }, {
        status: 503,
        headers: { "content-type": "application/problem+json", "x-request-id": "safe" }
      });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/reconcile`)) {
      return Response.json({ state: "committed", bundleId: BUNDLE_ID, projectVersion: 8 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const client = createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock });
  const result = await saveCurrentProject({
    client,
    csrfToken: "csrf-safe",
    owner: { ownerType: "user", ownerId: OWNER_ID },
    projectId: PROJECT_ID,
    storageScopeId: SCOPE_ID,
    projectEtag: '"project-v7"',
    snapshotCurrentTree: () => { snapshotCalls += 1; return { revision: 1, files: current }; },
    currentRevision: () => localRevision,
    transferFetch: fetchMock
  });
  assert.equal(result.projectEtag, '"project-v8"');
  assert.equal(requests.filter((item) => item.url.endsWith("/save-sessions")).length, 1, "unknown complete must reconcile before any new session");
  assert.equal(result.snapshotCurrent, false, "a mutation during upload must remain dirty");
  const create = requests[0];
  assert.equal(create?.headers.get("if-match"), '"project-v7"');
  assert.match(create?.headers.get("idempotency-key") ?? "", /^bundle-v7-[0-9a-f]{64}$/u);
  assert.equal(snapshotCalls, 1, "the current tree must be detached/exported only once per attempt");
  assert.equal((create?.body as { fileCount: number }).fileCount, 2, "system exclusions apply before planning");
  assert.equal(requests.filter((item) => item.url.startsWith("https://storage.test/")).length, 1);
}

async function testRelaySingleSaveWithoutReceipt() {
  const requests: Array<{ credentials: RequestCredentials | undefined; headers: Headers; method: string; url: string }> = [];
  let receiptRequests = 0;
  const relayPath = `/api/v1/workspaces/users/${OWNER_ID}/projects/${PROJECT_ID}/save-sessions/${SESSION_ID}/upload`;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ credentials: init?.credentials, headers: new Headers(init?.headers), method: String(init?.method), url });
    if (url.endsWith("/save-sessions")) {
      const checksum = String(body?.sha256);
      return Response.json({
        expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: 1,
        sessionId: SESSION_ID, uploadMode: "single", upload: {
          transport: "relay", method: "PUT", path: relayPath, expectedBytes: Number(body?.physicalBytes),
          headers: [
            { name: "Content-Type", value: "application/vnd.nuriteo.project-bundle" },
            { name: "X-Nuriteo-Content-SHA256", value: checksum }
          ]
        }
      }, { status: 201 });
    }
    if (url === relayPath) return new Response(null, { status: 204 });
    if (url.endsWith("/parts/receipts")) {
      receiptRequests += 1;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/complete`)) {
      return Response.json({ bundleId: BUNDLE_ID, projectVersion: 2 }, { headers: { etag: '"project-v2"' } });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const result = await saveCurrentProject({
    client: createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock }),
    csrfToken: "csrf-safe", owner: { ownerType: "user", ownerId: OWNER_ID },
    projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag: '"project-v1"',
    snapshotCurrentTree: () => ({ revision: 1, files: [] }), currentRevision: () => 1,
    transferFetch: fetchMock
  });
  assert.equal(result.projectEtag, '"project-v2"');
  const upload = requests.find((request) => request.url === relayPath);
  assert.equal(upload?.credentials, "same-origin");
  assert.equal(upload?.headers.get("x-csrf-token"), "csrf-safe");
  assert.equal(receiptRequests, 0, "relay uploads must not fabricate or submit storage receipts");
}

async function testEmptyCurrentTree() {
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (url.endsWith("/save-sessions")) return Response.json({
      expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: 1,
      sessionId: SESSION_ID, uploadMode: "single", upload: {
        transport: "direct",
        method: "PUT", url: "https://storage.test/empty", expectedBytes: Number(body?.physicalBytes),
        headers: [{ name: "x-amz-checksum-sha256", value: String(body?.sha256) }]
      }
    }, { status: 201 });
    if (url === "https://storage.test/empty") return new Response(null, { status: 200, headers: { etag: '"empty"' } });
    if (url.endsWith(`/save-sessions/${SESSION_ID}/complete`)) return Response.json(
      { bundleId: BUNDLE_ID, projectVersion: 2 }, { headers: { etag: '"project-v2"' } }
    );
    throw new Error(`unexpected request ${url}`);
  };
  const client = createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock });
  const result = await saveCurrentProject({
    client, csrfToken: "csrf-safe", owner: { ownerType: "user", ownerId: OWNER_ID },
    projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag: '"project-v1"',
    snapshotCurrentTree: () => ({ revision: 0, files: [] }), currentRevision: () => 0,
    transferFetch: fetchMock
  });
  assert.equal(result.snapshotCurrent, true);
  assert.ok(result.physicalBytes > 0, "an empty tree still has a canonical manifest archive");
}

async function testMultipartSave() {
  const files = Array.from({ length: 8 }, (_, index) => ({
    path: `large/part-${index}.bin`,
    kind: "binary" as const,
    bytes: new Uint8Array(16 * 1024 * 1024).fill(index)
  }));
  let snapshotCalls = 0;
  let uploadedParts = 0;
  let receiptCount = 0;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (url.endsWith("/save-sessions")) {
      const parts = body?.parts as unknown[];
      assert.ok(parts.length > 1);
      return Response.json({
        expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: parts.length,
        sessionId: SESSION_ID, uploadMode: "multipart", upload: null
      }, { status: 201 });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/parts`)) {
      const parts = body?.parts as Array<{ expectedBytes: number; partNumber: number; sha256: string }>;
      assert.ok(parts.length <= 16);
      return Response.json(parts.map((part) => ({
        transport: "direct",
        method: "PUT", url: `https://storage.test/part-${part.partNumber}`,
        expectedBytes: part.expectedBytes,
        headers: [{ name: "x-amz-checksum-sha256", value: part.sha256 }]
      })));
    }
    if (url.startsWith("https://storage.test/part-")) {
      uploadedParts += 1;
      return new Response(null, { status: 200, headers: { etag: `"part-${uploadedParts}"` } });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/parts/receipts`)) {
      const receipts = body?.receipts as unknown[];
      assert.ok(receipts.length <= 16);
      receiptCount += receipts.length;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/complete`)) {
      return Response.json({ bundleId: BUNDLE_ID, projectVersion: 3 }, { headers: { etag: '"project-v3"' } });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const result = await saveCurrentProject({
    client: createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock }),
    csrfToken: "csrf-safe", owner: { ownerType: "user", ownerId: OWNER_ID },
    projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag: '"project-v2"',
    snapshotCurrentTree: () => { snapshotCalls += 1; return { revision: 4, files }; },
    currentRevision: () => 4, transferFetch: fetchMock
  });
  assert.equal(result.projectEtag, '"project-v3"');
  assert.equal(uploadedParts, receiptCount);
  assert.ok(uploadedParts > 1);
  assert.equal(snapshotCalls, 1, "the legal 128 MiB tree must be exported once without completion re-cloning");
}

async function testRelayMultipartSaveWithoutReceipts() {
  const sharedBytes = new Uint8Array(14 * 1024 * 1024).fill(9);
  const files = Array.from({ length: 5 }, (_, index) => ({
    path: `relay/part-${index}.bin`,
    kind: "binary" as const,
    bytes: sharedBytes
  }));
  let uploadedParts = 0;
  let receiptRequests = 0;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (url.endsWith("/save-sessions")) {
      const parts = body?.parts as unknown[];
      assert.ok(parts.length > 1);
      return Response.json({
        expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: parts.length,
        sessionId: SESSION_ID, uploadMode: "multipart", upload: null
      }, { status: 201 });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/parts`)) {
      const parts = body?.parts as Array<{ expectedBytes: number; partNumber: number; sha256: string }>;
      return Response.json(parts.map((part) => ({
        transport: "relay",
        method: "PUT",
        path: `/api/v1/workspaces/users/${OWNER_ID}/projects/${PROJECT_ID}/save-sessions/${SESSION_ID}/upload/parts/${part.partNumber}`,
        expectedBytes: part.expectedBytes,
        headers: [
          { name: "Content-Type", value: "application/vnd.nuriteo.project-bundle" },
          { name: "X-Nuriteo-Content-SHA256", value: part.sha256 }
        ]
      })));
    }
    if (url.includes(`/save-sessions/${SESSION_ID}/upload/parts/`)) {
      uploadedParts += 1;
      assert.equal(init?.credentials, "same-origin");
      assert.equal(new Headers(init?.headers).get("x-csrf-token"), "csrf-safe");
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/parts/receipts`)) {
      receiptRequests += 1;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/complete`)) {
      return Response.json({ bundleId: BUNDLE_ID, projectVersion: 4 }, { headers: { etag: '"project-v4"' } });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const result = await saveCurrentProject({
    client: createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock }),
    csrfToken: "csrf-safe", owner: { ownerType: "user", ownerId: OWNER_ID },
    projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag: '"project-v3"',
    snapshotCurrentTree: () => ({ revision: 8, files }), currentRevision: () => 8,
    transferFetch: fetchMock
  });
  assert.equal(result.projectEtag, '"project-v4"');
  assert.ok(uploadedParts > 1);
  assert.equal(receiptRequests, 0, "relay multipart parts must never submit direct storage receipts");
}

async function testCancelledUploadAbortsSession() {
  const controller = new AbortController();
  let abortedSession = false;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (url.endsWith("/save-sessions")) return Response.json({
      expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: 1,
      sessionId: SESSION_ID, uploadMode: "single", upload: {
        transport: "direct",
        method: "PUT", url: "https://storage.test/cancel", expectedBytes: Number(body?.physicalBytes),
        headers: [{ name: "x-amz-checksum-sha256", value: String(body?.sha256) }]
      }
    }, { status: 201 });
    if (url === "https://storage.test/cancel") {
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}`) && init?.method === "DELETE") {
      abortedSession = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  await assert.rejects(saveCurrentProject({
    client: createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock }),
    csrfToken: "csrf-safe", owner: { ownerType: "user", ownerId: OWNER_ID },
    projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag: '"project-v3"',
    snapshotCurrentTree: () => ({ revision: 5, files: [] }), currentRevision: () => 5,
    transferFetch: fetchMock, signal: controller.signal
  }));
  assert.equal(abortedSession, true, "cancellation must still release the server reservation");
}

async function testIdempotencyKeyScopesBaseRevision() {
  const keys: string[] = [];
  const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    return Response.json({
      type: "about:blank", title: "Stale", status: 412, detail: "Stale.", instance: "/api/v1/save",
      code: "PROJECT_VERSION_STALE", request_id: "safe", errors: []
    }, { status: 412, headers: { "content-type": "application/problem+json" } });
  };
  const attempt = (projectEtag: string) => saveCurrentProject({
    client: createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock }),
    csrfToken: "csrf-safe", owner: { ownerType: "user", ownerId: OWNER_ID },
    projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag,
    snapshotCurrentTree: () => ({ revision: 1, files: [] }), currentRevision: () => 1,
    transferFetch: fetchMock
  });
  await assert.rejects(attempt('"project-v4"'));
  await assert.rejects(attempt('"project-v4"'));
  await assert.rejects(attempt('"project-v5"'));
  assert.equal(keys[0], keys[1], "the same snapshot and base revision must keep a stable key");
  assert.notEqual(keys[1], keys[2], "the same content on a new Project revision must use a new key");
}

async function testAmbiguousCompleteReconciles() {
  for (const mode of ["transport", "invalid", "timeout"] as const) {
    let reconciled = 0;
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      if (url.endsWith("/save-sessions")) return Response.json({
        expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: 1,
        sessionId: SESSION_ID, uploadMode: "single", upload: {
          transport: "direct",
          method: "PUT", url: `https://storage.test/${mode}`, expectedBytes: Number(body?.physicalBytes),
          headers: [{ name: "x-amz-checksum-sha256", value: String(body?.sha256) }]
        }
      }, { status: 201 });
      if (url === `https://storage.test/${mode}`) return new Response(null, { status: 200, headers: { etag: `"${mode}"` } });
      if (url.endsWith(`/save-sessions/${SESSION_ID}/complete`)) {
        if (mode === "transport") throw new TypeError("response lost");
        if (mode === "invalid") return Response.json({ malformed: true });
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
        });
      }
      if (url.endsWith(`/save-sessions/${SESSION_ID}/reconcile`)) {
        reconciled += 1;
        return Response.json({ state: "committed", bundleId: BUNDLE_ID, projectVersion: 9 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const result = await saveCurrentProject({
      client: createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock, timeoutMs: mode === "timeout" ? 5 : 1_000 }),
      csrfToken: "csrf-safe", owner: { ownerType: "user", ownerId: OWNER_ID },
      projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag: '"project-v8"',
      snapshotCurrentTree: () => ({ revision: 2, files: [] }), currentRevision: () => 2,
      transferFetch: fetchMock
    });
    assert.equal(result.projectEtag, '"project-v9"');
    assert.equal(reconciled, 1, `${mode} complete must reconcile exactly once`);
  }
}

async function testExplicitAbortDoesNotReconcile() {
  const controller = new AbortController();
  let reconciled = false;
  let abortedSession = false;
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (url.endsWith("/save-sessions")) return Response.json({
      expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: 1,
      sessionId: SESSION_ID, uploadMode: "single", upload: {
        transport: "direct",
        method: "PUT", url: "https://storage.test/user-abort", expectedBytes: Number(body?.physicalBytes),
        headers: [{ name: "x-amz-checksum-sha256", value: String(body?.sha256) }]
      }
    }, { status: 201 });
    if (url === "https://storage.test/user-abort") return new Response(null, { status: 200, headers: { etag: '"abort"' } });
    if (url.endsWith(`/save-sessions/${SESSION_ID}/complete`)) {
      controller.abort();
      throw new DOMException("user abort", "AbortError");
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/reconcile`)) {
      reconciled = true;
      return Response.json({ state: "notCommitted" });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}`) && init?.method === "DELETE") {
      abortedSession = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  await assert.rejects(saveCurrentProject({
    client: createApiClient({ baseUrl: "https://nuriteo.test", fetch: fetchMock }),
    csrfToken: "csrf-safe", owner: { ownerType: "user", ownerId: OWNER_ID },
    projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag: '"project-v9"',
    snapshotCurrentTree: () => ({ revision: 3, files: [] }), currentRevision: () => 3,
    transferFetch: fetchMock, signal: controller.signal
  }));
  assert.equal(reconciled, false, "an explicit user abort must not infer or reconcile commit outcome");
  assert.equal(abortedSession, true);
}
