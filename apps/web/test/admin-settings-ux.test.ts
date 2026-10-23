import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PATCH as patchSetting } from "../src/app/api/v1/admin/settings/[key]/route.ts";
import { POST as previewImpact } from "../src/app/api/v1/admin/settings/[key]/impact/route.ts";
import { GET as previewCleanup } from "../src/app/api/v1/admin/policy-cleanup/preview/route.ts";
import { GET as getOperations } from "../src/app/api/v1/admin/operations/route.ts";
import { GET as getSupportBundle } from "../src/app/api/v1/admin/support-bundle/route.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  await settingBffContract();
  await policyPreviewBffContract();
  await operationsBffContract();
  await supportBundleBffContract();
  sourceContracts();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function supportBundleBffContract(): Promise<void> {
  let dispatched: { headers: Headers; method: string | undefined; url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    dispatched = {
      headers: new Headers(init?.headers),
      method: init?.method,
      url: String(input)
    };
    return Response.json({ schemaVersion: 1, format: "nuriteo-support-bundle-v1+json" });
  };
  const response = await getSupportBundle(new Request(
    "https://nuriteo.example.test/api/v1/admin/support-bundle",
    { headers: { cookie: "nuriteo_dev_session=admin", host: "nuriteo.example.test" } }
  ));
  assert.equal(response.status, 200);
  assert.equal(dispatched?.method, "GET");
  assert.equal(dispatched?.url, "http://core.internal:8080/api/v1/admin/support-bundle");
  assert.equal(dispatched?.headers.get("cookie"), "nuriteo_dev_session=admin");
  assert.equal(dispatched?.headers.get("authorization"), null);
}

async function policyPreviewBffContract(): Promise<void> {
  let dispatched: { body?: string; headers: Headers; method: string | undefined; url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    dispatched = {
      ...(init?.body === undefined ? {} : { body: Buffer.from(init.body as ArrayBuffer).toString("utf8") }),
      headers: new Headers(init?.headers),
      method: init?.method,
      url: String(input)
    };
    return Response.json({ dryRun: true });
  };

  const impact = await previewImpact(policyRequest(), {
    params: Promise.resolve({ key: "workspace.personal_default_quota_bytes" })
  });
  assert.equal(impact.status, 200);
  assert.equal(dispatched?.method, "POST");
  assert.equal(dispatched?.url, "http://core.internal:8080/api/v1/admin/settings/workspace.personal_default_quota_bytes/impact");
  assert.equal(dispatched?.headers.get("x-csrf-token"), `nrt_csrf_${"a".repeat(43)}`);
  assert.equal(dispatched?.body, JSON.stringify({ value: 1048576 }));

  const cleanup = await previewCleanup(new Request(
    "https://nuriteo.example.test/api/v1/admin/policy-cleanup/preview?batchLimit=25",
    { headers: { cookie: "nuriteo_dev_session=admin", host: "nuriteo.example.test" } }
  ));
  assert.equal(cleanup.status, 200);
  assert.equal(dispatched?.method, "GET");
  assert.equal(dispatched?.url, "http://core.internal:8080/api/v1/admin/policy-cleanup/preview?batchLimit=25");
  assert.equal(dispatched?.headers.get("x-csrf-token"), null);

  const rejected = await previewCleanup(new Request(
    "https://nuriteo.example.test/api/v1/admin/policy-cleanup/preview?batchLimit=101",
    { headers: { cookie: "nuriteo_dev_session=admin", host: "nuriteo.example.test" } }
  ));
  assert.equal(rejected.status, 400);
}

