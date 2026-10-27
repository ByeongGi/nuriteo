import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

import type { RuntimeAdapter } from "../../src/runtime/runtime-adapter.ts";
import { integritySha512 } from "../../../../packages/node-runtime/src/network/crypto.ts";

declare global {
  interface Window { __nuriteoRuntimeProbe: { activeWorkers: number; adapter?: RuntimeAdapter; createdWorkers: number; committedVersion?: number; committedEtag?: string; reloads: number; restoreMode: "download-failure" | "intervening" | "materialization-failure" | "not-saved" | "success"; runtimeActiveWorkers: number; runtimeCreatedWorkers: number } }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot = path.join(webRoot, "public");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-runtime-browser-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/runtime-journey.tsx")],
  format: "esm",
  jsx: "automatic",
  loader: { ".ttf": "dataurl" },
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(path.join(fixtureRoot, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>\n');

const server = http.createServer((request, response) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const root = pathname.startsWith("/runtime/")
    ? publicRoot
    : pathname.startsWith("/node_modules/monaco-editor/")
      ? webRoot
      : fixtureRoot;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  if (pathname.endsWith("preview-sw.js")) response.setHeader("Service-Worker-Allowed", "/");
  response.setHeader("Content-Type", contentType(resolved));
  response.end(fs.readFileSync(resolved));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const registryArchive = new Uint8Array(gzipSync(tar({
    "package/package.json": JSON.stringify({
      name: "browser-answer",
      version: "1.0.0",
      bin: { answer: "cli.cjs" },
      scripts: { postinstall: "node postinstall.cjs" }
    }),
    "package/cli.cjs": "#!/usr/bin/env node\nconsole.log('browser-answer:42');\n",
    "package/postinstall.cjs": "console.log('browser-postinstall:ready');\n"
  })));
  await page.route("https://registry.npmjs.org/browser-answer", (route) => route.fulfill({
    body: JSON.stringify({
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "browser-answer",
          version: "1.0.0",
          dist: {
            integrity: integritySha512(registryArchive),
            tarball: "https://registry.npmjs.org/browser-answer/-/browser-answer-1.0.0.tgz"
          }
        }
      }
    }),
    headers: { "access-control-allow-origin": "*", "content-type": "application/json" }
  }));
  await page.route("https://registry.npmjs.org/browser-answer/-/browser-answer-1.0.0.tgz", (route) => route.fulfill({
    body: Buffer.from(registryArchive),
    headers: { "access-control-allow-origin": "*", "content-type": "application/octet-stream" }
  }));
  const errors: string[] = [];
  const networkErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  page.on("requestfailed", (request) => networkErrors.push(`${request.url()} ${request.failure()?.errorText ?? "failed"}`));
  page.on("response", (response) => {
    if (response.status() >= 400) networkErrors.push(`${response.url()} ${response.status()}`);
  });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);

  try {
    await page.getByRole("button", { name: "미리보기 실행" }).waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`Studio fixture did not render:\n${await page.locator("body").innerText()}\n${errors.join("\n")}`, { cause: error });
  }
  try {
    await page.waitForFunction(
      () => Boolean(document.querySelector<HTMLElement>('[aria-label="미리보기"]')?.dataset.previewUrl),
      undefined,
      { timeout: 20_000 }
    );
  } catch (error) {
    throw new Error(`Studio did not reach the ready state:\n${await page.locator("body").innerText()}`, { cause: error });
  }
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.runtimeCreatedWorkers), 2);
  const previewUrl = await page.getByRole("region", { name: "미리보기", exact: true }).getAttribute("data-preview-url");
  assert(previewUrl && previewUrl.includes("/__preview/"));
  const initialPreview = await page.evaluate(async (url) => (await fetch(url)).text(), previewUrl);
  assert.match(initialPreview, /nuriteo:1/u);

  const terminalJourney = await page.evaluate(async () => {
    const adapter = window.__nuriteoRuntimeProbe.adapter;
    if (!adapter) throw new Error("runtime adapter probe unavailable");
    const manifest = JSON.parse(adapter.workspace.readText("package.json"));
    manifest.scripts.check = "node scripts/check.cjs";
    manifest.scripts.pipeline = "node scripts/emit.cjs | node scripts/upper.cjs > piped.txt";
    manifest.scripts.serve = "vite --host 0.0.0.0";
    adapter.workspace.writeText("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    adapter.workspace.createText(
      "scripts/check.cjs",
      "const fs = require('node:fs');\nfs.writeFileSync('generated.txt', process.argv[2]);\nconsole.log('script:' + process.argv[2]);\n"
    );
    adapter.workspace.createText("scripts/emit.cjs", "process.stdout.write('browser pipeline');\n");
    adapter.workspace.createText("scripts/direct-node.cjs", "console.log('direct-node:' + process.argv[2]);\n");
    adapter.workspace.createText(
      "scripts/upper.cjs",
      "let value = '';\nprocess.stdin.on('data', (chunk) => { value += chunk; });\nprocess.stdin.on('end', () => process.stdout.write(value.toUpperCase()));\n"
    );
    const install = await adapter.terminal.run("pnpm install", "browser-script") as { exitCode: number };
    const directNode = await adapter.terminal.run("node scripts/direct-node.cjs browser", "browser-script") as { exitCode: number; stdout: string };
    const add = await adapter.terminal.run("npm install browser-answer@1.0.0", "browser-script") as { exitCode: number; stdout: string };
    const installedManifest = JSON.parse(adapter.workspace.readText("package.json"));
    const installedDependency = installedManifest.dependencies?.["browser-answer"];
    installedManifest.scripts.answer = "answer";
    adapter.workspace.writeText("package.json", `${JSON.stringify(installedManifest, null, 2)}\n`);
    const answer = await adapter.terminal.run("pnpm run answer", "browser-script") as { exitCode: number; stdout: string };
    const check = await adapter.terminal.run("pnpm run check -- browser", "browser-script") as { exitCode: number; stdout: string };
    const pipeline = await adapter.terminal.run("npm run pipeline", "browser-script") as { exitCode: number; stdout: string };
    const serve = await adapter.terminal.run("pnpm serve", "browser-script") as { exitCode: number; stdout: string };
    return {
      add,
      answer,
      check,
      directNode,
      generated: adapter.workspace.readText("generated.txt"),
      hasGeneratedFile: adapter.workspace.getState().files.some((file) => file.path === "generated.txt"),
      install,
      installedDependency,
      piped: adapter.workspace.readText("piped.txt"),
      pipeline,
      serve
    };
  });
  assert.equal(terminalJourney.install.exitCode, 0);
  assert.equal(terminalJourney.directNode.exitCode, 0);
  assert.equal(terminalJourney.directNode.stdout, "direct-node:browser\n");
  assert.equal(terminalJourney.add.exitCode, 0);
  assert.match(terminalJourney.add.stdout, /added browser-answer@1\.0\.0/u);
  assert.match(terminalJourney.add.stdout, /browser-postinstall:ready/u);
  assert.equal(terminalJourney.installedDependency, "1.0.0");
  assert.equal(terminalJourney.answer.exitCode, 0);
  assert.equal(terminalJourney.answer.stdout, "browser-answer:42\n");
  assert.equal(terminalJourney.check.exitCode, 0);
  assert.equal(terminalJourney.check.stdout, "script:browser\n");
  assert.equal(terminalJourney.generated, "browser");
  assert.equal(terminalJourney.hasGeneratedFile, true);
  assert.equal(terminalJourney.pipeline.exitCode, 0);
  assert.equal(terminalJourney.pipeline.stdout, "");
  assert.equal(terminalJourney.piped, "BROWSER PIPELINE");
  assert.equal(terminalJourney.serve.exitCode, 0);
  assert.match(terminalJourney.serve.stdout, /dev server ready/u);

  const portsTab = page.getByRole("button", { name: "포트 1", exact: true });
  await portsTab.evaluate((button: HTMLButtonElement) => button.click());
  await portsTab.getAttribute("aria-pressed").then((pressed) => assert.equal(pressed, "true"));
  const portList = page.getByRole("list", { name: "열린 포트" });
  const previewPort = await page.evaluate(() => window.__nuriteoRuntimeProbe.adapter?.getState().ports[0]?.port ?? null);
  assert(previewPort, "preview port was not exposed by the runtime adapter");
  await portList.getByText(`Preview · localhost:${previewPort}`, { exact: true }).waitFor();
  await portList.getByRole("button", { name: "브라우저에서 열기" }).waitFor();

  const runningProcesses = await page.evaluate(async () => {
    const adapter = window.__nuriteoRuntimeProbe.adapter;
    if (!adapter) throw new Error("runtime adapter probe unavailable");
    const scope = window as typeof window & { __runtimeProcessJourney?: {
      first: Promise<{ exitCode: number }>;
      firstAccepted: boolean;
      output: { first: string; second: string };
      second: Promise<{ exitCode: number }>;
      secondAccepted: boolean;
    } };
    const output = { first: "", second: "" };
    const first = adapter.terminal.run("worker-pty", "browser-pty-1", (chunk) => { output.first += chunk.data; }) as Promise<{ exitCode: number }>;
    const second = adapter.terminal.run("worker-pty", "browser-pty-2", (chunk) => { output.second += chunk.data; }) as Promise<{ exitCode: number }>;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const firstAccepted = adapter.terminal.input("first terminal\r", "browser-pty-1");
    const secondAccepted = adapter.terminal.input("second terminal\r", "browser-pty-2");
    const outputDeadline = Date.now() + 2_000;
    while ((!output.first.includes("first terminal") || !output.second.includes("second terminal")) && Date.now() < outputDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    scope.__runtimeProcessJourney = { first, firstAccepted, output, second, secondAccepted };
    return {
      activeDuringRun: adapter.terminal.activeCount(),
      processes: adapter.getState().processes
    };
  });
  assert.equal(runningProcesses.activeDuringRun, 2);
  assert.deepEqual(runningProcesses.processes.map((process) => process.terminalId).sort(), ["browser-pty-1", "browser-pty-2"]);

  const processesTab = page.getByRole("button", { name: "프로세스 2", exact: true });
  await processesTab.evaluate((button: HTMLButtonElement) => button.click());
  const processList = page.getByRole("list", { name: "실행 중 프로세스" });
  const firstProcess = processList.getByRole("listitem").filter({ hasText: "browser-pty-1" });
  const secondProcess = processList.getByRole("listitem").filter({ hasText: "browser-pty-2" });
  await firstProcess.getByRole("button", { name: /프로세스 종료/u }).evaluate((button: HTMLButtonElement) => button.click());
  await secondProcess.getByRole("button", { name: /프로세스 종료/u }).evaluate((button: HTMLButtonElement) => button.click());
  const processJourney = await page.evaluate(async () => {
    const adapter = window.__nuriteoRuntimeProbe.adapter;
    const scope = window as typeof window & { __runtimeProcessJourney?: {
      first: Promise<{ exitCode: number }>;
      firstAccepted: boolean;
      output: { first: string; second: string };
      second: Promise<{ exitCode: number }>;
      secondAccepted: boolean;
    } };
    const journey = scope.__runtimeProcessJourney;
    if (!adapter || !journey) throw new Error("runtime process journey unavailable");
    const [firstResult, secondResult] = await Promise.all([journey.first, journey.second]);
    return {
      activeAfterExit: adapter.terminal.activeCount(),
      firstAccepted: journey.firstAccepted,
      firstResult,
      output: journey.output,
      secondAccepted: journey.secondAccepted,
      secondResult
    };
  });
  assert.equal(processJourney.firstAccepted, true);
  assert.equal(processJourney.secondAccepted, true);
  assert.match(processJourney.output.first, /first terminal/u);
  assert.match(processJourney.output.second, /second terminal/u);
  assert.equal(processJourney.firstResult.exitCode, 143);
  assert.equal(processJourney.secondResult.exitCode, 143);
  assert.equal(processJourney.activeAfterExit, 0);
  await page.getByText("실행 중인 터미널 프로세스가 없습니다.", { exact: true }).waitFor();

  await page.evaluate(() => {
    const adapter = window.__nuriteoRuntimeProbe.adapter;
    if (!adapter) throw new Error("runtime adapter probe unavailable");
    adapter.workspace.writeText("src/message.ts", 'export const label = "RT004 edited";\n');
  });
  const updatedPreview = await page.evaluate(async (url) => (await fetch(url)).text(), previewUrl);
  assert.match(updatedPreview, /RT004 edited:1/u);

  await portsTab.evaluate((button: HTMLButtonElement) => button.click());
  await page.getByRole("button", { name: `포트 ${previewPort} 중지` }).evaluate((button: HTMLButtonElement) => button.click());
  await page.getByText("열린 개발 서버 포트가 없습니다.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "미리보기", exact: true }).getAttribute("data-preview-url"), null);

  await page.getByRole("button", { name: "워크스페이스 종료" }).click();
  // The fixture intentionally omits Next.js/Tailwind global CSS; force the
  // portal action because its production stacking styles are not present.
  await page.getByRole("button", { name: "초안을 버리고 종료" }).evaluate((button: HTMLButtonElement) => button.click());
  try {
    await page.getByRole("button", { name: "Studio 열기" }).waitFor({ timeout: 10_000 });
  } catch (error) {
    const cleanupState = await page.evaluate(() => ({
      activeWorkers: window.__nuriteoRuntimeProbe.activeWorkers,
      lifecycle: window.__nuriteoRuntimeProbe.adapter?.getState().lifecycle,
      text: document.body.innerText
    }));
    throw new Error(`Studio did not dispose cleanly: ${JSON.stringify(cleanupState)}`, { cause: error });
  }
  await page.waitForFunction(() => window.__nuriteoRuntimeProbe.runtimeActiveWorkers === 0);
  assert.deepEqual({ errors, networkErrors }, { errors: [], networkErrors: [] });
  console.log("RT-004 actual browser journey ok (direct node, npm registry install/save/lifecycle/bin, arbitrary scripts, pipe/redirect, dev alias, Ports UI, multi-PTY Processes UI, Preview, edit, HMR, dispose)");
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function tar(files: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(files)) {
    const body = new TextEncoder().encode(value);
    const header = new Uint8Array(512);
    writeTarField(header, 0, 100, name);
    writeTarField(header, 100, 8, "0000644\0");
    writeTarField(header, 108, 8, "0000000\0");
    writeTarField(header, 116, 8, "0000000\0");
    writeTarField(header, 124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
    writeTarField(header, 136, 12, "00000000000\0");
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarField(header, 257, 6, "ustar\0");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function writeTarField(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}
