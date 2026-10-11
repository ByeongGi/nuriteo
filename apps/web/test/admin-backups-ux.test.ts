import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;
process.env.NURITEO_INTERNAL_API_URL = "https://core.example.test";

try {
  let forwardedEtag: string | null = null;
  globalThis.fetch = async (_input, init) => {
    forwardedEtag = new Headers(init?.headers).get("if-match");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const policy = await import("../src/app/api/v1/admin/backups/policy/route.ts");
  const missingEtag = await policy.PUT(request("PUT"));
  assert.equal(missingEtag.status, 428);
  const invalidEtag = await policy.PUT(request("PUT", '"setting-v1"'));
  assert.equal(invalidEtag.status, 428);
  const accepted = await policy.PUT(request("PUT", '"backup-policy-v7"'));
  assert.equal(accepted.status, 200);
  assert.equal(forwardedEtag, '"backup-policy-v7"');

  const operations = await import("../src/app/api/v1/admin/backups/operations/route.ts");
  const noCsrf = await operations.POST(new Request("https://nuriteo.example.test/api/v1/admin/backups/operations", {
    method: "POST",
    body: JSON.stringify({ kind: "drill", backupId: null }),
    headers: { "content-type": "application/json", origin: "https://nuriteo.example.test" }
  }));
  assert.equal(noCsrf.status, 403);
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

function request(method: "PUT", etag?: string) {
  return new Request("https://nuriteo.example.test/api/v1/admin/backups/policy", {
    method,
    body: JSON.stringify({ enabled: true }),
    headers: {
      "content-type": "application/json",
      cookie: "nuriteo_dev_session=admin",
      host: "nuriteo.example.test",
      origin: "https://nuriteo.example.test",
      "x-csrf-token": `nrt_csrf_${"u".repeat(43)}`,
      ...(etag === undefined ? {} : { "if-match": etag })
    }
  });
}

console.log("admin backups BFF contract ok");
