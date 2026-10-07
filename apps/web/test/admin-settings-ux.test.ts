import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PATCH as patchSetting } from "../src/app/api/v1/admin/settings/[key]/route.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  await settingBffContract();
  sourceContracts();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function settingBffContract(): Promise<void> {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  let dispatched: { body: string; headers: Headers; url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    dispatched = {
      body: Buffer.from(init?.body as ArrayBuffer).toString("utf8"),
      headers: new Headers(init?.headers),
      url: String(input)
    };
    return Response.json({
      key: "invitations.default_expiry_hours",
      value: 336,
      version: 2,
      applyMode: "live"
    }, { headers: { etag: '"setting-v2"' } });
  };

  const response = await patchSetting(settingRequest('"setting-v1"'), {
    params: Promise.resolve({ key: "invitations.default_expiry_hours" })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"setting-v2"');
  assert.equal(dispatched?.url, "http://core.internal:8080/api/v1/admin/settings/invitations.default_expiry_hours");
  assert.equal(dispatched?.headers.get("if-match"), '"setting-v1"');
  assert.equal(dispatched?.headers.get("x-csrf-token"), `nrt_csrf_${"a".repeat(43)}`);
  assert.equal(dispatched?.body, JSON.stringify({ value: 336 }));

  for (const etag of [undefined, 'W/"setting-v1"', '"setting-v0"', '"project-v1"']) {
    dispatched = undefined;
    const rejected = await patchSetting(settingRequest(etag), {
      params: Promise.resolve({ key: "invitations.default_expiry_hours" })
    });
    assert.equal(rejected.status, 428);
    assert.equal(dispatched, undefined);
  }

  const unsafe = await patchSetting(settingRequest('"setting-v1"'), {
    params: Promise.resolve({ key: "../open-proxy" })
  });
  assert.equal(unsafe.status, 400);
}

function sourceContracts(): void {
  const page = read("src/app/(authenticated)/admin/settings/page.tsx");
  const settings = read("src/app/(authenticated)/admin/settings/admin-settings.tsx");
  const navigation = read("src/app/(authenticated)/admin/admin-navigation.tsx");
  const layout = read("src/app/(authenticated)/layout.tsx");

  assert.match(page, /is_instance_admin/u);
  assert.match(page, /Promise\.all\(\[/u);
  assert.match(page, /listAdminSettings\(client\)/u);
  assert.match(page, /getAdminStatus\(client\)/u);
  assert.match(settings, /Reload latest/u);
  assert.match(settings, /Web update required/u);
  assert.match(settings, /Recent administrator reauthentication is required/u);
  assert.match(settings, /aria-busy=\{mutation\.isPending\}/u);
  assert.match(navigation, /aria-current=\{pathname === destination\.href \? "page"/u);
  assert.match(layout, /href="\/admin\/settings">Administration/u);
  assert.doesNotMatch(`${page}\n${settings}`, /dangerouslySetInnerHTML|localStorage|sessionStorage/u);
}

function settingRequest(etag: string | undefined): Request {
  return new Request(
    "https://nuriteo.example.test/api/v1/admin/settings/invitations.default_expiry_hours",
    {
      method: "PATCH",
      body: JSON.stringify({ value: 336 }),
      headers: {
        cookie: "nuriteo_dev_session=admin",
        "content-type": "application/json",
        host: "nuriteo.example.test",
        origin: "https://nuriteo.example.test",
        "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`,
        ...(etag === undefined ? {} : { "if-match": etag })
      }
    }
  );
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}
