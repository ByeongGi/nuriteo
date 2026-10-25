import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ApiError } from "@nuriteo/api-client";

import { projectError } from "../src/lib/api/browser-security.ts";
import { forwardCollaborationMutation } from "../src/lib/api/collaboration-bff.ts";
import { forwardProjectContentDownload } from "../src/lib/api/content-bff.ts";
import {
  exactProjectListPath,
  forwardProjectRequest,
  projectContentPath,
  projectItemPath,
  projectOwnerPath,
  projectRolePath
} from "../src/lib/api/project-bff.ts";
import { projectSaveSessionPath } from "../src/lib/api/project-bff.ts";
import { forwardSaveSessionRequest } from "../src/lib/api/save-bff.ts";

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
  await testSaveForwardingBoundary();
  await testPostDispatchCommitAmbiguity();
  await testContentStreamForwarding();
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
  assert.equal(projectContentPath("organizations", OWNER_ID, PROJECT_ID), `${collection}/${PROJECT_ID}/content`);
  assert.equal(projectContentPath("organizations", OWNER_ID, PROJECT_ID, USER_ID), `${collection}/${PROJECT_ID}/content/${USER_ID}`);
  assert.equal(projectRolePath("organizations", OWNER_ID, PROJECT_ID, USER_ID), `${collection}/${PROJECT_ID}/roles/${USER_ID}`);
  assert.equal(projectSaveSessionPath("organizations", OWNER_ID, PROJECT_ID, USER_ID), `${collection}/${PROJECT_ID}/save-sessions/${USER_ID}`);
  assert.equal(projectRolePath("users", OWNER_ID, PROJECT_ID), undefined);
  assert.equal(projectOwnerPath("organizations", "../unsafe"), undefined);
  assert.equal(exactProjectListPath(request("?state=archived&pageSize=100&cursor=opaque_1"), collection, true), `${collection}?state=archived&pageSize=100&cursor=opaque_1`);
  assert.equal(exactProjectListPath(request("?cursor=&cursor=valid"), collection, true), undefined);
  assert.equal(exactProjectListPath(request("?pageSize=01"), collection, true), undefined);
  assert.equal(exactProjectListPath(request("?state=deleted"), collection, true), undefined);
  assert.equal(exactProjectListPath(request("?state=active"), `${collection}/${PROJECT_ID}/roles`, false), undefined);
  assert.equal(exactProjectListPath(request(`?cursor=${"x".repeat(2_049)}`), collection, true), undefined);
}

async function testSaveForwardingBoundary() {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  let forwarded: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    forwarded = init;
    return Response.json({ ok: true }, { status: 201 });
  };
  const path = `/api/v1/workspaces/organizations/${OWNER_ID}/projects/${PROJECT_ID}/save-sessions`;
  const response = await forwardSaveSessionRequest(new Request(`https://nuriteo.test${path}`, {
    method: "POST",
    body: "{}",
    headers: {
      host: "nuriteo.test", origin: "https://nuriteo.test", "content-type": "application/json",
      "x-csrf-token": "csrf-safe", "if-match": '"project-v1"', "idempotency-key": "bundle-0123456789abcdef"
    }
  }), { ownerType: "organizations", ownerId: OWNER_ID, projectId: PROJECT_ID }, "create");
  assert.equal(response.status, 201);
  const headers = new Headers(forwarded?.headers);
  assert.equal(headers.get("if-match"), '"project-v1"');
  assert.equal(headers.get("idempotency-key"), "bundle-0123456789abcdef");
  const rejected = await forwardSaveSessionRequest(new Request(`https://nuriteo.test${path}`, {
    method: "POST", body: "{}", headers: {
      host: "nuriteo.test", origin: "https://nuriteo.test", "content-type": "application/json",
      "x-csrf-token": "csrf-safe", "if-match": '"project-v1"'
    }
  }), { ownerType: "organizations", ownerId: OWNER_ID, projectId: PROJECT_ID }, "create");
  await assertProblemCode(rejected, 428, "BFF_IDEMPOTENCY_KEY_REQUIRED");
}

