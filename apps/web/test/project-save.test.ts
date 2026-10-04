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
await testEmptyCurrentTree();
await testMultipartSave();
await testCancelledUploadAbortsSession();

async function testSingleSaveAndRevisionFence() {
  let current: readonly RuntimeBundleFile[] = [
    { path: "src/main.tsx", kind: "text", bytes: new TextEncoder().encode("before") },
    { path: "public/logo.bin", kind: "binary", bytes: Uint8Array.of(0, 255, 1, 2) },
    { path: "node_modules/ignored.js", kind: "text", bytes: Uint8Array.of(1) }
  ];
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
          method: "PUT",
          url: "https://storage.test/upload?signature=redacted",
          expectedBytes: physicalBytes,
          headers: [{ name: "x-amz-checksum-sha256", value: checksum }]
        }
      }, { status: 201 });
    }
    if (url.startsWith("https://storage.test/")) {
      current = [{ path: "src/main.tsx", kind: "text", bytes: new TextEncoder().encode("changed during save") }];
      return new Response(null, { status: 200, headers: { etag: '"uploaded-etag"' } });
    }
    if (url.endsWith(`/save-sessions/${SESSION_ID}/complete`)) {
      return Response.json({
        type: "about:blank", title: "Unknown", status: 503, detail: "Unknown.",
        instance: "/api/v1/save", code: "COMMIT_OUTCOME_UNKNOWN", request_id: "safe", errors: []
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
    exportCurrentTree: () => current,
    transferFetch: fetchMock
  });
  assert.equal(result.projectEtag, '"project-v8"');
  assert.equal(requests.filter((item) => item.url.endsWith("/save-sessions")).length, 1, "unknown complete must reconcile before any new session");
  assert.equal(result.snapshotCurrent, false, "a mutation during upload must remain dirty");
  const create = requests[0];
  assert.equal(create?.headers.get("if-match"), '"project-v7"');
  assert.match(create?.headers.get("idempotency-key") ?? "", /^bundle-[0-9a-f]{64}$/u);
  assert.equal((create?.body as { fileCount: number }).fileCount, 2, "system exclusions apply before planning");
  assert.equal(requests.filter((item) => item.url.startsWith("https://storage.test/")).length, 1);
}

async function testEmptyCurrentTree() {
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (url.endsWith("/save-sessions")) return Response.json({
      expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: 1,
      sessionId: SESSION_ID, uploadMode: "single", upload: {
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
    projectId: PROJECT_ID, storageScopeId: SCOPE_ID, projectEtag: '"project-v1"', exportCurrentTree: () => [],
    transferFetch: fetchMock
  });
  assert.equal(result.snapshotCurrent, true);
  assert.ok(result.physicalBytes > 0, "an empty tree still has a canonical manifest archive");
}

async function testMultipartSave() {
  const files = Array.from({ length: 5 }, (_, index) => ({
    path: `large/part-${index}.bin`,
    kind: "binary" as const,
    bytes: new Uint8Array(15 * 1024 * 1024).fill(index)
  }));
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
    exportCurrentTree: () => files, transferFetch: fetchMock
  });
  assert.equal(result.projectEtag, '"project-v3"');
  assert.equal(uploadedParts, receiptCount);
  assert.ok(uploadedParts > 1);
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
    exportCurrentTree: () => [], transferFetch: fetchMock, signal: controller.signal
  }));
  assert.equal(abortedSession, true, "cancellation must still release the server reservation");
}
