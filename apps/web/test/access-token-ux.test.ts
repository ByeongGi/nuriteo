import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { POST as issuePersonal } from "../src/app/api/v1/access-tokens/route.ts";
import { DELETE as revokePersonal } from "../src/app/api/v1/access-tokens/[tokenId]/route.ts";
import { POST as rotateProject } from "../src/app/api/v1/projects/[projectId]/access-tokens/[tokenId]/rotate/route.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "0199ee6c-c777-7000-8000-000000040001";
const PROJECT = "0199ee6c-c777-7000-8000-000000040002";
const CSRF = `nrt_csrf_${"a".repeat(43)}`;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  await forwardsCredentialLifecycleSafely();
  await mutationAmbiguityRequiresReconciliation();
  sourceContracts();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function forwardsCredentialLifecycleSafely() {
  const calls: Array<{ url: string; headers: Headers; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), method: String(init?.method) });
    return Response.json({ ok: true }, { status: init?.method === "POST" ? 201 : 200 });
  };
  const issue = await issuePersonal(mutationRequest("/api/v1/access-tokens", "POST", { name: "CLI", scopes: ["project:read"] }));
  const revoke = await revokePersonal(mutationRequest(`/api/v1/access-tokens/${TOKEN}`, "DELETE"), { params: Promise.resolve({ tokenId: TOKEN }) });
  const rotate = await rotateProject(mutationRequest(`/api/v1/projects/${PROJECT}/access-tokens/${TOKEN}/rotate`, "POST", {}), { params: Promise.resolve({ projectId: PROJECT, tokenId: TOKEN }) });
  assert.equal(issue.status, 201);
  assert.equal(revoke.status, 200);
  assert.equal(rotate.status, 201);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["POST", "http://core.internal:8080/api/v1/access-tokens"],
    ["DELETE", `http://core.internal:8080/api/v1/access-tokens/${TOKEN}`],
    ["POST", `http://core.internal:8080/api/v1/projects/${PROJECT}/access-tokens/${TOKEN}/rotate`]
  ]);
  assert.ok(calls.every(({ headers }) => headers.get("x-csrf-token") === CSRF));
  assert.ok(calls.every(({ headers }) => headers.get("authorization") === null));
}

async function mutationAmbiguityRequiresReconciliation() {
  globalThis.fetch = async () => { throw new TypeError("response lost"); };
  const response = await issuePersonal(mutationRequest("/api/v1/access-tokens", "POST", { name: "CLI", scopes: [] }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "COMMIT_OUTCOME_UNKNOWN");
}

function sourceContracts() {
  const console = read("src/app/(authenticated)/access-tokens/token-console.tsx");
  const page = read("src/app/(authenticated)/access-tokens/page.tsx");
  const layout = read("src/app/(authenticated)/layout.tsx");
  assert.match(console, /Shown once/u);
  assert.match(console, /stores only its hash/u);
  assert.match(console, /recently authenticated session/u);
  assert.match(console, /navigator\.clipboard\.writeText/u);
  assert.match(page, /No credential was issued, changed, or exposed/u);
  assert.match(layout, /Access tokens/u);
  assert.doesNotMatch(`${console}\n${page}`, /localStorage|sessionStorage|dangerouslySetInnerHTML/u);
}

function mutationRequest(pathname: string, method: "DELETE" | "POST", body?: unknown) {
  return new Request(`https://nuriteo.example.test${pathname}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      authorization: "Bearer must-not-forward",
      cookie: "nuriteo_dev_session=session",
      host: "nuriteo.example.test",
      origin: "https://nuriteo.example.test",
      "x-csrf-token": CSRF,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    }
  });
}

function read(relative: string) { return fs.readFileSync(path.join(root, relative), "utf8"); }
export {};
