import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5189;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");
const server = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: appRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

await waitForServer();
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true
});
const page = await browser.newPage();
const pageErrors = [];
const workerRequests = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
  if (request.url().includes("worker")) workerRequests.push(request.url());
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#welcome-start");
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector(".monaco-editor")) ||
      document.body.textContent.includes("workers failed to start"),
    null,
    { timeout: 60_000 }
  );
  if (await page.getByText("Editor language workers failed to start", { exact: false }).count()) {
    const failure = await page.evaluate(async () => {
      const workers = await import("/src/lib/monacoWorkers.ts");
      try {
        await workers.probeMonacoTypeScriptWorker();
        return "unknown worker startup failure";
      } catch (error) {
        const messages = [];
        let current = error;
        while (current instanceof Error) {
          messages.push(current.message);
          current = current.cause;
        }
        return messages.join(" <- ");
      }
    });
    assert.fail(failure);
  }

  const status = await page.evaluate(async () => {
    const workers = await import("/src/lib/monacoWorkers.ts");
    return Promise.race([
      workers.probeMonacoTypeScriptWorker(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Monaco TypeScript worker probe timed out")), 15_000)
      )
    ]);
  });
  assert.equal(status.loader, "bundler");
  assert.ok(status.typescriptDiagnostics > 0, "TypeScript worker must return semantic diagnostics");

  const languageFeatures = await page.evaluate(async () => {
    const workers = await import("/src/lib/monacoWorkers.ts");
    return workers.probeMonacoLanguageFeatures();
  });

  assert.ok(
    languageFeatures.definitionFiles.some((file) => file.endsWith("/__cargo_language_probe__/answer.ts")),
    `Definition provider must resolve a project file; saw ${JSON.stringify(languageFeatures.definitionFiles)}`
  );
  assert.ok(languageFeatures.quickInfoKind, "Hover/quick-info provider must return symbol information");
  assert.ok(languageFeatures.completionNames.includes("toFixed"), "Completion provider must return number members");
  assert.equal(languageFeatures.diagnosticCount, 0, "Valid cross-file TypeScript must have no semantic errors");

  assert.ok(
    workerRequests.some((url) => url.includes("ts.worker")),
    `Vite-bundled TypeScript module worker must be requested; saw ${JSON.stringify(workerRequests)}`
  );
  assert.ok(
    workerRequests.every((url) => new URL(url).origin === baseUrl),
    "Monaco workers must be same-origin"
  );

  for (const workerUrl of workerRequests) {
    const response = await page.request.get(workerUrl);
    assert.equal(response.status(), 200, `${workerUrl} must be served`);
    assert.match(response.headers()["content-type"] || "", /javascript/, `${workerUrl} must use JavaScript MIME`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`preview service Monaco language service ok diagnostics=${status.typescriptDiagnostics}`);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview-service Vite start timeout")), 60_000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes("Local:") || text.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      onData(chunk);
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview-service Vite exited early: ${code}`));
    });
  });
}
