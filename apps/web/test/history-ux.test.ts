import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { forwardProjectHistoryRequest } from "../src/lib/api/history-bff.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "0199ee6c-c777-7000-8000-00000000d001";
const projectId = "0199ee6c-c777-7000-8000-00000000d002";
const base = `/api/v1/workspaces/users/${ownerId}/projects/${projectId}`;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.NURITEO_INTERNAL_API_URL;

try {
  await testHistoryForwarding();
  testHistoryUiContract();
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NURITEO_INTERNAL_API_URL;
  else process.env.NURITEO_INTERNAL_API_URL = originalUrl;
}

async function testHistoryForwarding(): Promise<void> {
  process.env.NURITEO_INTERNAL_API_URL = "http://core.internal:8080";
  const forwarded: { headers: Headers; method: string; url: string }[] = [];
  globalThis.fetch = async (input, init) => {
    forwarded.push({ headers: new Headers(init?.headers), method: String(init?.method), url: String(input) });
    return Response.json({ items: [], nextCursor: null }, { headers: { etag: '"project-v2"' } });
  };

  const versions = await forwardProjectHistoryRequest(request(`${base}/versions?pageSize=20&cursor=opaque_1`), {
    ownerType: "users", ownerId, projectId
  }, "versions");
  assert.equal(versions.status, 200);
  assert.equal(forwarded[0]?.url, `http://core.internal:8080${base}/versions?pageSize=20&cursor=opaque_1`);
  assert.equal(forwarded[0]?.method, "GET");

  const invalid = await forwardProjectHistoryRequest(request(`${base}/versions?pageSize=20&pageSize=21`), {
    ownerType: "users", ownerId, projectId
  }, "versions");
  assert.equal(invalid.status, 400);
  assert.equal(forwarded.length, 1);

  const create = await forwardProjectHistoryRequest(request(`${base}/versions`, "POST", {
    "content-type": "application/json",
    "idempotency-key": "history-version-0123456789abcdef",
    "if-match": '"project-v1"',
    "x-csrf-token": "csrf-safe"
  }, JSON.stringify({ name: "Release point" })), { ownerType: "users", ownerId, projectId }, "versions");
  assert.equal(create.status, 200);
  assert.equal(forwarded[1]?.headers.get("if-match"), '"project-v1"');
  assert.equal(forwarded[1]?.headers.get("idempotency-key"), "history-version-0123456789abcdef");
  assert.equal(forwarded[1]?.headers.get("x-csrf-token"), "csrf-safe");

  await forwardProjectHistoryRequest(request(`${base}/history/restore`, "GET", {
    "idempotency-key": "history-restore-0123456789abcdef"
  }), { ownerType: "users", ownerId, projectId }, "restore");
  assert.equal(forwarded[2]?.headers.get("idempotency-key"), "history-restore-0123456789abcdef");
  assert.equal(forwarded[2]?.headers.get("x-csrf-token"), null);

  const badRecovery = await forwardProjectHistoryRequest(request(`${base}/recovery-checkpoints?unexpected=1`), {
    ownerType: "users", ownerId, projectId
  }, "recovery");
  assert.equal(badRecovery.status, 400);
}

function testHistoryUiContract(): void {
  const panel = read("src/projects/project-history-panel.tsx");
  const shell = read("src/projects/project-ide-shell.tsx");
  const confirmationDialog = read("src/components/ui/confirmation-dialog.tsx");
  assert.match(panel, /<ConfirmationDialog/u);
  assert.match(confirmationDialog, /<AlertDialog\.Root/u);
  assert.match(confirmationDialog, /<AlertDialog\.Popup/u);
  assert.match(confirmationDialog, /<AlertDialog\.Viewport/u);
  assert.match(panel, /Date\.parse\(right\.createdAt\) - Date\.parse\(left\.createdAt\)/u);
  assert.match(panel, /로컬 초안은 바꾸지 않았습니다/u);
  assert.match(panel, /보관됨 · 읽기 전용/u);
  assert.match(panel, /reconcileProjectHistory/u);
  assert.match(panel, /`버전 \$\{VERSION_PAGE_SIZE\}개 더 보기`/u);
  assert.match(shell, /서버 저장 다시 시도/u);
  assert.match(shell, /최신 프로젝트 다시 불러오기/u);
}

function request(urlPath: string, method = "GET", headers: Record<string, string> = {}, body?: string): Request {
  return new Request(`https://nuriteo.test${urlPath}`, {
    method,
    headers: { host: "nuriteo.test", origin: "https://nuriteo.test", ...headers },
    ...(body === undefined ? {} : { body })
  });
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}
