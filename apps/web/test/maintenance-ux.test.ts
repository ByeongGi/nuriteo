import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GET, PUT } from "../src/app/api/v1/admin/maintenance/route.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  let dispatched: { readonly body?: string; readonly headers: Headers; readonly method?: string; readonly url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    dispatched = {
      ...(init?.body === undefined ? {} : { body: Buffer.from(init.body as ArrayBuffer).toString("utf8") }),
      headers: new Headers(init?.headers),
      ...(init?.method === undefined ? {} : { method: init.method }),
      url: String(input)
    };
    return Response.json({ phase: "maintenance", activeWrites: 0, writeAdmissionOpen: false });
  };

  const read = await GET(request("GET"));
  assert.equal(read.status, 200);
  assert.equal(dispatched?.method, "GET");
  assert.equal(dispatched?.url, "http://core.internal:8080/api/v1/admin/maintenance");

  const update = await PUT(request("PUT", { enabled: true }));
  assert.equal(update.status, 200);
  assert.equal(dispatched?.method, "PUT");
  assert.equal(dispatched?.body, JSON.stringify({ enabled: true }));
  assert.equal(dispatched?.headers.get("x-csrf-token"), `nrt_csrf_${"m".repeat(43)}`);

  const missingCsrf = await PUT(new Request(
    "https://nuriteo.example.test/api/v1/admin/maintenance",
    {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: {
        "content-type": "application/json",
        cookie: "nuriteo_dev_session=admin",
        host: "nuriteo.example.test",
        origin: "https://nuriteo.example.test"
      }
    }
  ));
  assert.equal(missingCsrf.status, 403);

  const page = readSource("src/app/(authenticated)/admin/maintenance/page.tsx");
  const consoleSource = readSource("src/app/(authenticated)/admin/maintenance/maintenance-console.tsx");
  const shell = readSource("src/app/(authenticated)/layout.tsx");
  assert.match(page, /is_instance_admin/u);
  assert.match(consoleSource, /Recent administrator reauthentication is required/u);
  assert.match(consoleSource, /drain timeout stays fail-closed/iu);
  assert.match(consoleSource, /aria-busy=\{mutation\.isPending\}/u);
  assert.match(shell, /Projects are read only while an administrator completes maintenance/u);
  assert.doesNotMatch(`${page}\n${consoleSource}\n${shell}`, /dangerouslySetInnerHTML|localStorage|sessionStorage/u);
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

function request(method: "GET" | "PUT", body?: unknown): Request {
  return new Request("https://nuriteo.example.test/api/v1/admin/maintenance", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      cookie: "nuriteo_dev_session=admin",
      host: "nuriteo.example.test",
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        origin: "https://nuriteo.example.test",
        "x-csrf-token": `nrt_csrf_${"m".repeat(43)}`
      })
    }
  });
}

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}

console.log("maintenance control UX contract ok");
