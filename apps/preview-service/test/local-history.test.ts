import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptyLocalHistory,
  listLocalHistoryRevisions,
  persistLocalHistory,
  recordLocalHistoryRevision
} from "../src/lib/localHistory.ts";

verifyHistoryBoundsAndFallback();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5191;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");
const server = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: appRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

await waitForServer();
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage();

try {
  await page.addInitScript(() => {
    localStorage.setItem("cargo.preview-service.settings", JSON.stringify({ saveTrigger: "manual" }));
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#welcome-start");
  await page.waitForFunction(() => Boolean(globalThis.__previewService), null, { timeout: 30_000 });

  const fixture = await page.evaluate(() => {
    const api = globalThis.__previewService;
    const path = api.snapshot().project.listFiles().find((file) => file.path.endsWith("src/App.tsx"))?.path;
    if (!path) throw new Error("vite-react template must include src/App.tsx");
    api.openFile(path);
    const original = api.snapshot().editor.openFile(path).data;
    api.editCurrentFile(`${original}\n// timeline edit\n`);
    return { path, original };
  });

  await page.getByRole("button", { name: "Timeline" }).click();
  const timeline = page.getByRole("complementary", { name: "Timeline" });
  await timeline.getByText("src/App.tsx", { exact: true }).waitFor();
  assert.equal(await timeline.getByRole("list", { name: "Local history revisions" }).getByRole("listitem").count(), 1);

  await timeline.getByRole("button", { name: "Compare" }).first().click();
  await page.getByRole("region", { name: "Diff editor" }).waitFor();
  assert.match(await page.getByRole("region", { name: "Diff editor" }).innerText(), /Diff · src\/App\.tsx/);

  await timeline.getByRole("button", { name: "Restore" }).first().click();
  await page.waitForFunction(
    ({ path, original }) => globalThis.__previewService.snapshot().editor.openFile(path).data === original,
    fixture
  );

  await page.evaluate(({ original }) => {
    globalThis.__previewService.editCurrentFile(`${original}\n// saved checkpoint\n`);
    globalThis.__previewService.saveCurrentFile();
  }, fixture);
  await timeline.getByText("Saved", { exact: false }).first().waitFor();

  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("cargo.preview-service.local-history")));
  assert.equal(persisted.v, 1);
  const storedRevision = Object.values(Object.values(persisted.p)[0])[0][0];
  assert.deepEqual(Object.keys(storedRevision).sort(), ["c", "k", "t"]);

  console.log("preview service local history ok");
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

function verifyHistoryBoundsAndFallback() {
  let store = emptyLocalHistory();
  for (let index = 0; index < 25; index += 1) {
    store = recordLocalHistoryRevision(store, {
      projectId: "project",
      path: "/workspace/project/src/main.ts",
      content: `revision ${index}`,
      kind: "save",
      timestamp: index * 2_000
    });
  }
  assert.equal(listLocalHistoryRevisions(store, "project").length, 20);

  let projectBoundedStore = emptyLocalHistory();
  for (let index = 0; index < 120; index += 1) {
    projectBoundedStore = recordLocalHistoryRevision(projectBoundedStore, {
      projectId: "bounded-project",
      path: `/workspace/bounded-project/src/file-${index % 10}.ts`,
      content: `revision ${index}`,
      kind: "save",
      timestamp: index * 2_000
    });
  }
  assert.equal(listLocalHistoryRevisions(projectBoundedStore, "bounded-project").length, 100);

  const beforeCoalescedEdit = store;
  store = recordLocalHistoryRevision(store, {
    projectId: "project",
    path: "/workspace/project/src/other.ts",
    content: "first edit",
    kind: "edit",
    timestamp: 100_000
  });
  const afterFirstEdit = store;
  store = recordLocalHistoryRevision(store, {
    projectId: "project",
    path: "/workspace/project/src/other.ts",
    content: "rapid edit",
    kind: "edit",
    timestamp: 100_500
  });
  assert.notEqual(afterFirstEdit, beforeCoalescedEdit);
  assert.equal(store, afterFirstEdit);

  const throwingStorage = {
    setItem() {
      throw new DOMException("quota", "QuotaExceededError");
    }
  };
  assert.equal(persistLocalHistory(store, throwingStorage), false);
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