async function testContentStreamForwarding() {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  const etag = `"content-v2-${"a".repeat(43)}"`;
  const contentPath = `/api/v1/workspaces/organizations/${OWNER_ID}/projects/${PROJECT_ID}/content/${USER_ID}` as const;
  let receivedHeaders: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedHeaders = new Headers(init?.headers);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.enqueue(Uint8Array.of(3));
        controller.close();
      }
    }), { headers: {
      "cache-control": "private, no-store",
      "content-length": "3",
      "content-type": "application/octet-stream",
      etag,
      "x-content-type-options": "nosniff"
    } });
  };
  const response = await forwardProjectContentDownload(new Request(`https://nuriteo.test${contentPath}`, {
    headers: {
      cookie: "__Host-nuriteo_session=safe",
      host: "nuriteo.test",
      "if-match": etag,
      origin: "https://nuriteo.test"
    }
  }), contentPath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.equal(receivedHeaders?.get("cookie"), "__Host-nuriteo_session=safe");
  assert.equal(receivedHeaders?.get("if-match"), etag);

  const headerDeadline = new AbortController();
  let releaseSlowBody!: () => void;
  const slowBodyReady = new Promise<void>((resolve) => { releaseSlowBody = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(Uint8Array.of(4));
      await slowBodyReady;
      controller.enqueue(Uint8Array.of(5));
      controller.close();
    }
  }), { headers: {
    "content-length": "2",
    "content-type": "application/octet-stream",
    etag,
    "x-content-type-options": "nosniff"
  } });
  const slowResponse = await forwardProjectContentDownload(new Request(`https://nuriteo.test${contentPath}`, {
    headers: { host: "nuriteo.test", "if-match": etag, origin: "https://nuriteo.test" }
  }), contentPath, {
    bodyIdleTimeoutMs: 100,
    bodyTotalTimeout: AbortSignal.timeout(500),
    headerTimeout: headerDeadline.signal
  });
  headerDeadline.abort();
  setTimeout(releaseSlowBody, 20);
  assert.deepEqual([...new Uint8Array(await slowResponse.arrayBuffer())], [4, 5]);

  let stalledCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.of(6)); },
    cancel() { stalledCancelled = true; }
  }), { headers: {
    "content-length": "2",
    "content-type": "application/octet-stream",
    etag,
    "x-content-type-options": "nosniff"
  } });
  const stalled = await forwardProjectContentDownload(new Request(`https://nuriteo.test${contentPath}`, {
    headers: { host: "nuriteo.test", "if-match": etag, origin: "https://nuriteo.test" }
  }), contentPath, { bodyIdleTimeoutMs: 5, bodyTotalTimeout: AbortSignal.timeout(500) });
  await assert.rejects(stalled.arrayBuffer());
  assert.equal(stalledCancelled, true, "an idle upstream body must be cancelled");

  const totalDeadline = new AbortController();
  let totalCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.of(8)); },
    cancel() { totalCancelled = true; }
  }), { headers: {
    "content-length": "2",
    "content-type": "application/octet-stream",
    etag,
    "x-content-type-options": "nosniff"
  } });
  const totalBounded = await forwardProjectContentDownload(new Request(`https://nuriteo.test${contentPath}`, {
    headers: { host: "nuriteo.test", "if-match": etag, origin: "https://nuriteo.test" }
  }), contentPath, { bodyIdleTimeoutMs: 500, bodyTotalTimeout: totalDeadline.signal });
  totalDeadline.abort();
  await assert.rejects(totalBounded.arrayBuffer());
  assert.equal(totalCancelled, true, "the total body deadline must cancel the upstream body");

  const requestAbort = new AbortController();
  let requestCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.of(7)); },
    cancel() { requestCancelled = true; }
  }), { headers: {
    "content-length": "2",
    "content-type": "application/octet-stream",
    etag,
    "x-content-type-options": "nosniff"
  } });
  const aborted = await forwardProjectContentDownload(new Request(`https://nuriteo.test${contentPath}`, {
    headers: { host: "nuriteo.test", "if-match": etag, origin: "https://nuriteo.test" },
    signal: requestAbort.signal
  }), contentPath, { bodyIdleTimeoutMs: 500, bodyTotalTimeout: AbortSignal.timeout(1_000) });
  requestAbort.abort();
  await assert.rejects(aborted.arrayBuffer());
  assert.equal(requestCancelled, true, "a disconnected request must cancel the upstream body");

  globalThis.fetch = async () => new Response(Uint8Array.of(1), { headers: {
    "content-length": String(16 * 1024 * 1024 + 1),
    "content-type": "application/octet-stream",
    etag,
    "x-content-type-options": "nosniff"
  } });
  const oversized = await forwardProjectContentDownload(new Request(`https://nuriteo.test${contentPath}`, {
    headers: { host: "nuriteo.test", "if-match": etag, origin: "https://nuriteo.test" }
  }), contentPath);
  await assertProblemCode(oversized, 502, "BFF_UPSTREAM_RESPONSE_REJECTED");
}

