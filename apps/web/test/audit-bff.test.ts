import assert from "node:assert/strict";

import { auditEventListPath, forwardAuditEventList } from "../src/lib/api/audit-bff.ts";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  const request = new Request(
    "https://nuriteo.test/api/v1/admin/audit-events?limit=100&actionCode=team.created"
  );
  assert.equal(
    auditEventListPath(request),
    "/api/v1/admin/audit-events?actionCode=team.created&limit=100"
  );
  assert.equal(
    auditEventListPath(new Request("https://nuriteo.test/api/v1/admin/audit-events?limit=101")),
    undefined
  );
  assert.equal(
    auditEventListPath(new Request("https://nuriteo.test/api/v1/admin/audit-events?limit=1&limit=2")),
    undefined
  );
  assert.equal(
    auditEventListPath(new Request("https://nuriteo.test/api/v1/admin/audit-events?unknown=value")),
    undefined
  );

  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  let received: { init: RequestInit | undefined; url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    received = { init, url: String(input) };
    return Response.json({ items: [], nextCursor: null });
  };
  const response = await forwardAuditEventList(new Request(
    "https://nuriteo.test/api/v1/admin/audit-events?limit=100",
    { headers: { cookie: "__Host-nuriteo_session=safe", host: "nuriteo.test" } }
  ));
  assert.equal(response.status, 200);
  assert.equal(received?.url, "http://core.internal:8080/api/v1/admin/audit-events?limit=100");
  assert.equal(new Headers(received?.init?.headers).get("cookie"), "__Host-nuriteo_session=safe");
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}
