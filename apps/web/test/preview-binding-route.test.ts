import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const applicationOrigin = "http://app.localhost:3042";
const ownerId = "019a4a82-1640-7000-8000-000000000010";
const projectId = "019a4a82-1640-7000-8000-000000000011";
const storageScopeId = "019a4a82-1640-7000-8000-000000000012";
const userId = "019a4a82-1640-7000-8000-000000000013";
const sessionId = "019a4a82-1640-7000-8000-000000000014";
const csrf = `nrt_csrf_${"A".repeat(43)}`;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-preview-binding-"));
const signingKeyFile = path.join(temporaryDirectory, "signing-key");
fs.writeFileSync(signingKeyFile, randomBytes(32).toString("base64url"), { mode: 0o600 });

const originalEnvironment = {
  externalUrl: process.env.NURITEO_EXTERNAL_URL,
  internalApiUrl: process.env.NURITEO_INTERNAL_API_URL,
  previewBaseDomain: process.env.NURITEO_PREVIEW_BASE_DOMAIN,
  signingKeyFile: process.env.NURITEO_PREVIEW_SIGNING_KEY_FILE
};
const originalFetch = globalThis.fetch;

process.env.NURITEO_EXTERNAL_URL = applicationOrigin;
process.env.NURITEO_INTERNAL_API_URL = "http://core.internal";
process.env.NURITEO_PREVIEW_BASE_DOMAIN = "preview.localhost";
process.env.NURITEO_PREVIEW_SIGNING_KEY_FILE = signingKeyFile;

try {
  const { POST } = await import("../src/app/api/runtime-preview/bindings/route.ts");

  for (const scenario of ["anonymous", "stale-session", "no-project-access"] as const) {
    globalThis.fetch = coreFetch(scenario);
    const response = await POST(bindingRequest());
    assert.equal(response.status, 403, scenario);
    assert.equal((await response.json() as { code: string }).code, "PREVIEW_BINDING_REJECTED");
  }

  globalThis.fetch = coreFetch("authorized");
  const response = await POST(bindingRequest());
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json() as { runtimeId: string; ttlMs: number };
  assert.match(result.runtimeId, /^[a-z2-7]{45}$/u);
  assert.ok(result.ttlMs > 0 && result.ttlMs <= 6_000, "the client receives a bounded relative lifetime, not a wall-clock expiry");

  let stalledBodyCancelled = false;
  const stalledBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    cancel() { stalledBodyCancelled = true; }
  });
  const startedAt = performance.now();
  const keepProcessAlive = setTimeout(() => undefined, 6_500);
  const stalledResponse = await POST(new Request(`${applicationOrigin}/api/runtime-preview/bindings`, {
      body: stalledBody,
      duplex: "half",
      headers: {
        "content-type": "application/json",
        cookie: `nuriteo_dev_session=session; nuriteo_dev_csrf=${csrf}`,
        origin: applicationOrigin,
        "x-csrf-token": csrf
      },
      method: "POST"
    } as RequestInit & { duplex: "half" }))
    .finally(() => clearTimeout(keepProcessAlive));
  const elapsed = performance.now() - startedAt;
  assert.equal(stalledResponse.status, 504);
  assert.ok(elapsed >= 4_500 && elapsed < 6_500, `stalled body deadline was ${elapsed}ms`);
  assert.equal(stalledBodyCancelled, true);
} finally {
  globalThis.fetch = originalFetch;
  restoreEnvironment("NURITEO_EXTERNAL_URL", originalEnvironment.externalUrl);
  restoreEnvironment("NURITEO_INTERNAL_API_URL", originalEnvironment.internalApiUrl);
  restoreEnvironment("NURITEO_PREVIEW_BASE_DOMAIN", originalEnvironment.previewBaseDomain);
  restoreEnvironment("NURITEO_PREVIEW_SIGNING_KEY_FILE", originalEnvironment.signingKeyFile);
  fs.rmSync(temporaryDirectory, { recursive: true });
}

function bindingRequest(): Request {
  return new Request(`${applicationOrigin}/api/runtime-preview/bindings`, {
    body: JSON.stringify({ ownerId, ownerType: "organization", port: 4173, projectId }),
    headers: {
      "content-type": "application/json",
      cookie: `nuriteo_dev_session=session; nuriteo_dev_csrf=${csrf}`,
      origin: applicationOrigin,
      "x-csrf-token": csrf
    },
    method: "POST"
  });
}

function coreFetch(scenario: "anonymous" | "authorized" | "no-project-access" | "stale-session"): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname === "/api/v1/me") {
      if (scenario === "anonymous" || scenario === "stale-session") return coreProblem(401);
      return json({
        session: {
          absolute_expires_at: "2026-10-06T00:00:00.000Z",
          id: sessionId,
          idle_expires_at: "2026-10-05T00:00:00.000Z",
          last_seen_at: "2026-10-04T00:00:00.000Z"
        },
        user: { display_name: "Preview User", email: "preview@example.test", id: userId, is_instance_admin: false }
      });
    }
    if (url.pathname === `/api/v1/workspaces/organizations/${ownerId}/projects/${projectId}`) {
      if (scenario === "no-project-access") return coreProblem(404);
      return json({
        archivedAt: null,
        createdAt: "2026-10-04T00:00:00.000Z",
        id: projectId,
        name: "Preview Project",
        ownerId,
        ownerType: "organization",
        slug: "preview-project",
        state: "active",
        storageScopeId,
        updatedAt: "2026-10-04T00:00:00.000Z",
        version: 1
      }, { etag: '"project-v1"' });
    }
    throw new Error(`unexpected Core request ${url.pathname}`);
  };
}

function json(value: unknown, headers: HeadersInit = {}): Response {
  return Response.json(value, { headers: { ...Object.fromEntries(new Headers(headers)), "content-type": "application/json" } });
}

function coreProblem(status: number): Response {
  return Response.json({
    code: status === 404 ? "PROJECT_NOT_FOUND" : "AUTHENTICATION_REQUIRED",
    detail: "The request could not be completed.",
    errors: [],
    instance: "/api/v1",
    request_id: "preview-binding-test",
    status,
    title: "Rejected",
    type: "about:blank"
  }, { headers: { "content-type": "application/problem+json" }, status });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("preview binding route tests ok");