function testReconciliationClassification() {
  const reauthentication = projectError(new ApiError(403, "safe", {
    type: "/docs/problems/reauthentication-required", title: "Recent reauthentication required",
    status: 403, detail: "Sign in again.", instance: "/api/v1/projects",
    code: "REAUTHENTICATION_REQUIRED", request_id: "safe", errors: []
  }), "project-delete");
  assert.equal(reauthentication.reconcile, false);
  assert.match(reauthentication.message, /다시 로그인/u);
  const stale = projectError(new ApiError(412, "safe", undefined), "project-profile");
  assert.equal(stale.reconcile, true);
  assert.match(stale.message, /최신 버전을 불러온 뒤/u);
  const unknown = projectError(new ApiError(503, "safe", {
    type: "about:blank", title: "Unknown", status: 503, detail: "Unknown.",
    instance: "/api/v1/projects", code: "COMMIT_OUTCOME_UNKNOWN", request_id: "safe", errors: []
  }), "project-role");
  assert.equal(unknown.reconcile, true);
  assert.match(unknown.message, /변경을 완료했을 수 있습니다/u);
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
      origin: "https://nuriteo.test",
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
      origin: "https://nuriteo.test",
      "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`
    },
    method: "PATCH"
  }), { method: "PATCH", path: `${collection}/${PROJECT_ID}`, withBody: true, withEtag: true });
  assert.equal(overflow.status, 428);
}

async function testPostDispatchCommitAmbiguity() {
  const collection = `/api/v1/workspaces/organizations/${OWNER_ID}/projects` as const;
  let applied = false;
  globalThis.fetch = async () => {
    applied = true;
    throw new TypeError("response connection was lost");
  };
  const lost = await forwardProjectRequest(projectMutationRequest(collection), {
    method: "POST",
    path: collection,
    withBody: true,
    locationPrefix: collection
  });
  assert.equal(applied, true);
  await assertProblemCode(lost, 503, "COMMIT_OUTCOME_UNKNOWN");

  globalThis.fetch = async () => new Response(new Uint8Array(1_048_577), { status: 201 });
  const rejectedResponse = await forwardProjectRequest(projectMutationRequest(collection), {
    method: "POST",
    path: collection,
    withBody: true,
    locationPrefix: collection
  });
  await assertProblemCode(rejectedResponse, 503, "COMMIT_OUTCOME_UNKNOWN");

  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("response stream lost")); }
  }), { status: 201 });
  const unreadableResponse = await forwardProjectRequest(projectMutationRequest(collection), {
    method: "POST",
    path: collection,
    withBody: true,
    locationPrefix: collection
  });
  await assertProblemCode(unreadableResponse, 503, "COMMIT_OUTCOME_UNKNOWN");

  const timeout = new AbortController();
  let markDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    markDispatched();
    init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
  });
  const pending = forwardCollaborationMutation(projectMutationRequest(collection), {
    commitOutcomeUnknown: true,
    method: "POST",
    path: collection,
    requireCsrf: true,
    withBody: true
  }, timeout.signal);
  await dispatched;
  timeout.abort();
  await assertProblemCode(await pending, 503, "COMMIT_OUTCOME_UNKNOWN");

  let invalidDispatched = false;
  globalThis.fetch = async () => {
    invalidDispatched = true;
    return Response.json({});
  };
  const invalid = await forwardProjectRequest(new Request(`https://nuriteo.test${collection}/${PROJECT_ID}`, {
    body: "{}",
    headers: {
      "content-type": "application/json",
      host: "nuriteo.test",
      origin: "https://nuriteo.test",
      "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`
    },
    method: "PATCH"
  }), { method: "PATCH", path: `${collection}/${PROJECT_ID}`, withBody: true, withEtag: true });
  assert.equal(invalidDispatched, false);
  await assertProblemCode(invalid, 428, "BFF_PRECONDITION_REQUIRED");

  globalThis.fetch = async () => { throw new TypeError("read failed"); };
  const getFailure = await forwardProjectRequest(new Request(`https://nuriteo.test${collection}`, {
    headers: { host: "nuriteo.test", origin: "https://nuriteo.test" },
    method: "GET"
  }), { method: "GET", path: collection });
  await assertProblemCode(getFailure, 502, "BFF_UPSTREAM_UNAVAILABLE");
}

