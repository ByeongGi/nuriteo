import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const applicationOrigin = "http://app.localhost:3042";
const publicId = "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA";
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-public-preview-binding-"));
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
  const { POST } = await import("../src/app/api/runtime-preview/public-bindings/route.ts");
  const coreRequests: Array<{ readonly credentials: RequestCredentials | undefined; readonly headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    assert.equal(url.pathname, `/api/v1/published-examples/${publicId}/versions/3`);
    coreRequests.push({ credentials: init?.credentials, headers: new Headers(init?.headers) });
    return Response.json({
      publicId,
      name: "Public Preview",
      visibility: "public",
      versionNumber: 3,
      publishedAt: "2026-10-08T00:00:00Z"
    }, { headers: { "content-type": "application/json" } });
  };

  const response = await POST(bindingRequest());
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as { runtimeId: string; ttlMs: number };
  assert.match(body.runtimeId, /^[a-z2-7]{45}$/u);
  assert.ok(body.ttlMs > 0 && body.ttlMs <= 6_000);
  const firstCookie = cookiePair(response);
  assert.equal(coreRequests.length, 1);
  assert.equal(coreRequests[0]?.credentials, "omit");
  assert.equal(coreRequests[0]?.headers.get("cookie"), null);
  assert.equal(coreRequests[0]?.headers.get("authorization"), null);
  assert.equal(coreRequests[0]?.headers.get("x-csrf-token"), null);
  const firstAbuseKey = coreRequests[0]?.headers.get("x-nuriteo-preview-abuse-key");
  assert.match(firstAbuseKey ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.match(coreRequests[0]?.headers.get("x-nuriteo-preview-abuse-proof") ?? "", /^[A-Za-z0-9_-]{43}$/u);

  const secondClient = await POST(bindingRequest());
  assert.equal(secondClient.status, 201);
  const secondCookie = cookiePair(secondClient);
  const secondAbuseKey = coreRequests[1]?.headers.get("x-nuriteo-preview-abuse-key");
  assert.notEqual(secondCookie, firstCookie);
  assert.notEqual(secondAbuseKey, firstAbuseKey);

  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get("x-nuriteo-preview-abuse-key") === firstAbuseKey) {
      return problemResponse(429, "RATE_LIMITED");
    }
    return Response.json({
      publicId,
      name: "Public Preview",
      visibility: "public",
      versionNumber: 3,
      publishedAt: "2026-10-08T00:00:00Z"
    }, { headers: { "content-type": "application/json" } });
  };
  const limited = await POST(bindingRequest(firstCookie));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, "PUBLIC_PREVIEW_BINDING_RATE_LIMITED");
  const independent = await POST(bindingRequest(secondCookie));
  assert.equal(independent.status, 201, "one anonymous client must not throttle another");

  const coreRequestCount = coreRequests.length;
  const rejected = await POST(new Request(`${applicationOrigin}/api/runtime-preview/public-bindings`, {
    body: JSON.stringify({ port: 4173, publicId, versionNumber: 3 }),
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    method: "POST"
  }));
  assert.equal(rejected.status, 403);
  assert.equal(coreRequests.length, coreRequestCount, "rejected origins must not reach Core");

  globalThis.fetch = async () => problemResponse(404, "PUBLISHED_EXAMPLE_NOT_FOUND");
  const missing = await POST(bindingRequest());
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { code: string }).code, "PUBLIC_PREVIEW_NOT_FOUND");
} finally {
  globalThis.fetch = originalFetch;
  restoreEnvironment("NURITEO_EXTERNAL_URL", originalEnvironment.externalUrl);
  restoreEnvironment("NURITEO_INTERNAL_API_URL", originalEnvironment.internalApiUrl);
  restoreEnvironment("NURITEO_PREVIEW_BASE_DOMAIN", originalEnvironment.previewBaseDomain);
  restoreEnvironment("NURITEO_PREVIEW_SIGNING_KEY_FILE", originalEnvironment.signingKeyFile);
  fs.rmSync(temporaryDirectory, { recursive: true });
}

function bindingRequest(cookie?: string): Request {
  return new Request(`${applicationOrigin}/api/runtime-preview/public-bindings`, {
    body: JSON.stringify({ port: 4173, publicId, versionNumber: 3 }),
    headers: {
      authorization: "Bearer must-not-forward",
      cookie: cookie ?? "nuriteo_dev_session=must-not-forward; nuriteo_dev_csrf=must-not-forward",
      "content-type": "application/json",
      origin: applicationOrigin,
      "x-csrf-token": "must-not-forward"
    },
    method: "POST"
  });
}

function cookiePair(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "new anonymous clients receive a signed identity cookie");
  return cookie.split(";", 1)[0]!;
}

function problemResponse(status: number, code: string): Response {
  return Response.json({
    code,
    detail: "rejected",
    errors: [],
    instance: "/api/v1",
    request_id: "public-preview-test",
    status,
    title: "Rejected",
    type: "about:blank"
  }, { headers: { "content-type": "application/problem+json" }, status });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("public Preview binding route tests ok");
