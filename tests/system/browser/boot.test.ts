import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";

const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}`);
}

async function withRuntimeLab(callback) {
  const server = spawn(process.execPath, [new URL("../../fixtures/runtime-lab/server.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: "0"
    },
    stdio: ["ignore", "pipe", "inherit"]
  });
  const [line] = await once(server.stdout, "data");
  const match = String(line).match(/http:\/\/127\.0\.0\.1:\d+/);
  if (!match) throw new Error(`could not parse runtime-lab URL from ${line}`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath
  });
  try {
    const page = await browser.newPage();
    return await callback(page, match[0]);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await withRuntimeLab(async (page, baseUrl) => {
  await page.goto(baseUrl, { waitUntil: "load" });
  const cliWorkerResult = await page.evaluate(async () => {
    const encode = (value) => btoa(value);
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("cli worker evaluation timeout")), 1000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:result") return;
          clearTimeout(timeout);
          resolve(event.data);
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        });
        worker.postMessage({
          id: 1,
          type: "cli:evaluate",
          root: "/workspace",
          request: {
            entry: {
              name: "fixture-cli",
              version: "1.0.0",
              entry: "/workspace/cli/bin/fixture.js"
            },
            args: [],
            cwd: "/workspace/project"
          },
          workspaceSnapshot: {
            directories: ["/", "/workspace", "/workspace/cli", "/workspace/cli/bin", "/workspace/project"],
            files: [
              {
                path: "/workspace/cli/bin/fixture.js",
                data: encode("const fs = require('fs');\nfs.writeFileSync(process.cwd() + '/worker-cli.txt', 'ok');\nprocess.stdout.write('browser-worker-cli\\n');\n"),
                encoding: "base64"
              }
            ],
            links: []
          }
        });
      });
      return result;
    } finally {
      worker.terminate();
    }
  });
  if (cliWorkerResult.error) throw new Error(cliWorkerResult.error);
  if (cliWorkerResult.result.stdout !== "browser-worker-cli\n") {
    throw new Error(`process worker eval-free CLI stdout mismatch: ${JSON.stringify(cliWorkerResult.result)}`);
  }
  const workerCliFile = cliWorkerResult.result.workspaceSnapshot.files.find((file) => file.path === "/workspace/project/worker-cli.txt");
  if (!workerCliFile || workerCliFile.data !== "b2s=") throw new Error("process worker eval-free CLI snapshot did not include write result");


  const esmCliWorkerResult = await page.evaluate(async () => {
    const encode = (value) => btoa(value);
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("esm cli worker evaluation timeout")), 1000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:result") return;
          clearTimeout(timeout);
          resolve(event.data);
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        });
        worker.postMessage({
          captureGlobalCalls: [
            "__viteRegisterDevServer",
            "__viteRegisterHmrChannel",
            "__viteRegisterTransform"
          ],
          id: 2,
          type: "cli:evaluate",
          root: "/workspace",
          request: {
            entry: {
              name: "vite",
              version: "0.0.0-worker-smoke",
              entry: "/workspace/cli/bin/vite.mjs"
            },
            args: [],
            cwd: "/workspace/project",
            env: { PORT: "5300" }
          },
          workspaceSnapshot: {
            directories: [
              "/",
              "/workspace",
              "/workspace/cli",
              "/workspace/cli/bin",
              "/workspace/cli/dist",
              "/workspace/project"
            ],
            files: [
              {
                path: "/workspace/cli/bin/vite.mjs",
                data: encode("import { startDevServer } from '../dist/server.mjs';\nstartDevServer({ host: '127.0.0.1', port: Number(process.env.PORT || 5173) });\n"),
                encoding: "base64"
              },
              {
                path: "/workspace/cli/dist/server.mjs",
                data: encode("import { createHotChannel } from './hmr.mjs';\nimport { registerTransform } from './transform.mjs';\nexport function startDevServer(options) {\n  registerTransform();\n  createHotChannel();\n  global.__viteRegisterDevServer?.({ command: 'dev', host: options.host, port: options.port, source: 'vite-cli' });\n}\n"),
                encoding: "base64"
              },
              {
                path: "/workspace/cli/dist/hmr.mjs",
                data: encode("export function createHotChannel() {\n  global.__viteRegisterHmrChannel?.({ channel: 'hmr', source: 'vite-cli', transport: 'loopback', sendUpdate(update) { return update; } });\n}\n"),
                encoding: "base64"
              },
              {
                path: "/workspace/cli/dist/transform.mjs",
                data: encode("export function registerTransform() {\n  global.__viteRegisterTransform?.({ mode: 'browser-esm', source: 'vite-cli', transformRequest(request) { return { code: request.source }; } });\n}\n"),
                encoding: "base64"
              }
            ],
            links: []
          }
        });
      });
      return result;
    } finally {
      worker.terminate();
    }
  });
  if (esmCliWorkerResult.error) throw new Error(esmCliWorkerResult.error);
  const esmCapturedCalls = esmCliWorkerResult.result.capturedGlobalCalls.map((call) => [call.name, call.args[0]]);
  if (esmCapturedCalls.length !== 3) throw new Error(`process worker eval-free ESM CLI did not capture Vite registrations: ${JSON.stringify(esmCliWorkerResult.result)}`);
  if (!esmCapturedCalls.some(([name, registration]) => name === "__viteRegisterDevServer" && registration.port === 5300)) {
    throw new Error(`process worker eval-free ESM CLI did not capture dev server registration: ${JSON.stringify(esmCapturedCalls)}`);
  }
  if (!esmCapturedCalls.some(([name, registration]) => name === "__viteRegisterHmrChannel" && registration.sendUpdate?.__cliFunctionRef)) {
    throw new Error(`process worker eval-free ESM CLI did not capture HMR function ref: ${JSON.stringify(esmCapturedCalls)}`);
  }
  if (!esmCapturedCalls.some(([name, registration]) => name === "__viteRegisterTransform" && registration.transformRequest?.__cliFunctionRef)) {
    throw new Error(`process worker eval-free ESM CLI did not capture transform function ref: ${JSON.stringify(esmCapturedCalls)}`);
  }

  const result = await page.evaluate(() => globalThis.__runtimeLab.boot());
  if (result.role !== "system") throw new Error("runtime did not boot through system worker");
  if (!result.details.processSeen) throw new Error("system worker did not see process worker");
  if (result.details.syscall?.payload !== "pong") throw new Error("SAB syscall ping did not roundtrip");
  if (result.details.syscall?.generation !== 1) throw new Error("SAB syscall generation was not echoed");
  if (result.details.syscall?.pid !== 1) throw new Error("SAB syscall PID was not echoed from request header");
  if (await page.locator("#status").textContent() !== "ready") throw new Error("status was not ready");
  const fsResult = await page.evaluate(() => globalThis.__runtimeLab.runFsSmoke());
  if (fsResult.exports?.value !== "hello") throw new Error("node:fs binding did not read written file");
  if (fsResult.exports?.size !== 5) throw new Error("node:fs binding stat size mismatch");
  const previewResult = await page.evaluate(() => globalThis.__runtimeLab.runPreviewSmoke());
  if (previewResult.ready.type !== "preview:ready") throw new Error("preview handshake did not complete");
  if (previewResult.routed.response?.body !== "preview:/index.html") throw new Error("preview request did not route to container port");
  if (!previewResult.hmr.includes("message:update")) throw new Error("HMR reconnect/update smoke did not complete");
  const overlayResult = await page.evaluate(() => globalThis.__runtimeLab.runPreviewOverlaySmoke());
  if (overlayResult.state.lastError.code !== "EVITEBUILD") throw new Error("preview overlay did not store build error");
  if (overlayResult.state.lastError.file !== "/workspace/app/src/App.jsx") throw new Error("preview overlay did not store file");
  if (overlayResult.messages.at(-1).diagnostic.recoveryActions[0].kind !== "open-file") {
    throw new Error("preview overlay did not suggest opening the file");
  }
  if (await page.locator("#diagnostics-status").textContent() !== "EVITEBUILD") {
    throw new Error("diagnostics panel did not render overlay status");
  }
  if (!await page.locator("#diagnostics-list").textContent().then((text) => text.includes("Unexpected token"))) {
    throw new Error("diagnostics panel did not render overlay message");
  }
  await page.locator("#recovery-actions button", { hasText: "Open file" }).click();
  if (await page.locator("#editor-path").inputValue() !== "/workspace/app/src/App.jsx") {
    throw new Error("open-file recovery action did not select editor file");
  }
  const recoveryResult = await page.evaluate(() => globalThis.__runtimeLab.runRecoverySmoke());
  if (!recoveryResult.plan.blocked) throw new Error("recovery plan did not mark unsupported native addon as blocked");
  if (!recoveryResult.bundle.diagnostics.some((diagnostic) => diagnostic.code === "ERR_RUNTIME_TCP_DB_UNSUPPORTED")) {
    throw new Error("runtime network boundary did not route TCP DB diagnostic into recovery smoke");
  }
  if (!recoveryResult.plan.actions.some((action) => action.kind === "export-support-bundle")) {
    throw new Error("recovery plan did not include support bundle export");
  }
  if (recoveryResult.bundle.schemaVersion !== 1) throw new Error("support bundle was not created");
  if (await page.locator("#diagnostics-status").textContent() !== "blocked") {
    throw new Error("diagnostics panel did not render recovery status");
  }
  await page.locator("#recovery-actions button", { hasText: "Retry preview request" }).click();
  await page.waitForFunction(() => globalThis.__runtimeLab.terminalOutput().includes("preview request retried"));
  await page.locator("#recovery-actions button", { hasText: "Restart dev server" }).click();
  if (await page.locator("#terminal-status").textContent() !== "restarted") {
    throw new Error("reset-runtime recovery action did not restart terminal session");
  }
  await page.locator("#recovery-actions button", { hasText: "Clear package cache" }).click();
  if (!await page.locator("#terminal-log").textContent().then((text) => text.includes("package cache cleared"))) {
    throw new Error("clear-cache recovery action did not write terminal feedback");
  }
  await page.locator("#recovery-actions button", { hasText: "Export support bundle" }).click();
  if (!await page.locator("#log").textContent().then((text) => text.includes("ERR_PM_NATIVE_ADDON_UNSUPPORTED"))) {
    throw new Error("export support bundle action did not write bundle to log");
  }
  await page.waitForFunction(() => Boolean(globalThis.__runtimeLab.supportBundleExport()));
  const exportedBundle = await page.evaluate(() => globalThis.__runtimeLab.supportBundleExport());
  if (exportedBundle.fileName !== "runtime-support-bundle.json") {
    throw new Error("export support bundle action did not prepare a download file");
  }
  if (!exportedBundle.payload.includes("ERR_PM_NATIVE_ADDON_UNSUPPORTED")) {
    throw new Error("export support bundle action did not serialize diagnostics");
  }
  const terminalResult = await page.evaluate(async () => {
    const install = await globalThis.__runtimeLab.runTerminalCommand("npm install");
    const pending = globalThis.__runtimeLab.runTerminalCommand("sleep");
    const active = globalThis.__runtimeLab.terminalTranscript().at(-1);
    const cancelAccepted = globalThis.__runtimeLab.cancelTerminalCommand();
    const cancelled = await pending;
    globalThis.__runtimeLab.restartTerminal();
    const build = await globalThis.__runtimeLab.runTerminalCommand("vite build");
    return {
      install,
      active,
      cancelAccepted,
      cancelled,
      build,
      history: globalThis.__runtimeLab.terminalHistory(),
      output: globalThis.__runtimeLab.terminalOutput()
    };
  });
  if (terminalResult.install.entry.status !== "completed") throw new Error("terminal install did not complete");
  if (!terminalResult.install.stdout.includes("linked node_modules/.bin/vite")) {
    throw new Error("terminal install did not show linked Vite bin");
  }
  if (terminalResult.active.command !== "sleep") throw new Error("terminal did not expose active command");
  if (!terminalResult.cancelAccepted) throw new Error("terminal cancel was not accepted");
  if (terminalResult.cancelled.entry.status !== "cancelled") throw new Error("terminal command was not cancelled");
  if (terminalResult.build.stdout !== "vite build completed\n") throw new Error("terminal build did not run after restart");
  if (!terminalResult.history.includes("vite build")) throw new Error("terminal history did not include build command");
  if (!terminalResult.output.includes("$ npm install")) throw new Error("terminal output did not include command prompt");
  const editorResult = await page.evaluate(() => {
    const opened = globalThis.__runtimeLab.openEditorFile("src/main.jsx");
    const edited = globalThis.__runtimeLab.editCurrentFile("console.log(\"browser edit\")\n");
    const searchDirty = globalThis.__runtimeLab.editorSearch("browser edit");
    const saved = globalThis.__runtimeLab.saveCurrentFile();
    const created = globalThis.__runtimeLab.createEditorFile("src/Preview.jsx", "export const Preview = true;\n");
    const renamed = globalThis.__runtimeLab.renameCurrentFile("src/Preview.tsx");
    const searchRenamed = globalThis.__runtimeLab.editorSearch("Preview");
    globalThis.__runtimeLab.deleteCurrentFile();
    return {
      opened,
      edited,
      searchDirty,
      saved,
      created,
      renamed,
      searchRenamed,
      editorEvents: globalThis.__runtimeLab.editorEvents(),
      hmrUpdates: globalThis.__runtimeLab.viteHmrUpdates(),
      tree: globalThis.__runtimeLab.editorTree()
    };
  });
  if (editorResult.opened.path !== "/workspace/app/src/main.jsx") throw new Error("editor did not open file");
  if (!editorResult.edited.dirty) throw new Error("editor did not mark dirty state");
  if (editorResult.searchDirty[0]?.snippet !== "console.log(\"browser edit\")") {
    throw new Error("editor dirty search did not include edit");
  }
  if (editorResult.saved.dirty) throw new Error("editor save did not clear dirty state");
  if (!editorResult.hmrUpdates.some((update) => update.updates[0].path === "/src/main.jsx")) {
    throw new Error("editor save did not propagate to Vite source edit HMR");
  }
  if (!editorResult.hmrUpdates.some((update) => update.updates[0].path === "/src/Preview.jsx")) {
    throw new Error("editor create did not propagate to dev server source change");
  }
  if (editorResult.created.path !== "/workspace/app/src/Preview.jsx") throw new Error("editor did not create file");
  if (editorResult.renamed.path !== "/workspace/app/src/Preview.tsx") throw new Error("editor did not rename file");
  if (!editorResult.searchRenamed.some((match) => match.path.endsWith("Preview.tsx"))) {
    throw new Error("editor search did not include renamed file");
  }
  if (JSON.stringify(editorResult.tree).includes("Preview.tsx")) throw new Error("editor did not delete renamed file");
  if (!editorResult.editorEvents.some((event) => event.kind === "rename" && event.previousPath.endsWith("Preview.jsx"))) {
    throw new Error("editor did not emit rename change event");
  }
  if (!editorResult.editorEvents.some((event) => event.kind === "delete" && event.relativePath === "src/Preview.tsx")) {
    throw new Error("editor did not emit delete change event");
  }
  if (!await page.locator("#diagnostics-status").textContent().then((text) => text === "EDEVSERVER_SOURCE_DELETED")) {
    throw new Error("editor delete did not surface preview recovery diagnostic");
  }
  await page.evaluate(() => globalThis.__runtimeLab.teardown());
  if (await page.locator("#status").textContent() !== "stopped") throw new Error("status was not stopped");
});

await withRuntimeLab(async (page, baseUrl) => {
  await page.goto(`${baseUrl}/broken/`, { waitUntil: "load" });
  const status = await page.locator("#status").textContent();
  if (status !== "isolation-missing") throw new Error(`expected isolation diagnostic, got ${status}`);
  const error = await page.evaluate(async () => {
    try {
      await globalThis.__runtimeLab.boot();
      return "unexpected success";
    } catch (cause) {
      return cause.message;
    }
  });
  if (!error.includes("requires COOP/COEP isolation")) {
    throw new Error(`missing isolation error, got ${error}`);
  }
});

console.log("browser boot test ok");
