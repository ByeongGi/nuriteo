import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PATCH as patchPolicy } from "../src/app/api/v1/admin/mfa-policy/route.ts";
import { POST as challenge } from "../src/app/api/v1/mfa/challenge/route.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;
const CSRF = `nrt_csrf_${"a".repeat(43)}`;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  await policyContract();
  await rotatedSessionContract();
  sourceContracts();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function policyContract(): Promise<void> {
  let dispatched: { body: string; headers: Headers; url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    dispatched = { body: Buffer.from(init?.body as ArrayBuffer).toString("utf8"), headers: new Headers(init?.headers), url: String(input) };
    return Response.json({ mode: "administrators", gracePeriodDays: 0, version: 2, affectedUsers: 1, immediatelyRestrictedUsers: 0, enrolledLocalAdministrators: 1 }, { headers: { etag: '"mfa-policy-v2"' } });
  };
  const response = await patchPolicy(request("/api/v1/admin/mfa-policy", { mode: "administrators", gracePeriodDays: 0 }, '"mfa-policy-v1"'));
  assert.equal(response.status, 200);
  assert.equal(dispatched?.url, "http://core.internal:8080/api/v1/admin/mfa-policy");
  assert.equal(dispatched?.headers.get("if-match"), '"mfa-policy-v1"');
  assert.equal(dispatched?.headers.get("origin"), "https://nuriteo.example.test");
  assert.equal(dispatched?.headers.get("x-csrf-token"), CSRF);
  assert.equal(dispatched?.body, JSON.stringify({ mode: "administrators", gracePeriodDays: 0 }));

  for (const etag of [undefined, 'W/"mfa-policy-v1"', '"mfa-policy-v0"', '"setting-v1"']) {
    const rejected = await patchPolicy(request("/api/v1/admin/mfa-policy", { mode: "administrators", gracePeriodDays: 0 }, etag));
    assert.equal(rejected.status, 428);
  }
}

async function rotatedSessionContract(): Promise<void> {
  globalThis.fetch = async () => { throw new TypeError("response lost"); };
  const unknown = await challenge(request("/api/v1/mfa/challenge", { code: "123456" }));
  assert.equal(unknown.status, 503);
  assert.equal((await unknown.json()).code, "COMMIT_OUTCOME_UNKNOWN");
  globalThis.fetch = async () => new Response(null, { status: 204, headers: { "set-cookie": "nuriteo_dev_session=rotated; HttpOnly; SameSite=Strict; Path=/" } });
  const response = await challenge(request("/api/v1/mfa/challenge", { code: "123456" }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get("set-cookie") ?? "", /rotated/u);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function sourceContracts(): void {
  const security = read("src/app/mfa/security.tsx");
  const policy = read("src/app/(authenticated)/admin/mfa/policy-editor.tsx");
  const layout = read("src/app/(authenticated)/layout.tsx");
  const qr = read("src/lib/qr-matrix.ts");
  assert.match(security, /shown once/u);
  assert.match(security, /Copy codes to continue/u);
  assert.match(security, /does not grant recent reauthentication/u);
  assert.match(security, /Sign out or switch account/u);
  assert.match(policy, /active local administrator/u);
  assert.match(policy, /Reload latest/u);
  assert.match(layout, /mfa\.data\.restricted/u);
  assert.doesNotMatch(layout, /getMfaStatus\(client\)\.catch/u);
  assert.match(policy, /Review impact/u);
  assert.match(policy, /Find by email or display name/u);
  assert.match(qr, /qrcode-terminal/u);
  assert.doesNotMatch(`${security}\n${policy}\n${qr}`, /localStorage|sessionStorage|dangerouslySetInnerHTML/u);
}

function request(pathname: string, body: unknown, etag?: string): Request {
  return new Request(`https://nuriteo.example.test${pathname}`, {
    method: pathname === "/api/v1/admin/mfa-policy" ? "PATCH" : "POST",
    body: JSON.stringify(body),
    headers: {
      cookie: "nuriteo_dev_session=session",
      "content-type": "application/json",
      host: "nuriteo.example.test",
      origin: "https://nuriteo.example.test",
      "x-csrf-token": CSRF,
      "idempotency-key": "mfa-web-contract-0001",
      ...(etag === undefined ? {} : { "if-match": etag })
    }
  });
}

function read(relativePath: string): string { return fs.readFileSync(path.join(webRoot, relativePath), "utf8"); }
