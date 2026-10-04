import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ApiError } from "@nuriteo/api-client";

import { collaborationError } from "../src/lib/api/browser-security.ts";
import {
  forwardCollaborationMutation,
  invalidCollaborationRoute,
  uuidPathSegment
} from "../src/lib/api/collaboration-bff.ts";
import { DELETE as revokeActivationRoute } from "../src/app/api/v1/admin/activation-invitations/[invitationId]/route.ts";
import { createSecretChunkScanner } from "./secret-chunk-scanner.ts";
import { createSecretSafeOutputDiagnostics } from "./secret-safe-output.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  testSafeErrorClassification();
  await testExactBoundedForwarding();
  await testDeadlineAbortAndEarlyCancellation();
  await testInvalidRouteIsProblemDetails();
  testSplitSecretScanner();
  testSecretSafeOutputDiagnostics();
  testUxSourceContracts();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

function testSplitSecretScanner() {
  const scanner = createSecretChunkScanner(["nrt_org_inv_split-secret"]);
  assert.equal(scanner.scan("safe output nrt_org_inv_split-"), false);
  assert.equal(scanner.scan("secret safe output"), true);
  assert.equal(scanner.detected, true);

  const clean = createSecretChunkScanner(["never-visible"]);
  assert.equal(clean.scan("ordinary output"), false);
  assert.equal(clean.detected, false);
}

function testSecretSafeOutputDiagnostics() {
  const secret = "nrt_org_inv_split-secret";
  const diagnostics = createSecretSafeOutputDiagnostics([secret]);
  diagnostics.record("stdout", Buffer.from("safe output nrt_org_inv_split-"));
  diagnostics.record("stdout", Buffer.from("secret trailing output"));
  diagnostics.record("stderr", Buffer.from("ordinary diagnostic"));

  assert.equal(diagnostics.detected, true);
  assert.match(diagnostics.render(), /stdout=52 bytes\/2 chunks/u);
  assert.match(diagnostics.render(), /stderr=19 bytes\/1 chunks/u);
  assert.doesNotMatch(diagnostics.render(), /nrt_org_inv_|split-secret|ordinary diagnostic/u);
}

function testSafeErrorClassification() {
  assert.match(collaborationError(new ApiError(412, "safe", undefined), "organization-profile"), /Reload/u);
  assert.match(collaborationError(new ApiError(410, "safe", undefined), "organization-invitation-terminal"), /expired, used, revoked/u);
  assert.match(collaborationError(apiValidationError("invitation"), "activation-invitation-terminal"), /expired, used, revoked/u);
  assert.match(collaborationError(apiValidationError("token"), "activation-invitation-terminal"), /expired, used, revoked/u);
  assert.match(collaborationError(apiValidationError("email"), "activation-invitation-terminal"), /submitted values are invalid/u);
  assert.match(collaborationError(apiValidationError("password"), "activation-invitation-terminal"), /submitted values are invalid/u);
  assert.match(collaborationError(new ApiError(409, "safe", undefined), "organization-create"), /slug is already in use/u);
  assert.match(collaborationError(new ApiError(409, "safe", undefined), "organization-member"), /last Organization Owner/u);
  assert.match(collaborationError(new ApiError(422, "safe", undefined), "organization-create"), /submitted values are invalid/u);
  assert.match(collaborationError(new ApiError(422, "safe", undefined), "organization-invitation-issue"), /submitted values are invalid/u);
  assert.doesNotMatch(collaborationError(new Error("token=nrt_org_inv_secret"), "organization-invitation-terminal"), /secret|token/u);
  assert.equal(uuidPathSegment("0199ee6c-c777-7000-8000-000000005001"), "0199ee6c-c777-7000-8000-000000005001");
  assert.equal(uuidPathSegment("../open-proxy"), undefined);
}

function apiValidationError(path: string): ApiError {
  return new ApiError(422, "safe", {
    type: "about:blank",
    title: "Validation failed",
    status: 422,
    detail: "The request was invalid.",
    instance: "/api/v1/auth/activation",
    code: "VALIDATION_FAILED",
    request_id: "safe",
    errors: [{ path, code: "INVALID", detail: "Invalid value." }]
  });
}

