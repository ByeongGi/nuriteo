import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ApiError } from "@nuriteo/api-client";

import { projectError } from "../src/lib/api/browser-security.ts";
import {
  exactProjectListPath,
  forwardProjectRequest,
  projectItemPath,
  projectOwnerPath,
  projectRolePath
} from "../src/lib/api/project-bff.ts";

const OWNER_ID = "0199ee6c-c777-7000-8000-000000005001";
const PROJECT_ID = "0199ee6c-c777-7000-8000-000000005002";
const USER_ID = "0199ee6c-c777-7000-8000-000000005003";
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  testExactPathsAndQueries();
  testReconciliationClassification();
  await testProjectForwardingBoundary();
  testProjectSourceContracts();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

function testExactPathsAndQueries() {
  const collection = `/api/v1/workspaces/organizations/${OWNER_ID}/projects` as const;
  assert.equal(projectOwnerPath("organizations", OWNER_ID), `/api/v1/workspaces/organizations/${OWNER_ID}`);
  assert.equal(projectItemPath("organizations", OWNER_ID, PROJECT_ID), `${collection}/${PROJECT_ID}`);
  assert.equal(projectRolePath("organizations", OWNER_ID, PROJECT_ID, USER_ID), `${collection}/${PROJECT_ID}/roles/${USER_ID}`);
  assert.equal(projectRolePath("users", OWNER_ID, PROJECT_ID), undefined);
  assert.equal(projectOwnerPath("organizations", "../unsafe"), undefined);
  assert.equal(exactProjectListPath(request("?state=archived&pageSize=100&cursor=opaque_1"), collection, true), `${collection}?state=archived&pageSize=100&cursor=opaque_1`);
  assert.equal(exactProjectListPath(request("?cursor=&cursor=valid"), collection, true), undefined);
  assert.equal(exactProjectListPath(request("?pageSize=01"), collection, true), undefined);
  assert.equal(exactProjectListPath(request("?state=deleted"), collection, true), undefined);
  assert.equal(exactProjectListPath(request("?state=active"), `${collection}/${PROJECT_ID}/roles`, false), undefined);
  assert.equal(exactProjectListPath(request(`?cursor=${"x".repeat(2_049)}`), collection, true), undefined);
}

function testReconciliationClassification() {
  const stale = projectError(new ApiError(412, "safe", undefined), "project-profile");
  assert.equal(stale.reconcile, true);
  assert.match(stale.message, /Reload/u);
  const unknown = projectError(new ApiError(503, "safe", {
    type: "about:blank", title: "Unknown", status: 503, detail: "Unknown.",
    instance: "/api/v1/projects", code: "COMMIT_OUTCOME_UNKNOWN", request_id: "safe", errors: []
  }), "project-role");
  assert.equal(unknown.reconcile, true);
  assert.match(unknown.message, /may have completed/u);
  assert.doesNotMatch(projectError(new Error("token=secret"), "project-role").message, /token|secret/u);
}

async function testProjectForwardingBoundary() {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  let received: { init: RequestInit | undefined; url: string } | undefined;
  globalThis.fetch = async (input, init) => {
    received = { url: String(input), init };
    return Response.json({ id: PROJECT_ID }, {
      headers: {
        etag: '"project-v2"',
        location: `/api/v1/workspaces/organizations/${OWNER_ID}/projects/${PROJECT_ID}`
      },
      status: 201
    });
  };
  const collection = `/api/v1/workspaces/organizations/${OWNER_ID}/projects` as const;
  const response = await forwardProjectRequest(new Request(`https://nuriteo.test${collection}`, {
    body: "{}",
    headers: {
      cookie: "__Host-nuriteo_session=safe",
      "content-type": "application/json",
      host: "nuriteo.test",
      origin: "https://nuriteo.test",
      "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`
    },
    method: "POST"
  }), { method: "POST", path: collection, withBody: true, locationPrefix: collection });
  assert.equal(received?.url, `http://core.internal:8080${collection}`);
  assert.equal(new Headers(received?.init?.headers).get("origin"), "https://nuriteo.test");
  assert.equal(response.headers.get("location"), `${collection}/${PROJECT_ID}`);

  const invalid = await forwardProjectRequest(new Request(`https://nuriteo.test${collection}/${PROJECT_ID}`, {
    body: "{}",
    headers: {
      "content-type": "application/json",
      host: "nuriteo.test",
      "if-match": '"project-v01"',
      "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`
    },
    method: "PATCH"
  }), { method: "PATCH", path: `${collection}/${PROJECT_ID}`, withBody: true, withEtag: true });
  assert.equal(invalid.status, 428);
  assert.equal(invalid.headers.get("content-type"), "application/problem+json");

  const overflow = await forwardProjectRequest(new Request(`https://nuriteo.test${collection}/${PROJECT_ID}`, {
    body: "{}",
    headers: {
      "content-type": "application/json",
      host: "nuriteo.test",
      "if-match": '"project-v9223372036854775807"',
      "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`
    },
    method: "PATCH"
  }), { method: "PATCH", path: `${collection}/${PROJECT_ID}`, withBody: true, withEtag: true });
  assert.equal(overflow.status, 428);
}

function testProjectSourceContracts() {
  const dashboard = read("src/app/(authenticated)/projects/project-dashboard.tsx");
  const page = read("src/app/(authenticated)/projects/page.tsx");
  assert.match(dashboard, /createBrowserApiClient\(\)/u);
  assert.match(dashboard, /readCsrfCredential\(\)/u);
  assert.match(dashboard, /useExclusiveMutation\(\)/u);
  assert.match(dashboard, /COMMIT_OUTCOME_UNKNOWN|needsReconciliation/u);
  assert.match(page, /createServerApiClient\(\)/u);
  assert.match(page, /listProjects/u);
  assert.match(page, /key=\{`\$\{workspace\.storageScopeId\}:\$\{state\}:/u);
  assert.match(page, /error\.status !== 403 && error\.status !== 404/u);
  assert.doesNotMatch(`${dashboard}\n${page}`, /localStorage|sessionStorage|console\./u);
}

function request(search: string): Request {
  return new Request(`https://nuriteo.test/api/v1/projects${search}`);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(webRoot, relative), "utf8");
}
