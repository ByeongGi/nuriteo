import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAvailableLoopbackPort } from "./available-port.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoot = path.join(root, "apps/preview-service");
const safariDriverPath = process.env.SAFARIDRIVER_PATH || "/usr/bin/safaridriver";
const appPort = await getAvailableLoopbackPort();
const driverPort = await getAvailableLoopbackPort();
const baseUrl = `http://127.0.0.1:${appPort}`;
const driverUrl = `http://127.0.0.1:${driverPort}`;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");

assert.equal(process.platform, "darwin", "Safari smoke requires macOS");
assert.ok(fs.existsSync(safariDriverPath), `safaridriver not found at ${safariDriverPath}`);

const server = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], {
  cwd: appRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});
const driver = spawn(safariDriverPath, ["-p", String(driverPort)], {
  stdio: ["ignore", "pipe", "pipe"]
});

let sessionId: string | null = null;

try {
  await Promise.all([
    waitForHttp(baseUrl, "preview-service"),
    waitForHttp(`${driverUrl}/status`, "safaridriver")
  ]);

  const response = await fetch(baseUrl);
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");

  const session = await webdriver("/session", {
    method: "POST",
    body: { capabilities: { alwaysMatch: { browserName: "safari" } } }
  }) as { sessionId: string; capabilities: Record<string, unknown> };
  sessionId = session.sessionId;
  assert.equal(session.capabilities.browserName, "Safari");
  assert.equal(session.capabilities["safari:useSimulator"], false, "smoke must use desktop Safari, not a simulator");

  await command("/timeouts", { script: 90_000, pageLoad: 60_000, implicit: 0 });
  await command("/url", { url: baseUrl });
  await executeAsync(`
    const done = arguments[arguments.length - 1];
    const started = Date.now();
    const timer = setInterval(() => {
      if (globalThis.__previewService || Date.now() - started > 30_000) {
        clearInterval(timer);
        done(Boolean(globalThis.__previewService));
      }
    }, 50);
  `).then((ready) => assert.equal(ready, true, "preview service API did not initialize"));

  const platform = await execute(`return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    hasSharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
    hasServiceWorker: "serviceWorker" in navigator,
    hasOpfs: typeof navigator.storage?.getDirectory === "function"
  }`) as Record<string, unknown>;
  assert.match(String(platform.userAgent), /Version\/[^ ]+ Safari\//, "smoke must run in Safari");
  assert.equal(platform.crossOriginIsolated, true, "Safari must preserve COOP/COEP isolation");
  assert.equal(platform.hasSharedArrayBuffer, true, "Safari must expose SharedArrayBuffer");
  assert.equal(platform.hasServiceWorker, true, "Safari must expose Service Worker support");
  assert.equal(platform.hasOpfs, true, "Safari must expose OPFS");

  await execute(`document.querySelector("#welcome-start")?.click(); return true`);
  await execute(`globalThis.__previewService.loadTemplate("vite-react"); return true`);
  const preview = await executeAsync(`
    const done = arguments[arguments.length - 1];
    document.querySelector("#run-preview")?.click();
    const started = Date.now();
    const timer = setInterval(() => {
      const snapshot = globalThis.__previewService.snapshot();
      if (["preview_ready", "hmr_connected", "failed"].includes(snapshot.phase) || Date.now() - started > 60_000) {
        clearInterval(timer);
        done({ phase: snapshot.phase, error: snapshot.lastError, previewUrl: snapshot.previewUrl });
      }
    }, 100);
  `) as { phase: string; error: unknown; previewUrl: string | null };
  assert.ok(["preview_ready", "hmr_connected"].includes(preview.phase), `Safari preview failed: ${JSON.stringify(preview)}`);

  const routed = await executeAsync(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const registration = await navigator.serviceWorker.ready;
      const frame = document.querySelector("#preview-frame");
      const started = Date.now();
      while (Date.now() - started < 20_000 && !frame?.contentDocument?.querySelector("#app")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      done({
        active: Boolean(registration.active),
        controlled: Boolean(navigator.serviceWorker.controller),
        scope: registration.scope,
        iframeApp: Boolean(frame?.contentDocument?.querySelector("#app"))
      });
    })().catch((error) => done({ error: String(error) }));
  `) as Record<string, unknown>;
  assert.equal(routed.active, true, "Safari preview Service Worker must activate");
  assert.equal(routed.controlled, true, "Safari preview Service Worker must control the product page");
  assert.equal(routed.scope, `${baseUrl}/`);
  assert.equal(routed.iframeApp, true, `Safari preview iframe did not render: ${JSON.stringify(routed)}`);

  const reliabilityModuleUrl = `/@fs/${path.join(root, "packages/preview-service/src/reliability.ts")}`;
  const storage = await executeAsync(`
    const moduleUrl = arguments[0];
    const done = arguments[arguments.length - 1];
    (async () => {
      const root = await navigator.storage.getDirectory();
      const name = "nuriteo-safari-smoke-" + Date.now() + ".txt";
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write("opfs-safari-ok");
      await writable.close();
      const reopened = await root.getFileHandle(name);
      const text = await (await reopened.getFile()).text();
      await root.removeEntry(name);

      const module = await import(moduleUrl);
      const reliability = module.createPreviewReliabilitySession({
        policy: {
          storage: {
            quotaBytesDefault: 80,
            evictionPrefixes: ["cache/"],
            protectedPrefixes: ["projects/"],
            writerLeaseTtlMs: 30_000
          }
        }
      });
      reliability.writeCacheFile("cache/a", "x".repeat(50));
      reliability.writeCacheFile("projects/a", "y".repeat(50));
      let diagnostic = null;
      try {
        reliability.writeCacheFile("projects/b", "z".repeat(100));
      } catch (error) {
        diagnostic = reliability.handleStorageError(error);
      }
      const plan = reliability.createRecoveryPlan(diagnostic ? [diagnostic] : []);
      done({ text, files: reliability.storage.listFiles(), diagnostic, actions: plan.actions.map((action) => action.kind) });
    })().catch((error) => done({ error: String(error), stack: error?.stack }));
  `, [reliabilityModuleUrl]) as {
    text?: string;
    files?: string[];
    diagnostic?: { code?: string };
    actions?: string[];
    error?: string;
  };
  assert.equal(storage.error, undefined, `Safari storage smoke failed: ${storage.error}`);
  assert.equal(storage.text, "opfs-safari-ok", "Safari OPFS reopen must preserve bytes");
  assert.deepEqual(storage.files, ["projects/a"], "quota recovery must evict cache and preserve project data");
  assert.equal(storage.diagnostic?.code, "EOPFSQUOTA");
  assert.deepEqual(storage.actions?.slice(0, 2), ["clear-cache", "retry"]);

  console.log(`preview service Safari smoke ok version=${session.capabilities.browserVersion} userAgent=${platform.userAgent}`);
} finally {
  if (sessionId) {
    await webdriver(`/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
  }
  stop(server);
  stop(driver);
}

async function command(pathname: string, body: unknown): Promise<unknown> {
  assert.ok(sessionId, "Safari WebDriver session is not initialized");
  return webdriver(`/session/${sessionId}${pathname}`, { method: "POST", body });
}

function execute(script: string, args: unknown[] = []): Promise<unknown> {
  return command("/execute/sync", { script, args });
}

function executeAsync(script: string, args: unknown[] = []): Promise<unknown> {
  return command("/execute/async", { script, args });
}

async function webdriver(
  pathname: string,
  options: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const response = await fetch(`${driverUrl}${pathname}`, {
    method: options.method || "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json() as { value?: unknown };
  if (!response.ok) throw new Error(`Safari WebDriver ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload.value;
}

async function waitForHttp(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} start timeout: ${String(lastError)}`);
}

function stop(process: ChildProcess): void {
  if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
}
