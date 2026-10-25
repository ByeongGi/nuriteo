import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

declare global {
  interface Window {
    __runtimeRecoveryFixture: {
      failPreview(): void;
      resolvePendingBridge(): void;
      snapshot(): { bridgeAttempts: number; bridgeCreationPending: boolean; disposedBridges: number };
      unmount(): void;
    };
  }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-runtime-recovery-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/runtime-recovery.tsx")],
  format: "esm",
  jsx: "automatic",
  loader: { ".ttf": "dataurl" },
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(path.join(fixtureRoot, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>\n');

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(fixtureRoot, file);
  if (!resolved.startsWith(`${fixtureRoot}${path.sep}`) || !fs.existsSync(resolved)) {
    response.writeHead(404).end("not found");
    return;
  }
  response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(fs.readFileSync(resolved));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => { if (!expectedFixturePageError(error.message)) pageErrors.push(error.message); });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });

  await page.getByRole("alert").getByText("브라우저 워크스페이스를 안전하게 시작하지 못했습니다.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "다시 시도" }).click();

  await page.getByRole("region", { name: "워크스페이스 복구" }).waitFor();
  await page.getByRole("button", { name: "프로젝트 파일 검색" }).click();
  const fileSearch = page.getByPlaceholder("프로젝트 코드 검색");
  assert.equal(await fileSearch.evaluate((element) => element === document.activeElement), true);
  await fileSearch.fill("initial");
  assert.equal(await page.getByRole("navigation", { name: "프로젝트 파일" }).getByRole("button", { name: /src\/message\.ts/u }).count(), 1);
  await fileSearch.fill("missing-file");
  await page.getByText("일치하는 코드를 찾지 못했습니다.").waitFor();
  await fileSearch.fill("");
  await page.getByRole("button", { name: "Terminal 1", exact: true }).click();
  await page.getByRole("application", { name: /콘솔$/u }).waitFor();
  const focusMode = page.getByRole("button", { name: "편집기에 집중" });
  await focusMode.click();
  const exitFocusMode = page.getByRole("button", { name: "전체 패널 표시" });
  assert.equal(await exitFocusMode.getAttribute("aria-pressed"), "true");
  await exitFocusMode.click();
  await page.getByText("읽기 전용", { exact: true }).waitFor();
  await page.getByRole("button", { name: "편집 권한 가져오기" }).click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("button", { name: "이 탭에서 편집 시작" }).click();
  await page.getByText("편집 권한 획득 · 로컬 초안 보존됨", { exact: false }).waitFor();
  await page.getByText("편집 가능", { exact: true }).waitFor();

  const editor = page.getByLabel("src/message.ts 편집기");
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially('export const label = "quota-trigger";\n', { delay: 1 });
  await page.getByRole("button", { name: "로컬 초안에 적용" }).evaluate((button) => (button as HTMLButtonElement).click());
  await page.getByText("EOPFSQUOTA", { exact: false }).waitFor();
  assert.match(await page.locator(".monaco-editor .view-lines").innerText(), /quota-trigger/u, "quota failure must preserve unsaved editor text");
  await page.getByRole("button", { name: "패키지 캐시 비우기" }).click();
  await page.getByText("패키지 캐시 삭제됨 · 로컬 초안 보존됨", { exact: false }).waitFor();
  await page.getByRole("button", { name: "로컬 초안에 적용" }).evaluate((button) => (button as HTMLButtonElement).click());
  await page.getByText("로컬 초안 저장됨", { exact: false }).waitFor();

  await page.locator('iframe[title="Runtime Recovery 미리보기"]').waitFor();
  assert.equal(await page.getByRole("region", { name: "미리보기", exact: true }).getAttribute("data-preview-url"), "about:blank");
  await page.evaluate(() => {
    window.__runtimeRecoveryFixture.failPreview();
  });
  await page.getByText("RUNTIME_PREVIEW_FAILED", { exact: false }).waitFor();
  await page.getByRole("button", { name: "미리보기 다시 시도" }).click();
  await page.getByText("복구를 완료하지 못했습니다.", { exact: false }).waitFor();
  assert.equal(await page.locator('iframe[title="Runtime Recovery 미리보기"]').count(), 0, "a failed replacement must not retain the disposed iframe");
  assert.equal(await page.getByRole("region", { name: "미리보기", exact: true }).getAttribute("data-preview-url"), null);
  assert.equal(await page.evaluate(() => window.__runtimeRecoveryFixture.snapshot().disposedBridges), 1);

  await page.getByRole("button", { name: "미리보기 실행" }).click();
  await page.locator('iframe[title="Runtime Recovery 미리보기"]').waitFor();
  assert.equal(await page.getByRole("region", { name: "미리보기", exact: true }).getAttribute("data-preview-url"), "about:blank");
  assert.deepEqual(pageErrors, []);

  const scalePage = await browser.newPage();
  const scalePageErrors: string[] = [];
  scalePage.on("pageerror", (error) => { if (!expectedFixturePageError(error.message)) scalePageErrors.push(error.message); });
  await scalePage.goto(`http://127.0.0.1:${address.port}/?mode=scale`, { waitUntil: "domcontentloaded" });
  const scaleFiles = scalePage.getByRole("navigation", { name: "프로젝트 파일" });
  await scalePage.getByText("파일 2501개").waitFor();
  assert.equal(await scaleFiles.locator('button[title^="src/"]').count(), 200, "large workspaces must render only the first file batch");
  await scalePage.evaluate(() => globalThis.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "p" })));
  const scaleSearch = scalePage.getByPlaceholder("파일 이름을 입력하세요");
  await scaleSearch.fill("module-2499");
  const lastGeneratedFile = scalePage.getByRole("region", { name: "빠른 파일 열기" }).getByRole("button", { name: /module-2499\.ts/u });
  await lastGeneratedFile.waitFor();
  await lastGeneratedFile.click();
  await scaleFiles.getByRole("button", { name: "module-2499.ts", exact: true }).waitFor();
  await scalePage.waitForFunction(() => document.querySelectorAll('nav[aria-label="프로젝트 파일"] button[title^="src/"]').length === 200);
  assert.equal(await scaleFiles.locator('button[title^="src/"]').count(), 200, "the selected file must stay pinned without expanding the rendered batch");
  await scalePage.getByRole("button", { name: "다음 200개 보기" }).click();
  await scalePage.waitForFunction(() => document.querySelectorAll('nav[aria-label="프로젝트 파일"] button[title^="src/"]').length === 400);
  assert.equal(await scaleFiles.locator('button[title^="src/"]').count(), 400, "load more must append one bounded batch");
  await scalePage.getByRole("button", { name: "Terminal 1", exact: true }).click();
  const scaleTerminal = scalePage.getByRole("application", { name: "Terminal 1 콘솔" });
  await scaleTerminal.pressSequentially("stress-log");
  await scaleTerminal.press("Enter");
  assert.deepEqual(scalePageErrors, []);
  await scalePage.close();

  const unmountPage = await browser.newPage();
  const unmountPageErrors: string[] = [];
  unmountPage.on("pageerror", (error) => { if (!expectedFixturePageError(error.message)) unmountPageErrors.push(error.message); });
  await unmountPage.goto(`http://127.0.0.1:${address.port}/?mode=unmount`, { waitUntil: "domcontentloaded" });
  await unmountPage.waitForFunction(() => window.__runtimeRecoveryFixture.snapshot().bridgeCreationPending);
  await unmountPage.evaluate(() => {
    const control = window.__runtimeRecoveryFixture;
    control.unmount();
    control.resolvePendingBridge();
  });
  await unmountPage.waitForFunction(() => window.__runtimeRecoveryFixture.snapshot().disposedBridges === 1);
  assert.equal(await unmountPage.locator("#root").textContent(), "");
  assert.equal(await unmountPage.locator("iframe").count(), 0);
  assert.deepEqual(unmountPageErrors, []);
  await unmountPage.close();

  console.log("RT-005 browser recovery journey ok (2,501-file scale, lazy retry, writer takeover, quota preservation, failed bridge replacement, unmount disposal)");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
}

function expectedFixturePageError(message: string): boolean {
  return message === "Event" || message.includes("potential listener LEAK detected");
}