async function operationsBffContract(): Promise<void> {
  let dispatched: { headers: Headers; method: string | undefined; url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    dispatched = {
      headers: new Headers(init?.headers),
      method: init?.method,
      url: String(input)
    };
    return Response.json({ state: "fixture" });
  };
  const response = await getOperations(new Request(
    "https://nuriteo.example.test/api/v1/admin/operations",
    { headers: { cookie: "nuriteo_dev_session=admin", host: "nuriteo.example.test" } }
  ));
  assert.equal(response.status, 200);
  assert.equal(dispatched?.method, "GET");
  assert.equal(dispatched?.url, "http://core.internal:8080/api/v1/admin/operations");
  assert.equal(dispatched?.headers.get("cookie"), "nuriteo_dev_session=admin");
  assert.equal(dispatched?.headers.get("origin"), null);
  assert.equal(dispatched?.headers.get("x-csrf-token"), null);
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
  const page = read("src/app/(admin)/admin/system/settings/page.tsx");
  const legacySettingsPage = read("src/app/(admin)/admin/settings/page.tsx");
  const adminHome = read("src/app/(admin)/admin/page.tsx");
  const settings = read("src/app/(admin)/admin/settings/admin-settings.tsx");
  const navigation = read("src/app/(admin)/admin/admin-navigation.tsx");
  const adminLayout = read("src/app/(admin)/admin/layout.tsx");
  const adminShell = read("src/app/(admin)/admin/admin-shell-frame.tsx");
  const operationsPage = read("src/app/(admin)/admin/operations/page.tsx");
  const operationsDashboard = read("src/app/(admin)/admin/operations/operations-dashboard.tsx");
  const supportBundle = read("src/app/(admin)/admin/operations/support-bundle-download.tsx");
  const layout = read("src/app/(authenticated)/layout.tsx");
  const authenticatedNavigation = read("src/app/(authenticated)/authenticated-navigation.tsx");

  assert.match(page, /Promise\.all\(\[/u);
  assert.match(page, /listAdminSettings\(client\)/u);
  assert.match(page, /getAdminStatus\(client\)/u);
  assert.match(page, /previewAdminPolicyCleanup\(client\)/u);
  assert.match(settings, /영향 검토/u);
  assert.match(settings, /기본값으로 초기화/u);
  assert.match(settings, /기존 데이터는 자동으로 삭제되지 않습니다/u);
  assert.match(settings, /읽기 전용 점검/u);
  assert.match(settings, /최신 상태 불러오기/u);
  assert.match(settings, /웹 업데이트 필요/u);
  assert.match(settings, /최근 관리자 재인증이 필요/u);
  assert.match(settings, /aria-busy=\{mutation\.isPending\}/u);
  assert.match(navigation, /activeDestination === destination\.href/u);
  assert.match(navigation, /href="\/admin"/u);
  assert.match(navigation, /href: "\/admin\/operations"/u);
  assert.match(navigation, /label: "사용자·접근"/u);
  assert.match(navigation, /label: "인증"/u);
  assert.match(navigation, /label: "연동"/u);
  assert.match(navigation, /label: "운영"/u);
  assert.match(navigation, /label: "시스템"/u);
  assert.match(navigation, /href: "\/admin\/access\/invitations"/u);
  assert.match(navigation, /href: "\/admin\/authentication\/mfa"/u);
  assert.match(navigation, /href: "\/admin\/integrations\/git"/u);
  assert.match(navigation, /href: "\/admin\/operations\/email-deliveries"/u);
  assert.match(navigation, /href: "\/admin\/system\/settings"/u);
  assert.doesNotMatch(navigation, /href: "\/admin\/(?:invitations|mfa|oidc|git-providers|registries|notifications|smtp-trust|maintenance|backups|updates|settings)"/u);
  assert.match(adminHome, /href: "\/admin\/access\/invitations"/u);
  assert.match(adminHome, /href: "\/admin\/authentication\/mfa"/u);
  assert.match(adminHome, /href: "\/admin\/integrations\/git"/u);
  assert.match(adminHome, /href: "\/admin\/operations"/u);
  assert.match(adminHome, /href: "\/admin\/system\/updates"/u);
  assert.match(legacySettingsPage, /redirect\("\/admin\/system\/settings"\)/u);
  for (const [legacy, canonical] of [
    ["invitations", "/admin/access/invitations"],
    ["mfa", "/admin/authentication/mfa"],
    ["oidc", "/admin/authentication/oidc"],
    ["git-providers", "/admin/integrations/git"],
    ["registries", "/admin/integrations/registries"],
    ["smtp-trust", "/admin/integrations/smtp/trust"],
    ["notifications", "/admin/operations/email-deliveries"],
    ["maintenance", "/admin/operations/maintenance"],
    ["backups", "/admin/operations/backups"],
    ["updates", "/admin/system/updates"],
    ["settings", "/admin/system/settings"]
  ] as const) {
    assert.ok(read(`src/app/(admin)/admin/${legacy}/page.tsx`).includes(`redirect("${canonical}")`));
  }
  assert.match(operationsPage, /getAdminOperations\(client\)/u);
  assert.match(operationsDashboard, /상세 엔드포인트, 자격 증명과 내부 오류 내용은 표시하지 않습니다/u);
  assert.match(operationsDashboard, /aria-labelledby="dependency-health-title"/u);
  assert.match(operationsDashboard, /SupportBundleDownload preview=\{operations\.supportBundle\}/u);
  assert.match(supportBundle, /어떤 정보도 자동으로 업로드되지 않습니다/u);
  assert.match(supportBundle, /bytes\.byteLength > preview\.maximumBytes/u);
  assert.doesNotMatch(supportBundle, /localStorage|sessionStorage|dangerouslySetInnerHTML/u);
  assert.match(layout, /<AuthenticatedShellFrame/u);
  assert.match(authenticatedNavigation, /href: "\/admin"/u);
  assert.match(adminLayout, /is_instance_admin/u);
  assert.match(adminLayout, /<AdminShellFrame/u);
  assert.doesNotMatch(adminLayout, /AuthenticatedShellFrame/u);
  assert.match(adminShell, /사용자 화면으로 돌아가기/u);
  assert.match(adminShell, /<AdminNavigation/u);
  assert.doesNotMatch(
    `${page}\n${settings}\n${operationsPage}\n${operationsDashboard}`,
    /dangerouslySetInnerHTML|localStorage|sessionStorage/u
  );
}

function policyRequest(): Request {
  return new Request(
    "https://nuriteo.example.test/api/v1/admin/settings/workspace.personal_default_quota_bytes/impact",
    {
      method: "POST",
      body: JSON.stringify({ value: 1_048_576 }),
      headers: {
        cookie: "nuriteo_dev_session=admin",
        "content-type": "application/json",
        host: "nuriteo.example.test",
        origin: "https://nuriteo.example.test",
        "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`
      }
    }
  );
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