function projectMutationRequest(collection: string): Request {
  return new Request(`https://nuriteo.test${collection}`, {
    body: "{}",
    headers: {
      "content-type": "application/json",
      host: "nuriteo.test",
      origin: "https://nuriteo.test",
      "x-csrf-token": `nrt_csrf_${"a".repeat(43)}`
    },
    method: "POST"
  });
}

async function assertProblemCode(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal((await response.json() as { code: string }).code, code);
}

function testProjectSourceContracts() {
  assert.equal(
    fs.existsSync(path.join(webRoot, "src/app/(authenticated)/projects/[projectId]/settings/page.tsx")),
    true,
    "legacy Project settings bookmarks require a redirect shim"
  );
  assert.equal(
    fs.existsSync(path.join(webRoot, "src/app/(studio)/workspaces/[workspaceId]/projects/[projectId]/studio/page.tsx")),
    true,
    "workspace-first IA requires a canonical Studio route"
  );
  const dashboard = read("src/app/(authenticated)/projects/project-dashboard.tsx");
  const ideShell = read("src/app/(authenticated)/projects/project-ide-shell.tsx");
  const terminalView = read("src/app/(authenticated)/projects/project-terminal-view.tsx");
  const templatePicker = read("src/app/(authenticated)/projects/project-template-picker.tsx");
  const legacyPage = read("src/app/(authenticated)/projects/page.tsx");
  const legacyProjectPage = read("src/app/(authenticated)/projects/[projectId]/page.tsx");
  const legacySettingsPage = read("src/app/(authenticated)/projects/[projectId]/settings/page.tsx");
  const workspacePage = read("src/app/(workspace)/workspaces/[workspaceId]/page.tsx");
  const workspaceProjectsPage = read("src/app/(workspace)/workspaces/[workspaceId]/projects/page.tsx");
  const projectSettingsPage = read("src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/page.tsx");
  const projectAccessSettingsPage = read("src/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/access/page.tsx");
  const studioScreen = read("src/app/(studio)/projects/[projectId]/studio/project-studio-screen.tsx");
  const legacyStudioPage = read("src/app/(studio)/projects/[projectId]/studio/page.tsx");
  const workspaceProjectStudioPage = read("src/app/(studio)/workspaces/[workspaceId]/projects/[projectId]/studio/page.tsx");
  const studioStory = read("src/design-system/redesign/studio-redesign.stories.tsx");
  const projectLinkHelpers = dashboard.slice(
    dashboard.indexOf("function projectHref"),
    dashboard.indexOf("function visibleInState")
  );
  assert.match(dashboard, /createBrowserApiClient\(\)/u);
  assert.match(dashboard, /readCsrfCredential\(\)/u);
  assert.match(dashboard, /useExclusiveMutation\(\)/u);
  assert.match(dashboard, /useDeferredValue\(projectQuery\)/u);
  assert.match(dashboard, /aria-busy=\{isSearchPending\}/u);
  assert.match(dashboard, /검색은 현재 불러온 프로젝트에 적용됩니다/u);
  assert.match(dashboard, /createProjectRoleDirectory/u);
  assert.match(dashboard, /COMMIT_OUTCOME_UNKNOWN|needsReconciliation/u);
  assert.doesNotMatch(dashboard, /router\.replace\([^;]+;\s*router\.refresh\(\)/u);
  assert.match(dashboard, /router\.replace\(projectStudioHref\(workspace\.storageScopeId, result\.data\.id\)\)/u);
  assert.match(dashboard, /<ProjectTemplatePicker disabled=\{mutation\.isPending\} \/>/u);
  assert.match(dashboard, /templateId: projectTemplateId\(data\.get\("templateId"\)\)/u);
  assert.match(templatePicker, /name="templateId"/u);
  assert.match(templatePicker, /id: "vite-react"[\s\S]+recommended: true/u);
  assert.match(templatePicker, /id: "next-app"/u);
  assert.match(templatePicker, /프로젝트 생성 후 변경할 수 없습니다/u);
  assert.match(dashboard, /title="이 프로젝트를 삭제할까요\?"/u);
  assert.match(dashboard, /name: project\.name/u);
  assert.doesNotMatch(dashboard, /confirmName|정확한 프로젝트 이름/u);
  assert.match(
    dashboard,
    /href=\{item\.state === "active"\s*\? projectStudioHref\(workspace\.storageScopeId, item\.id\)\s*:\s*projectDetailHref\(workspace\.storageScopeId, state, item\.id\)\}/u,
    "활성 프로젝트의 목록 주 동작은 설정 화면이 아니라 Studio를 열어야 합니다."
  );
  assert.match(
    dashboard,
    /href=\{projectDetailHref\(workspace\.storageScopeId, state, item\.id\)\}[\s\S]+aria-label=\{`\$\{item\.name\} 프로젝트 설정`\}/u,
    "프로젝트 설정은 목록의 별도 보조 동작이어야 합니다."
  );
  assert.match(dashboard, /function projectHref\([\s\S]+return `\/workspaces\/\$\{encodeURIComponent\(scope\)\}\?\$\{query\.toString\(\)\}`/u);
  assert.match(dashboard, /function projectDetailHref\([\s\S]+return `\/workspaces\/\$\{encodeURIComponent\(scope\)\}\/projects\/\$\{encodeURIComponent\(projectId\)\}\/settings\/general\?/u);
  assert.match(dashboard, /function projectStudioHref\([\s\S]+return `\/workspaces\/\$\{encodeURIComponent\(scope\)\}\/projects\/\$\{encodeURIComponent\(projectId\)\}\/studio`/u);
  assert.doesNotMatch(
    projectLinkHelpers,
    /new URLSearchParams\(\{[^}]*workspace:/u,
    "canonical project links must carry workspace identity in the path, not a query parameter"
  );
  assert.match(dashboard, /"편집기 열기"/u);
  assert.match(legacyPage, /redirect\(projectsHref\(workspaceId, state\)\)/u);
  assert.doesNotMatch(legacyPage, /createServerApiClient|<ProjectDashboard/u);
  assert.match(legacyProjectPage, /\/studio/u);
  assert.match(legacySettingsPage, /\/settings\/general\?/u);
  assert.match(workspacePage, /<ProjectDashboard/u);
  assert.match(workspacePage, /createServerApiClient\(\)/u);
  assert.match(workspacePage, /listProjects/u);
  assert.match(workspaceProjectsPage, /redirect\(`\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\?/u);
  assert.doesNotMatch(workspaceProjectsPage, /createServerApiClient|listProjects|<ProjectDashboard/u);
  assert.match(projectSettingsPage, /settings\/general/u);
  assert.match(projectAccessSettingsPage, /listOrganizationMembers/u);
  assert.match(projectAccessSettingsPage, /roleManagement/u);
  assert.doesNotMatch(projectAccessSettingsPage, /listProjects/u);
  assert.match(dashboard, /<SelectField label="조직 멤버"/u);
  assert.doesNotMatch(dashboard, /Organization member user ID/u);
  assert.match(projectAccessSettingsPage, /key=\{`\$\{project\.data\.id\}:\$\{project\.data\.version\}:access`\}/u);
  assert.match(projectAccessSettingsPage, /error\.status !== 403 && error\.status !== 404/u);
  assert.doesNotMatch(dashboard, /<ProjectIdeShell/u);
  assert.match(studioScreen, /<ProjectIdeShell/u);
  assert.match(studioScreen, /export function ProjectStudioFrame/u);
  assert.match(studioScreen, /const workspaceHref = `\/workspaces\/\$\{encodeURIComponent\(workspaceScope\)\}`/u);
  assert.match(studioScreen, /const projectBaseHref = `\$\{workspaceHref\}\/projects`/u);
  assert.match(studioScreen, /<Link href=\{workspaceHref\}[^>]+프로젝트 목록으로 돌아가기/u);
  assert.match(studioScreen, /const settingsHref = `\$\{projectBaseHref\}\/\$\{encodeURIComponent\(project\.id\)\}\/settings`/u);
  assert.match(studioScreen, /<Link[^>]+href=\{settingsHref\}>프로젝트 관리<\/Link>/u);
  assert.match(legacyStudioPage, /redirect\(/u);
  assert.doesNotMatch(legacyStudioPage, /<ProjectStudioScreen|createServerApiClient/u);
  assert.match(workspaceProjectStudioPage, /<ProjectStudioScreen/u);
  assert.match(workspaceProjectStudioPage, /getProject/u);
  assert.match(studioScreen, /key=\{`\$\{props\.workspaceScope\}:\$\{project\.id\}:\$\{project\.state\}`\}/u);
  assert.match(ideShell, /command\.length > MAX_TERMINAL_COMMAND_CHARS/u);
  assert.match(ideShell, /aria-label="프로젝트 파일"/u);
  assert.match(ideShell, /aria-label="텍스트 편집기"/u);
  assert.match(ideShell, /aria-label="미리보기"/u);
  assert.match(ideShell, /로컬 초안에 적용/u);
  assert.match(ideShell, /로컬 초안 저장됨 · HMR 적용됨/u);
  assert.match(ideShell, /동일 출처 미리보기는 보안을 위해 비활성화/u);
  assert.doesNotMatch(ideShell, />Save<|"Saved · HMR/u);
  assert.match(terminalView, /aria-label=\{`\$\{props\.sessionName\} 콘솔`\}/u);
  assert.match(studioStory, /<ProjectIdeShell/u);
  assert.match(studioStory, /<ProjectStudioFrame/u);
  assert.match(studioStory, /resumeProjectContentLoader=\{async \(\) =>/u);
  assert.doesNotMatch(studioStory, /function CodeEditor|function Explorer/u);
  assert.match(ideShell, /createRuntimeAdapter/u);
  assert.match(ideShell, /materializeTemplate\(project\.templateId\)/u);
  assert.doesNotMatch(ideShell, /name="templateId"|ProjectTemplatePicker/u);
  assert.match(ideShell, /if \(project\.state === "active"\) void startWorkspace\(\)/u);
  assert.doesNotMatch(ideShell, /템플릿으로 워크스페이스 시작|저장된 프로젝트 이어서 열기/u);
  assert.match(ideShell, /storageScopeId: project\.storageScopeId/u);
  assert.match(ideShell, /workspaceScopeId: workspaceScope/u);
  assert.doesNotMatch(ideShell, /localDraftKey/u);
  assert.doesNotMatch(ideShell, /BrowserRuntimeSupervisor|HostProcessTable|createPreviewWorkflowController|service-backend/u);
  assert.doesNotMatch(
    `${dashboard}\n${workspaceProjectsPage}\n${projectSettingsPage}\n${studioScreen}\n${ideShell}`,
    /localStorage|sessionStorage|console\./u
  );
}

function request(search: string): Request {
  return new Request(`https://nuriteo.test/api/v1/projects${search}`);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(webRoot, relative), "utf8");
}