async function testExactBoundedForwarding() {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  let received: { url: string; init: RequestInit | undefined } | undefined;
  globalThis.fetch = async (input, init) => {
    received = { url: String(input), init };
    return Response.json({ ok: true }, { headers: { etag: '"org-v1"', location: "/api/v1/organizations/0199ee6c-c777-7000-8000-000000005001" }, status: 201 });
  };
  const response = await forwardCollaborationMutation(new Request(
    "https://nuriteo.example.test/api/v1/organizations",
    { body: "{}", headers: { cookie: "session=safe", "content-type": "application/json", host: "nuriteo.example.test", origin: "https://nuriteo.example.test", "x-csrf-token": `nrt_csrf_${"a".repeat(43)}` }, method: "POST" }
  ), { method: "POST", path: "/api/v1/organizations", requireCsrf: true, withBody: true });
  assert.equal(received?.url, "http://core.internal:8080/api/v1/organizations");
  assert.equal(new Headers(received?.init?.headers).get("cookie"), "session=safe");
  assert.equal(new Headers(received?.init?.headers).has("authorization"), false);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("etag"), '"org-v1"');
  assert.equal(response.headers.get("location"), "/api/v1/organizations/0199ee6c-c777-7000-8000-000000005001");

  await forwardCollaborationMutation(new Request(
    "https://nuriteo.example.test/api/v1/organizations/0199ee6c-c777-7000-8000-000000005001",
    { body: "{}", headers: { "content-type": "application/json", host: "nuriteo.example.test", "if-match": '"org-v7"', "x-csrf-token": `nrt_csrf_${"a".repeat(43)}` }, method: "PATCH" }
  ), { method: "PATCH", path: "/api/v1/organizations/0199ee6c-c777-7000-8000-000000005001", requireCsrf: true, withBody: true, withEtag: true });
  assert.equal(new Headers(received?.init?.headers).get("if-match"), '"org-v7"');

  const oversized = await forwardCollaborationMutation(new Request(
    "https://nuriteo.example.test/api/v1/organizations",
    { body: "x".repeat(16_385), headers: { "content-type": "application/json", host: "nuriteo.example.test", "x-csrf-token": `nrt_csrf_${"a".repeat(43)}` }, method: "POST" }
  ), { method: "POST", path: "/api/v1/organizations", requireCsrf: true, withBody: true });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("content-type"), "application/problem+json");

  globalThis.fetch = async () => Response.json({ ok: true }, {
    headers: { location: "http://core.internal:8080/private" },
    status: 201
  });
  const unsafeLocation = await forwardCollaborationMutation(jsonRequest(), {
    method: "POST", path: "/api/v1/organizations", requireCsrf: true, withBody: true
  });
  assert.equal(unsafeLocation.headers.has("location"), false);
}

async function testDeadlineAbortAndEarlyCancellation() {
  const timeout = new AbortController();
  timeout.abort();
  const timedOut = await forwardCollaborationMutation(jsonRequest(), {
    method: "POST", path: "/api/v1/organizations", requireCsrf: true, withBody: true
  }, timeout.signal);
  assert.equal(timedOut.status, 504);

  const caller = new AbortController();
  caller.abort();
  const aborted = await forwardCollaborationMutation(jsonRequest(caller.signal), {
    method: "POST", path: "/api/v1/organizations", requireCsrf: true, withBody: true
  }, new AbortController().signal);
  assert.equal(aborted.status, 408);

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const rejected = await forwardCollaborationMutation(new Request(
    "https://nuriteo.example.test/api/v1/organizations",
    { body: stream, headers: { host: "nuriteo.example.test", "content-type": "text/plain" }, method: "POST", duplex: "half" } as RequestInit & { duplex: "half" }
  ), { method: "POST", path: "/api/v1/organizations", requireCsrf: false, withBody: true });
  assert.equal(rejected.status, 415);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
}

async function testInvalidRouteIsProblemDetails() {
  const request = new Request("https://nuriteo.example.test/api/v1/admin/activation-invitations/not-a-uuid", { method: "DELETE" });
  const response = await revokeActivationRoute(request, { params: Promise.resolve({ invitationId: "../not-safe" }) });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  assert.doesNotMatch(await response.text(), /not-safe/u);

  const direct = invalidCollaborationRoute(request);
  assert.equal(direct.status, 400);
}

function jsonRequest(signal?: AbortSignal): Request {
  return new Request("https://nuriteo.example.test/api/v1/organizations", {
    body: "{}",
    headers: {
      "content-type": "application/json",
      host: "nuriteo.example.test",
      "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`
    },
    method: "POST",
    ...(signal === undefined ? {} : { signal })
  });
}

function testUxSourceContracts() {
  const activation = read("src/app/activate/activation-form.tsx");
  const admin = read("src/app/(authenticated)/admin/invitations/activation-invitations.tsx");
  const organizations = read("src/app/(authenticated)/organizations/organization-console.tsx");
  const accept = read("src/app/(authenticated)/organization-invitations/accept/accept-invitation.tsx");
  const organizationPage = read("src/app/(authenticated)/organizations/page.tsx");
  const guard = read("src/lib/use-exclusive-mutation.ts");
  assert.match(activation, /useSearchParams\(\)/u);
  assert.match(activation, /router\.replace\("\/sign-in\?activated=1"\)/u);
  assert.match(admin, /activationUrl\.consume\(\)/u);
  assert.match(organizations, /acceptUrl\.consume\(\)/u);
  assert.match(accept, /router\.replace\(action === "accept" \? "\/workspaces\?joined=1"/u);
  assert.match(organizationPage, /error instanceof ApiError && error\.status === 403/u);
  assert.match(organizationPage, /canManage=\{canManage\}/u);
  assert.match(guard, /if \(locked\.current\) return false/u);
  assert.match(guard, /finally/u);
  assert.doesNotMatch(`${activation}\n${admin}\n${organizations}\n${accept}`, /localStorage|sessionStorage|console\./u);
  for (const file of findRoutes("src/app/api/v1")) {
    assert.doesNotMatch(file, /\[\.\.\./u);
  }
}

function findRoutes(directory: string): string[] {
  const absolute = path.join(webRoot, directory);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? findRoutes(relative) : entry.name === "route.ts" ? [relative] : [];
  });
}

function read(relative: string): string {
  return fs.readFileSync(path.join(webRoot, relative), "utf8");
}
